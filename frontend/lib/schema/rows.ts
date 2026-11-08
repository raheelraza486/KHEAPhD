// Extracted schemas -> the rows migration 0016 stores. Pure: no network, no
// database, no clock.
//
// Kept apart from the route so the part that decides what gets written can be
// tested without a database, the same division parse.ts and the import route
// already have.

import {
  parameterIdentity, parameterLeafNorm, type ExtractedParameter,
} from "./parameters.ts";
import {
  flattenSchema,
  schemaContentHash,
  type DocumentSchemas,
  type ExtractedSchema,
  type SchemaField,
} from "./extract.ts";

/** An extracted schema as kept between preview and confirm: raw, no fields. */
export type StoredSchema = Omit<ExtractedSchema, "fields">;

/**
 * Whether a schema can take part in a chain: a request body, or a response
 * that describes success.
 *
 * The BP-Builder asks whether operation A's output can feed operation B's
 * input. An error body is never that output. On the Poland KSeF document 356
 * of 441 schemas are error responses -- 400 and 429 on 122 operations each,
 * 401 and 403 on 56 -- mostly one exception envelope repeated. Storing them
 * would multiply the rows fivefold and give comparison nothing to compare.
 *
 * 'default' is kept. The specification defines it as "any response not
 * otherwise described", and a document whose only response is 'default' has
 * put its success shape there. The extractor itself still returns every
 * response; this is a decision about what to store, made in one place.
 */
export function isChainable(schema: { direction: string; status_code: string | null }): boolean {
  if (schema.direction === "request") return true;
  const status = schema.status_code ?? "";
  return /^2\d\d$/.test(status) || status.toUpperCase() === "2XX" || status === "default";
}

/**
 * The schemas of one operation that can take part in a chain.
 *
 * isChainable judges a schema on its own. This judges them together, because
 * one of the rules needs the whole operation: 'default' is only a success
 * shape when the operation states no success status. Where an operation has
 * a 2XX response as well, its 'default' is the error branch -- on the live
 * catalogue every one of the 49 stored 'default' responses carried an error
 * shape (code / details / error), and 32 of them belonged to operations that
 * also had a 2XX. Those were reaching the compatibility checks as though
 * they were an operation's output.
 */
export function chainableSchemas<T extends { direction: string; status_code: string | null }>(
  schemas: readonly T[],
): T[] {
  const hasSuccess = schemas.some(
    (s) => s.direction === "response" && /^2(\d\d|XX)$/i.test(s.status_code ?? ""),
  );
  return schemas.filter(
    (s) => isChainable(s)
      && !(hasSuccess && s.direction === "response" && (s.status_code ?? "").toLowerCase() === "default"),
  );
}

/**
 * What the preview stores for confirm: chainable schemas, raw only.
 *
 * Fields are left out because raw is self-contained after dereferencing and
 * fields are derived from it. On KSeF that is the difference between 1.6 MB
 * and 191 KB in one import_session row.
 */
export function forStorage(schemas: readonly ExtractedSchema[]): StoredSchema[] {
  return chainableSchemas(schemas).map(({ fields: _fields, ...rest }) => rest);
}

/** The inverse at confirm: derive the fields from raw, the way extraction did. */
export function restoreFields(stored: readonly StoredSchema[]): ExtractedSchema[] {
  return stored.map((schema) => ({ ...schema, fields: flattenSchema(schema.raw, {}).fields }));
}

/** Where a schema came from. The two shapes 0016's origin check accepts. */
export type SchemaOrigin =
  | { kind: "extracted"; sourceUrl: string }
  | { kind: "uploaded"; createdBy: string };

/** One insert into public.api_schema. */
export type ApiSchemaRow = {
  api_id: string;
  direction: "request" | "response";
  media_type: string;
  status_code: string | null;
  origin: "extracted" | "uploaded";
  source_url: string;
  content_hash: string;
  raw: unknown;
  warnings: string[];
  created_by: string;
};

/** One insert into public.api_schema_field. */
export type ApiSchemaFieldRow = SchemaField & { schema_id: string };

/**
 * The key 0016's api_schema_identity_idx enforces, as a string.
 *
 * Used to pair a schema sent to the database with the id that comes back.
 * PostgREST returns a bulk insert's rows, but matching them to what was sent
 * by position assumes an ordering nothing promises; matching by the identity
 * the database itself enforces does not.
 */
export function schemaIdentity(row: {
  direction: string;
  status_code: string | null;
  media_type: string;
}): string {
  return JSON.stringify([row.direction, row.status_code ?? "", row.media_type]);
}

/**
 * The schemas that belong to one operation of the document.
 *
 * The key is (path, method) -- what identifies an operation inside one
 * document. operation_path is optional on Candidate so that previews created
 * before it existed stay readable; such a candidate simply gets no schemas,
 * which is the truthful answer rather than a guess.
 */
export function schemasForOperation(
  operation: { operation_path?: string; http_method: string },
  documentSchemas: readonly DocumentSchemas[],
): ExtractedSchema[] {
  if (!operation.operation_path) return [];
  const method = operation.http_method.toUpperCase();
  const match = documentSchemas.find(
    (d) => d.operation_path === operation.operation_path && d.http_method === method,
  );
  return match ? match.schemas : [];
}

export function toSchemaRows(
  apiId: string,
  schemas: readonly ExtractedSchema[],
  origin: SchemaOrigin,
): ApiSchemaRow[] {
  const rows: ApiSchemaRow[] = [];
  const seen = new Set<string>();
  for (const schema of schemas) {
    const key = schemaIdentity(schema);
    // Extraction cannot produce the same identity twice for one operation --
    // content is keyed by media type and responses by status -- but a
    // duplicate here would fail the whole bulk insert against 0016's index,
    // losing every schema for the operation over one. Dropping the repeat
    // keeps the rest.
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      api_id: apiId,
      direction: schema.direction,
      media_type: schema.media_type,
      status_code: schema.status_code,
      origin: origin.kind,
      source_url: origin.kind === "extracted" ? origin.sourceUrl : "",
      content_hash: schemaContentHash(schema.raw),
      raw: schema.raw,
      warnings: schema.warnings,
      created_by: origin.kind === "uploaded" ? origin.createdBy : "",
    });
  }
  return rows;
}

/**
 * Field rows for every schema just inserted.
 *
 * `insertedIds` maps schemaIdentity -> the id the database assigned. A schema
 * with no id in that map was not inserted, and its fields are not written:
 * a field row pointing at a schema that does not exist would fail the foreign
 * key, and the whole field insert with it.
 */
export function toFieldRows(
  schemas: readonly ExtractedSchema[],
  insertedIds: ReadonlyMap<string, string>,
): ApiSchemaFieldRow[] {
  const rows: ApiSchemaFieldRow[] = [];
  const done = new Set<string>();
  for (const schema of schemas) {
    const key = schemaIdentity(schema);
    const schemaId = insertedIds.get(key);
    if (!schemaId || done.has(key)) continue;
    done.add(key);
    for (const field of schema.fields) rows.push({ ...field, schema_id: schemaId });
  }
  return rows;
}

/** One insert into public.api_parameter. */
export type ApiParameterRow = {
  api_id: string;
  name: string;
  location: "path" | "query";
  is_required: boolean;
  schema: unknown;
  json_type: string;
  format: string | null;
  enum_values: string[] | null;
  name_norm: string;
  description: string;
  origin: "extracted" | "uploaded";
  source_url: string;
  created_by: string;
};

/**
 * Parameter rows for one operation.
 *
 * The same shape as toSchemaRows: a duplicate (location, name) would fail the
 * whole bulk insert against 0017's identity index and lose every parameter
 * for the operation over one, so a repeat is dropped and the rest kept.
 * Extraction cannot produce one -- extractOperationParameters keys by the
 * pair itself -- but an upload could.
 */
export function toParameterRows(
  apiId: string,
  parameters: readonly ExtractedParameter[],
  origin: SchemaOrigin,
): ApiParameterRow[] {
  const rows: ApiParameterRow[] = [];
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const key = parameterIdentity(parameter);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      api_id: apiId,
      name: parameter.name,
      location: parameter.location,
      is_required: parameter.is_required,
      schema: parameter.schema,
      json_type: parameter.json_type,
      format: parameter.format,
      enum_values: parameter.enum_values,
      name_norm: parameterLeafNorm(parameter.name),
      description: parameter.description,
      origin: origin.kind,
      source_url: origin.kind === "extracted" ? origin.sourceUrl : "",
      created_by: origin.kind === "uploaded" ? origin.createdBy : "",
    });
  }
  return rows;
}

/**
 * The parameters of one operation of the document.
 *
 * The counterpart of schemasForOperation, on the same key and with the same
 * rule: a candidate created before operation_path existed gets none, which is
 * the truthful answer rather than a guess.
 */
export function parametersForOperation(
  operation: { operation_path?: string; http_method: string },
  documentSchemas: readonly DocumentSchemas[],
): ExtractedParameter[] {
  if (!operation.operation_path) return [];
  const method = operation.http_method.toUpperCase();
  const match = documentSchemas.find(
    (d) => d.operation_path === operation.operation_path && d.http_method === method,
  );
  return match?.parameters ?? [];
}
