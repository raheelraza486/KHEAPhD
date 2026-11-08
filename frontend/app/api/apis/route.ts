import { NextResponse } from "next/server";
import {
  ADMIN_ROLES,
  APP_ROLES,
  SUBMITTER_ROLES,
  getCurrentAppUser,
  requireRole,
} from "@/lib/auth";
import { canManageApi, ownsApi } from "@/lib/auth-policy";
import {
  API_CATEGORIES,
  AUTHENTICATION_TYPES,
  COMMUNICATION_DIRECTIONS,
  HTTP_METHODS,
  normalizeApiRecord,
  type ApiCategory,
  type ApiRecord,
  type AuditAction,
  type AuditEvent,
  type AuthenticationType,
  type CommunicationDirection,
  type ReviewStatus,
} from "@/lib/types";
import { summarizeCoverage } from "@/lib/coverage";
import { visibleCatalogueRecords } from "@/lib/catalog-visibility";
import { auditDetailsForDisplay, publicReviewNote } from "@/lib/audit-presentation";
import { checkMutationRateLimit, type MutationAction } from "@/lib/mutation-rate-limit";
import {
  buildMetadataBulkPlan,
  metadataBulkPlanToken,
  normalizeMetadataSpreadsheetRows,
} from "@/lib/metadata-bulk-update";

export const dynamic = "force-dynamic";

const SELECT_FIELDS = [
  "id", "api_name", "official_api_name", "description", "api_endpoint", "http_method",
  "operation_selector", "instructions",
  "company_name", "official_company_name", "country_region", "website_url", "documentation_url", "category",
  "category_other", "communication_direction", "authentication_method", "authentication_other", "authentication_details",
  "network", "is_active", "duplicate_of", "created_at", "updated_at", "input_formats", "output_formats",
  "business_rules", "client_types", "review_status", "source_url", "verified_at", "verified_by",
  "verification_notes", "created_by_user", "invoice_standard", "invoice_standard_source", "access_scope", "data_quality",
].join(",");

const LEGACY_SELECT_FIELDS = SELECT_FIELDS.split(",")
  .filter((field) => field !== "country_region" && field !== "communication_direction")
  .join(",");

const AUDIT_FIELDS = [
  "id", "api_id", "api_name", "company_name", "action", "actor_name", "details", "action_at",
].join(",");

const COVERAGE_SELECT_FIELDS = [
  "id", "api_name", "official_api_name", "company_name", "official_company_name",
  "country_region", "documentation_url", "website_url", "source_url", "api_endpoint", "is_active",
  "review_status", "verified_by", "verification_notes", "duplicate_of",
].join(",");

const LEGACY_COVERAGE_SELECT_FIELDS = [
  "id", "api_name", "official_api_name", "company_name", "official_company_name",
  "documentation_url", "website_url", "source_url", "api_endpoint", "is_active",
  "review_status", "verified_by", "verification_notes", "duplicate_of",
].join(",");

const fallbackRecords: ApiRecord[] = [];
const fallbackById = new Map(fallbackRecords.map((record) => [record.id, record]));
const MAX_BATCH_SIZE = 500;
const MAX_BULK_BODY_BYTES = 1_000_000;
const MAX_METADATA_BULK_BODY_BYTES = 2_000_000;
const MAX_MUTATION_BODY_BYTES = 30_000;
const PAGE_SIZE = 1_000;
const COVERAGE_CACHE_CONTROL = "public, max-age=30, s-maxage=60, stale-while-revalidate=300";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SupabaseConfig = { url: string; key: string; opaqueSecret: boolean };
type DatabaseApiRow = Partial<ApiRecord> & { id?: string };
type SubmissionRecord = ReturnType<typeof submissionDatabaseRecord>;
type ValidatedSubmission = { sourceRow: number; record: SubmissionRecord };
type AuditInsert = Omit<AuditEvent, "id" | "action_at"> & { actor_user_id: string };
type DuplicateReport = {
  source_row: number;
  api_name: string;
  company_name: string;
  reason: string;
};
type InvalidReport = {
  source_row: number;
  api_name: string;
  company_name: string;
  error: string;
};

class ValidationError extends Error {}
class PayloadTooLargeError extends Error {}
class DatabaseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const newSecret = process.env.SUPABASE_SECRET_KEY?.trim();
  const legacyKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const key = newSecret || legacyKey;
  return url && key ? { url, key, opaqueSecret: key.startsWith("sb_secret_") } : null;
}

function supabaseHeaders(config: SupabaseConfig, write = false): Record<string, string> {
  const headers: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) headers.Authorization = `Bearer ${config.key}`;
  if (write) headers["Content-Type"] = "application/json";
  return headers;
}

function publicError(message: string, status: number, requestId: string) {
  return NextResponse.json(
    { error: message, requestId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function sanitizeString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
  required = false,
) {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new ValidationError(`${field} must be text.`);
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (required && !cleaned) throw new ValidationError(`${field} is required.`);
  if (cleaned.length > maxLength) {
    throw new ValidationError(`${field} must be ${maxLength} characters or fewer.`);
  }
  return cleaned;
}

function requireHttpUrl(value: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(`${label} must start with http:// or https://.`);
  }
}

function requireHttpEndpoint(value: string) {
  // Government-hosted, on-premise connectors sometimes document a template
  // (for example http://{VSDC-host}:{port}/path) rather than one deployable URL.
  if (!/^https?:\/\/[^\s<>"`]+$/i.test(value)) {
    throw new ValidationError("API endpoint must be an http(s) URL or endpoint template.");
  }
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new ValidationError("API id is invalid.");
}

function getClientKey(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

function isSameOrigin(request: Request) {
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

function normalizeKeyPart(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function recordKey(record: Pick<ApiRecord, "company_name" | "api_name">) {
  return `${normalizeKeyPart(record.company_name)}\u0000${normalizeKeyPart(record.api_name)}`;
}

function sourceRow(input: Record<string, unknown>, index: number) {
  const value = input.source_row;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : index + 2;
}

async function readJsonObject(request: Request, maximumBytes: number) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new PayloadTooLargeError("Request body is too large.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBytes) {
    throw new PayloadTooLargeError("Request body is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ValidationError("Invalid JSON request body.");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new ValidationError("A JSON object is required.");
  }
  return value as Record<string, unknown>;
}

function submissionDatabaseRecord(input: Record<string, unknown>) {
  const apiName = sanitizeString(input, "api_name", 180, true);
  const officialApiName = sanitizeString(input, "official_api_name", 240);
  const companyName = sanitizeString(input, "company_name", 180, true);
  const officialCompanyName = sanitizeString(input, "official_company_name", 240);
  const countryRegion = sanitizeString(input, "country_region", 120);
  const description = sanitizeString(input, "description", 2_000, true);
  const apiEndpoint = sanitizeString(input, "api_endpoint", 2_000, true);
  const documentationUrl = sanitizeString(input, "documentation_url", 2_000, true);
  const category = sanitizeString(input, "category", 40, true);
  const categoryOtherInput = sanitizeString(input, "category_other", 100);
  const communicationDirectionInput = sanitizeString(input, "communication_direction", 40);
  const authentication = sanitizeString(input, "authentication_method", 60, true);
  const authenticationOtherInput = sanitizeString(input, "authentication_other", 120);
  const authenticationDetails = sanitizeString(input, "authentication_details", 1_000);

  requireHttpEndpoint(apiEndpoint);
  requireHttpUrl(documentationUrl, "Official documentation");
  if (!API_CATEGORIES.includes(category as ApiCategory)) {
    throw new ValidationError("Category is not supported.");
  }
  if (!AUTHENTICATION_TYPES.includes(authentication as AuthenticationType)) {
    throw new ValidationError("Authentication type is not supported.");
  }
  if (category === "Other" && !categoryOtherInput) {
    throw new ValidationError("Please enter the other category.");
  }
  if (
    category === "Communication"
    && communicationDirectionInput
    && !COMMUNICATION_DIRECTIONS.includes(communicationDirectionInput as CommunicationDirection)
  ) {
    throw new ValidationError("Communication direction is not supported.");
  }
  if (category !== "Communication" && communicationDirectionInput) {
    throw new ValidationError("Communication direction only applies to Communication APIs.");
  }
  if (authentication === "Other" && !authenticationOtherInput) {
    throw new ValidationError("Please enter the other authentication type.");
  }

  return {
    api_name: apiName,
    official_api_name: officialApiName,
    company_name: companyName,
    official_company_name: officialCompanyName,
    country_region: countryRegion,
    description,
    api_endpoint: apiEndpoint,
    documentation_url: documentationUrl,
    category: category as ApiCategory,
    category_other: category === "Other" ? categoryOtherInput : "",
    communication_direction: category === "Communication"
      ? (communicationDirectionInput || "Unspecified") as CommunicationDirection
      : "",
    authentication_method: authentication as AuthenticationType,
    authentication_other: authentication === "Other" ? authenticationOtherInput : "",
    authentication_details: authenticationDetails,
    instructions: "",
    website_url: "",
    network: "",
    is_active: true,
    // Do not turn an omitted value into a technical claim. OpenAPI imports
    // provide these fields explicitly; older/manual uploads keep them empty
    // until someone verifies the provider documentation.
    input_formats: [] as string[],
    output_formats: [] as string[],
    business_rules: [] as string[],
    client_types: [] as string[],
    review_status: "Published" as ReviewStatus,
    source_url: documentationUrl,
    verified_at: null,
    verified_by: "",
    verification_notes: "",
  };
}

/** Missing metadata is preserved for older clients; explicit empty values clear it. */
function editableMetadata(input: Record<string, unknown>): Partial<ApiRecord> {
  const output: Partial<ApiRecord> = {};
  for (const key of ["input_formats", "output_formats", "invoice_standard", "client_types", "business_rules"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    const limit = key === "business_rules" ? 500 : 100;
    if (!Array.isArray(value) || value.length > 40 || value.some((item) => typeof item !== "string" || item.length > limit)) {
      throw new ValidationError(`${key} must contain at most 40 text values, each up to ${limit} characters.`);
    }
    output[key] = [...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))];
  }
  for (const [key, limit] of [["network", 200], ["website_url", 2_000], ["instructions", 4_000]] as const) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "string") throw new ValidationError(`${key} must be text.`);
    output[key] = sanitizeString(input, key, limit);
  }
  if (output.website_url) requireHttpUrl(output.website_url, "Provider website");
  if ("http_method" in input) {
    if (typeof input.http_method !== "string") throw new ValidationError("HTTP method must be text.");
    const method = input.http_method.trim().toUpperCase();
    if (method && !HTTP_METHODS.includes(method as typeof HTTP_METHODS[number])) throw new ValidationError("HTTP method is not supported.");
    output.http_method = method;
  }
  if ("access_scope" in input) {
    if (!["public", "restricted", "unknown"].includes(String(input.access_scope))) throw new ValidationError("Provider access is not supported.");
    output.access_scope = input.access_scope as ApiRecord["access_scope"];
  }
  return output;
}

function databaseRecord(record: ApiRecord) {
  return {
    id: record.id,
    api_name: record.api_name,
    official_api_name: record.official_api_name,
    description: record.description,
    api_endpoint: record.api_endpoint,
    instructions: record.instructions,
    company_name: record.company_name,
    official_company_name: record.official_company_name,
    country_region: record.country_region,
    website_url: record.website_url,
    documentation_url: record.documentation_url,
    category: record.category,
    category_other: record.category_other,
    communication_direction: record.communication_direction,
    authentication_method: record.authentication_method,
    authentication_other: record.authentication_other,
    authentication_details: record.authentication_details,
    network: record.network,
    is_active: record.is_active,
    input_formats: record.input_formats,
    output_formats: record.output_formats,
    business_rules: record.business_rules,
    client_types: record.client_types,
    review_status: "Published" as ReviewStatus,
    source_url: record.source_url,
    verified_at: null,
    verified_by: "",
    verification_notes: "",
  };
}

async function fetchAllRows<T>(
  config: SupabaseConfig,
  table: "apis" | "api_audit_events",
  select: string,
  order: string,
  requestId: string,
  quietFailure = false,
  filters: Record<string, string> = {},
) {
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      ...filters,
      select,
      order,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    const response = await fetch(`${config.url}/rest/v1/${table}?${query}`, {
      headers: supabaseHeaders(config),
      cache: "no-store",
    });
    if (!response.ok) {
      if (!quietFailure) {
        console.error("Supabase read failed", { table, status: response.status, requestId });
      }
      throw new DatabaseError("Database read failed.", response.status);
    }
    const page = (await response.json()) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    offset += page.length;
    if (offset > 100_000) throw new DatabaseError("Database result is too large.", 500);
  }
}

async function fetchCatalogueRows(config: SupabaseConfig, requestId: string, ownerId?: string) {
  const filters: Record<string, string> = ownerId ? { created_by_user: `eq.${ownerId}` } : {};
  try {
    return await fetchAllRows<DatabaseApiRow>(
      config,
      "apis",
      SELECT_FIELDS,
      "id.asc",
      requestId,
      true,
      filters,
    );
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.status !== 400) throw error;
    // Keep public browsing available during the rollout of 0010/0012. Missing
    // values are normalized to safe display fallbacks; writes still require the
    // current schema and therefore cannot silently lose new metadata.
    return fetchAllRows<DatabaseApiRow>(
      config,
      "apis",
      LEGACY_SELECT_FIELDS,
      "id.asc",
      requestId,
      false,
      filters,
    );
  }
}

function normalizeAuditEvents(rows: Array<Partial<AuditEvent>>) {
  const actions: AuditAction[] = ["upload", "edit", "verify", "status_change", "delete", "restore"];
  return rows.flatMap((row): AuditEvent[] => {
    if (
      typeof row.id !== "string" || typeof row.api_id !== "string" ||
      typeof row.api_name !== "string" || typeof row.company_name !== "string" ||
      typeof row.action !== "string" || !actions.includes(row.action as AuditAction) ||
      typeof row.actor_name !== "string" || typeof row.details !== "string" ||
      typeof row.action_at !== "string"
    ) return [];
    const event = row as AuditEvent;
    return [{ ...event, details: auditDetailsForDisplay(event) }];
  });
}

function mergeWithFallback(databaseRecords: ApiRecord[]) {
  // Inactive DB rows deliberately shadow bundled rows during a migration
  // rollout, so a bundled row cannot reappear before its database row is restored.
  const databaseIds = new Set(databaseRecords.map((record) => record.id));
  const databaseKeys = new Set(databaseRecords.map(recordKey));
  const activeByKey = new Map<string, ApiRecord>();
  for (const record of databaseRecords) {
    if (record.is_active) activeByKey.set(recordKey(record), record);
  }
  for (const record of fallbackRecords) {
    if (!databaseIds.has(record.id) && !databaseKeys.has(recordKey(record))) {
      activeByKey.set(recordKey(record), record);
    }
  }
  return [...activeByKey.values()];
}

async function insertApiRows(config: SupabaseConfig, records: unknown[], requestId: string) {
  if (records.length === 0) return [] as DatabaseApiRow[];
  const query = new URLSearchParams({ select: SELECT_FIELDS });
  const response = await fetch(`${config.url}/rest/v1/apis?${query}`, {
    method: "POST",
    headers: { ...supabaseHeaders(config, true), Prefer: "return=representation" },
    body: JSON.stringify(records),
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 409) throw new DatabaseError("Duplicate API record.", 409);
    console.error("Supabase API insert failed", { status: response.status, requestId });
    throw new DatabaseError("API insert failed.", response.status);
  }
  return (await response.json()) as DatabaseApiRow[];
}

async function updateApiRows(
  config: SupabaseConfig,
  ids: string[],
  update: Record<string, unknown>,
  requestId: string,
  ownerId?: string,
) {
  if (ids.length === 0) return [] as DatabaseApiRow[];
  const query = new URLSearchParams({ id: `in.(${ids.join(",")})`, select: SELECT_FIELDS });
  query.set("is_active", "eq.true");
  if (ownerId) query.set("created_by_user", `eq.${ownerId}`);
  const response = await fetch(`${config.url}/rest/v1/apis?${query}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(config, true), Prefer: "return=representation" },
    body: JSON.stringify(update),
    cache: "no-store",
  });
  if (!response.ok) {
    console.error("Supabase API update failed", { status: response.status, requestId });
    throw new DatabaseError("API update failed.", response.status);
  }
  return (await response.json()) as DatabaseApiRow[];
}

async function commitMetadataBulkUpdate(
  config: SupabaseConfig,
  updates: ReturnType<typeof buildMetadataBulkPlan>["entries"],
  actorUserId: string,
  actorName: string,
  requestId: string,
) {
  const response = await fetch(`${config.url}/rest/v1/rpc/admin_bulk_update_api_metadata`, {
    method: "POST",
    headers: { ...supabaseHeaders(config, true), Prefer: "return=representation" },
    body: JSON.stringify({
      p_updates: updates.map(({ id, expected_updated_at, changes, fields, evidence, evidence_urls, source_rows }) => ({
        id,
        expected_updated_at,
        changes,
        fields,
        evidence,
        evidence_urls,
        source_rows,
      })),
      p_actor_user_id: actorUserId,
      p_actor_name: actorName,
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    const databaseMessage = await response.text().catch(() => "");
    console.error("Supabase metadata bulk update failed", {
      status: response.status,
      requestId,
      databaseMessage: databaseMessage.slice(0, 500),
    });
    if (response.status === 409 || /changed since preview|stale/i.test(databaseMessage)) {
      throw new DatabaseError("The catalogue changed after preview. Preview the spreadsheet again before applying it.", 409);
    }
    throw new DatabaseError("The metadata bulk update could not be applied.", response.status);
  }
  return (await response.json()) as Array<{
    api_id: string;
    updated_at: string;
    review_status: ReviewStatus;
  }>;
}

async function appendAuditEvents(
  config: SupabaseConfig,
  events: AuditInsert[],
  requestId: string,
) {
  if (events.length === 0) return true;
  // Stable client-generated IDs make one retry safe even if the first response
  // was lost after Supabase committed the transaction.
  const rows = events.map((event) => ({ id: crypto.randomUUID(), ...event }));
  let firstAttemptWasAmbiguous = false;
  let lastStatus: number | "network" = "network";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${config.url}/rest/v1/api_audit_events`, {
        method: "POST",
        headers: { ...supabaseHeaders(config, true), Prefer: "return=minimal" },
        body: JSON.stringify(rows),
        cache: "no-store",
      });
      if (response.ok) return true;
      lastStatus = response.status;
      if (attempt === 1 && response.status === 409 && firstAttemptWasAmbiguous) return true;
      firstAttemptWasAmbiguous = response.status >= 500;
    } catch {
      lastStatus = "network";
      firstAttemptWasAmbiguous = true;
    }
  }
  console.error("Supabase audit insert failed", { status: lastStatus, requestId });
  return false;
}

async function resolveMutationTargets(
  config: SupabaseConfig,
  ids: string[],
  requestId: string,
) {
  let rawRows = await fetchAllRows<DatabaseApiRow>(config, "apis", SELECT_FIELDS, "id.asc", requestId);
  let records = rawRows.map(normalizeApiRecord);
  let byId = new Map(records.map((record) => [record.id, record]));
  let byKey = new Map(records.map((record) => [recordKey(record), record]));
  const promotions = new Map<string, ApiRecord>();

  for (const id of ids) {
    if (byId.has(id)) continue;
    const seed = fallbackById.get(id);
    if (!seed) continue;
    const existingByKey = byKey.get(recordKey(seed));
    if (existingByKey) byId.set(id, existingByKey);
    else promotions.set(seed.id, seed);
  }

  if (promotions.size > 0) {
    try {
      await insertApiRows(config, [...promotions.values()].map(databaseRecord), requestId);
    } catch (error) {
      // Another request may have promoted the same seed. Reload on a unique-key race.
      if (!(error instanceof DatabaseError) || error.status !== 409) throw error;
    }
    rawRows = await fetchAllRows<DatabaseApiRow>(config, "apis", SELECT_FIELDS, "id.asc", requestId);
    records = rawRows.map(normalizeApiRecord);
    byId = new Map(records.map((record) => [record.id, record]));
    byKey = new Map(records.map((record) => [recordKey(record), record]));
  }

  const targets = new Map<string, ApiRecord>();
  const notFound: string[] = [];
  for (const id of ids) {
    const seed = fallbackById.get(id);
    const target = byId.get(id) || (seed ? byKey.get(recordKey(seed)) : undefined);
    if (target) targets.set(target.id, target);
    else notFound.push(id);
  }
  return { targets: [...targets.values()], notFound };
}

async function mutationGuard(request: Request, action: Exclude<MutationAction, "import">, requestId: string) {
  if (!isSameOrigin(request)) {
    return { response: publicError("Updates must come from this website.", 403, requestId) };
  }
  const roles = action === "upload" ? SUBMITTER_ROLES : action === "verification" ? ADMIN_ROLES : APP_ROLES;
  const access = await requireRole(request, roles, requestId);
  if ("response" in access) return access;
  const retryAfterSeconds = checkMutationRateLimit(action, access.user, getClientKey(request));
  if (retryAfterSeconds > 0) {
    const response = publicError(
      `Too many updates. Please try again in ${retryAfterSeconds} seconds.`,
      429,
      requestId,
    );
    response.headers.set("Retry-After", String(retryAfterSeconds));
    return { response };
  }
  return access;
}

function requireConfig(requestId: string) {
  const config = getSupabaseConfig();
  if (!config) {
    return {
      config: null,
      response: publicError(
        "Changes are not connected yet. Add the Supabase server environment variables.",
        503,
        requestId,
      ),
    };
  }
  return { config, response: null };
}

function auditWarning(recorded: boolean) {
  return recorded ? undefined : "The change was saved, but its audit event could not be recorded.";
}

function recordForClient(record: ApiRecord): ApiRecord {
  return {
    ...record,
    verification_notes: publicReviewNote(record.verification_notes) ?? "",
    audit_trail: record.audit_trail.map((event) => ({
      ...event,
      details: auditDetailsForDisplay(event),
    })),
  };
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const query = new URL(request.url).searchParams;
  const personal = query.get("scope") === "mine";
  const coverageOnly = !personal && query.get("view") === "coverage";
  const access = personal ? await requireRole(request, APP_ROLES, requestId) : null;
  if (access?.response) return access.response;
  const config = getSupabaseConfig();
  if (!config) {
    if (personal) return publicError("The submissions database is temporarily unavailable.", 503, requestId);
    const publicRecords = visibleCatalogueRecords(fallbackRecords);
    return NextResponse.json(
      coverageOnly
        ? summarizeCoverage(publicRecords)
        : { apis: publicRecords, mode: "dataset" },
      { headers: { "Cache-Control": coverageOnly ? COVERAGE_CACHE_CONTROL : "no-store" } },
    );
  }
  try {
    if (coverageOnly) {
      // The homepage map uses a compact, publicly cached projection. It must
      // include both pending and verified public records, regardless of login.
      let coverageRows: DatabaseApiRow[];
      try {
        coverageRows = await fetchAllRows<DatabaseApiRow>(
          config,
          "apis",
          COVERAGE_SELECT_FIELDS,
          "id.asc",
          requestId,
          true,
        );
      } catch (error) {
        if (!(error instanceof DatabaseError) || error.status !== 400) throw error;
        // A pre-0010 database has no explicit location column yet. Keep the
        // public map usable with the same conservative, display-only inference
        // used by the catalogue until that migration is applied.
        coverageRows = await fetchAllRows<DatabaseApiRow>(
          config,
          "apis",
          LEGACY_COVERAGE_SELECT_FIELDS,
          "id.asc",
          requestId,
        );
      }
      const records = visibleCatalogueRecords(
        mergeWithFallback(coverageRows.map(normalizeApiRecord)),
      );
      return NextResponse.json(
        summarizeCoverage(records),
        { headers: { "Cache-Control": COVERAGE_CACHE_CONTROL } },
      );
    }

    // All active catalogue records are public, including pending reviews.
    // Owners see their submission history; admins see all history.
    // Resolve the optional session alongside the catalogue read so public
    // browsing does not pay an additional sequential network round trip.
    const [signedInUser, apiRows] = await Promise.all([
      access?.user ?? getCurrentAppUser(request).catch(() => null),
      fetchCatalogueRows(config, requestId, access?.user.id),
    ]);
    const includeAdministration = !personal && signedInUser?.role === "admin";
    const ownedIds = apiRows.filter((row) => ownsApi(signedInUser?.id, row)).map((row) => row.id as string);
    const auditRows: Partial<AuditEvent>[] = includeAdministration
      ? await fetchAllRows<Partial<AuditEvent>>(
          config, "api_audit_events", AUDIT_FIELDS, "action_at.desc", requestId,
        )
      : [];
    if (!includeAdministration) {
      for (let index = 0; index < ownedIds.length; index += 100) {
        auditRows.push(...await fetchAllRows<Partial<AuditEvent>>(
          config, "api_audit_events", AUDIT_FIELDS, "action_at.desc", requestId, false,
          { api_id: `in.(${ownedIds.slice(index, index + 100).join(",")})` },
        ));
      }
    }
    const auditByApi = new Map<string, AuditEvent[]>();
    for (const event of normalizeAuditEvents(auditRows)) {
      const existing = auditByApi.get(event.api_id) ?? [];
      existing.push(event);
      auditByApi.set(event.api_id, existing);
    }
    const databaseRecords = apiRows.map((row) => {
      const normalized = normalizeApiRecord(row);
      normalized.audit_trail = auditByApi.get(normalized.id) ?? [];
      return normalized;
    });
    // Personal rows are already filtered by owner in the database query.
    const catalogue = personal ? databaseRecords : mergeWithFallback(databaseRecords);
    const merged = visibleCatalogueRecords(catalogue).map((record) => recordForClient({
        ...record,
        created_by_user: includeAdministration || ownsApi(signedInUser?.id, record) ? record.created_by_user : null,
        audit_trail: auditByApi.get(record.id) ?? record.audit_trail,
      }));

    return NextResponse.json(
      { apis: merged, mode: "supabase" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Supabase catalog request failed", {
      message: error instanceof Error ? error.message : "Unknown fetch error",
      requestId,
    });
    // Falling back here could expose bundled records that the database still
    // considers inactive while the restoration migration is rolling out.
    return publicError("The database is temporarily unavailable. Please try again.", 502, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const access = await mutationGuard(request, "upload", requestId);
  if ("response" in access) return access.response;
  try {
    const input = await readJsonObject(request, MAX_BULK_BODY_BYTES);
    const honeypot = sanitizeString(input, "website_confirm", 200);
    if (honeypot) return publicError("Submission could not be accepted.", 400, requestId);
    const actorName = access.user.displayName;
    if (!Array.isArray(input.apis)) throw new ValidationError("apis must be an array.");
    if (input.apis.length === 0) throw new ValidationError("At least one API is required.");
    if (input.apis.length > MAX_BATCH_SIZE) {
      throw new ValidationError(`A maximum of ${MAX_BATCH_SIZE} APIs can be uploaded at once.`);
    }

    const invalid: InvalidReport[] = [];
    const valid: ValidatedSubmission[] = [];
    input.apis.forEach((item, index) => {
      const object = item && !Array.isArray(item) && typeof item === "object"
        ? (item as Record<string, unknown>) : null;
      const rowNumber = object ? sourceRow(object, index) : index + 2;
      const apiName = object && typeof object.api_name === "string" ? object.api_name.trim() : "";
      const companyName = object && typeof object.company_name === "string"
        ? object.company_name.trim() : "";
      if (!object) {
        invalid.push({ source_row: rowNumber, api_name: apiName, company_name: companyName, error: "Row must be an object." });
        return;
      }
      try {
        const record = submissionDatabaseRecord(object);
        Object.assign(record, editableMetadata(object));
        valid.push({ sourceRow: rowNumber, record });
      } catch (error) {
        invalid.push({
          source_row: rowNumber,
          api_name: apiName,
          company_name: companyName,
          error: error instanceof ValidationError ? error.message : "Row is invalid.",
        });
      }
    });

    const { config, response } = requireConfig(requestId);
    if (!config) return response;
    const databaseRows = await fetchAllRows<DatabaseApiRow>(
      config, "apis", "id,api_name,company_name,is_active", "id.asc", requestId,
    );
    const databaseIds = new Set(
      databaseRows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])),
    );
    const databaseKeys = new Set<string>();
    for (const row of databaseRows) {
      if (typeof row.api_name === "string" && typeof row.company_name === "string") {
        databaseKeys.add(recordKey({ api_name: row.api_name, company_name: row.company_name }));
      }
    }
    const existingKeys = new Set(databaseKeys);
    for (const fallback of fallbackRecords) {
      const key = recordKey(fallback);
      if (!databaseIds.has(fallback.id) && !databaseKeys.has(key)) existingKeys.add(key);
    }

    const seenInUpload = new Set<string>();
    const duplicates: DuplicateReport[] = [];
    let uploadable = valid.filter(({ sourceRow: rowNumber, record }) => {
      const key = recordKey(record);
      if (seenInUpload.has(key)) {
        duplicates.push({
          source_row: rowNumber, api_name: record.api_name, company_name: record.company_name,
          reason: "Duplicate within this Excel upload.",
        });
        return false;
      }
      seenInUpload.add(key);
      if (existingKeys.has(key)) {
        duplicates.push({
          source_row: rowNumber, api_name: record.api_name, company_name: record.company_name,
          reason: "Already exists in the repository.",
        });
        return false;
      }
      return true;
    });

    let savedRows: DatabaseApiRow[] = [];
    if (uploadable.length > 0) {
      try {
        savedRows = await insertApiRows(
          config,
          uploadable.map(({ record }) => ({ ...record, created_by_user: access.user.id })),
          requestId,
        );
      } catch (error) {
        if (!(error instanceof DatabaseError) || error.status !== 409) throw error;
        // Resolve an insert race by filtering only the rows that now exist.
        const latestRows = await fetchAllRows<DatabaseApiRow>(
          config, "apis", "id,api_name,company_name,is_active", "id.asc", requestId,
        );
        const latestKeys = new Set(latestRows.flatMap((row) =>
          typeof row.api_name === "string" && typeof row.company_name === "string"
            ? [recordKey({ api_name: row.api_name, company_name: row.company_name })] : [],
        ));
        uploadable = uploadable.filter(({ sourceRow: rowNumber, record }) => {
          if (!latestKeys.has(recordKey(record))) return true;
          duplicates.push({
            source_row: rowNumber, api_name: record.api_name, company_name: record.company_name,
            reason: "Already exists in the repository.",
          });
          return false;
        });
        if (uploadable.length > 0) {
          // A second race should still filter only the conflicting row, not
          // reject the rest of the batch. This slower path is used only after
          // the normal bulk insert has encountered a unique-key conflict.
          const successfullyInserted: DatabaseApiRow[] = [];
          const stillUploadable: ValidatedSubmission[] = [];
          for (const candidate of uploadable) {
            try {
              successfullyInserted.push(...(await insertApiRows(
                config,
                [{ ...candidate.record, created_by_user: access.user.id }],
                requestId,
              )));
              stillUploadable.push(candidate);
            } catch (individualError) {
              if (!(individualError instanceof DatabaseError) || individualError.status !== 409) {
                throw individualError;
              }
              duplicates.push({
                source_row: candidate.sourceRow,
                api_name: candidate.record.api_name,
                company_name: candidate.record.company_name,
                reason: "Already exists in the repository.",
              });
            }
          }
          uploadable = stillUploadable;
          savedRows = successfullyInserted;
        }
      }
    }

    const saved = savedRows.map(normalizeApiRecord);
    const auditRecorded = await appendAuditEvents(
      config,
      saved.map((record) => ({
        api_id: record.id,
        api_name: record.api_name,
        company_name: record.company_name,
        action: "upload" as AuditAction,
        actor_name: actorName,
        actor_user_id: access.user.id,
        details: "Uploaded through Excel bulk import.",
      })),
      requestId,
    );
    return NextResponse.json(
      {
        apis: saved.map(recordForClient),
        uploaded_count: saved.length,
        duplicate_count: duplicates.length,
        invalid_count: invalid.length,
        duplicates,
        invalid,
        warning: auditWarning(auditRecorded),
      },
      { status: saved.length > 0 ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return publicError(error.message, 413, requestId);
    if (error instanceof ValidationError) return publicError(error.message, 400, requestId);
    console.error("Unexpected API bulk upload error", {
      message: error instanceof Error ? error.message : "Unknown error", requestId,
    });
    return publicError("The APIs could not be saved. Please try again.", 502, requestId);
  }
}

export async function PUT(request: Request) {
  const requestId = crypto.randomUUID();
  const access = await mutationGuard(request, "edit", requestId);
  if ("response" in access) return access.response;
  try {
    const input = await readJsonObject(request, MAX_MUTATION_BODY_BYTES);
    const id = sanitizeString(input, "id", 36, true);
    requireUuid(id);
    const actorName = access.user.displayName;
    const submissionInput = input.api && !Array.isArray(input.api) && typeof input.api === "object"
      ? (input.api as Record<string, unknown>) : input;
    const edited = submissionDatabaseRecord(submissionInput);
    const metadata = editableMetadata(submissionInput);
    const { config, response } = requireConfig(requestId);
    if (!config) return response;
    const { targets } = await resolveMutationTargets(config, [id], requestId);
    const target = targets[0];
    if (!target || !target.is_active) return publicError("API record was not found.", 404, requestId);

    if (!canManageApi(access.user, target)) {
      return publicError("You can only edit APIs you submitted.", 403, requestId);
    }

    const newKey = recordKey(edited);
    const oldKey = recordKey(target);
    if (newKey !== oldKey) {
      const allRows = await fetchAllRows<DatabaseApiRow>(
        config, "apis", "id,api_name,company_name,is_active", "id.asc", requestId,
      );
      const allDatabaseIds = new Set(
        allRows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])),
      );
      const allDatabaseKeys = new Set(
        allRows.flatMap((row) =>
          typeof row.api_name === "string" && typeof row.company_name === "string"
            ? [recordKey({ api_name: row.api_name, company_name: row.company_name })]
            : [],
        ),
      );
      const duplicateInDatabase = allRows.some((row) =>
        row.id !== target.id && typeof row.api_name === "string" &&
        typeof row.company_name === "string" &&
        recordKey({ api_name: row.api_name, company_name: row.company_name }) === newKey,
      );
      const duplicateSeed = fallbackRecords.some((record) => {
        const key = recordKey(record);
        const shadowed = allDatabaseIds.has(record.id) || allDatabaseKeys.has(key);
        return !shadowed && record.id !== id && record.id !== target.id && key === newKey;
      });
      if (duplicateInDatabase || duplicateSeed) {
        return publicError("This company and API name are already in the repository.", 409, requestId);
      }
    }

    const editableUpdate = {
      ...metadata,
      ...("http_method" in metadata ? { http_method: metadata.http_method || null } : {}),
      api_name: edited.api_name,
      official_api_name: edited.official_api_name,
      company_name: edited.company_name,
      official_company_name: edited.official_company_name,
      country_region: edited.country_region,
      description: edited.description,
      api_endpoint: edited.api_endpoint,
      documentation_url: edited.documentation_url,
      category: edited.category,
      category_other: edited.category_other,
      communication_direction: edited.communication_direction,
      authentication_method: edited.authentication_method,
      authentication_other: edited.authentication_other,
      authentication_details: edited.authentication_details,
      source_url: edited.documentation_url,
      ...(metadata.invoice_standard && JSON.stringify(metadata.invoice_standard) !== JSON.stringify(target.invoice_standard)
        ? { invoice_standard_source: null } : {}),
    };
    const updatedRows = await updateApiRows(
      config,
      [target.id],
      {
        ...editableUpdate,
        review_status: "Published",
        verified_at: null,
        verified_by: "",
        verified_by_user: null,
        verification_notes: "",
      },
      requestId,
      access.user.role === "admin" ? undefined : access.user.id,
    );
    const saved = updatedRows[0] ? normalizeApiRecord(updatedRows[0]) : null;
    if (!saved) return publicError("The API was updated but could not be returned.", 502, requestId);
    const auditRecorded = await appendAuditEvents(
      config,
      [{
        api_id: saved.id,
        api_name: saved.api_name,
        company_name: saved.company_name,
        action: "edit",
        actor_name: actorName,
        actor_user_id: access.user.id,
        details: target.review_status === "Verified"
          ? "Edited API details; returned to awaiting verification."
          : "Edited API details.",
      }],
      requestId,
    );
    return NextResponse.json(
      { api: recordForClient(saved), warning: auditWarning(auditRecorded) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return publicError(error.message, 413, requestId);
    if (error instanceof ValidationError) return publicError(error.message, 400, requestId);
    if (error instanceof DatabaseError && error.status === 409) {
      return publicError("This company and API name are already in the repository.", 409, requestId);
    }
    console.error("Unexpected API edit error", {
      message: error instanceof Error ? error.message : "Unknown error", requestId,
    });
    return publicError("The API could not be updated. Please try again.", 502, requestId);
  }
}

export async function PATCH(request: Request) {
  const requestId = crypto.randomUUID();
  const access = await mutationGuard(request, "verification", requestId);
  if ("response" in access) return access.response;
  try {
    const input = await readJsonObject(request, MAX_METADATA_BULK_BODY_BYTES);
    const bulkAction = input.action === "preview_metadata_bulk" || input.action === "commit_metadata_bulk"
      ? input.action
      : null;
    if (bulkAction) {
      const normalized = normalizeMetadataSpreadsheetRows(input.rows);
      const { config, response } = requireConfig(requestId);
      if (!config) return response;
      const ids = [...new Set(normalized.rows.map((row) => row.apiId))];
      const { targets } = await resolveMutationTargets(config, ids, requestId);
      const plan = buildMetadataBulkPlan(normalized, targets);
      const summary = {
        row_count: plan.rows.length,
        api_count: plan.entries.length,
        changed_row_count: plan.changedRows,
        unchanged_row_count: plan.unchangedRows,
        field_counts: plan.fieldCounts,
      };
      if (!plan.ready) {
        return NextResponse.json(
          {
            error: "The spreadsheet is not ready to apply. Fix the listed rows and preview it again.",
            ready: false,
            ...summary,
            invalid_count: plan.invalid.length,
            invalid: plan.invalid.slice(0, 200),
          },
          { status: 422, headers: { "Cache-Control": "no-store" } },
        );
      }

      const planToken = metadataBulkPlanToken(plan.entries);
      if (bulkAction === "preview_metadata_bulk") {
        return NextResponse.json(
          {
            ready: true,
            plan_token: planToken,
            ...summary,
            sample: plan.entries.slice(0, 20).map((entry) => ({
              id: entry.id,
              api_name: entry.api_name,
              company_name: entry.company_name,
              fields: entry.fields,
              changes: entry.changes,
            })),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      const submittedToken = sanitizeString(input, "plan_token", 64, true);
      if (submittedToken !== planToken) {
        return publicError(
          "The catalogue or spreadsheet changed after preview. Preview it again before applying the update.",
          409,
          requestId,
        );
      }
      const updated = await commitMetadataBulkUpdate(
        config,
        plan.entries,
        access.user.id,
        access.user.displayName,
        requestId,
      );
      return NextResponse.json(
        {
          applied: true,
          ...summary,
          updated_count: updated.length,
          updated_ids: updated.map((row) => row.api_id),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const id = sanitizeString(input, "id", 36, true);
    requireUuid(id);
    const actorName = access.user.displayName;
    const reviewStatus = sanitizeString(input, "review_status", 20, true);
    if (reviewStatus !== "Published" && reviewStatus !== "Verified") {
      throw new ValidationError("Verification status is not supported.");
    }
    const verificationNotesInput = sanitizeString(input, "verification_notes", 1_000);
    const requestingChanges = input.request_changes === true;
    if (requestingChanges && (reviewStatus !== "Published" || !verificationNotesInput)) {
      throw new ValidationError("Requesting changes requires awaiting-verification status and a note explaining what to change.");
    }
    const verifiedBy = reviewStatus === "Verified" ? actorName : "";
    if (reviewStatus === "Verified" && !verificationNotesInput) {
      throw new ValidationError("A verification note is required for Verified status.");
    }

    const { config, response } = requireConfig(requestId);
    if (!config) return response;
    const { targets } = await resolveMutationTargets(config, [id], requestId);
    const target = targets[0];
    if (!target || !target.is_active) return publicError("API record was not found.", 404, requestId);
    const update = reviewStatus === "Verified"
      ? {
          review_status: "Verified" as ReviewStatus,
          verified_by: verifiedBy,
          verified_by_user: access.user.id,
          verification_notes: verificationNotesInput,
          verified_at: new Date().toISOString(),
        }
      : {
          review_status: "Published" as ReviewStatus,
          verified_by: "",
          verified_by_user: null,
          verification_notes: verificationNotesInput,
          verified_at: null,
        };
    const updatedRows = await updateApiRows(config, [target.id], update, requestId);
    const saved = updatedRows[0] ? normalizeApiRecord(updatedRows[0]) : null;
    if (!saved) return publicError("Verification was saved but could not be returned.", 502, requestId);

    const auditAction: AuditAction = reviewStatus === "Verified" ? "verify" : "status_change";
    const details = reviewStatus === "Verified"
      ? "API verification completed."
      : "Verification status updated.";
    const auditRecorded = await appendAuditEvents(
      config,
      [{
        api_id: saved.id,
        api_name: saved.api_name,
        company_name: saved.company_name,
        action: auditAction,
        actor_name: actorName,
        actor_user_id: access.user.id,
        details,
      }],
      requestId,
    );
    // Read the persisted queue after the write, independently of the client's filters
    // or cached catalogue. Include all pages and apply the catalogue visibility rule.
    let awaitingVerificationCount: number | null = null;
    try {
      const queueRows = await fetchAllRows<Pick<ApiRecord, "id" | "is_active" | "duplicate_of" | "review_status">>(
        config, "apis", "id,is_active,duplicate_of,review_status", "id.asc", requestId, true,
        { review_status: "eq.Published", is_active: "eq.true", duplicate_of: "is.null" },
      );
      awaitingVerificationCount = visibleCatalogueRecords(queueRows).filter((record) => record.review_status === "Published").length;
    } catch {
      // The mutation already succeeded. A failed count must not invite a duplicate save or imply zero remaining.
      console.error("Verification queue count failed", { requestId });
    }
    return NextResponse.json(
      { api: recordForClient(saved), warning: auditWarning(auditRecorded), awaitingVerificationCount },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return publicError(error.message, 413, requestId);
    if (error instanceof ValidationError) return publicError(error.message, 400, requestId);
    if (error instanceof DatabaseError && error.status === 409) {
      return publicError(error.message, 409, requestId);
    }
    console.error("Unexpected verification update error", {
      message: error instanceof Error ? error.message : "Unknown error", requestId,
    });
    return publicError("Verification could not be saved. Please try again.", 502, requestId);
  }
}

export async function DELETE(request: Request) {
  const requestId = crypto.randomUUID();
  void request;
  const response = publicError("API deletion is currently disabled.", 405, requestId);
  response.headers.set("Allow", "GET, POST, PUT, PATCH");
  return response;
}
