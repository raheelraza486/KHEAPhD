import { NextResponse } from "next/server";
import { isCatalogueRecordVisible } from "@/lib/catalog-visibility";
import { isChainable } from "@/lib/schema/rows";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
const ID_BATCH_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type VisibleApi = { id: string; is_active: boolean; duplicate_of: string | null };
type SchemaIdentity = { api_id: string; direction: string; status_code: string | null };

/** Public discovery metadata only; callers fetch selected schemas separately. */
export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const respond = (body: Record<string, unknown>, status = 200) => NextResponse.json(
    { ...body, requestId }, { status, headers: { "Cache-Control": "no-store" } },
  );
  const requestedIds = [...new Set(new URL(request.url).searchParams.getAll("api_id").map((id) => id.trim()))];
  if (requestedIds.length > ID_BATCH_SIZE || requestedIds.some((id) => !UUID.test(id))) {
    return respond({ error: `api_id must contain at most ${ID_BATCH_SIZE} UUIDs.` }, 400);
  }
  if (!url || !key) return respond({ error: "The database is not configured." }, 503);
  const headers: Record<string, string> = { apikey: key, Accept: "application/json" };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;

  async function select<T>(table: string, query: URLSearchParams): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const params = new URLSearchParams(query);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const response = await fetch(`${url}/rest/v1/${table}?${params}`, { headers, cache: "no-store" });
      if (!response.ok) throw new Error("Schema availability could not be read.");
      const page = await response.json() as T[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) return rows;
    }
  }

  try {
    const apiQuery = new URLSearchParams({
      select: "id,is_active,duplicate_of", is_active: "eq.true", duplicate_of: "is.null", order: "id.asc",
    });
    if (requestedIds.length > 0) apiQuery.set("id", `in.(${requestedIds.join(",")})`);
    const apis = (await select<VisibleApi>("apis", apiQuery)).filter(isCatalogueRecordVisible);
    const counts = new Map(apis.map((api) => [api.id, { api_id: api.id, request_count: 0, response_count: 0 }]));
    // Bound URLs independently of catalogue size, and page schemas within each
    // batch so one API with many representations cannot truncate the counts.
    for (let start = 0; start < apis.length; start += ID_BATCH_SIZE) {
      const ids = apis.slice(start, start + ID_BATCH_SIZE).map((api) => api.id);
      const schemas = await select<SchemaIdentity>("api_schema", new URLSearchParams({
        select: "api_id,direction,status_code", api_id: `in.(${ids.join(",")})`, order: "id.asc",
      }));
      for (const schema of schemas) {
        const count = counts.get(schema.api_id);
        if (!count || !isChainable(schema)) continue;
        if (schema.direction === "request") count.request_count++;
        else if (schema.direction === "response") count.response_count++;
      }
    }
    return respond({ apis: [...counts.values()] });
  } catch {
    return respond({ error: "Schema availability could not be read." }, 502);
  }
}
