import { NextResponse } from "next/server";
import { normalizeApiRecord, type ApiRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
const ID_BATCH_SIZE = 100;
const API_SELECT_FIELDS = [
  "id", "api_name", "official_api_name", "api_endpoint", "http_method", "operation_selector",
  "company_name", "official_company_name", "country_region", "website_url", "documentation_url", "source_url",
  "category", "category_other", "input_formats", "output_formats", "is_active", "duplicate_of",
].join(",");
const VIEW_SELECT_FIELDS = `${API_SELECT_FIELDS},request_count,response_count`;

type SupabaseConfig = { url: string; key: string; opaqueSecret: boolean };
type CompatibilityCatalogueRow = Partial<ApiRecord> & {
  request_count?: number | string;
  response_count?: number | string;
};
type SchemaIdentity = { id: string; api_id: string; direction: string; status_code: string | null };
type SchemaFieldIdentity = { schema_id: string };

class DatabaseReadError extends Error {
  constructor(public readonly table: string, public readonly status: number) {
    super(`${table} read failed ${status}`);
  }
}

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key, opaqueSecret: key.startsWith("sb_secret_") } : null;
}

function headers(config: SupabaseConfig): Record<string, string> {
  const result: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) result.Authorization = `Bearer ${config.key}`;
  return result;
}

function schemaCount(value: number | string | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

async function select<T>(
  config: SupabaseConfig,
  table: string,
  query: URLSearchParams,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const pageQuery = new URLSearchParams(query);
    pageQuery.set("limit", String(PAGE_SIZE));
    pageQuery.set("offset", String(offset));
    const response = await fetch(`${config.url}/rest/v1/${table}?${pageQuery}`, {
      headers: headers(config),
      cache: "no-store",
    });
    if (!response.ok) throw new DatabaseReadError(table, response.status);
    const page = await response.json() as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function readComparisonReadyRows(config: SupabaseConfig): Promise<CompatibilityCatalogueRow[]> {
  try {
    return await select<CompatibilityCatalogueRow>(
      config,
      "v_compatibility_catalogue",
      new URLSearchParams({ select: VIEW_SELECT_FIELDS, order: "id.asc" }),
    );
  } catch (error) {
    // During a rolling deployment the application may arrive before migration
    // 0036. The compatibility route still must not fall back to /api/apis: read
    // only schema identities, derive eligible IDs, then fetch metadata for
    // those IDs alone. Other database errors fail closed.
    if (!(error instanceof DatabaseReadError) || error.status !== 404) throw error;
  }

  const [schemas, fields] = await Promise.all([
    select<SchemaIdentity>(
      config,
      "api_schema",
      new URLSearchParams({ select: "id,api_id,direction,status_code", order: "id.asc" }),
    ),
    select<SchemaFieldIdentity>(
      config,
      "api_schema_field",
      new URLSearchParams({ select: "schema_id", order: "schema_id.asc" }),
    ),
  ]);
  const schemasWithFields = new Set(fields.map((field) => field.schema_id));
  const counts = new Map<string, { request_count: number; response_count: number }>();
  for (const schema of schemas) {
    if (!schemasWithFields.has(schema.id)) continue;
    const count = counts.get(schema.api_id) ?? { request_count: 0, response_count: 0 };
    if (schema.direction === "request") count.request_count++;
    else if (
      schema.direction === "response"
      && (/^2\d\d$/.test(schema.status_code ?? "")
        || (schema.status_code ?? "").toUpperCase() === "2XX"
        || (schema.status_code ?? "").toLowerCase() === "default")
    ) count.response_count++;
    counts.set(schema.api_id, count);
  }
  const eligibleIds = [...counts]
    .filter(([, count]) => count.request_count > 0 && count.response_count > 0)
    .map(([id]) => id);
  const rows: CompatibilityCatalogueRow[] = [];
  for (let start = 0; start < eligibleIds.length; start += ID_BATCH_SIZE) {
    const ids = eligibleIds.slice(start, start + ID_BATCH_SIZE);
    const apis = await select<Partial<ApiRecord>>(
      config,
      "apis",
      new URLSearchParams({
        select: API_SELECT_FIELDS,
        id: `in.(${ids.join(",")})`,
        is_active: "eq.true",
        duplicate_of: "is.null",
        order: "id.asc",
      }),
    );
    rows.push(...apis.map((api) => ({ ...api, ...counts.get(String(api.id))! })));
  }
  return rows;
}

/**
 * The only repository catalogue exposed to the compatibility workspace.
 *
 * The database view applies the real access boundary. The checks below are
 * repeated defensively so a stale or incorrectly deployed view cannot leak an
 * API with a missing side into the page.
 */
export async function GET() {
  const requestId = crypto.randomUUID();
  const config = getSupabaseConfig();
  if (!config) {
    return NextResponse.json(
      { apis: [], availability: [], mode: "dataset", requestId },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const rows = (await readComparisonReadyRows(config)).filter((row) =>
      typeof row.id === "string"
      && row.id.length > 0
      && row.is_active !== false
      && row.duplicate_of == null
      && schemaCount(row.request_count) > 0
      && schemaCount(row.response_count) > 0,
    );
    return NextResponse.json({
      apis: rows.map((row) => normalizeApiRecord(row)),
      availability: rows.map((row) => ({
        api_id: String(row.id),
        request_count: schemaCount(row.request_count),
        response_count: schemaCount(row.response_count),
      })),
      mode: "supabase",
      requestId,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Compatibility catalogue request failed", {
      message: error instanceof Error ? error.message : "Unknown fetch error",
      requestId,
    });
    return NextResponse.json(
      { error: "The comparison-ready API catalogue is temporarily unavailable.", requestId },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
