// The compatibility check of a pair in which one or both sides are not saved
// in the catalogue (#33): an OpenAPI link, an uploaded OpenAPI document, or
// one JSON Schema. Each such side goes through the Publisher's import
// pipeline (lib/checks/adhoc.ts) so the engine compares the same shape of
// data as for saved records; the report has the same form as GET /api/checks.
//
//   POST /api/checks/adhoc
//   { source: Side, target: Side, format?: string }
//   Side = { api_id }                                   a saved record
//        | { url, operation?: { path, method } }         an OpenAPI link, fetched here
//        | { text, operation?: { path, method } }        an uploaded OpenAPI document
//        | { text, direction, media_type? }              one JSON Schema for this side
//
// Saved answers (check_choice) apply only when both sides are saved records;
// an ad-hoc side has no identity to save an answer against.
import { NextResponse } from "next/server";
import { getCurrentAppUser } from "@/lib/auth";
import { AdhocSideError, buildAdhocSide, type AdhocSideSpec } from "@/lib/checks/adhoc";
import { runChecks } from "@/lib/checks/run";
import { getSupabaseConfig, loadAliasMaps, loadSides, PairNotFound, PairSchemaNotFound, selectedSchema, } from "@/lib/checks/store";
import type { ApiSideInput } from "@/lib/checks/types";
import { MAX_UPLOAD_CHARS, type OperationRef } from "@/lib/schema/upload";
import { loadSchemaDocument } from "@/lib/schema/document-loader";
import { checkMutationRateLimit } from "@/lib/mutation-rate-limit";
import { clientKey, isSameOrigin, publicError, reportFor, UUID } from "../shared";

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 2 * MAX_UPLOAD_CHARS + 4_000;

type SideBody =
  | { api_id: string; schema_id?: string }
  | { url: string; operation?: OperationRef }
  | { text: string; operation?: OperationRef }
  | { text: string; direction: "request" | "response"; media_type?: string };

function operationOf(value: unknown): OperationRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { path, method } = value as { path?: unknown; method?: unknown };
  return typeof path === "string" && typeof method === "string" && path.length <= 2_048 && method.length <= 10 ? { path, method } : undefined;
}

function sideBody(value: unknown, name: string): SideBody | string {
  if (!value || typeof value !== "object") return `${name} must be an object.`;
  const v = value as Record<string, unknown>;
  if (typeof v.api_id === "string") { if (!UUID.test(v.api_id)){return `${name}.api_id must be a UUID.`;} const schemaId = typeof v.schema_id === "string" ? v.schema_id.trim() : ""; if (schemaId && !UUID.test(schemaId)) { return `${name}.schema_id must be a UUID.`; } return { api_id: v.api_id, schema_id: schemaId || undefined, };}
  if (typeof v.url === "string") return v.url.trim() && v.url.length <= 2_048 ? { url: v.url.trim(), operation: operationOf(v.operation) } : `${name}.url must be a link.`;
  if (typeof v.text === "string") {
    if (v.text.length > MAX_UPLOAD_CHARS) return `${name}.text is larger than ${MAX_UPLOAD_CHARS} characters.`;
    if (v.direction === "request" || v.direction === "response") {
      return { text: v.text, direction: v.direction, media_type: typeof v.media_type === "string" ? v.media_type : undefined };
    }
    return { text: v.text, operation: operationOf(v.operation) };
  }
  return `${name} must carry api_id, url or text.`;
}

async function specOf(body: SideBody): Promise<AdhocSideSpec | { error: string; status: number }> {
  if ("url" in body) {
    const loaded = await loadSchemaDocument(body.url);
    if (!loaded.ok) return { error: loaded.message, status: 422 };
    return { kind: "openapi", document: loaded.document, document_url: loaded.final_url, operation: body.operation };
  }
  if ("direction" in body) return { kind: "schema", text: body.text, direction: body.direction, media_type: body.media_type };
  if (!("text" in body)) return { error: "A saved record is not read as a document.", status: 400 };
  let document: unknown;
  try {
    document = JSON.parse(body.text);
  } catch {
    const { parse } = await import("yaml");
    try { document = parse(body.text, { maxAliasCount: 100 }); } catch { return { error: "The uploaded document is not JSON or YAML.", status: 422 }; }
  }
  return { kind: "openapi", document, document_url: "", operation: body.operation };
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);
  const retryAfter = checkMutationRateLimit("import", { id: "compatibility-adhoc", role: "viewer" }, `adhoc:${clientKey(request)}`);
  if (retryAfter) return publicError("Too many checks. Please wait before trying again.", 429, requestId, { retryAfterSeconds: retryAfter });

  let raw: string;
  try { raw = await request.text(); } catch { return publicError("The request body could not be read.", 400, requestId); }
  if (raw.length > MAX_BODY_CHARS) return publicError("The request body is too large.", 413, requestId);
  let value: { source?: unknown; target?: unknown; format?: unknown };
  try { value = JSON.parse(raw); } catch { return publicError("The request body must be valid JSON.", 400, requestId); }
  const source = sideBody(value.source, "source"), target = sideBody(value.target, "target");
  if (typeof source === "string") return publicError(source, 400, requestId);
  if (typeof target === "string") return publicError(target, 400, requestId);
  const format = typeof value.format === "string" && value.format.trim() ? value.format.trim() : null;
  if (format && format.length > 100) return publicError("format is not a known format name.", 400, requestId);

  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);

  // Two saved records are the ordinary pair check, answers included.
  if ("api_id" in source && "api_id" in target) {
    if (source.api_id === target.api_id) return publicError("source and target must differ.", 400, requestId);
    const signedIn = await getCurrentAppUser(request).then((user) => user !== null).catch(() => false);
    const outcome = await reportFor(config, source.api_id, target.api_id, requestId, format, signedIn, { sourceSchemaId: source.schema_id ?? null, targetSchemaId: target.schema_id ?? null },);
    if (!outcome.ok) return outcome.response;
    return NextResponse.json({ report: outcome.report, requestId, adhoc: false }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const savedIds = [source, target].flatMap((s) => ("api_id" in s ? [s.api_id] : []));
    const [{ sides, formatAliases }, aliases] = await Promise.all([loadSides(config, savedIds), loadAliasMaps(config)]);
    const warnings: Record<"source" | "target", string[]> = { source: [], target: [] };
    const operations: Partial<Record<"source" | "target", OperationRef[]>> = {};
    const build = async (body: SideBody, side: "source" | "target"): Promise<ApiSideInput | { error: string; status: number }> => {
      if ("api_id" in body) return sides.get(body.api_id)!;
      const spec = await specOf(body);
      if ("error" in spec) return spec;
      try {
        const built = buildAdhocSide(spec, side, aliases);
        warnings[side] = built.warnings;
        if (built.operations) operations[side] = built.operations;
        return built;
      } catch (error) {
        if (error instanceof AdhocSideError) {
          if (error.operations.length) operations[side] = error.operations;
          return { error: `${side}: ${error.message}`, status: 422 };
        }
        throw error;
      }
    };
    const [s, t] = await Promise.all([build(source, "source"), build(target, "target")]);
    if ("error" in s) return publicError(s.error, s.status, requestId, { operations });
    if ("error" in t) return publicError(t.error, t.status, requestId, { operations });
    const selectedSourceSchemaId = "api_id" in source ? selectedSchema(s, source.schema_id, "response", "source",) : null;
    const selectedTargetSchemaId = "api_id" in target ? selectedSchema(t, target.schema_id, "request", "target",) : null;
    const report = runChecks({ source: s, target: t, formatAliases, choices: [], selectedFormat: format, selectedSourceSchemaId, selectedTargetSchemaId,});
    if (format && !report.check1.format_options.some((option) => option.selectable && option.format === format)) {
      const offered = report.check1.format_options.filter((o) => o.selectable).map((o) => o.format);
      return publicError(offered.length > 0 ? `format must be one of: ${offered.join(", ")}.` : "Neither API declares a format that can be compared.", 400, requestId);
    }
    // The fields of the schemas compared, for the page's field-level views;
    // a saved side's fields it already has, an ad-hoc side's it does not.
    const fieldsOf = (side: ApiSideInput, id: string | null | undefined) => side.schemas.find((schema) => schema.id === id)?.fields ?? [];
    const fields = {
      source: fieldsOf(s, report.check2.schema.source_schema_used?.schema_id),
      target: fieldsOf(t, report.check2.schema.target_schema_used?.schema_id),
    };
    return NextResponse.json({ report, requestId, adhoc: true, warnings, operations, fields }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PairNotFound) return publicError("API record not found.", 404, requestId, { missing: error.missing });
    if (error instanceof PairSchemaNotFound) { return publicError(`${error.side}.schema_id does not identify a valid ${error.side === "source" ? "response" : "request"} schema for the selected API.`, 400, requestId,); }
    return publicError("The check could not be run.", 502, requestId);
  }
}
