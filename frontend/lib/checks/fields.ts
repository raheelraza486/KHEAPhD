/**
 * Field model shared by check items 2.1–2.4: schema fields and parameters
 * are turned into one `Field` shape, and a scalar body becomes the synthetic
 * `(body)` field (Check Manual §7.4, rule (5)).
 */
import type { Field, ParameterRecord, SchemaRecord } from "./types.ts";

export const BODY_FIELD = "(body)";

export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parentOf(path: string): string | null {
  const stripped = path.replace(/\[\]$/, "");
  const i = stripped.lastIndexOf(".");
  return i < 0 ? null : stripped.slice(0, i);
}

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

function rawObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** Top-level `anyOf` / `oneOf` — Check Manual §7.4 rule (5), reason `schema_unsupported_shape`. */
export function hasUnsupportedTopLevel(schema: SchemaRecord): boolean {
  const raw = rawObject(schema.raw);
  return !!raw && (Array.isArray(raw.anyOf) || Array.isArray(raw.oneOf));
}

/**
 * The top level is a scalar, or an array of scalars: the whole body is one
 * value with no field name of its own. It takes part as `(body)`.
 */
export function scalarBodyType(schema: SchemaRecord): { jsonType: string; format: string | null } | null {
  const raw = rawObject(schema.raw);
  if (!raw) return null;
  const type = typeof raw.type === "string" ? raw.type : null;
  if (type && SCALAR_TYPES.has(type)) return { jsonType: type, format: typeof raw.format === "string" ? raw.format : null };
  if (type === "array") {
    const items = rawObject(raw.items);
    const itemType = items && typeof items.type === "string" ? items.type : null;
    if (itemType && SCALAR_TYPES.has(itemType)) return { jsonType: "array", format: null };
  }
  return null;
}

export function schemaFields(schema: SchemaRecord): Field[] {
  const fields: Field[] = schema.fields.map((f) => ({
    path: f.path,
    leaf: f.leaf_name,
    name: f.leaf_name_norm || normaliseName(f.leaf_name),
    parent: parentOf(f.path),
    jsonType: f.json_type ?? "unknown",
    format: f.format,
    required: !!f.is_required,
    arrayItem: !!f.is_array_item,
    depth: f.depth,
    enumValues: f.enum_values,
    description: f.description,
    isParameter: false,
  }));
  if (fields.length === 0) {
    const scalar = scalarBodyType(schema);
    if (scalar) {
      fields.push({
        path: BODY_FIELD,
        leaf: BODY_FIELD,
        name: BODY_FIELD,
        parent: null,
        jsonType: scalar.jsonType,
        format: scalar.format,
        required: true,
        arrayItem: false,
        depth: 0,
        enumValues: null,
        description: null,
        isParameter: false,
      });
    }
  }
  return fields;
}

export function parameterFields(parameters: readonly ParameterRecord[]): Field[] {
  return parameters.map((p) => ({
    path: p.name,
    leaf: p.name,
    name: p.name_norm || normaliseName(p.name),
    parent: null,
    jsonType: p.json_type ?? "unknown",
    format: p.format ?? null,
    required: !!p.is_required,
    arrayItem: false,
    depth: 0,
    enumValues: p.enum_values ?? null,
    description: p.description,
    isParameter: true,
  }));
}

export function fieldMap(fields: readonly Field[]): Map<string, Field> {
  return new Map(fields.map((f) => [f.path, f]));
}
