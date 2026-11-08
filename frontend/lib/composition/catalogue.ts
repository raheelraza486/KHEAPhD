/** Bulk reads for the composition endpoint. No query is made for an API pair. */
import type { ApiSideInput, FormatAliasRow, ParameterRecord, SchemaRecord, UserChoice } from "../checks/types.ts";
import type { ChoiceRow } from "../checks/store.ts";
import type { SupabaseConfig } from "../checks/store.ts";
import type { CandidateApi } from "./task-candidates.ts";
import type { InvoiceStandardCapability } from "./invoice-standard-capabilities.ts";

export interface CompositionApi extends CandidateApi {
  company_name: string;
  api_endpoint: string | null;
  http_method: string | null;
  input_formats: string[];
  output_formats: string[];
  authentication_method: string | null;
  authentication_details: string | null;
}

type SchemaRow = Omit<SchemaRecord, "fields">;
type FieldRow = SchemaRecord["fields"][number] & { schema_id: string };
type ParameterRow = ParameterRecord & { api_id: string };

const PAGE_SIZE = 1000;
const API_COLUMNS = [
  "id", "api_name", "official_api_name", "description", "instructions", "company_name",
  "country_region", "category", "network", "communication_direction", "is_active", "duplicate_of",
  "input_formats", "output_formats", "invoice_standard", "business_rules",
  "api_endpoint", "http_method", "authentication_method", "authentication_details",
].join(",");

function headers(config: SupabaseConfig): Record<string, string> {
  const result: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) result.Authorization = `Bearer ${config.key}`;
  return result;
}

async function select<T>(config: SupabaseConfig, table: string, query: URLSearchParams): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const pageQuery = new URLSearchParams(query);
    pageQuery.set("limit", String(PAGE_SIZE));
    pageQuery.set("offset", String(offset));
    const response = await fetch(`${config.url}/rest/v1/${table}?${pageQuery}`, {
      headers: headers(config), cache: "no-store", signal: config.signal,
    });
    if (!response.ok) throw new Error(`${table} read failed ${response.status}`);
    const page = await response.json() as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/** Read all active, non-duplicate API metadata once for this composition request. */
export async function loadCompositionCatalogue(config: SupabaseConfig): Promise<CompositionApi[]> {
  const rows = await select<CompositionApi>(config, "apis", new URLSearchParams({
    select: API_COLUMNS,
    is_active: "eq.true",
    duplicate_of: "is.null",
    order: "id.asc",
  }));
  return rows.filter((row) => row.id && row.api_name && row.category && row.is_active !== false && !row.duplicate_of)
    .map((row) => ({
      ...row,
      input_formats: row.input_formats ?? [],
      output_formats: row.output_formats ?? [],
      invoice_standard: row.invoice_standard ?? [],
      business_rules: row.business_rules ?? [],
    }));
}

/** Load technical data only for the selected IDs, one bulk read per table. */
export async function loadCompositionSides(
  config: SupabaseConfig,
  catalogue: readonly CompositionApi[],
  ids: readonly string[],
  includeSavedChoices = false,
  requireFormatAliases = false,
): Promise<{ sides: ApiSideInput[]; formatAliases: FormatAliasRow[]; choicesByPair: Map<string, UserChoice[]> }> {
  const readFormats = () => select<FormatAliasRow>(config, "format_alias", new URLSearchParams({ select: "alias,canonical" }));
  const unique = [...new Set(ids)];
  // An empty catalogue must not make known goal formats look unrecognised.
  if (unique.length === 0) return {
    sides: [], formatAliases: requireFormatAliases ? await readFormats() : [], choicesByPair: new Map(),
  };
  const byId = new Map(catalogue.map((api) => [api.id, api]));
  const inList = `in.(${unique.join(",")})`;
  const [schemas, parameters, formatAliases, choices] = await Promise.all([
    select<SchemaRow>(config, "api_schema", new URLSearchParams({
      select: "id,api_id,direction,status_code,media_type,raw,verified_by,content_hash",
      api_id: inList,
      order: "api_id.asc,direction.asc,status_code.asc,media_type.asc,id.asc",
    })),
    select<ParameterRow>(config, "api_parameter", new URLSearchParams({
      select: "api_id,name,name_norm,location,json_type,format,is_required,enum_values,description",
      api_id: inList,
      order: "api_id.asc,location.asc,name.asc",
    })),
    readFormats(),
    includeSavedChoices ? select<ChoiceRow>(config, "check_choice", new URLSearchParams({
      select: "id,source_api_id,target_api_id,target_path,kind,option,chosen_source_path,source_content_hash,target_content_hash,chosen_by,chosen_at",
      source_api_id: inList,
      target_api_id: inList,
      order: "chosen_at.asc,id.asc",
    })) : Promise.resolve([]),
  ]);
  const fields = schemas.length === 0 ? [] : await select<FieldRow>(config, "api_schema_field", new URLSearchParams({
    select: "schema_id,path,leaf_name,leaf_name_norm,json_type,format,is_required,is_array_item,depth,enum_values,description",
    schema_id: `in.(${schemas.map((schema) => schema.id).join(",")})`,
    order: "schema_id.asc,path.asc",
  }));
  const fieldsBySchema = new Map<string, FieldRow[]>();
  for (const field of fields) {
    const current = fieldsBySchema.get(field.schema_id) ?? [];
    current.push(field);
    fieldsBySchema.set(field.schema_id, current);
  }
  const schemasByApi = new Map<string, SchemaRecord[]>();
  for (const schema of schemas) {
    const current = schemasByApi.get(schema.api_id) ?? [];
    current.push({ ...schema, fields: fieldsBySchema.get(schema.id) ?? [] });
    schemasByApi.set(schema.api_id, current);
  }
  const parametersByApi = new Map<string, ParameterRow[]>();
  for (const parameter of parameters) {
    const current = parametersByApi.get(parameter.api_id) ?? [];
    current.push(parameter);
    parametersByApi.set(parameter.api_id, current);
  }
  const sides: ApiSideInput[] = unique.flatMap((id) => {
    const api = byId.get(id);
    return api ? [{
      api: {
        id: api.id, api_name: api.api_name, company_name: api.company_name,
        category: api.category, api_endpoint: api.api_endpoint, http_method: api.http_method,
        input_formats: api.input_formats, output_formats: api.output_formats,
        authentication_method: api.authentication_method, authentication_details: api.authentication_details,
        invoice_standard: api.invoice_standard ?? [],
      },
      schemas: schemasByApi.get(id) ?? [],
      parameters: parametersByApi.get(id) ?? [],
    }] : [];
  });
  const choicesByPair = new Map<string, UserChoice[]>();
  for (const choice of choices) {
    const key = `${choice.source_api_id}->${choice.target_api_id}`;
    const current = choicesByPair.get(key) ?? [];
    current.push(choice);
    choicesByPair.set(key, current);
  }
  return { sides, formatAliases, choicesByPair };
}

/** A missing migration leaves the existing technical endpoint usable. */
export async function loadInvoiceStandardCapabilities(
  config: SupabaseConfig,
  ids?: readonly string[],
): Promise<{ available: boolean; rows: InvoiceStandardCapability[] }> {
  const unique = ids ? [...new Set(ids)] : null;
  if (unique?.length === 0) return { available: true, rows: [] };
  const query = new URLSearchParams({
    select: "id,api_id,direction,standard,version,profile,condition,status,evidence_url",
  });
  if (unique) query.set("api_id", `in.(${unique.join(",")})`);
  const rows: InvoiceStandardCapability[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const pageQuery = new URLSearchParams(query);
    pageQuery.set("limit", String(PAGE_SIZE));
    pageQuery.set("offset", String(offset));
    const response = await fetch(`${config.url}/rest/v1/api_invoice_standard_capability?${pageQuery}`, {
      headers: headers(config), cache: "no-store", signal: config.signal,
    });
    if (response.status === 404) return { available: false, rows: [] };
    if (!response.ok) throw new Error(`standard capability read failed ${response.status}`);
    const page = await response.json() as InvoiceStandardCapability[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { available: true, rows };
  }
}
