import type {
  ArrayNode,
  NormalizedNode,
  ObjectNode,
  PrimitiveNode,
  SchemaEntry,
} from "./types.ts";
import { normalizeName } from "./name.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type name for a raw JSON value, used when a bare value stands in for a schema. */
export function inferPrimitiveType(value: unknown): string {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "bigint") return "integer";
  if (typeof value === "string") return "string";
  return "unknown";
}

function copyIfPresent(from: Record<string, unknown>, to: Record<string, unknown>, key: string) {
  if (key in from) {
    const v = from[key];
    to[key] = key === "enum" && Array.isArray(v) ? [...v] : v;
  }
}

/**
 * Bring any schema-ish input (an OpenAPI/JSON Schema fragment, an XML
 * extractor result, a bare value) into the engine's canonical shape.
 *
 * Rules worth knowing:
 *  - an object with no "required" list treats EVERY property as required.
 *    This follows the reference project (W13C-BREAD CompatibilityEngine),
 *    whose schemas came from sample data and never carried a required list;
 *    it is the opposite of the JSON Schema default that public.api_schema_field
 *    uses (is_required = false). Kept so the acceptance verdicts match the
 *    reference engine issue for issue; revisit once that baseline is no
 *    longer needed;
 *  - "attributes" (from XML) become "@name" properties and are always required;
 *  - "required" and "properties" are both sorted alphabetically (the upstream
 *    engine kept property order; we sort so jsonb storage cannot change results).
 */
export function normalizeSchema(schema: unknown): NormalizedNode {
  if (schema === null || schema === undefined) {
    return { type: "unknown" };
  }
  if (!isObject(schema)) {
    return { type: inferPrimitiveType(schema) };
  }
  const map = schema;

  if ("root" in map && "schema" in map && !("type" in map)) {
    const rootNode = normalizeSchema(map.schema) as unknown as Record<string, unknown>;
    return { ...rootNode, xml_root: map.root } as unknown as NormalizedNode;
  }

  if (Array.isArray(map.allOf)) {
    return normalizeSchema(mergeAllOf(map));
  }

  if ("oneOf" in map) {
    return { oneOf: normalizeVariants(map.oneOf) };
  }
  if ("anyOf" in map) {
    return { anyOf: normalizeVariants(map.anyOf) };
  }

  if ("properties" in map || "attributes" in map || map.type === "object") {
    const properties: Record<string, NormalizedNode> = {};
    if (isObject(map.attributes)) {
      for (const [name, child] of Object.entries(map.attributes)) {
        properties[`@${name}`] = isObject(child)
          ? normalizeSchema(child)
          : { type: typeof child === "string" ? child : "string" };
      }
    }
    if (isObject(map.properties)) {
      for (const [name, child] of Object.entries(map.properties)) {
        properties[name] = normalizeSchema(child);
      }
    }

    // Properties are visited in key order by the engine, and the first target
    // field to claim a source path wins. Postgres jsonb does not preserve key
    // order, so sort here to make results independent of storage.
    const sortedProperties: Record<string, NormalizedNode> = {};
    for (const key of Object.keys(properties).sort()) sortedProperties[key] = properties[key];

    let required: string[];
    const rawRequired = map.required;
    if (rawRequired === null || rawRequired === undefined) {
      required = Object.keys(properties);
    } else {
      required = Array.isArray(rawRequired) ? rawRequired.map(String) : [];
      for (const key of Object.keys(properties)) {
        if (key.startsWith("@") && !required.includes(key)) required.push(key);
      }
    }

    const normalized: ObjectNode = {
      type: "object",
      properties: sortedProperties,
      required: [...new Set(required)].sort(),
    };
    const out = normalized as unknown as Record<string, unknown>;
    copyIfPresent(map, out, "enum");
    copyIfPresent(map, out, "description");
    copyIfPresent(map, out, "example");
    copyIfPresent(map, out, "xml_root");
    return normalized;
  }

  if ("items" in map || map.type === "array") {
    const normalized: ArrayNode = {
      type: "array",
      items: normalizeSchema(map.items ?? {}),
    };
    copyIfPresent(map, normalized as unknown as Record<string, unknown>, "enum");
    return normalized;
  }

  const normalized: PrimitiveNode = {
    type: typeof map.type === "string" ? map.type : "unknown",
  };
  const out = normalized as unknown as Record<string, unknown>;
  copyIfPresent(map, out, "enum");
  copyIfPresent(map, out, "description");
  copyIfPresent(map, out, "example");
  // Not in the upstream engine: OpenAPI's value convention (date, date-time,
  // uuid, ...) is kept so two strings with different conventions can be flagged.
  if (typeof map.format === "string") out.format = map.format;
  return normalized;
}

/**
 * Merge the branches of an allOf into one plain schema.
 *
 * Stored schemas (api_schema.raw) keep allOf exactly as the document wrote
 * it; only $ref is inlined there. Real documents build most of their objects
 * this way (KSeF: 274 allOf), so an engine that skipped them would see empty
 * objects. Properties and required lists are unioned across branches; the
 * first branch to state a type wins; keys on the node itself (description,
 * enum, ...) are kept. oneOf / anyOf are alternatives, not parts, and are
 * handled separately by the caller.
 */
export function mergeAllOf(node: Record<string, unknown>): Record<string, unknown> {
  const { allOf, ...rest } = node;
  const merged: Record<string, unknown> = { ...rest };
  const properties: Record<string, unknown> = isObject(rest.properties) ? { ...rest.properties } : {};
  const required = new Set<string>(Array.isArray(rest.required) ? rest.required.map(String) : []);
  let sawProperties = isObject(rest.properties);
  let sawRequired = Array.isArray(rest.required);

  for (const branch of Array.isArray(allOf) ? allOf : []) {
    if (!isObject(branch)) continue;
    const inner = Array.isArray(branch.allOf) ? mergeAllOf(branch) : branch;
    if (isObject(inner.properties)) {
      Object.assign(properties, inner.properties);
      sawProperties = true;
    }
    if (Array.isArray(inner.required)) {
      for (const r of inner.required) required.add(String(r));
      sawRequired = true;
    }
    for (const key of ["type", "items", "enum", "format", "description", "example"]) {
      if (merged[key] === undefined && inner[key] !== undefined) merged[key] = inner[key];
    }
  }
  if (sawProperties) merged.properties = properties;
  // An explicit (possibly empty) required list must survive: with no list at
  // all, normalizeSchema treats every property as required.
  if (sawRequired) merged.required = [...required];
  return merged;
}

function normalizeVariants(options: unknown): NormalizedNode[] {
  return Array.isArray(options) ? options.map((o) => normalizeSchema(o)) : [];
}

/**
 * Flatten a normalised schema into a list of every node with its path.
 * Container nodes are included, not just leaves, because a target field
 * may map onto a whole source object or array.
 */
export function buildIndex(node: NormalizedNode, path: string): SchemaEntry[] {
  const entries: SchemaEntry[] = [];
  const nodeType = typeof (node as { type?: unknown }).type === "string"
    ? ((node as { type: string }).type)
    : "unknown";
  const segments = path.split(".");
  const leaf = segments[segments.length - 1].replace("[]", "").replace("$", "root");
  entries.push({ path, leaf, leafNorm: normalizeName(leaf), node, nodeType });

  if (nodeType === "object") {
    const props = (node as ObjectNode).properties;
    if (props && typeof props === "object") {
      for (const [key, child] of Object.entries(props)) {
        const childPath = path === "$" ? key : `${path}.${key}`;
        entries.push(...buildIndex(child, childPath));
      }
    }
  } else if (nodeType === "array") {
    const childPath = path === "$" ? "[]" : `${path}[]`;
    const items = (node as ArrayNode).items ?? { type: "unknown" };
    entries.push(...buildIndex(items, childPath));
  }
  return entries;
}
