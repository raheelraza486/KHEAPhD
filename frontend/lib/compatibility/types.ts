/**
 * Shared shapes for the compatibility engine.
 *
 * The engine is a port of the W13C-BREAD CompatibilityEngine (Java), which was
 * itself a port of an earlier Python version. Issue codes, kinds, severities
 * and the English message text are kept identical so results can be compared
 * against the original implementation and reused by later tooling.
 */

export type PrimitiveType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null"
  | "unknown";

export type NormalizedNode =
  | ObjectNode
  | ArrayNode
  | PrimitiveNode
  | OneOfNode
  | AnyOfNode;

export interface ObjectNode {
  type: "object";
  properties: Record<string, NormalizedNode>;
  required: string[];
  enum?: unknown[];
  description?: unknown;
  example?: unknown;
  xml_root?: unknown;
}

export interface ArrayNode {
  type: "array";
  items: NormalizedNode;
  enum?: unknown[];
}

export interface PrimitiveNode {
  type: PrimitiveType | string;
  enum?: unknown[];
  description?: unknown;
  example?: unknown;
  /** OpenAPI value convention such as "date", "date-time", "uuid". Not used upstream. */
  format?: string;
}

export interface OneOfNode {
  oneOf: NormalizedNode[];
}

export interface AnyOfNode {
  anyOf: NormalizedNode[];
}

/** One entry of the flattened source index built by buildIndex(). */
export interface SchemaEntry {
  /** "$" for the root, "customer_id", "items[]", "items[].price", ... */
  path: string;
  /** Last path segment without "[]"; the root becomes "root". */
  leaf: string;
  /** normalizeName(leaf) */
  leafNorm: string;
  node: NormalizedNode;
  nodeType: string;
}

export type IssueKind = "blocking" | "mapping" | "info";
export type IssueSeverity = "error" | "warning" | "information";

export type IssueCode =
  // blocking
  | "structural_mismatch"
  | "missing_required_field"
  | "array_type_mismatch"
  | "type_mismatch"
  | "enum_mismatch"
  // mapping
  | "field_mapping_required"
  | "type_conversion_required"
  | "singleton_array_mapping"
  | "array_to_object_mapping"
  | "enum_mapping_required"
  // info
  | "exact_path_match"
  | "missing_optional_field"
  | "extra_source_field"
  // additions beyond the upstream engine (see engine.ts / parameters.ts)
  | "format_conversion_required"
  | "exact_parameter_match"
  | "parameter_mapping_required"
  | "missing_required_parameter"
  | "missing_optional_parameter";

export interface Issue {
  code: IssueCode;
  kind: IssueKind;
  severity: IssueSeverity;
  source_path: string;
  target_path: string;
  message: string;
  suggestion: string;
  /** Set on field_mapping_required and parameter_mapping_required, the two
   * codes that name one side's field as the other's: 0 = strongest evidence
   * (same normalised name, directly castable type), 5 = weakest (string
   * similarity alone). Absent on the conversion codes, which transform a value
   * rather than decide which value it is. */
  match_tier?: number;
  /**
   * How many source fields tied at `match_tier`, the chosen one included. 1
   * means the choice was forced; 2 or more means it was not, and the tie was
   * broken by path length and then source order — neither of which carries any
   * meaning. Measured over the catalogue, 1,118 of 2,360 mappings (47.4%) have
   * a tie, and the rate is *highest* at the tiers that look safest: 58.3% of
   * tier 2 and 79.7% of tier 3. A mapping picked from three equally good tier-0
   * candidates deserves less trust than a unique tier-4 one, and until this
   * field existed nothing said which was which.
   *
   * Set on the two identity codes only. It is recorded, not acted on: the level
   * a pair is given is unchanged by it. What a verdict should be allowed to
   * claim on this evidence is a policy question that belongs with the
   * compatibility engine's owner.
   */
  match_alternatives?: number;
  /**
   * Whether the target field or parameter this issue is about is required.
   *
   * It decides whether the mapping is load-bearing. engine.ts and
   * parameters.ts both read `if (a candidate was found) mapping else if
   * (required) blocking`, so finding a candidate — at any tier, including a
   * similarity guess — is exactly what stops a required target field from
   * being reported as impossible to supply. On an optional field the same guess
   * changes nothing about whether the pair can be chained: of 749 tier-4/5
   * mappings in the catalogue, 55 sit on a required field and 694 do not.
   */
  target_required?: boolean;
}

export type CompatibilityLevel =
  | "directly_compatible"
  | "compatible_with_mapping"
  | "incompatible";

export interface CompareSummary {
  compatibility_label: string;
  blocking_issues: number;
  mapping_issues: number;
  informational_issues: number;
  issue_count: number;
}

export interface CompareResult {
  source: string;
  target: string;
  compatibility: CompatibilityLevel;
  summary: CompareSummary;
  issues: Issue[];
  normalized_source: NormalizedNode;
  normalized_target: NormalizedNode;
  chosen_variant?: { source_variant_index: number; target_variant_index: number };
}

/** Relation between two primitive types, see relation.ts. */
export type TypeRelation = "direct" | "mapping" | "incompatible";

/** Outcome of one check (format, schema, or a later third check). */
export type CheckStatus = "compatible" | "incompatible" | "unknown";

export interface CheckOutcome {
  status: CheckStatus;
  reason: string;
}
