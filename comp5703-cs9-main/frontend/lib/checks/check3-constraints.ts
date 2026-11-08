/**
 * Check 3 · value and constraint compatibility (Check Manual ch. 8).
 *
 * Runs only after Check 2 has established field mappings; it never matches
 * fields again. For each mapped pair it asks one question: can every value
 * the source may produce be accepted by the target? The answer is drawn from
 * what the records declare — the target's accepted values (`enum_values`),
 * the source's declared values, its type and its `format` — never from a
 * live call.
 *
 * Rules (V2.1):
 * - Target enum, source enum: every source value must be accepted
 *   (compared ignoring case). Values outside the target's list → fail.
 * - Target enum, source without one: fail when the source's type cannot
 *   produce any of the target's values (an object, an array, a number
 *   where the target wants words); otherwise undetermined.
 * - Conditional conversion from 2.3 (string → integer and the like): decided
 *   from the source's evidence. A conversion that succeeds for every valid
 *   value of the source type passes; a `format` that rules the target out
 *   (a GUID can never be integer text) fails; a source enum is tested value
 *   by value; with no evidence the pair stays undetermined.
 * - A representation difference noted by 2.2 (rule S-7: a code against a
 *   name, another format) is information for the page, not a vote: it says
 *   a transformation step may be needed, which is 2.3's reading of a shape
 *   difference as well. Decided 21 October 2026.
 * - With no constraint to judge, the check does not vote.
 */
import type {
  Check3Result,
  ConstraintIssue,
  Conversion,
  Field,
  Mapping,
} from "./types.ts";

export interface Check3Input {
  mappings: readonly Mapping[];
  sourceFields: ReadonlyMap<string, Field>;
  targetFields: ReadonlyMap<string, Field>;
  conversions: readonly Conversion[];
}

function normaliseEnumValues(values: readonly string[] | null | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter((value) => value.length > 0))];
}

const fold = (value: string) => value.toLowerCase();

/**
 * Conditional conversions that succeed for every valid value of the source
 * type: the target is broader than, or a truncation of, the source. The
 * condition text of type_conversion.csv records what the step must do.
 */
const ALWAYS_CONVERTIBLE = new Set(["date-time→string", "date-time→date", "date-time→integer", "date-time→number"]);

/**
 * Source `format` values (raw, as the schema declares them) that describe a
 * string which can never be numeric, boolean, date, e-mail or base64 text.
 * Formats that the type vocabulary already maps (date, email, byte…) never
 * reach here as strings.
 */
const NEVER_CONVERTIBLE_FORMATS = new Set(["guid", "uuid", "uri", "url", "uri-reference", "hostname", "ipv4", "ipv6"]);

/** Does this literal satisfy the target type a conditional conversion asks for? */
function literalFits(value: string, targetType: string): boolean | null {
  const v = value.trim();
  switch (targetType) {
    case "integer": return /^[+-]?\d+$/.test(v);
    case "number": return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v);
    case "boolean": return /^(true|false)$/i.test(v);
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(v);
    case "date-time": return /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    case "binary": return /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0;
    default: return null;
  }
}

/** Can a value of this (normalised) source type ever be this literal? */
function typeCanProduce(sourceType: string, value: string): boolean | null {
  switch (sourceType) {
    case "string": case "email": case "date": case "date-time": case "binary": return true;
    case "integer": return /^[+-]?\d+$/.test(value.trim());
    case "number": return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
    case "boolean": return /^(true|false)$/i.test(value.trim());
    case "object": case "array": return false;
    default: return null;
  }
}

function issue(partial: Omit<ConstraintIssue, "source_values" | "target_values" | "unsupported_values" | "condition"> & Partial<ConstraintIssue>): ConstraintIssue {
  return { source_values: [], target_values: [], unsupported_values: [], condition: null, ...partial };
}

function representationDiffers(mappings: readonly Mapping[]): Check3Result["representation_differs"] {
  return mappings
    .filter((mapping) => mapping.notes.includes("representation_differs"))
    .map((mapping) => ({ target_path: mapping.target_path, source_path: mapping.source_path, note: "representation_differs" }));
}

function result(status: Check3Result["status"], reason: Check3Result["reason_code"], issues: ConstraintIssue[], rep: Check3Result["representation_differs"], conditional: Conversion[], flags: Check3Result["flags"]): Check3Result {
  return { status, reason_code: reason, issues, representation_differs: rep, conditional_conversions: conditional, flags };
}

/**
 * Check 3 cannot vote until the semantic mapping has been completed. The
 * mappings and conversions known so far are kept so the page can still show
 * what Check 2 has identified.
 */
export function waitingCheck3(mappings: readonly Mapping[] = [], conversions: readonly Conversion[] = []): Check3Result {
  return result("not_voting", null, [], representationDiffers(mappings), conversions.filter((c) => c.kind === "conditional"), ["check3_waiting_for_semantics"]);
}

export function runCheck3(input: Check3Input): Check3Result {
  const conditional = input.conversions.filter((c) => c.kind === "conditional");
  const rep = representationDiffers(input.mappings);
  const issues: ConstraintIssue[] = [];
  let failed = false;
  let undetermined = false;
  let judged = 0;

  // (1) Declared values: the target's enum against what the source declares.
  for (const mapping of input.mappings) {
    const source = input.sourceFields.get(mapping.source_path);
    const target = input.targetFields.get(mapping.target_path);
    if (!source || !target) continue;
    const targetValues = normaliseEnumValues(target.enumValues);
    if (targetValues.length === 0) continue; // a target without an enum does not restrict the source
    judged++;
    const sourceValues = normaliseEnumValues(source.enumValues);
    const base = { target_path: mapping.target_path, source_path: mapping.source_path, source_values: sourceValues, target_values: targetValues };

    if (sourceValues.length === 0) {
      const conv = conditional.find((c) => c.source_path === mapping.source_path && c.target_path === mapping.target_path);
      const sourceType = conv?.source_type ?? sourceTypeOf(source);
      const producible = targetValues.map((v) => typeCanProduce(sourceType, v));
      if (producible.every((p) => p === false)) {
        failed = true;
        issues.push(issue({ ...base, kind: "source_type_mismatch", unsupported_values: targetValues, message: `The target accepts only ${describe(targetValues)}, which a source of type ${sourceType} can never produce.` }));
      } else {
        undetermined = true;
        issues.push(issue({ ...base, kind: "source_values_unknown", message: "The target restricts accepted values, but the source does not declare its possible values." }));
      }
      continue;
    }

    const accepted = new Set(targetValues.map(fold));
    const unsupported = sourceValues.filter((v) => !accepted.has(fold(v)));
    if (unsupported.length === 0) continue;
    failed = true;
    const overlap = sourceValues.length - unsupported.length;
    issues.push(issue({
      ...base,
      kind: overlap === 0 ? "enum_no_overlap" : "enum_partial_overlap",
      unsupported_values: unsupported,
      message: overlap === 0 ? "The source and target declare no common accepted values." : "The source may produce values that the target does not accept.",
    }));
  }

  // (2) Conditional conversions from 2.3, decided from the source's evidence.
  for (const conv of conditional) {
    const source = input.sourceFields.get(conv.source_path);
    const base = { target_path: conv.target_path, source_path: conv.source_path, condition: conv.condition || null };
    judged++;
    if (ALWAYS_CONVERTIBLE.has(`${conv.source_type}→${conv.target_type}`)) {
      issues.push(issue({ ...base, kind: "conversion_always_succeeds", message: `Every ${conv.source_type} value converts to ${conv.target_type} (${conv.condition}); a transformation step performs it.` }));
      continue;
    }
    const format = (source?.format ?? "").trim().toLowerCase();
    if (conv.source_type === "string" && format && NEVER_CONVERTIBLE_FORMATS.has(format)) {
      failed = true;
      issues.push(issue({ ...base, kind: "conversion_impossible", message: `The source value is a ${format}, which can never satisfy "${conv.condition}".` }));
      continue;
    }
    const sourceValues = normaliseEnumValues(source?.enumValues);
    if (sourceValues.length > 0) {
      const fits = sourceValues.map((v) => literalFits(v, conv.target_type));
      if (fits.every((f) => f === true)) continue; // every declared value satisfies the condition
      if (fits.some((f) => f === false)) {
        failed = true;
        issues.push(issue({ ...base, kind: "conversion_impossible", source_values: sourceValues, unsupported_values: sourceValues.filter((_, i) => fits[i] === false), message: `Declared source values do not satisfy "${conv.condition}".` }));
        continue;
      }
    }
    undetermined = true;
    issues.push(issue({ ...base, kind: "conditional_conversion", message: "This conversion can succeed only when the runtime value satisfies the stated condition; the source declares nothing that settles it." }));
  }

  const flags: Check3Result["flags"] = [];
  if (issues.some((i) => i.kind === "conditional_conversion")) flags.push("runtime_validation_required");
  if (rep.length > 0 || issues.some((i) => i.kind === "conversion_always_succeeds")) flags.push("value_mapping_required");

  if (failed) return result("fail", "value_constraint_incompatible", issues, rep, conditional, flags);
  if (undetermined) return result("unknown", "value_constraint_unknown", issues, rep, conditional, flags);
  if (judged === 0) return result("not_voting", null, issues, rep, conditional, [...flags, "no_declared_constraints"]);
  return result("pass", null, issues, rep, conditional, flags);
}

function sourceTypeOf(field: Field): string {
  const t = (field.jsonType ?? "").trim();
  return t === "" ? "unknown" : t;
}

function describe(values: readonly string[]): string {
  return values.length <= 4 ? values.join(" / ") : `${values.slice(0, 4).join(" / ")} … (${values.length} values)`;
}
