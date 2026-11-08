// OpenAPI operation -> schemas -> flat field rows. Pure: no network, no
// database, no clock.
//
// The importer already walks requestBody and responses to fill input_formats
// and output_formats, then discards the schemas. This module keeps them,
// because the BP-Builder decides whether operation A's output can feed
// operation B's input, and formats alone cannot tell it anything: the whole
// catalogue is JSON.
//
// Two outputs, matching migration 0016's two tables. `raw` is the schema as
// stated after local $ref resolution and stays authoritative; `fields` is the
// same thing flattened to one row per leaf, which is the form a comparison
// can query. fields is derived and can always be rebuilt from raw.
//
// Every value is what the document STATES. A schema with no `type` produces
// json_type 'unknown', not a guess.

import { createHash } from "node:crypto";

import { isObject, refOf, resolveRef, text, type JsonObject } from "../openapi/ref.ts";
import { enumOf, jsonTypeOf, normaliseLeafName, JSON_TYPES, type JsonType } from "./json-type.ts";
import { extractOperationParameters, type ExtractedParameter } from "./parameters.ts";

// Re-exported: these were defined here before parameters.ts needed them too,
// and every existing importer names extract.ts.
export { enumOf, jsonTypeOf, normaliseLeafName, JSON_TYPES };
export type { JsonType };

/** Deeper than any invoice schema seen in the four fixture documents. */
const MAX_FIELD_DEPTH = 12;

/** One row of public.api_schema_field. */
export type SchemaField = {
  /** Dotted path from the schema root; '[]' marks an array boundary. */
  path: string;
  leaf_name: string;
  leaf_name_norm: string;
  json_type: JsonType;
  format: string | null;
  is_required: boolean;
  is_array_item: boolean;
  depth: number;
  enum_values: string[] | null;
  description: string;
};

/** One row of public.api_schema, minus the columns only the writer knows. */
export type ExtractedSchema = {
  direction: "request" | "response";
  media_type: string;
  /** The response key as stated: '200', '2XX', 'default'. Null on requests. */
  status_code: string | null;
  raw: unknown;
  fields: SchemaField[];
  warnings: string[];
};

/**
 * Merge the branches of allOf into one object node.
 *
 * allOf is how real specifications compose a schema from parts, and a field
 * that arrives through one is an ordinary field of the object. Ignoring it
 * would silently drop most of the fields in documents that use it.
 *
 * oneOf and anyOf are different: they state alternatives, and a field present
 * in one alternative is not a field of the object. Those warn instead.
 */
function flattenComposition(
  node: JsonObject,
  root: JsonObject,
  warnings: string[],
  refChain: readonly string[],
): JsonObject {
  if (!Array.isArray(node.allOf)) return node;
  const merged: JsonObject = { ...node };
  delete merged.allOf;
  const properties: JsonObject = isObject(node.properties) ? { ...node.properties } : {};
  const required = new Set<string>(
    Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === "string") : [],
  );
  for (const branch of node.allOf) {
    const ref = refOf(branch);
    if (ref && refChain.includes(ref)) {
      warnings.push(`recursive $ref not expanded: ${ref}`);
      continue;
    }
    const resolved = resolveRef(branch, root, warnings);
    if (!isObject(resolved)) continue;
    const inner = flattenComposition(resolved, root, warnings, ref ? [...refChain, ref] : refChain);
    if (isObject(inner.properties)) Object.assign(properties, inner.properties);
    if (Array.isArray(inner.required)) {
      for (const r of inner.required) if (typeof r === "string") required.add(r);
    }
    if (merged.type === undefined && inner.type !== undefined) merged.type = inner.type;
  }
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

type WalkContext = {
  root: JsonObject;
  warnings: string[];
  out: SchemaField[];
};

function walk(
  node: unknown,
  ctx: WalkContext,
  path: string,
  depth: number,
  isRequired: boolean,
  insideArray: boolean,
  refChain: readonly string[],
): void {
  if (depth > MAX_FIELD_DEPTH) {
    ctx.warnings.push(`depth limit reached at ${path || "(root)"}`);
    return;
  }

  const ref = refOf(node);
  if (ref && refChain.includes(ref)) {
    // A schema that contains itself. Stopping here is the only finite answer;
    // saying so is more use than a stack overflow or a silent truncation.
    ctx.warnings.push(`recursive $ref not expanded: ${ref}`);
    return;
  }

  const resolved = resolveRef(node, ctx.root, ctx.warnings);
  if (!isObject(resolved)) return;
  const chain = ref ? [...refChain, ref] : refChain;
  const schema = flattenComposition(resolved, ctx.root, ctx.warnings, chain);

  // Record the node itself, unless it has no name of its own. That is true of
  // the schema root, and also of the items node of a root-level array: an
  // endpoint returning a bare list has a shape but the list itself is not a
  // field, so its path is '[]' and its leaf name is empty. Its members still
  // get rows, at '[].invoiceNumber' and below.
  const leaf = path.split(".").at(-1)?.replace(/\[\]$/, "") ?? "";
  if (leaf !== "") {
    ctx.out.push({
      path,
      leaf_name: leaf,
      leaf_name_norm: normaliseLeafName(leaf),
      json_type: jsonTypeOf(schema),
      format: text(schema.format) || null,
      is_required: isRequired,
      is_array_item: insideArray,
      // Derived from the path rather than carried down the recursion: the
      // path is the definition of how deep a field is, and two sources for
      // one number is how they come to disagree.
      depth: path.split(".").length - 1,
      enum_values: enumOf(schema),
      description: text(schema.description),
    });
  }

  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    // Alternatives, not members. Descending would report fields the operation
    // may never send.
    ctx.warnings.push(
      `oneOf/anyOf at ${path || "(root)"} states alternatives; its branches are not flattened`,
    );
  }

  const type = jsonTypeOf(schema);

  if (type === "array") {
    const items = schema.items;
    if (items === undefined) {
      ctx.warnings.push(`array at ${path || "(root)"} states no items`);
      return;
    }
    // The array boundary is part of the path, so a comparison can tell one
    // invoice from many.
    walk(items, ctx, `${path}[]`, depth, isRequired, true, chain);
    return;
  }

  const properties = isObject(schema.properties) ? schema.properties : null;
  if (!properties) return;
  const required = new Set<string>(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  for (const [name, child] of Object.entries(properties)) {
    walk(
      child,
      ctx,
      path === "" ? name : `${path}.${name}`,
      depth + 1,
      required.has(name),
      insideArray,
      chain,
    );
  }
}

/**
 * Inline every local $ref, so the schema stands on its own.
 *
 * api_schema.raw is stored without the document it came from, and 0016
 * promises that the flattened fields can be rebuilt from raw alone. Resolving
 * only the outermost $ref does not keep that promise: on the Poland KSeF
 * document, 196 of 441 schemas still pointed into components that would not
 * be stored with them.
 *
 * A reference back into its own ancestry cannot be inlined -- that is an
 * infinite schema. It is replaced by a node carrying the target's type and an
 * x-recursive-ref marker, so the field is still recorded with an honest type
 * and a reader can see where the recursion is. External refs stay as they
 * are, and warn, as they do everywhere else.
 */
export function dereferenceSchema(
  schema: unknown,
  root: JsonObject,
  warnings: string[],
): unknown {
  const visit = (node: unknown, chain: readonly string[], depth: number): unknown => {
    if (Array.isArray(node)) return node.map((n) => visit(n, chain, depth));
    if (!isObject(node)) return node;
    if (depth > MAX_FIELD_DEPTH * 2) {
      warnings.push("depth limit reached while inlining references");
      return node;
    }
    const ref = refOf(node);
    if (ref) {
      if (!ref.startsWith("#/")) {
        warnings.push(`external $ref not resolved: ${ref}`);
        return node;
      }
      if (chain.includes(ref)) {
        warnings.push(`recursive $ref not expanded: ${ref}`);
        const target = resolveRef(node, root, []);
        const type = isObject(target) ? target.type : undefined;
        return { ...(type !== undefined ? { type } : {}), "x-recursive-ref": ref };
      }
      const target = resolveRef(node, root, warnings);
      if (target === undefined) return node;
      return visit(target, [...chain, ref], depth + 1);
    }
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) out[key] = visit(value, chain, depth + 1);
    return out;
  };
  return visit(schema, [], 0);
}

/** Flatten one schema to one row per leaf. */
export function flattenSchema(
  schema: unknown,
  root: JsonObject,
): { fields: SchemaField[]; warnings: string[] } {
  const ctx: WalkContext = { root, warnings: [], out: [] };
  walk(schema, ctx, "", 0, false, false, []);
  return { fields: ctx.out, warnings: ctx.warnings };
}

/** content: { "<media type>": { schema } } -> one entry per media type. */
function schemasUnderContent(
  container: unknown,
  root: JsonObject,
  warnings: string[],
): { media_type: string; schema: unknown }[] {
  const resolved = resolveRef(container, root, warnings);
  if (!isObject(resolved) || !isObject(resolved.content)) return [];
  const out: { media_type: string; schema: unknown }[] = [];
  for (const [mediaType, entry] of Object.entries(resolved.content)) {
    const media = mediaType.trim();
    if (!media) continue;
    const resolvedEntry = resolveRef(entry, root, warnings);
    if (!isObject(resolvedEntry) || resolvedEntry.schema === undefined) {
      // A media type declared with no schema. The operation accepts or
      // returns that type; what it looks like is simply not stated.
      warnings.push(`${media} states no schema`);
      continue;
    }
    out.push({ media_type: media, schema: resolvedEntry.schema });
  }
  return out;
}

/**
 * The media types a Swagger 2.0 operation states, from the operation's own
 * `consumes`/`produces` or the document's.
 *
 * No default is applied. Swagger 2.0 does not define one, and inventing
 * `application/json` would put a media type in the row that the document
 * never stated -- api_schema.media_type is documented as "the media type key
 * as the document stated it".
 */
function swaggerMediaTypes(op: JsonObject, root: JsonObject, key: "consumes" | "produces"): string[] {
  const stated = Array.isArray(op[key]) ? op[key] : Array.isArray(root[key]) ? root[key] : [];
  return stated
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim());
}

/**
 * A Swagger 2.0 request body: the one parameter with `in: "body"`.
 *
 * detect.ts has always classified these documents as swagger_2, but extraction
 * read only the OpenAPI 3 shape (`requestBody`, schemas under `content`), so a
 * 2.0 document was recognised and then yielded nothing at all. Vendors still
 * publish 2.0 -- Storecove's is one -- and this is the whole difference
 * between reading such a document and silently storing nothing for it.
 */
function swaggerBodyParameter(op: JsonObject, root: JsonObject, warnings: string[]): unknown {
  const parameters = Array.isArray(op.parameters) ? op.parameters : [];
  for (const parameter of parameters) {
    const resolved = resolveRef(parameter, root, warnings);
    if (isObject(resolved) && text(resolved.in) === "body" && resolved.schema !== undefined) {
      return resolved.schema;
    }
  }
  return undefined;
}

/**
 * Every schema one operation states: its request body, and each response.
 *
 * Responses keep their status key rather than being reduced to "the success
 * one". Which status a chain should read is a decision for the person
 * composing it, and 'default' and '2XX' are both legal keys -- collapsing
 * them here would discard the information needed to make that choice.
 */
export function extractOperationSchemas(
  operation: unknown,
  document: unknown,
): ExtractedSchema[] {
  if (!isObject(document)) return [];
  const root = document;
  const op = resolveRef(operation, root, []);
  if (!isObject(op)) return [];

  const out: ExtractedSchema[] = [];

  const emit = (
    mediaType: string,
    schema: unknown,
    direction: "request" | "response",
    statusCode: string | null,
    containerWarnings: string[],
  ): void => {
    const rawWarnings: string[] = [];
    const raw = dereferenceSchema(schema, root, rawWarnings);
    // Fields come from raw, not from the document. That makes "rebuild the
    // fields from raw" the same code path as the first extraction, rather
    // than a second path that could disagree with it.
    const { fields, warnings: flatWarnings } = flattenSchema(raw, {});
    out.push({
      direction,
      media_type: mediaType,
      status_code: statusCode,
      raw,
      fields,
      warnings: [...new Set([...containerWarnings, ...rawWarnings, ...flatWarnings])],
    });
  };

  const collect = (
    container: unknown,
    direction: "request" | "response",
    statusCode: string | null,
  ): number => {
    const containerWarnings: string[] = [];
    const found = schemasUnderContent(container, root, containerWarnings);
    for (const { media_type, schema } of found) {
      emit(media_type, schema, direction, statusCode, containerWarnings);
    }
    return found.length;
  };

  // Swagger 2.0 states the same things elsewhere, so the 2.0 shape is read
  // only where the OpenAPI 3 shape found nothing. An OpenAPI 3 document is
  // therefore extracted exactly as before.
  const collectSwagger = (
    schema: unknown,
    direction: "request" | "response",
    statusCode: string | null,
    key: "consumes" | "produces",
    label: string,
  ): void => {
    if (schema === undefined) return;
    const warnings: string[] = [];
    const media = swaggerMediaTypes(op, root, key);
    if (media.length === 0) {
      warnings.push(`${label} states a schema but no ${key} media type`);
      return;
    }
    for (const mediaType of media) emit(mediaType, schema, direction, statusCode, warnings);
  };

  if (collect(op.requestBody, "request", null) === 0) {
    const bodyWarnings: string[] = [];
    const body = swaggerBodyParameter(op, root, bodyWarnings);
    collectSwagger(body, "request", null, "consumes", "the request body");
  }

  const responses = isObject(op.responses) ? op.responses : {};
  for (const [status, response] of Object.entries(responses)) {
    const statusKey = status.trim();
    if (!statusKey) continue;
    if (collect(response, "response", statusKey) > 0) continue;
    const resolved = resolveRef(response, root, []);
    if (isObject(resolved)) {
      collectSwagger(resolved.schema, "response", statusKey, "produces", `response ${statusKey}`);
    }
  }

  return out;
}

/**
 * A hash of the schema that does not change when a provider reorders keys.
 *
 * Its purpose is change detection: on re-import, a schema whose hash matches
 * the stored one has not changed and its flattened rows can stand. Without a
 * canonical key order the hash would differ on every fetch of an unchanged
 * document and every re-import would look like a provider revision.
 */
export function schemaContentHash(schema: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isObject(value)) {
      const sorted: JsonObject = {};
      for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key]);
      return sorted;
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(schema))).digest("hex");
}

/** Every schema in a document, keyed by the operation it belongs to. */
export type DocumentSchemas = {
  operation_path: string;
  http_method: string;
  schemas: ExtractedSchema[];
  /**
   * The operation's path/query parameters; see lib/schema/parameters.ts.
   *
   * Optional because not every producer of this type has parameters to state:
   * the NAV WADL path (scripts/plan-nav-schemas.ts) builds operations from
   * XML, where the concept does not appear. extractDocumentSchemas always
   * sets both, so an absent value means "this producer states none", never
   * "not looked at".
   */
  parameters?: ExtractedParameter[];
  /** Notes from reading the parameters, kept apart from the schemas' own. */
  parameter_warnings?: string[];
};

const METHODS = [
  "get", "post", "put", "patch", "delete", "head", "options", "trace",
] as const;

/**
 * Walk a whole OpenAPI 3.x document. The key is (path, method), which is what
 * identifies an operation in the catalogue as well: 0007 added http_method to
 * public.apis for exactly this reason.
 */
export function extractDocumentSchemas(document: unknown): DocumentSchemas[] {
  if (!isObject(document)) return [];
  const root = document;
  const paths = isObject(root.paths) ? root.paths : {};
  const out: DocumentSchemas[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = resolveRef(item, root, []);
    if (!isObject(pathItem)) continue;
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!isObject(op)) continue;
      const schemas = extractOperationSchemas(op, root);
      const { parameters, warnings } = extractOperationParameters(pathItem, op, root);
      // An operation with no body but with path/query parameters used to be
      // dropped here, which is how seven live records ended up with nothing
      // stored although their documents parse perfectly well. Parameters are
      // an input in their own right, so either one keeps the operation.
      if (schemas.length === 0 && parameters.length === 0) continue;
      out.push({
        operation_path: path, http_method: method.toUpperCase(), schemas,
        parameters, parameter_warnings: warnings,
      });
    }
  }
  return out;
}
