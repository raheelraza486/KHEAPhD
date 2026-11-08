// An operation's path and query parameters, as the document states them.
//
// Why this is not part of api_schema: extract.ts records request and response
// *bodies*, and an operation whose whole input is parameters has no body at
// all. extractDocumentSchemas used to drop such operations, so they reached
// the catalogue with nothing stored and the comparison screen could only
// answer "cannot be determined" for them. On the live catalogue that is seven
// records -- six Serbian SEF download operations
// (GET /api/publicApi/sales-invoice/xml?invoiceId=...) and one Poland KSeF
// session operation -- whose documents parse perfectly well as OpenAPI 3.
//
// Parameters belong to the operation, not to one of its body schemas, so they
// are their own rows keyed by api_id (migration 0017) rather than a synthetic
// api_schema row with an invented media type.
//
// Pure: no network, no database, no clock. The same division extract.ts has.

import { isObject, resolveRef, text, type JsonObject } from "../openapi/ref.ts";
import { enumOf, jsonTypeOf, normaliseLeafName, type JsonType } from "./json-type.ts";

/**
 * Only path and query are stored.
 *
 * A header or cookie parameter (Authorization, Content-Type, a session
 * cookie) is a transport concern: it is not data the previous operation has
 * to supply, and lib/compatibility/parameters.ts already skips those
 * locations when it compares. Storing them would put credentials-shaped
 * names into the field vocabulary for nothing. The same kind of decision as
 * isChainable's, made in one place.
 */
const DATA_LOCATIONS = ["path", "query"] as const;
const MAX_PARAMETER_DEPTH = 4;
export type ParameterLocation = (typeof DATA_LOCATIONS)[number];

/** One row of public.api_parameter, minus the columns only the writer knows. */
export type ExtractedParameter = {
  name: string;
  location: ParameterLocation;
  /** Path parameters are required by the specification, whatever it says. */
  is_required: boolean;
  /** The parameter's own schema as stated, after local $ref resolution. */
  schema: unknown;
  json_type: JsonType;
  format: string | null;
  enum_values: string[] | null;
  description: string;
};

function isDataLocation(value: unknown): value is ParameterLocation {
  return typeof value === "string" && (DATA_LOCATIONS as readonly string[]).includes(value);
}

/** The identity migration 0017's unique index enforces, as a string. */
export function parameterIdentity(parameter: { location: string; name: string }): string {
  return `${parameter.location}:${parameter.name}`;
}

/**
 * The path/query parameters of one operation.
 *
 * `pathItem.parameters` applies to every operation under that path and
 * `operation.parameters` may override an entry; the specification says a
 * parameter is identified by the pair (name, in), so that pair is the
 * override key. Order is the document's own, path-item entries first, which
 * keeps a rebuild from the same document stable.
 */
export function extractOperationParameters(
  pathItem: JsonObject,
  operation: JsonObject,
  root: JsonObject,
): { parameters: ExtractedParameter[]; warnings: string[] } {
  const warnings: string[] = [];
  const byIdentity = new Map<string, ExtractedParameter>();

  for (const list of [pathItem.parameters, operation.parameters]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      warnings.push("A parameters value was not a list and was ignored.");
      continue;
    }
    for (const entry of list) {
      const parameter = resolveRef(entry, root, []);
      if (!isObject(parameter)) {
        // An unresolved $ref is a note, not a failure: the rest of the
        // operation is still worth storing.
        warnings.push("A parameter reference could not be resolved and was skipped.");
        continue;
      }
      const name = text(parameter.name);
      const location = parameter.in;
      if (!name) continue;
      if (!isDataLocation(location)) continue;

      const schema = isObject(parameter.schema)
        ? dereferenceParameterSchema(parameter.schema, root, warnings)
        : undefined;
      // A parameter with no schema is a string as far as comparison goes;
      // lib/compatibility/parameters.ts makes the same assumption, and
      // recording it here means both sides agree without a second rule.
      const node: JsonObject = schema ?? { type: "string" };

      byIdentity.set(parameterIdentity({ location, name }), {
        name,
        location,
        is_required: location === "path" ? true : parameter.required === true,
        schema: node,
        json_type: jsonTypeOf(node),
        format: text(node.format) || null,
        enum_values: enumOf(node),
        description: text(parameter.description),
      });
    }
  }
  return { parameters: [...byIdentity.values()], warnings };
}

/**
 * Resolve local $refs inside a parameter's schema, the way extract.ts does
 * for a body: what is stored has to stand on its own, because the components
 * section it pointed into is not stored with it.
 */
function dereferenceParameterSchema(
  schema: JsonObject,
  root: JsonObject,
  warnings: string[],
  depth = 0,
): JsonObject {
  const resolved = resolveRef(schema, root, warnings);
  if (!isObject(resolved)) {
    warnings.push("A parameter schema reference could not be resolved.");
    return { type: "string" };
  }
  const out: JsonObject = { ...resolved };
  // A parameter schema is a primitive or an array of primitives in practice;
  // one level of items is all that needs following, and the depth guard stops
  // a document that points items back at itself.
  if (isObject(resolved.items) && depth < MAX_PARAMETER_DEPTH) {
    out.items = dereferenceParameterSchema(resolved.items, root, warnings, depth + 1);
  }
  return out;
}

/**
 * The shape lib/compatibility/parameters.ts compares against, rebuilt from
 * stored rows. Kept here so the storage format and the engine's input stay
 * described in one place; the engine's own type is structural.
 */
export function toOpenApiParameters(
  rows: readonly Pick<ExtractedParameter, "name" | "location" | "is_required" | "schema">[],
): { name: string; in: ParameterLocation; required: boolean; schema: unknown }[] {
  return rows.map((row) => ({
    name: row.name,
    in: row.location,
    required: row.is_required,
    schema: row.schema,
  }));
}

/** Field-style path for a parameter, matching field-comparison.ts's key. */
export function parameterFieldPath(parameter: { location: string; name: string }): string {
  return `${parameter.location}:${parameter.name}`;
}

/** leaf_name_norm for a parameter, on the same rule field rows use. */
export function parameterLeafNorm(name: string): string {
  return normaliseLeafName(name);
}
