/**
 * A side of a pair that is not in the catalogue: an OpenAPI document read
 * from a link or an uploaded file, or one JSON Schema for one side of one
 * operation (#33). The document goes through the Publisher's own import
 * pipeline — parseOpenApi3 and toApiRow decide the category, authentication
 * and formats exactly as an import would; extractDocumentSchemas and the
 * upload reader produce the same schema rows an import would store — so the
 * check engine sees the same shape of data whether a side was saved or not.
 * No database, no network: the caller fetches and loads the aliases.
 */
import { parseOpenApi3 } from "../openapi/parse.ts";
import { toApiRow, type AliasMaps } from "../import/candidate-record.ts";
import type { Candidate } from "../import/types.ts";
import { extractDocumentSchemas, schemaContentHash, type ExtractedSchema } from "../schema/extract.ts";
import { resolveUpload, type OperationRef } from "../schema/upload.ts";
import { schemasForOperation } from "../schema/rows.ts";
import type { ApiSideInput, ParameterRecord, SchemaRecord } from "./types.ts";

export type AdhocSideSpec =
  | { kind: "openapi"; document: unknown; document_url: string; operation?: OperationRef }
  | { kind: "schema"; text: string; direction: "request" | "response"; media_type?: string };

export type AdhocSide = ApiSideInput & { operations?: OperationRef[]; warnings: string[] };

export class AdhocSideError extends Error {
  readonly operations: OperationRef[];
  constructor(message: string, operations: OperationRef[] = []) {
    super(message);
    this.operations = operations;
  }
}

function schemaRecords(apiId: string, schemas: readonly ExtractedSchema[]): SchemaRecord[] {
  return schemas.map((s, i) => ({
    id: `${apiId}:schema:${i}`,
    api_id: apiId,
    direction: s.direction,
    status_code: s.status_code,
    media_type: s.media_type,
    raw: s.raw,
    verified_by: null,
    content_hash: schemaContentHash(s.raw),
    fields: s.fields.map((f) => ({ ...f, description: f.description || null })),
  }));
}

function candidateFor(parsed: { candidates: Candidate[] }, operation: OperationRef | undefined): Candidate {
  const listed = parsed.candidates.map((c) => ({ path: c.operation_path ?? c.api_endpoint, method: c.http_method }));
  if (operation) {
    const method = operation.method.toUpperCase();
    const match = parsed.candidates.find((c) => (c.operation_path ?? "") === operation.path && c.http_method.toUpperCase() === method)
      ?? parsed.candidates.find((c) => c.api_endpoint.endsWith(operation.path) && c.http_method.toUpperCase() === method);
    if (!match) throw new AdhocSideError(`The document has no ${method} ${operation.path}.`, listed);
    return match;
  }
  if (parsed.candidates.length === 1) return parsed.candidates[0];
  throw new AdhocSideError(`The document has ${parsed.candidates.length} operations. Choose the one to compare.`, listed);
}

/** Build the engine's view of a side that is not in the catalogue. */
export function buildAdhocSide(spec: AdhocSideSpec, side: "source" | "target", aliases: AliasMaps): AdhocSide {
  const apiId = `adhoc-${side}`;
  if (spec.kind === "schema") {
    const read = resolveUpload({ kind: "schema", text: spec.text, direction: spec.direction, media_type: spec.media_type });
    if (!read.ok) throw new AdhocSideError(read.error);
    const media = read.schemas[0]?.media_type ?? "application/json";
    const format = aliases.format.get(media) ?? aliases.format.get(media.toLowerCase()) ?? media;
    return {
      api: {
        id: apiId, api_name: side === "source" ? "Uploaded source schema" : "Uploaded target schema", company_name: "",
        category: null, api_endpoint: null, http_method: null,
        input_formats: side === "target" ? [format] : [], output_formats: side === "source" ? [format] : [],
        authentication_method: null, authentication_details: null, invoice_standard: [],
      },
      schemas: schemaRecords(apiId, read.schemas),
      parameters: [],
      warnings: read.schemas.flatMap((s) => s.warnings),
    };
  }

  let parsed;
  try {
    parsed = parseOpenApi3(spec.document, spec.document_url);
  } catch (error) {
    throw new AdhocSideError(error instanceof Error ? error.message : "The document could not be read as OpenAPI.");
  }
  if (parsed.candidates.length === 0) throw new AdhocSideError("The document declares no operation.");
  const candidate = candidateFor(parsed, spec.operation);
  const row = toApiRow(candidate, spec.document_url, aliases);
  const documentSchemas = extractDocumentSchemas(spec.document);
  const schemas = schemasForOperation(candidate, documentSchemas);
  const found = documentSchemas.find((d) => d.operation_path === candidate.operation_path && d.http_method === candidate.http_method.toUpperCase());
  const parameters: ParameterRecord[] = (found?.parameters ?? []).map((p) => ({
    name: p.name, name_norm: p.name.toLowerCase().replace(/[^a-z0-9]/g, ""), location: p.location,
    json_type: p.json_type, format: p.format, is_required: p.is_required, enum_values: p.enum_values, description: p.description || null,
  }));
  return {
    api: {
      id: apiId, api_name: row.api_name, company_name: row.company_name,
      category: row.category, api_endpoint: row.api_endpoint, http_method: row.http_method,
      input_formats: row.input_formats, output_formats: row.output_formats,
      authentication_method: row.authentication_method, authentication_details: row.authentication_other, invoice_standard: [],
    },
    schemas: schemaRecords(apiId, schemas),
    parameters,
    operations: parsed.candidates.map((c) => ({ path: c.operation_path ?? c.api_endpoint, method: c.http_method })),
    warnings: [...parsed.warnings, ...schemas.flatMap((s) => s.warnings), ...(found?.parameter_warnings ?? [])],
  };
}
