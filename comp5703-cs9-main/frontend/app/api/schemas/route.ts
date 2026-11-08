// Reading and uploading API schemas (migration 0016).
//
// Both tables are closed to the public roles by row level security, as
// import_session is: the front end reaches data through the application's
// own routes, never the database. So without this route nothing outside the
// server can read a schema -- field matching and the comparison screen
// included.
//
//   GET  /api/schemas?api_id=<uuid>[&api_id=<uuid>...]   schemas and fields
//   POST /api/schemas                                     a person's upload

import { NextResponse } from "next/server";
import { SUBMITTER_ROLES, getCurrentAppUser, requireRole } from "@/lib/auth";
import { canManageApi, hasAllowedRole } from "@/lib/auth-policy";
import { checkMutationRateLimit } from "@/lib/mutation-rate-limit";
import { schemaIdentity } from "@/lib/schema/rows";
import { writeSchemaSet } from "@/lib/schema/store";
import { MAX_UPLOAD_CHARS, resolveUpload, type UploadInput } from "@/lib/schema/upload";

export const dynamic = "force-dynamic";

/** Enough for a comparison of several operations; small enough to answer quickly. */
const MAX_APIS_PER_READ = 10;
/** PostgREST's page size on Supabase. Reads page through it rather than trusting one response. */
const PAGE_SIZE = 1000;
const MAX_BODY_CHARS = MAX_UPLOAD_CHARS + 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function publicError(message: string, status: number, requestId: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, requestId, ...extra }, {
    status, headers: { "Cache-Control": "no-store" },
  });
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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) throw new Error("payload too large");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("body must be an object");
  }
  return parsed as Record<string, unknown>;
}

async function select<T>(config: SupabaseConfig, table: string, query: URLSearchParams): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const q = new URLSearchParams(query);
    q.set("limit", String(PAGE_SIZE));
    q.set("offset", String(offset));
    const res = await fetch(`${config.url}/rest/v1/${table}?${q}`, { headers: headers(config) });
    if (!res.ok) throw new Error(`${table} read failed ${res.status}`);
    const page = (await res.json()) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

type ApiRow = {
  id: string; api_name: string; company_name: string;
  is_active: boolean; duplicate_of: string | null; created_by_user: string | null;
  http_method?: string | null;
  documentation_url?: string | null;
};
type SchemaRow = {
  id: string; api_id: string; direction: string; media_type: string; status_code: string | null;
  origin: string; source_url: string; created_by: string; created_at: string;
  warnings: string[]; raw: unknown;
};
type FieldRow = { schema_id: string } & Record<string, unknown>;
type ParameterRow = { api_id: string } & Record<string, unknown>;

// -- GET: read ---------------------------------------------------------------

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const ids = [...new Set(new URL(request.url).searchParams.getAll("api_id").map((s) => s.trim()))];
  if (ids.length === 0) return publicError("Name at least one api_id.", 400, requestId);
  if (ids.length > MAX_APIS_PER_READ) {
    return publicError(`At most ${MAX_APIS_PER_READ} APIs can be read at once.`, 400, requestId);
  }
  if (ids.some((id) => !UUID.test(id))) return publicError("api_id must be a UUID.", 400, requestId);

  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);

  try {
    const inList = `in.(${ids.join(",")})`;
    // Every active, non-duplicate record is public (0014), so its schemas are
    // too. An inactive or duplicate record is answered as missing, the way
    // the catalogue itself treats it.
    const [apis, viewer] = await Promise.all([
      select<ApiRow>(config, "apis", new URLSearchParams({
        select: "id,api_name,company_name,is_active,duplicate_of,created_by_user,http_method,documentation_url", id: inList,
      })),
      getCurrentAppUser().catch(() => null),
    ]);
    const visible = new Set(apis.filter((a) => a.is_active && !a.duplicate_of).map((a) => a.id));

    const schemas = visible.size === 0 ? [] : await select<SchemaRow>(config, "api_schema", new URLSearchParams({
      select: "id,api_id,direction,media_type,status_code,origin,source_url,created_by,created_at,warnings,raw",
      api_id: `in.(${[...visible].join(",")})`,
      order: "api_id.asc,direction.asc,status_code.asc,media_type.asc",
    }));
    const fields = schemas.length === 0 ? [] : await select<FieldRow>(config, "api_schema_field", new URLSearchParams({
      select: "schema_id,path,leaf_name,leaf_name_norm,json_type,format,is_required,is_array_item,depth,enum_values,description",
      schema_id: `in.(${schemas.map((s) => s.id).join(",")})`,
      order: "schema_id.asc,path.asc",
    }));

    // Migration 0017: an operation whose whole input is path/query parameters
    // has no api_schema row at all, so this is a separate read rather than a
    // join -- a record can have parameters and no schemas, or both.
    const parameters = visible.size === 0 ? [] : await select<ParameterRow>(config, "api_parameter", new URLSearchParams({
      select: "api_id,name,location,is_required,schema,json_type,format,enum_values,name_norm,description,origin,source_url,created_at",
      api_id: `in.(${[...visible].join(",")})`,
      order: "api_id.asc,location.asc,name.asc",
    }));

    const fieldsBySchema = new Map<string, Record<string, unknown>[]>();
    for (const { schema_id, ...field } of fields) {
      fieldsBySchema.set(schema_id, [...(fieldsBySchema.get(schema_id) ?? []), field]);
    }
    return NextResponse.json({
      apis: ids.filter((id) => visible.has(id)).map((id) => {
        const api = apis.find((a) => a.id === id)!;
        const canWriteSchemas = Boolean(viewer && hasAllowedRole(viewer.role, SUBMITTER_ROLES) && canManageApi(viewer, api));
        return {
        api_id: id,
        api_name: api.api_name,
        company_name: api.company_name,
        // Whether this viewer may upload, not who submitted the record: the
        // catalogue shows the owner only to the owner and administrators, and
        // this answer must not become a way round that.
        can_upload: canWriteSchemas,
        // Legacy records can recover schemas when their endpoint uniquely
        // identifies an operation in the linked document.
        can_fetch: canWriteSchemas && Boolean(api.documentation_url),
        schemas: schemas.filter((s) => s.api_id === id).map(({ api_id: _api, ...s }) => ({
          ...s, fields: fieldsBySchema.get(s.id) ?? [],
        })),
        // The other half of an operation's input. Empty is the honest answer
        // for an operation that declares none, and for every record stored
        // before 0017 until its documentation is read again.
        parameters: parameters.filter((p) => p.api_id === id).map(({ api_id: _api, ...p }) => p),
        };
      }),
      missing: ids.filter((id) => !visible.has(id)),
      requestId,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return publicError("Schemas could not be read.", 502, requestId);
  }
}

// -- POST: upload ------------------------------------------------------------

function uploadInput(body: Record<string, unknown>): UploadInput | null {
  const text = typeof body.text === "string" ? body.text : "";
  if (body.kind === "openapi") {
    const op = body.operation;
    const operation = op && typeof op === "object"
      && typeof (op as Record<string, unknown>).path === "string"
      && typeof (op as Record<string, unknown>).method === "string"
      ? { path: (op as { path: string }).path, method: (op as { method: string }).method }
      : undefined;
    return { kind: "openapi", text, operation };
  }
  if (body.kind === "schema") {
    if (body.direction !== "request" && body.direction !== "response") return null;
    return {
      kind: "schema", text, direction: body.direction,
      status_code: typeof body.status_code === "string" ? body.status_code : undefined,
      media_type: typeof body.media_type === "string" ? body.media_type : undefined,
    };
  }
  return null;
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);

  const access = await requireRole(request, SUBMITTER_ROLES, requestId);
  if ("response" in access) return access.response;
  const user = access.user;
  const retryAfter = checkMutationRateLimit("edit", user, clientKey(request));
  if (retryAfter > 0) {
    const res = publicError(`Too many requests. Please try again in ${retryAfter} seconds.`, 429, requestId);
    res.headers.set("Retry-After", String(retryAfter));
    return res;
  }

  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);

  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return publicError("The request body could not be read.", 400, requestId);
  }
  const apiId = typeof body.api_id === "string" ? body.api_id.trim() : "";
  if (!UUID.test(apiId)) return publicError("api_id must be a UUID.", 400, requestId);
  const input = uploadInput(body);
  if (!input) return publicError("Say whether this is an OpenAPI document or a schema, and which side.", 400, requestId);

  let api: ApiRow | undefined;
  try {
    [api] = await select<ApiRow>(config, "apis", new URLSearchParams({
      select: "id,api_name,company_name,is_active,duplicate_of,created_by_user", id: `eq.${apiId}`,
    }));
  } catch {
    return publicError("The API could not be checked. Nothing was uploaded.", 503, requestId);
  }
  if (!api || !api.is_active) return publicError("API record was not found.", 404, requestId);
  // The same rule as editing the record: its submitter, or an administrator.
  if (!canManageApi(user, api)) {
    return publicError("You can only add schemas to APIs you submitted.", 403, requestId);
  }

  const resolved = resolveUpload(input);
  if (!resolved.ok) {
    return publicError(resolved.error, 400, requestId, resolved.operations ? { operations: resolved.operations } : {});
  }

  try {
    const existing = await select<{ id: string; direction: string; status_code: string | null; media_type: string; origin: string }>(
      config, "api_schema",
      new URLSearchParams({ select: "id,direction,status_code,media_type,origin", api_id: `eq.${apiId}` }),
    );
    const byIdentity = new Map(existing.map((e) => [schemaIdentity(e), e]));
    const clashes = resolved.schemas.map((s) => byIdentity.get(schemaIdentity(s))).filter((e) => e !== undefined);

    // A schema read from the provider's own documentation outranks one a
    // person typed in. Replacing it would lose the provenance that makes it
    // trustworthy, so an upload may replace an upload but never an extraction.
    if (clashes.some((e) => e.origin === "extracted")) {
      return publicError(
        "This API already has a schema taken from its documentation for that side and media type.",
        409, requestId,
      );
    }

    // Replacing an earlier upload: remove it first, because 0016's identity
    // index admits one schema per side. If the insert below then fails, the
    // earlier upload is gone and the response says so; uploading again
    // restores it.
    if (clashes.length > 0) {
      const res = await fetch(`${config.url}/rest/v1/api_schema?id=in.(${clashes.map((e) => e.id).join(",")})`, {
        method: "DELETE", headers: headers(config, true),
      });
      if (!res.ok) return publicError("The earlier upload could not be replaced. Nothing was changed.", 502, requestId);
    }

    const written = await writeSchemaSet(
      config, apiId, resolved.schemas, { kind: "uploaded", createdBy: user.displayName || user.id },
    );
    if (!written.ok) {
      return publicError(
        clashes.length > 0
          ? "The earlier upload was removed but the new one could not be saved. Please upload again."
          : written.error === "schemas_not_recorded" ? "The schema could not be saved." : "The schema's fields could not be saved. Nothing was kept.",
        502, requestId,
      );
    }

    const sides = resolved.schemas
      .map((s) => (s.direction === "request" ? "request" : `${s.status_code} response`) + ` (${s.media_type})`)
      .join(", ");
    const audit = await fetch(`${config.url}/rest/v1/api_audit_events`, {
      method: "POST", headers: headers(config, true),
      body: JSON.stringify({
        api_id: apiId, api_name: api.api_name, company_name: api.company_name, action: "edit",
        actor_name: user.displayName, actor_user_id: user.id,
        details: `${clashes.length > 0 ? "Replaced uploaded" : "Uploaded"} schema: ${sides}.`,
      }),
    }).then((r) => r.ok).catch(() => false);

    return NextResponse.json({
      schemas: written.schemas,
      fields: written.fields,
      replaced: clashes.length,
      ...(audit ? {} : { warning: "The upload was saved but not recorded in the history." }),
      requestId,
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return publicError("The schema could not be saved.", 502, requestId);
  }
}
