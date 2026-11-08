/**
 * Check item 2.4 · required-field coverage (Check Manual §7.7).
 * Runs on a complete mapping table (2.2 status `complete`) with the 2.3
 * conversions, and decides whether every required target input has a source.
 */
import { BODY_FIELD, parentOf } from "./fields.ts";
import type { Conversion, CoverageState, Field, Mapping, RequiredFieldCoverage, RequiredKind, RequiredResult } from "./types.ts";

export interface RequiredInput {
  targetFields: readonly Field[];
  sourceFields: Map<string, Field>;
  mappings: readonly Mapping[];
  conversions: readonly Conversion[];
  externalByChoice: readonly string[];
  uncoveredByChoice: readonly string[];
  /** Fields excluded by 2.2 — S-1 envelope fields and S-9 constants — never part of coverage. */
  excludedPaths?: readonly string[];
  /**
   * True when the stored request definition explicitly confirms that its
   * required set is empty (for example `raw.required = []`). This separates a
   * genuinely all-optional request from an upload whose required annotations
   * have not been reviewed yet.
   */
  requiredInformationConfirmed?: boolean;
}

function ancestorsOf(path: string, fields: Map<string, Field>): Field[] {
  const out: Field[] = [];
  let p = parentOf(path);
  while (p !== null) {
    const f = fields.get(p);
    if (f) out.push(f);
    p = parentOf(p);
  }
  return out;
}

/** Rule "definition of required": unconditional / conditional / array item. */
export function requiredKind(field: Field, fields: Map<string, Field>): RequiredKind | null {
  if (!field.required) return null;
  if (field.isParameter || field.path === BODY_FIELD) return "unconditional";
  if (field.arrayItem) return "array_item";
  const optionalAncestor = ancestorsOf(field.path, fields).some((a) => !a.required);
  return optionalAncestor ? "conditional" : "unconditional";
}

export function runRequired(input: RequiredInput): RequiredResult {
  const fields = new Map(input.targetFields.map((f) => [f.path, f]));
  const mappingByTarget = new Map(input.mappings.map((m) => [m.target_path, m]));
  const conversionByTarget = new Map(input.conversions.map((c) => [c.target_path, c]));
  const external = new Set(input.externalByChoice);
  const chosenNone = new Set(input.uncoveredByChoice);
  const excluded = new Set(input.excludedPaths ?? []);
  const children = (path: string) => input.targetFields.filter((f) => f.parent === path);
  const hasMappedDescendant = (path: string) =>
    input.mappings.some((m) => m.target_path.startsWith(path + ".") || m.target_path.startsWith(path + "[]"));

  // Rule (1) — envelope fields (S-1) and constants (S-9) are not business inputs and stay out of R.
  const required = input.targetFields.filter((f) => requiredKind(f, fields) !== null && !excluded.has(f.path));

  // Rule (2)
  if (required.length === 0) {
    const hasFields = input.targetFields.length > 0;
    return {
      status: "pass",
      reason_code: null,
      required_fields: [],
      uncovered: [],
      external_inputs: [...external],
      flags: hasFields && !input.requiredInformationConfirmed ? ["required_info_missing"] : [],
      source_optional_pairs: [],
    };
  }

  const memo = new Map<string, CoverageState>();
  const reasonFor = new Map<string, "field_type_unknown" | "shape_transformation_required">();

  const stateOfLeaf = (f: Field): CoverageState => {
    if (external.has(f.path)) return "external";
    if (chosenNone.has(f.path)) return "uncovered";
    const m = mappingByTarget.get(f.path);
    if (!m) return "uncovered";
    const c = conversionByTarget.get(f.path);
    if (!c) return "covered";
    if (c.kind === "incompatible") return "uncovered";
    if (c.kind === "undetermined") {
      reasonFor.set(f.path, "field_type_unknown");
      return "unknown";
    }
    if (c.kind === "shape") {
      reasonFor.set(f.path, "shape_transformation_required");
      return "unknown";
    }
    return "covered"; // same, lossless, conditional, container
  };

  // Rule (4): containers are judged by their children.
  const stateOf = (f: Field): CoverageState => {
    const cached = memo.get(f.path);
    if (cached) return cached;
    let state: CoverageState;
    const kids = f.jsonType === "object" || f.jsonType === "array" ? children(f.path).concat(children(f.path + "[]")) : [];
    if (kids.length === 0) state = stateOfLeaf(f);
    else if (external.has(f.path)) state = "external";
    else {
      const requiredKids = kids.filter((k) => k.required && !excluded.has(k.path));
      const states = requiredKids.map(stateOf);
      if (states.some((s) => s === "uncovered")) state = "uncovered";
      else if (states.some((s) => s === "unknown")) state = "unknown";
      // A required container whose children are all optional still needs *something*
      // provided: its own mapping or at least one mapped descendant.
      else if (requiredKids.length === 0 && !mappingByTarget.has(f.path) && !hasMappedDescendant(f.path)) state = "uncovered";
      else state = "covered";
    }
    memo.set(f.path, state);
    return state;
  };

  const result: RequiredFieldCoverage[] = [];
  const sourceOptional: RequiredResult["source_optional_pairs"] = [];
  for (const f of required) {
    const kind = requiredKind(f, fields)!;
    let state: CoverageState;
    // Rule (5): conditionally required fields apply only when their optional ancestor is provided.
    if (kind === "conditional") {
      const optional = ancestorsOf(f.path, fields).filter((a) => !a.required);
      const provided = optional.every((a) => mappingByTarget.has(a.path) || hasMappedDescendant(a.path) || external.has(a.path));
      state = provided ? stateOf(f) : "not_applicable";
    } else {
      state = stateOf(f);
    }
    const m = mappingByTarget.get(f.path);
    result.push({ target_path: f.path, kind, state, source_path: m?.source_path ?? null });
    // Rule (7)
    if (m) {
      const s = input.sourceFields.get(m.source_path);
      if (s && !s.required && !s.isParameter && s.path !== BODY_FIELD) sourceOptional.push({ target_path: f.path, source_path: s.path });
    }
  }

  // Rule (6)
  const uncovered = result.filter((r) => r.state === "uncovered").map((r) => r.target_path);
  const unknown = result.filter((r) => r.state === "unknown");
  let status: RequiredResult["status"] = "pass";
  let reason: RequiredResult["reason_code"] = null;
  if (uncovered.length > 0) {
    status = "fail";
    reason = "required_field_uncovered";
  } else if (unknown.length > 0) {
    status = "unknown";
    reason = reasonFor.get(unknown[0].target_path) ?? "field_type_unknown";
  }
  const flags: RequiredResult["flags"] = [];
  if (sourceOptional.length > 0) flags.push("source_field_optional");
  return {
    status,
    reason_code: reason,
    required_fields: result,
    uncovered,
    external_inputs: [...external],
    flags,
    source_optional_pairs: sourceOptional,
  };
}
