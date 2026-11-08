// Recover schemas for records imported before schema extraction existed.
//
//   POST /api/schemas/backfill  { api_id }
//
// Fetches the record's documentation again, through the same guarded fetcher
// the importer uses, and gives schemas to that record and to every other
// record from the same document that has none -- one fetch serves the whole
// document, so a 61-operation KSeF import is recovered with one request. The
// caller fills only records they may manage: an administrator all of them, a
// submitter their own.

import { NextResponse } from "next/server";
import { SUBMITTER_ROLES, requireRole } from "@/lib/auth";
import { canManageApi } from "@/lib/auth-policy";
import { checkMutationRateLimit } from "@/lib/mutation-rate-limit";
import { safeFetch } from "@/lib/import/fetch";
import { planBackfill, type SkipReason } from "@/lib/schema/backfill";
import { buildSchemaCandidates } from "@/lib/schema/document-candidates";
import { loadSchemaDocument } from "@/lib/schema/document-loader";
import { extractDocumentSchemas } from "@/lib/schema/extract";
import { restHeaders, writeParameterSet, writeSchemaSet, type RestConfig } from "@/lib/schema/store";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_CHARS = 2_000;

function getSupabaseConfig(): RestConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key, opaqueSecret: key.startsWith("sb_secret_") } : null;
}

function publicError(message: string, status: number, requestId: string) {
  return NextResponse.json({ error: message, requestId }, { status, headers: { "Cache-Control": "no-store" } });
}

function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : "").trim() || "local";
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

async function get<T>(config: RestConfig, table: string, query: Record<string, string>): Promise<T[]> {
  const res = await fetch(`${config.url}/rest/v1/${table}?${new URLSearchParams(query)}`, {
    headers: restHeaders(config),
  });
  if (!res.ok) throw new Error(`${table} read failed ${res.status}`);
  return (await res.json()) as T[];
}

type ApiRow = {
  id: string; api_name: string; company_name: string; api_endpoint: string; http_method: string | null;
  documentation_url: string; is_active: boolean; duplicate_of: string | null; created_by_user: string | null;
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);

  const access = await requireRole(request, SUBMITTER_ROLES, requestId);
  if ("response" in access) return access.response;
  const user = access.user;
  // Each call fetches an outside document, so it draws on the import quota.
  const retryAfter = checkMutationRateLimit("import", user, clientKey(request));
  if (retryAfter > 0) {
    const res = publicError(`Too many requests. Please try again in ${retryAfter} seconds.`, 429, requestId);
    res.headers.set("Retry-After", String(retryAfter));
    return res;
  }

  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);

  let apiId = "";
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) throw new Error("too large");
    const body = JSON.parse(raw) as Record<string, unknown>;
    apiId = typeof body.api_id === "string" ? body.api_id.trim() : "";
  } catch {
    return publicError("The request body could not be read.", 400, requestId);
  }
  if (!UUID.test(apiId)) return publicError("api_id must be a UUID.", 400, requestId);

  const fields = "id,api_name,company_name,api_endpoint,http_method,documentation_url,is_active,duplicate_of,created_by_user";
  let api: ApiRow | undefined;
  try {
    [api] = await get<ApiRow>(config, "apis", { select: fields, id: `eq.${apiId}` });
  } catch {
    return publicError("The API could not be checked.", 503, requestId);
  }
  if (!api || !api.is_active || api.duplicate_of) return publicError("API record was not found.", 404, requestId);
  if (!canManageApi(user, api)) {
    return publicError("You can only fetch schemas for APIs you submitted.", 403, requestId);
  }
  if (!api.documentation_url) return publicError("This API has no documentation link to fetch.", 400, requestId);
  const target = api;

  const fetched = await loadSchemaDocument(api.documentation_url, safeFetch);
  if (!fetched.ok) return publicError(fetched.message, 422, requestId);

  const candidates = buildSchemaCandidates(fetched.document, fetched.final_url);
  const documentSchemas = extractDocumentSchemas(fetched.document);

  try {
    // Every record imported from the same document. The stored
    // documentation_url is the normalised address the importer recorded, so
    // it is the key that groups them.
    const siblings = await get<ApiRow>(config, "apis", {
      select: fields,
      documentation_url: `eq.${target.documentation_url}`,
      is_active: "eq.true",
      duplicate_of: "is.null",
    });
    const rows = siblings.some((s) => s.id === target.id) ? siblings : [target, ...siblings];
    const mine = rows.filter((r) => canManageApi(user, r));
    const notYours = rows.length - mine.length;

    const existing = mine.length === 0 ? [] : await get<{ api_id: string }>(config, "api_schema", {
      select: "api_id", api_id: `in.(${mine.map((r) => r.id).join(",")})`,
    });
    const plan = planBackfill(mine, candidates, documentSchemas, new Set(existing.map((e) => e.api_id)));

    let schemas = 0;
    let fieldCount = 0;
    let parameterCount = 0;
    const failed: string[] = [];
    const parametersFailed: string[] = [];
    for (const item of plan.fill) {
      const origin = { kind: "extracted" as const, sourceUrl: fetched.final_url };
      const written = await writeSchemaSet(config, item.api_id, item.schemas, origin);
      if (!written.ok) {
        failed.push(item.api_id);
        continue;
      }
      schemas += written.schemas;
      fieldCount += written.fields;
      // Parameters are additive, the way schemas are: an operation whose
      // bodies were recorded is still recovered even if its parameters
      // cannot be, and the answer reports which.
      if (item.parameters.length > 0) {
        const params = await writeParameterSet(config, item.api_id, item.parameters, origin);
        if (params.ok) parameterCount += params.parameters;
        else parametersFailed.push(item.api_id);
      }
      const row = mine.find((r) => r.id === item.api_id)!;
      await fetch(`${config.url}/rest/v1/api_audit_events`, {
        method: "POST", headers: restHeaders(config, true),
        body: JSON.stringify({
          api_id: row.id, api_name: row.api_name, company_name: row.company_name, action: "edit",
          actor_name: user.displayName, actor_user_id: user.id,
          details: `Extracted from its documentation: ${written.schemas} schema${written.schemas === 1 ? "" : "s"}`
            + `${item.parameters.length > 0 ? `, ${item.parameters.length} path/query parameter${item.parameters.length === 1 ? "" : "s"}` : ""}.`,
        }),
      }).catch(() => undefined);
    }

    const skipped: Record<SkipReason | "not_yours", number> = {
      has_schemas: 0, not_in_document: 0, ambiguous_operation: 0, no_schema_stated: 0, not_yours: notYours,
    };
    for (const s of plan.skipped) skipped[s.reason] += 1;

    return NextResponse.json({
      filled: plan.fill.length - failed.length,
      schemas,
      fields: fieldCount,
      parameters: parameterCount,
      parameters_failed: parametersFailed.length,
      skipped,
      failed: failed.length,
      // What happened to the record the caller asked about, among the rest.
      this_api: failed.includes(target.id)
        ? "failed"
        : plan.fill.some((f) => f.api_id === target.id)
          ? "filled"
          : plan.skipped.find((s) => s.api_id === target.id)?.reason ?? "not_in_document",
      requestId,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return publicError("Schemas could not be recovered.", 502, requestId);
  }
}
