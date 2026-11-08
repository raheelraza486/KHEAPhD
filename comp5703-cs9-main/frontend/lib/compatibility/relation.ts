import type { NormalizedNode, TypeRelation } from "./types.ts";

export function typeOf(node: NormalizedNode | undefined | null): string {
  if (!node) return "unknown";
  const t = (node as { type?: unknown }).type;
  return typeof t === "string" ? t : "unknown";
}

/**
 * Pairs where a value of the source type can be cast into the target type.
 * Written as "source>target". Directional: integer -> number is "direct"
 * (handled above), number -> integer is only "mapping" because it may lose
 * precision.
 */
const CASTABLE_PAIRS = new Set([
  "number>integer",
  "string>integer",
  "string>number",
  "string>boolean",
  "integer>string",
  "number>string",
  "boolean>string",
  "integer>boolean",
  "boolean>integer",
]);

/**
 * How a source value relates to what the target expects.
 *   direct       - can be forwarded as is
 *   mapping      - reachable with a cast
 *   incompatible - no sensible conversion (covers object/array/unknown mixes)
 */
export function primitiveRelation(
  sourceNode: NormalizedNode,
  targetNode: NormalizedNode,
): TypeRelation {
  const s = typeOf(sourceNode);
  const t = typeOf(targetNode);
  if (s === t) return "direct";
  if (s === "integer" && t === "number") return "direct";
  if (s === "null" && t !== "null" && t !== "unknown") return "mapping";
  if (CASTABLE_PAIRS.has(`${s}>${t}`)) return "mapping";
  return "incompatible";
}
