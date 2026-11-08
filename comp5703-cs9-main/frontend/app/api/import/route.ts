import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  SUBMITTER_ROLES,
  requireRole,
  type AuthenticatedAppUser,
} from "@/lib/auth";
import { ownsImportSession } from "@/lib/auth-policy";
import { checkMutationRateLimit } from "@/lib/mutation-rate-limit";
import { safeFetch, refusalMessage } from "@/lib/import/fetch";
import { normaliseDocumentUrl } from "@/lib/import/url";
import { detect, formatName, extractSpecUrl } from "@/lib/import/detect";
import { applyCatalogueScope } from "@/lib/import/catalogue-scope";
import {
  applyGeneralImportScope,
  MAX_CONFIRM_OPERATIONS,
  MAX_PARSED_OPERATIONS,
  MAX_PREVIEW_SESSION_BYTES,
  utf8Bytes,
} from "@/lib/import/import-safety";
import { parseOpenApi3 } from "@/lib/openapi/parse";
import { extractDocumentSchemas, type DocumentSchemas } from "@/lib/schema/extract";
import { forStorage, restoreFields, schemasForOperation } from "@/lib/schema/rows";
import { writeSchemaSet } from "@/lib/schema/store";
import { loadAliasMaps } from "@/lib/checks/store";
import { toApiRow, type AliasMaps } from "@/lib/import/candidate-record";
import {
  MERGEABLE_FIELDS,
  predictOutcome,
  type StoredRecord,
} from "@/lib/import/merge";
import {
  operationKey,
  parseStoredCandidates,
  type StoredCandidates,
} from "@/lib/import/session-candidates";
import {
  decideAppendOnly,
  normaliseSelectedIndices,
} from "@/lib/import/confirm-policy";
import type { Candidate } from "@/lib/import/types";
import { normalizeCommunicationDirection } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 20_000;
const SESSION_TTL_MS = 60 * 60 * 1000;

type SupabaseConfig = { url: string; key: string; opaqueSecret: boolean };

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key, opaqueSecret: key.startsWith("sb_secret_") } : null;
}

function headers(config: SupabaseConfig, write = false): Record<string, string> {
  const h: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) h.Authorization = `Bearer ${config.key}`;
  if (write) h["Content-Type"] = "application/json";
  return h;
}

function publicError(message: string, status: number, requestId: string) {
  return NextResponse.json({ error: message, requestId }, { status, headers: { "Cache-Control": "no-store" } });
}

// -- rate limiting and same-origin, matching the existing apis route -------

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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new Error("payload too large");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("body must be an object");
  return parsed as Record<string, unknown>;
}

function hashOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

// -- Supabase helpers ------------------------------------------------------

type ApiMatch = StoredRecord & { id: string; api_endpoint: string; http_method: string };

/** Rows already imported from this document, keyed by endpoint+method. */
async function loadExisting(config: SupabaseConfig, documentUrl: string): Promise<Map<string, ApiMatch>> {
  const fields = ["id", "api_endpoint", "http_method", ...MERGEABLE_FIELDS].join(",");
  const q = new URLSearchParams({
    select: fields,
    documentation_url: `eq.${documentUrl}`,
    http_method: "not.is.null",
  });
  const res = await fetch(`${config.url}/rest/v1/apis?${q}`, { headers: headers(config) });
  const map = new Map<string, ApiMatch>();
  if (!res.ok) throw new Error(`existing records lookup failed ${res.status}`);
  for (const row of (await res.json()) as ApiMatch[]) {
    if (row.http_method) map.set(operationKey(row), row);
  }
  return map;
}

function identityKey(c: Candidate): string {
  return operationKey(c);
}

// -- POST: preview or confirm depending on the presence of sessionId -------

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);

  const access = await requireRole(request, SUBMITTER_ROLES, requestId);
  if ("response" in access) return access.response;

  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);

  let input: Record<string, unknown>;
  try {
    input = await readJson(request);
  } catch {
    return publicError("The request body could not be read.", 400, requestId);
  }

  const isConfirmation = typeof input.sessionId === "string";
  // Rate-limit new import attempts, not the one-use confirmation belonging to
  // an existing preview. Otherwise one user action would consume two slots and
  // a successful preview could be prevented from being confirmed.
  if (!isConfirmation) {
    const retryAfterSeconds = checkMutationRateLimit("import", access.user, clientKey(request));
    if (retryAfterSeconds > 0) {
      const response = publicError(
        `Too many import requests. Please try again in ${retryAfterSeconds} seconds.`,
        429,
        requestId,
      );
      response.headers.set("Retry-After", String(retryAfterSeconds));
      return response;
    }
  }

  return isConfirmation
    ? confirm(config, input, requestId, access.user)
    : preview(config, input, requestId, access.user);
}

async function preview(
  config: SupabaseConfig,
  input: Record<string, unknown>,
  requestId: string,
  user: AuthenticatedAppUser,
) {
  await compactExpiredPreviewSessions(config);
  const submitted = typeof input.url === "string" ? input.url.trim() : "";
  if (!submitted) return publicError("Enter a URL.", 400, requestId);

  const fetched = await safeFetch(submitted);
  if (!fetched.ok) {
    await recordSession(config, {
      documentation_url_raw: submitted, documentation_url: submitted,
      outcome: "refused", refusal_reason: fetched.refusal,
      created_by_user: user.id,
    });
    return publicError(refusalMessage(fetched.refusal), 422, requestId);
  }

  let body = fetched.body;
  let finalUrl = fetched.finalUrl;
  let detection = detect(body, finalUrl);

  // A Swagger UI / Redoc page names the real document. Follow it once, through
  // every fetch gate, so the user does not have to find the JSON themselves
  // One hop only: a page pointing at a page is refused below.
  if (detection.format === "html_page") {
    let specUrl = detection.specUrl;
    if (!specUrl) {
      for (const scriptUrl of detection.configScriptUrls) {
        const script = await safeFetch(scriptUrl);
        if (script.ok) {
          specUrl = extractSpecUrl(script.body, scriptUrl);
          if (specUrl) break;
        }
      }
    }
    if (specUrl) {
      const followed = await safeFetch(specUrl);
      if (followed.ok) {
        body = followed.body;
        finalUrl = followed.finalUrl;
        detection = detect(body, finalUrl);
      }
    }
  }

  const normalised = normaliseDocumentUrl(finalUrl);
  const contentHash = hashOf(body);

  // Swagger 2.0 is parsed and its schemas extracted from its own fields
  // (parseOpenApi3, extract.ts); Billit and Nanonets publish only 2.0.
  if (detection.format !== "openapi_3" && detection.format !== "swagger_2") {
    const reason = detection.format;
    await recordSession(config, {
      documentation_url_raw: submitted, documentation_url: normalised,
      content_hash: contentHash, detected_format: reason, outcome: "refused",
      refusal_reason: reason,
      created_by_user: user.id,
    });
    const hint = detection.format === "html_page"
      ? "This is a documentation page. Please submit the OpenAPI document link it points to."
      : `This is ${formatName(reason)}, which this version does not yet import.`;
    return NextResponse.json(
      { refused: true, detected_format: reason, message: hint, requestId },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsedDocument = parseOpenApi3(detection.document, finalUrl);
  if (parsedDocument.candidates.length > MAX_PARSED_OPERATIONS) {
    await recordSession(config, {
      documentation_url_raw: submitted, documentation_url: normalised,
      content_hash: contentHash, detected_format: detection.format, outcome: "refused",
      refusal_reason: "too_many_operations",
      created_by_user: user.id,
    });
    return publicError(
      `This document declares more than ${MAX_PARSED_OPERATIONS} operations. Split it into smaller e-invoicing documents before importing.`,
      413,
      requestId,
    );
  }

  const parsed = applyCatalogueScope(
    parsedDocument,
    finalUrl,
  );
  // Schemas are additive. A document whose schemas cannot be walked still
  // imports its operations exactly as before; it simply stores none.
  let documentSchemas: DocumentSchemas[] = [];
  try {
    documentSchemas = extractDocumentSchemas(detection.document);
  } catch {
    documentSchemas = [];
  }
  const [aliases, existing] = await Promise.all([
    loadAliasMaps(config),
    loadExisting(config, normalised),
  ]);

  const classifiedCandidates = parsed.candidates.map((c) => {
    const row = toApiRow(c, normalised, aliases);
    const match = existing.get(identityKey(c));
    const outcome = predictOutcome(match ?? null, row);
    return {
      candidate: c, row, predicted_outcome: outcome, matched_id: match?.id ?? null,
      schemas: forStorage(schemasForOperation(c, documentSchemas)),
    };
  });

  const generalScope = applyGeneralImportScope(classifiedCandidates, detection.document);
  const candidates = generalScope.items;
  const warnings = [...parsed.warnings, ...generalScope.warnings];
  const excludedOperations = [...parsed.excluded_operations, ...generalScope.excluded_operations];
  const excludedCount = parsed.excluded_count + generalScope.excluded_count;
  if (candidates.length === 0) {
    await recordSession(config, {
      documentation_url_raw: submitted, documentation_url: normalised,
      content_hash: contentHash, detected_format: detection.format, outcome: "refused",
      refusal_reason: "outside_catalogue_scope",
      candidates: JSON.stringify({
        info_title: parsed.info_title,
        warnings,
        excluded_operations: excludedOperations,
      }),
      created_by_user: user.id,
    });
    return NextResponse.json(
      {
        sessionId: "", documentation_url: normalised, info_title: parsed.info_title,
        info_version: parsed.info_version, warnings, excluded_count: excludedCount,
        candidates: [], requestId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const storedCandidates = JSON.stringify({
    items: candidates,
    info_title: parsed.info_title,
    warnings,
    excluded_operations: excludedOperations,
  });
  if (utf8Bytes(storedCandidates) > MAX_PREVIEW_SESSION_BYTES) {
    await recordSession(config, {
      documentation_url_raw: submitted, documentation_url: normalised,
      content_hash: contentHash, detected_format: detection.format, outcome: "refused",
      refusal_reason: "preview_too_large",
      created_by_user: user.id,
    });
    return publicError(
      "The relevant operations and schemas produce a preview larger than the 2 MB safety limit. Split the OpenAPI document before importing.",
      413,
      requestId,
    );
  }

  const sessionId = await recordSession(config, {
    documentation_url_raw: submitted, documentation_url: normalised,
    content_hash: contentHash, detected_format: detection.format, info_version: parsed.info_version,
    outcome: "previewed",
    candidates: storedCandidates,
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    created_by_user: user.id,
  });

  return NextResponse.json(
    {
      sessionId, documentation_url: normalised, info_title: parsed.info_title,
      info_version: parsed.info_version, warnings,
      excluded_count: excludedCount,
      candidates: candidates.map((c, i) => ({
        index: i, api_name: c.row.api_name, api_endpoint: c.row.api_endpoint,
        http_method: c.row.http_method, data_quality: c.row.data_quality,
        category: c.row.category,
        communication_direction: c.row.communication_direction,
        predicted_outcome: c.predicted_outcome, warnings: c.candidate.warnings,
      })),
      requestId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function confirm(
  config: SupabaseConfig,
  input: Record<string, unknown>,
  requestId: string,
  user: AuthenticatedAppUser,
) {
  const sessionId = input.sessionId as string;
  const actor = user.displayName;

  const session = await getSession(config, sessionId);
  if (!session) return publicError("This preview has expired. Please submit the URL again.", 410, requestId);
  if (!ownsImportSession(user.id, session.created_by_user)) {
    return publicError("This preview belongs to another account. Submit the URL again.", 403, requestId);
  }
  if (session.outcome !== "previewed") {
    return publicError("This preview has already been submitted. Create a new preview to import again.", 409, requestId);
  }
  if (new Date(session.expires_at ?? 0).getTime() < Date.now()) {
    return publicError("This preview has expired. Please submit the URL again.", 410, requestId);
  }

  const stored = parseStoredCandidates(session.candidates);
  const items = stored.items ?? [];
  const selected = normaliseSelectedIndices(input.selected, items.length);
  if (!selected) {
    return publicError("Select at least one valid new operation.", 400, requestId);
  }
  if (selected.length > MAX_CONFIRM_OPERATIONS) {
    return publicError(
      `Select no more than ${MAX_CONFIRM_OPERATIONS} operations in one import.`,
      400,
      requestId,
    );
  }
  if (selected.some((index) => items[index]?.predicted_outcome !== "insert")) {
    return publicError("Only operations marked as new can be imported.", 400, requestId);
  }
  const documentUrl = session.documentation_url;

  // Recompute against the database as it is NOW, not the preview's snapshot.
  let existing: Map<string, ApiMatch>;
  try {
    existing = await loadExisting(config, documentUrl);
  } catch {
    return publicError("The catalogue could not be checked. Nothing was imported.", 503, requestId);
  }

  // Atomically claim this preview before the first catalogue write. The
  // outcome filter means only one of two concurrent confirmations can win,
  // so a second click cannot process the batch or replace its attribution.
  let claimed = false;
  try {
    claimed = await claimSession(config, sessionId, user.id, {
      outcome: "imported",
      submitted_by: actor,
      submitted_by_user: user.id,
      candidates: JSON.stringify({
        ...stored,
        selected_indices: selected,
        applied_indices: [],
      }),
    });
  } catch {
    return publicError("The import could not be started. Nothing was imported.", 503, requestId);
  }
  if (!claimed) {
    return publicError("This preview has already been submitted. Create a new preview to import again.", 409, requestId);
  }

  const summary = { inserted: 0, skipped: 0, conflicted: 0, failed: 0, schemas: 0, details: [] as unknown[] };
  const appliedIndices = new Set<number>();

  function rememberApplied(index: number) {
    appliedIndices.add(index);
  }

  for (const index of selected) {
    const item = items[index];
    if (!item) { summary.failed++; continue; }
    try {
      const candidate = item.candidate;
      // Preview rows created shortly before this field was deployed may not
      // contain it. Normalize at confirm time so they remain safe to submit.
      const row: Record<string, unknown> = {
        ...item.row,
        communication_direction: normalizeCommunicationDirection(
          item.row.communication_direction,
          typeof item.row.category === "string" ? item.row.category : "",
        ),
      };
      const match = existing.get(identityKey(candidate));
      const nameTaken = !match && (await nameExists(config, row.company_name as string, row.api_name as string));
      const outcome = decideAppendOnly(Boolean(match), nameTaken);
      if (outcome.action === "insert") {
        const apiId = await insertRow(config, { ...row, created_by_user: user.id });
        summary.inserted++;
        rememberApplied(index);
        const auditRecorded = await audit(
          config, apiId, row, "upload", actor, user.id, "API submitted through document import.",
        );
        if (!auditRecorded) {
          summary.details.push({
            index,
            api_name: row.api_name,
            action: "audit_warning",
            reason: "audit_not_recorded",
          });
        }
        // The operation is already in the catalogue at this point. A schema
        // write that fails leaves it there without schemas and says so; it
        // must not turn an imported operation into a failed one.
        const schemaResult = await writeSchemaSet(
          config, apiId, restoreFields(item.schemas ?? []), { kind: "extracted", sourceUrl: documentUrl },
        );
        if (schemaResult.ok) {
          summary.schemas += schemaResult.schemas;
        } else {
          summary.details.push({
            index,
            api_name: row.api_name,
            action: "schema_warning",
            reason: schemaResult.error,
          });
        }
      } else if (outcome.action === "skip") {
        summary.skipped++;
      } else if (outcome.action === "conflict") {
        summary.conflicted++;
        summary.details.push({ index, api_name: row.api_name, action: "conflict", reason: outcome.reason });
      }
    } catch {
      summary.failed++;
      summary.details.push({ index, api_name: item.row.api_name, action: "failed" });
    }
  }

  try {
    await markSession(config, sessionId, {
      candidates: compactCandidatesForAudit(stored, selected, [...appliedIndices]),
    });
  } catch {
    summary.details.push({
      index: -1,
      api_name: "Import session",
      action: "audit_warning",
      reason: "session_not_finalised",
    });
  }
  return NextResponse.json({ summary, requestId }, { headers: { "Cache-Control": "no-store" } });
}

// -- Supabase writes -------------------------------------------------------

/** Best-effort housekeeping: expired previews cannot be confirmed, so their
 * large server-owned candidate/schema payload is no longer needed. Keep the
 * small provenance row while releasing the jsonb storage. */
async function compactExpiredPreviewSessions(config: SupabaseConfig): Promise<void> {
  try {
    const q = new URLSearchParams({
      outcome: "eq.previewed",
      expires_at: `lt.${new Date().toISOString()}`,
    });
    await fetch(`${config.url}/rest/v1/import_session?${q}`, {
      method: "PATCH",
      headers: headers(config, true),
      body: JSON.stringify({ outcome: "expired", candidates: null }),
    });
  } catch {
    // Housekeeping must not turn a valid preview into an outage.
  }
}

/** Once confirmation finishes, raw schemas are already stored against the
 * selected APIs. Retain identity, outcome and selection provenance without
 * keeping a second copy of every schema in import_session. */
function compactCandidatesForAudit(
  stored: StoredCandidates,
  selectedIndices: number[],
  appliedIndices: number[],
): string {
  const items = (stored.items ?? []).map((item) => ({
    candidate: {
      api_endpoint: item.candidate.api_endpoint,
      http_method: item.candidate.http_method,
      operation_id: item.candidate.operation_id ?? "",
      operation_path: item.candidate.operation_path ?? "",
    },
    row: {
      api_name: item.row.api_name,
      company_name: item.row.company_name,
      category: item.row.category,
      communication_direction: item.row.communication_direction,
    },
    predicted_outcome: item.predicted_outcome,
  }));
  return JSON.stringify({
    info_title: stored.info_title,
    warnings: stored.warnings,
    items,
    excluded_operations: stored.excluded_operations ?? [],
    selected_indices: selectedIndices,
    applied_indices: appliedIndices,
  });
}

async function recordSession(config: SupabaseConfig, row: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${config.url}/rest/v1/import_session`, {
    method: "POST",
    headers: { ...headers(config, true), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) return "";
  const [created] = (await res.json()) as { id: string }[];
  return created?.id ?? "";
}

async function getSession(config: SupabaseConfig, id: string) {
  const q = new URLSearchParams({ select: "*", id: `eq.${id}`, limit: "1" });
  const res = await fetch(`${config.url}/rest/v1/import_session?${q}`, { headers: headers(config) });
  if (!res.ok) return null;
  const [row] = (await res.json()) as {
    id: string; documentation_url: string; candidates: string | null;
    info_version: string | null; expires_at: string | null; content_hash: string | null; outcome: string;
    created_by_user: string | null;
  }[];
  return row ?? null;
}

async function claimSession(
  config: SupabaseConfig,
  id: string,
  createdByUser: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const q = new URLSearchParams({
    id: `eq.${id}`,
    outcome: "eq.previewed",
    created_by_user: `eq.${createdByUser}`,
    select: "id",
  });
  const res = await fetch(`${config.url}/rest/v1/import_session?${q}`, {
    method: "PATCH",
    headers: { ...headers(config, true), Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`session claim failed ${res.status}`);
  return ((await res.json()) as { id: string }[]).length === 1;
}

async function nameExists(config: SupabaseConfig, company: string, name: string): Promise<boolean> {
  const q = new URLSearchParams({
    select: "id", company_name: `ilike.${company}`, api_name: `ilike.${name}`, limit: "1",
  });
  const res = await fetch(`${config.url}/rest/v1/apis?${q}`, { headers: headers(config) });
  if (!res.ok) throw new Error(`name lookup failed ${res.status}`);
  return ((await res.json()) as unknown[]).length > 0;
}

async function insertRow(config: SupabaseConfig, row: Record<string, unknown>): Promise<string> {
  const query = new URLSearchParams({ select: "id" });
  const res = await fetch(`${config.url}/rest/v1/apis?${query}`, {
    method: "POST",
    headers: { ...headers(config, true), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`insert failed ${res.status}`);
  const [created] = (await res.json()) as { id?: unknown }[];
  if (typeof created?.id !== "string") throw new Error("insert did not return an id");
  return created.id;
}

async function markSession(config: SupabaseConfig, id: string, patch: Record<string, unknown>) {
  const res = await fetch(`${config.url}/rest/v1/import_session?id=eq.${id}`, {
    method: "PATCH", headers: headers(config, true), body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`session update failed ${res.status}`);
}

async function audit(
  config: SupabaseConfig, apiId: string, row: Record<string, unknown>,
  action: string, actor: string, actorUserId: string, details: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${config.url}/rest/v1/api_audit_events`, {
      method: "POST", headers: headers(config, true),
      body: JSON.stringify({
        api_id: apiId, api_name: row.api_name, company_name: row.company_name,
        action, actor_name: actor, actor_user_id: actorUserId, details,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
