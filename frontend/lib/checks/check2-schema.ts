/**
 * Check item 2.1 · schema availability (Check Manual §7.4), rules (1)–(7).
 * Also selects the fields that 2.2–2.4 compare.
 */
import { hasUnsupportedTopLevel, parameterFields, schemaFields } from "./fields.ts";
import { normaliseFormats } from "./check1-format.ts";
import { mediaTypeOrder } from "./media-types.ts";
import { declaredDocuments, findCarrier, schemasCarrying } from "./documents.ts";
import type { Field, PairInput, SchemaAvailabilityResult, SchemaRecord } from "./types.ts";

/** The `output_formats` convention for "this operation returns only a status code" (Backlog D12). */
const NO_OUTPUT_BODY = "Status Codes";

export interface SelectedSchemas {
  result: SchemaAvailabilityResult;
  sourceFields: Field[];
  targetFields: Field[];
}

/**
 * Rule (3): the smallest 2xx response; `default` only when no 2xx exists;
 * 4xx/5xx never. When a format is selected, only the schemas carrying it are
 * considered, so a provider that publishes the same response as JSON and as
 * XML is compared in the format the two APIs actually exchange. Within one
 * status code the remaining rows are ordered by media type and id, so the
 * choice never depends on the order the database happened to return.
 */
export function selectSourceSchema(
  schemas: readonly SchemaRecord[],
  format?: string | null,
  category?: string | null,
  documents?: readonly string[],
): { used: SchemaRecord | null; alternatives: SchemaRecord[]; filteredOut: boolean } {
  const responses = schemas.filter((s) => s.direction === "response");
  const inFormat = schemasCarrying(responses, format, category, documents);
  const filteredOut = responses.length > 0 && inFormat.length === 0;
  const success = [...inFormat]
    .filter((s) => /^2\d\d$/.test(s.status_code ?? ""))
    .sort((a, b) => Number(a.status_code) - Number(b.status_code) || mediaTypeOrder(format)(a, b));
  if (success.length > 0) return { used: success[0], alternatives: success.slice(1), filteredOut };
  const fallback = [...inFormat]
    .filter((s) => (s.status_code ?? "").toLowerCase() === "default")
    .sort(mediaTypeOrder(format));
  return { used: fallback[0] ?? null, alternatives: fallback.slice(1), filteredOut };
}

/** Rule (4), target side: the request schema carrying the selected format. */
export function selectTargetRequestSchema(
  schemas: readonly SchemaRecord[],
  format?: string | null,
  category?: string | null,
  documents?: readonly string[],
): { used: SchemaRecord | null; alternatives: SchemaRecord[]; filteredOut: boolean } {
  const requests = schemas.filter((s) => s.direction === "request");
  const inFormat = [...schemasCarrying(requests, format, category, documents)].sort(mediaTypeOrder(format));
  return {
    used: inFormat[0] ?? null,
    alternatives: inFormat.slice(1),
    filteredOut: requests.length > 0 && inFormat.length === 0,
  };
}

function ref(s: SchemaRecord) {
  return { schema_id: s.id, status_code: s.status_code, media_type: s.media_type ?? null };
}

export function runSchemaAvailability(input: PairInput, inputInParameters: boolean): SelectedSchemas {
  const empty: SchemaAvailabilityResult = {
    status: "pass",
    reason_code: null,
    source_schema_used: null,
    source_schema_alternatives: [],
    target_inputs: [],
    flags: [],
  };
  const fail = (result: Partial<SchemaAvailabilityResult>): SelectedSchemas => ({
    result: { ...empty, ...result },
    sourceFields: [],
    targetFields: [],
  });

  const format = input.selectedFormat ?? null;

  // Rule (1)
  const target = selectTargetRequestSchema(input.target.schemas, format, input.target.api.category, declaredDocuments(input.target, "input", input.formatAliases));
  const request = target.used;
  const hasParams = input.target.parameters.length > 0;
  if (!request && !hasParams) {
    return fail({
      status: "unknown",
      reason_code: "target_no_input_schema",
      flags: target.filteredOut ? ["no_schema_for_format"] : [],
    });
  }

  // Rule (2)
  const { used, alternatives, filteredOut } = selectSourceSchema(input.source.schemas, format, input.source.api.category, declaredDocuments(input.source, "output", input.formatAliases));
  if (!used) {
    const out = normaliseFormats(input.source.api.output_formats, input.formatAliases).formats;
    if (out.length === 1 && out[0] === NO_OUTPUT_BODY) return fail({ status: "fail", reason_code: "source_no_output_body" });
    return fail({
      status: "unknown",
      reason_code: "source_no_output_schema",
      flags: filteredOut ? ["no_schema_for_format"] : [],
    });
  }

  // Rule (5) — top-level alternatives cannot be flattened.
  // A schema that carries a whole document is compared as that document, so
  // its alternatives never need flattening (#41).
  const flat = (s: SchemaRecord, category: string | null | undefined) => !!findCarrier(s, category) || !hasUnsupportedTopLevel(s);
  if (!flat(used, input.source.api.category) || (request && !flat(request, input.target.api.category))) {
    return fail({
      status: "unknown",
      reason_code: "schema_unsupported_shape",
      source_schema_used: ref(used),
      source_schema_alternatives: alternatives.map(ref),
      target_schema_used: request ? ref(request) : null,
      target_schema_alternatives: target.alternatives.map(ref),
    });
  }

  // Rule (4)
  const targetInputs: Array<"body" | "parameters"> = [];
  const targetFields: Field[] = [];
  if (request) {
    targetInputs.push("body");
    targetFields.push(...schemaFields(request));
  }
  // With `input_in_parameters` the parameters are the input; when a body
  // exists as well, both are compared (rule (4)).
  if (hasParams && (inputInParameters || request)) {
    targetInputs.push("parameters");
    targetFields.push(...parameterFields(input.target.parameters));
  }
  const sourceFields = schemaFields(used);

  // Rules (6), (7)
  const flags: SchemaAvailabilityResult["flags"] = [];
  const comparable = (s: SchemaRecord) => schemaFields(s).length;
  if (comparable(used) <= 2 || (request && comparable(request) <= 2)) flags.push("thin_schema");
  const unverified = (s: SchemaRecord) => (s.verified_by ?? "").trim() === "";
  if (unverified(used) || (request && unverified(request))) flags.push("schema_unverified");

  return {
    result: {
      status: "pass",
      reason_code: null,
      source_schema_used: ref(used),
      source_schema_alternatives: alternatives.map(ref),
      target_schema_used: request ? ref(request) : null,
      target_schema_alternatives: target.alternatives.map(ref),
      target_inputs: targetInputs,
      flags,
    },
    sourceFields,
    targetFields,
  };
}
