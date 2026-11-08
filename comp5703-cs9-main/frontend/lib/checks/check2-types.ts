/**
 * Check item 2.3 · type compatibility (Check Manual §7.6).
 * Normalise both sides (type_vocabulary), then look the pair up in the
 * conversion matrix (type_conversion). Only mappings of required target
 * fields decide the verdict; every mapping is recorded in `conversions`.
 */
import { conversionOf, normaliseType } from "./data.ts";
import type { Conversion, Field, Mapping, TypeResult } from "./types.ts";

/**
 * What a shape difference (Semantic Check Manual 5.10) asks for, in words
 * the page can show: the fields are the same thing, but a transformation
 * step must change the container before the value can be passed. The
 * element type of an array is not known after normalisation, so an array
 * on either side is described as repetition. Decided 14 October 2026.
 */
export function shapeCondition(sourceType: string, targetType: string): string {
  if (sourceType === "array") return `The source repeats (array) what the target takes once (${targetType}): a transformation step must take the first element or process the elements one by one.`;
  if (targetType === "array") return `The target takes an array where the source gives a ${sourceType}: a transformation step must wrap the value in one layer.`;
  if (sourceType === "object") return `The source gives an object where the target takes a ${targetType}: a transformation step must pick the value out of the object.`;
  return `The target takes an object where the source gives a ${sourceType}: a transformation step must build the object around the value.`;
}

export function runTypes(mappings: readonly Mapping[], source: Map<string, Field>, target: Map<string, Field>, requiredPaths: ReadonlySet<string>): TypeResult {
  const conversions: Conversion[] = [];
  let status: TypeResult["status"] = "pass";
  let reason: TypeResult["reason_code"] = null;
  let conditional = false;

  for (const m of mappings) {
    const s = source.get(m.source_path);
    const t = target.get(m.target_path);
    if (!s || !t) continue;
    const st = normaliseType(s.jsonType, s.format);
    const tt = normaliseType(t.jsonType, t.format);
    const matrix = conversionOf(st, tt);
    const kind = matrix.kind;
    const condition = kind === "shape" ? shapeCondition(st, tt) : matrix.condition;
    conversions.push({ target_path: t.path, source_path: s.path, source_type: st, target_type: tt, kind, condition });
    if (kind === "conditional") conditional = true;
    if (!requiredPaths.has(t.path)) continue; // optional fields never fail the pair
    if (kind === "incompatible") {
      status = "fail";
      reason = null;
    } else if (kind === "undetermined" && status !== "fail") {
      status = "unknown";
      reason = "field_type_unknown";
    } else if (kind === "shape" && status === "pass") {
      // The fields correspond; the container does not. Not a dead end: a
      // transformation step between the two APIs resolves it (5.10).
      status = "unknown";
      reason = "shape_transformation_required";
    }
  }
  return { status, reason_code: reason, conversions, flags: conditional ? ["conversion_conditional"] : [] };
}
