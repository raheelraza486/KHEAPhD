// The vocabulary the stored rows use for a value: its JSON type, its enum,
// and the normalised form of its name.
//
// Moved out of extract.ts when parameters.ts needed the same three. Both a
// body field and a path/query parameter are described with these columns, and
// two copies of jsonTypeOf would be two chances to disagree about what a
// typeless schema means. The same reason ref.ts left parse.ts.

import { isObject, text, type JsonObject } from "../openapi/ref.ts";

export const JSON_TYPES = [
  "object", "array", "string", "number", "integer", "boolean", "null", "unknown",
] as const;
export type JsonType = (typeof JSON_TYPES)[number];

/**
 * leaf_name_norm: lowercased with everything that is not a letter or digit
 * removed. 'unit_price', 'unitPrice' and 'Unit-Price' all become 'unitprice'.
 *
 * This is the coarse key only. Tiered candidate ranking (tokenising
 * camelCase, scoring partial overlaps) belongs to field matching; storing the
 * coarse key means matching does not renormalise both sides on every run.
 */
export function normaliseLeafName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function jsonTypeOf(node: JsonObject): JsonType {
  const stated = node.type;
  // A schema may state a list of types; take the first that is nameable and
  // record nothing about the rest -- the flattened row has one type column,
  // and raw still holds what the document said.
  const first = Array.isArray(stated) ? stated.find((t) => typeof t === "string") : stated;
  const name = text(first);
  if ((JSON_TYPES as readonly string[]).includes(name)) return name as JsonType;
  // No type keyword. Infer only from structure that can mean nothing else.
  if (isObject(node.properties)) return "object";
  if (node.items !== undefined) return "array";
  return "unknown";
}

export function enumOf(node: JsonObject): string[] | null {
  if (!Array.isArray(node.enum)) return null;
  const values = node.enum.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  return values.length > 0 ? values : null;
}
