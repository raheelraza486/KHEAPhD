/**
 * Server-side access for the checks: reads the rows `runChecks` needs through
 * PostgREST with the service key (the tables are closed to the browser roles,
 * as 0016/0017/0033 say), and appends answers to `check_choice`.
 *
 * The checks routes and the read-only composition endpoint use this module.
 */
import type { AliasMaps } from "../import/candidate-record.ts";
import type { ApiRecord, ApiSideInput, FormatAliasRow, PairInput, ParameterRecord, SchemaRecord, StandardClaim, UserChoice } from "./types.ts";
import { normaliseName } from "./fields.ts";

export type SupabaseConfig = { url: string; key: string; opaqueSecret: boolean; signal?: AbortSignal };

export function getSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  const url = env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key, opaqueSecret: key.startsWith("sb_secret_") } : null;
}

function headers(config: SupabaseConfig, write = false): Record<string, string> {
  const h: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) h.Authorization = `Bearer ${config.key}`;
  if (write) {
    h["Content-Type"] = "application/json";
    h.Prefer = "return=representation";
  }
  return h;
}

/** PostgREST's page size on Supabase. Reads page through it rather than trusting one response. */
const PAGE_SIZE = 1000;

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

type ApiRow = ApiRecord & { is_active: boolean; duplicate_of: string | null };
type ClaimRow = StandardClaim & { api_id: string };

/**
 * Directional invoice-standard claims for check 2.0b (migration 0038). A
 * database without the table yet, or a failed read, leaves 2.0b on the
 * catalogue label instead of stopping the check.
 */
async function loadClaims(config: SupabaseConfig, ids: readonly string[]): Promise<ClaimRow[]> {
  if (ids.length === 0) return [];
  try {
    return await select<ClaimRow>(config, "api_invoice_standard_capability", new URLSearchParams({
      select: "api_id,direction,standard,version,status,condition",
      api_id: `in.(${ids.join(",")})`,
    }));
  } catch {
    return [];
  }
}
type SchemaRow = Omit<SchemaRecord, "fields">;
type FieldRow = SchemaRecord["fields"][number] & { schema_id: string };
type ParameterRow = ParameterRecord & { api_id: string };

export interface ChoiceRow extends UserChoice {
  id: string;
  source_api_id: string;
  target_api_id: string;
}

export class PairNotFound extends Error {
  constructor(public readonly missing: string[]) {
    super(`API record(s) not found: ${missing.join(", ")}`);
  }
}

export interface PairSchemaSelection {
  sourceSchemaId?: string | null;
  targetSchemaId?: string | null;
}

export class PairSchemaNotFound extends Error {
  constructor(
    public readonly side: "source" | "target",
    public readonly schemaId: string,
  ) {
    super(`${side} schema not found for the selected API: ${schemaId}`);
  }
}

/** The rows of one ordered pair, ready for `runChecks`. Inactive or duplicate records count as missing. */
/**
 * The engine's view of saved API records, one bulk read per table, plus the
 * format aliases. Shared by the pair check and the ad-hoc check (#33), where
 * one side may be saved and the other read from a document.
 */
export async function loadSides(config: SupabaseConfig, ids: readonly string[]): Promise<{ sides: Map<string, ApiSideInput>; formatAliases: FormatAliasRow[] }> {
  const unique = [...new Set(ids)];
  const [apis, formatAliases] = await Promise.all([
    unique.length === 0 ? Promise.resolve([] as ApiRow[]) : select<ApiRow>(config, "apis", new URLSearchParams({
      select: "id,api_name,company_name,category,api_endpoint,http_method,input_formats,output_formats,authentication_method,authentication_details,invoice_standard,is_active,duplicate_of",
      id: `in.(${unique.join(",")})`,
    })),
    select<FormatAliasRow>(config, "format_alias", new URLSearchParams({ select: "alias,canonical" })),
  ]);
  const byId = new Map(apis.filter((a) => a.is_active && !a.duplicate_of).map((a) => [a.id, a]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new PairNotFound(missing);
  if (unique.length === 0) return { sides: new Map(), formatAliases };

  const schemas = await select<SchemaRow>(config, "api_schema", new URLSearchParams({
    select: "id,api_id,direction,status_code,media_type,raw,verified_by,content_hash",
    api_id: `in.(${unique.join(",")})`,
    // media_type and id complete the key: several rows may share
    // (api, direction, status_code) when a provider declares the same schema
    // for more than one content type, and PostgREST gives no order between
    // rows whose sort keys are equal.
    order: "api_id.asc,direction.asc,status_code.asc,media_type.asc,id.asc",
  }));
  const fields = schemas.length === 0 ? [] : await select<FieldRow>(config, "api_schema_field", new URLSearchParams({
    select: "schema_id,path,leaf_name,leaf_name_norm,json_type,format,is_required,is_array_item,depth,enum_values,description",
    schema_id: `in.(${schemas.map((s) => s.id).join(",")})`,
    order: "schema_id.asc,path.asc",
  }));
  const parameters = await select<ParameterRow>(config, "api_parameter", new URLSearchParams({
    select: "api_id,name,name_norm,location,json_type,format,is_required,enum_values,description",
    api_id: `in.(${unique.join(",")})`,
    order: "api_id.asc,location.asc,name.asc",
  }));

  const fieldsBySchema = new Map<string, FieldRow[]>();
  for (const f of fields) (fieldsBySchema.get(f.schema_id) ?? fieldsBySchema.set(f.schema_id, []).get(f.schema_id)!).push(f);
  const claims = await loadClaims(config, unique);
  const sides = new Map(unique.map((id): [string, ApiSideInput] => [id, {
    api: byId.get(id)!,
    schemas: schemas.filter((s) => s.api_id === id).map((s) => ({ ...s, fields: fieldsBySchema.get(s.id) ?? [] })),
    parameters: parameters.filter((p) => p.api_id === id),
    standard_claims: claims.filter((c) => c.api_id === id),
  }]));
  return { sides, formatAliases };
}

export function selectedSchema(
  side: ApiSideInput,
  schemaId: string | null | undefined,
  direction: "request" | "response",
  name: "source" | "target",
): string | null {
  if (!schemaId) return null;

  const schema = side.schemas.find(
    (candidate) =>
      candidate.id === schemaId &&
      candidate.api_id === side.api.id &&
      candidate.direction === direction,
  );

  if (!schema) {
    throw new PairSchemaNotFound(name, schemaId);
  }

  return schema.id;
}

export async function loadPairInput(config: SupabaseConfig, sourceId: string, targetId: string, selection: PairSchemaSelection = {}): Promise<PairInput> {
  const [{ sides, formatAliases }, choices] = await Promise.all([
    loadSides(config, [sourceId, targetId]),
    loadChoices(config, sourceId, targetId),
  ]);
  const source = sides.get(sourceId)!;
  const target = sides.get(targetId)!;
  return {
    source,
    target,
    formatAliases,
    choices,
    selectedSourceSchemaId: selectedSchema(source, selection.sourceSchemaId, "response", "source"),
    selectedTargetSchemaId: selectedSchema(target, selection.targetSchemaId, "request", "target"),
  };
}

/** format_alias and provider_alias as the Publisher import reads them; an empty map degrades to raw spellings. */
export async function loadAliasMaps(config: SupabaseConfig): Promise<AliasMaps> {
  const format = new Map<string, string>();
  const provider = new Map<string, string>();
  try {
    const [f, p] = await Promise.all([
      select<{ alias: string; canonical: string }>(config, "format_alias", new URLSearchParams({ select: "alias,canonical" })),
      select<{ alias: string; canonical: string }>(config, "provider_alias", new URLSearchParams({ select: "alias,canonical" })),
    ]);
    for (const r of f) { format.set(r.alias, r.canonical); format.set(r.alias.toLowerCase(), r.canonical); }
    for (const r of p) { provider.set(r.alias, r.canonical); provider.set(r.alias.toLowerCase(), r.canonical); }
  } catch {
    /* an empty map degrades to raw spellings, which is safe */
  }
  return { format, provider };
}

/** The whole answer history of one pair, oldest first. */
export async function loadChoices(config: SupabaseConfig, sourceId: string, targetId: string): Promise<ChoiceRow[]> {
  return select<ChoiceRow>(config, "check_choice", new URLSearchParams({
    select: "id,source_api_id,target_api_id,target_path,kind,option,chosen_source_path,source_content_hash,target_content_hash,chosen_by,chosen_at",
    source_api_id: `eq.${sourceId}`,
    target_api_id: `eq.${targetId}`,
    order: "chosen_at.asc",
  }));
}

export interface NewChoice {
  source_api_id: string;
  target_api_id: string;
  target_path: string;
  kind: "user" | "admin";
  option: "candidate" | "none" | "external";
  chosen_source_path: string | null;
  source_content_hash: string;
  target_content_hash: string;
  chosen_by: string;
  note?: string;
}

/** Append one answer (the table is append-only; nothing is ever updated). */
export async function insertChoice(config: SupabaseConfig, choice: NewChoice): Promise<ChoiceRow> {
  const leaf = choice.target_path.split(".").at(-1)!.replace(/\[\]$/, "");
  const sourceLeaf = choice.chosen_source_path ? choice.chosen_source_path.split(".").at(-1)!.replace(/\[\]$/, "") : "";
  const row = {
    ...choice,
    target_name_norm: normaliseName(leaf),
    chosen_source_norm: sourceLeaf ? normaliseName(sourceLeaf) : "",
    note: choice.note ?? "",
  };
  const res = await fetch(`${config.url}/rest/v1/check_choice`, { method: "POST", headers: headers(config, true), body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`check_choice insert failed ${res.status}`);
  const [inserted] = (await res.json()) as ChoiceRow[];
  return inserted;
}

export interface PairKey {
  source_api_id: string;
  target_api_id: string;
}

/**
 * Every ordered pair that has at least one saved answer. These are the only
 * pairs a conflict can exist for: a conflict needs an answer to disagree with.
 */
export async function listAnsweredPairs(config: SupabaseConfig): Promise<PairKey[]> {
  const rows = await select<PairKey>(config, "check_choice", new URLSearchParams({
    select: "source_api_id,target_api_id",
    order: "source_api_id.asc,target_api_id.asc",
  }));
  const seen = new Set<string>();
  const pairs: PairKey[] = [];
  for (const row of rows) {
    const key = `${row.source_api_id}|${row.target_api_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(row);
  }
  return pairs;
}

/**
 * Load many pairs in one go: the APIs, schemas, fields, parameters and answers
 * of every record involved are read once each, then assembled per pair in
 * memory. Loading each pair on its own would be five round trips per pair.
 */
export async function loadPairInputs(config: SupabaseConfig, pairs: readonly PairKey[]): Promise<Map<string, PairInput>> {
  const result = new Map<string, PairInput>();
  if (pairs.length === 0) return result;
  const ids = [...new Set(pairs.flatMap((p) => [p.source_api_id, p.target_api_id]))];
  const inList = `in.(${ids.join(",")})`;

  const [apis, aliases, schemas, parameters, choices] = await Promise.all([
    select<ApiRow>(config, "apis", new URLSearchParams({
      select: "id,api_name,company_name,category,api_endpoint,http_method,input_formats,output_formats,authentication_method,authentication_details,invoice_standard,is_active,duplicate_of",
      id: inList,
    })),
    select<FormatAliasRow>(config, "format_alias", new URLSearchParams({ select: "alias,canonical" })),
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
    select<ChoiceRow>(config, "check_choice", new URLSearchParams({
      select: "id,source_api_id,target_api_id,target_path,kind,option,chosen_source_path,source_content_hash,target_content_hash,chosen_by,chosen_at",
      source_api_id: inList,
      order: "chosen_at.asc",
    })),
  ]);

  const usable = new Map(apis.filter((a) => a.is_active && !a.duplicate_of).map((a) => [a.id, a]));
  const fields = schemas.length === 0 ? [] : await select<FieldRow>(config, "api_schema_field", new URLSearchParams({
    select: "schema_id,path,leaf_name,leaf_name_norm,json_type,format,is_required,is_array_item,depth,enum_values,description",
    schema_id: `in.(${schemas.map((s) => s.id).join(",")})`,
    order: "schema_id.asc,path.asc",
  }));
  const fieldsBySchema = new Map<string, FieldRow[]>();
  for (const f of fields) (fieldsBySchema.get(f.schema_id) ?? fieldsBySchema.set(f.schema_id, []).get(f.schema_id)!).push(f);
  const claims = await loadClaims(config, ids);
  const side = (id: string): ApiSideInput => ({
    api: usable.get(id)!,
    schemas: schemas.filter((s) => s.api_id === id).map((s) => ({ ...s, fields: fieldsBySchema.get(s.id) ?? [] })),
    parameters: parameters.filter((p) => p.api_id === id),
    standard_claims: claims.filter((c) => c.api_id === id),
  });
  const sides = new Map(ids.filter((id) => usable.has(id)).map((id) => [id, side(id)]));

  for (const pair of pairs) {
    const source = sides.get(pair.source_api_id);
    const target = sides.get(pair.target_api_id);
    if (!source || !target) continue;
    result.set(`${pair.source_api_id}|${pair.target_api_id}`, {
      source,
      target,
      formatAliases: aliases,
      choices: choices.filter((c) => c.source_api_id === pair.source_api_id && c.target_api_id === pair.target_api_id),
    });
  }
  return result;
}

/**
 * How to name the people who answered, for the administrator deciding between
 * them. The display name is preferred; the email identifies someone whose
 * profile has no name yet.
 */
export async function displayNamesOf(config: SupabaseConfig, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
  if (unique.length === 0) return new Map();
  const rows = await select<{ id: string; email: string; display_name: string }>(config, "app_user", new URLSearchParams({
    select: "id,email,display_name",
    id: `in.(${unique.join(",")})`,
  }));
  return new Map(rows.map((row) => [row.id, row.display_name?.trim() || row.email]));
}

export interface SettlementNotice {
  recipient_user_id: string;
  source_api_id: string;
  target_api_id: string;
  target_path: string;
  source_api_name: string;
  target_api_name: string;
  option: "candidate" | "none" | "external";
  chosen_source_path: string | null;
  settled_by: string | null;
}

/**
 * Tell the people who answered a field that an administrator has settled it
 * (0035). One row each, the administrator excluded — they know. Answers with
 * no recorded author (seeded or imported) have nobody to tell.
 */
export async function insertSettlementNotices(config: SupabaseConfig, notices: readonly SettlementNotice[]): Promise<number> {
  if (notices.length === 0) return 0;
  const res = await fetch(`${config.url}/rest/v1/check_notification`, {
    method: "POST",
    headers: headers(config, true),
    body: JSON.stringify(notices.map((n) => ({ ...n, kind: "conflict_settled" }))),
  });
  if (!res.ok) throw new Error(`check_notification insert failed ${res.status}`);
  return notices.length;
}

/** Who has answered this field of this pair, as users (the administrator aside). */
export async function answerersOf(config: SupabaseConfig, sourceId: string, targetId: string, targetPath: string): Promise<string[]> {
  const rows = await select<{ chosen_by: string | null }>(config, "check_choice", new URLSearchParams({
    select: "chosen_by",
    source_api_id: `eq.${sourceId}`,
    target_api_id: `eq.${targetId}`,
    target_path: `eq.${targetPath}`,
    kind: "eq.user",
  }));
  return [...new Set(rows.map((r) => r.chosen_by).filter((id): id is string => typeof id === "string" && id !== ""))];
}

export interface ConflictListRow {
  source_api_id: string;
  target_api_id: string;
  target_path: string;
  target_name_norm: string;
  answers: number;
  distinct_answers: number;
  last_chosen_at: string;
}

/** The administrator's work list: every (pair, field) whose history merges to `conflict`. */
export async function listConflicts(config: SupabaseConfig): Promise<ConflictListRow[]> {
  return select<ConflictListRow>(config, "v_check_choice_current", new URLSearchParams({
    select: "source_api_id,target_api_id,target_path,target_name_norm,answers,distinct_answers,last_chosen_at",
    state: "eq.conflict",
    order: "last_chosen_at.desc",
  }));
}
