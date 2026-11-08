/**
 * BP-Builder compatibility checks — shared types.
 *
 * The checks are pure functions over the rows the caller already holds
 * (apis, api_schema, api_schema_field, api_parameter, format_alias). Nothing
 * here touches the database or the page: the page reads the report described
 * in the Compatibility Check Manual v1.0, chapter 9, and writes user choices
 * back through `UserChoice` (Semantic Check Manual v1.0, rule S-8 / step 2.2c).
 */

// ---------------------------------------------------------------------------
// Inputs — one row per table, named after the columns the checks read.
// ---------------------------------------------------------------------------

/** `public.apis` — only the columns the checks read. */
export interface ApiRecord {
  id: string;
  api_name: string;
  company_name: string;
  category?: string | null;
  api_endpoint?: string | null;
  http_method?: string | null;
  input_formats: readonly string[] | null;
  output_formats: readonly string[] | null;
  authentication_method: string | null;
  authentication_details: string | null;
  /** apis.invoice_standard — catalogue-wide label, used by 2.0b when no directional claim exists. */
  invoice_standard?: readonly string[] | null;
}

/** One row of api_invoice_standard_capability (migration 0038): what one side reads or writes. */
export interface StandardClaim {
  direction: "input" | "output";
  standard: string;
  version?: string | null;
  status?: string | null;
  /** Nonempty when a request option must be set for this standard to apply (`standard=peppol-bis`). */
  condition?: string | null;
}

/** `public.api_schema` with its flattened `api_schema_field` rows attached. */
export interface SchemaRecord {
  id: string;
  api_id: string;
  direction: "request" | "response";
  status_code: string | null;
  /**
   * `api_schema.media_type`. One operation may store the same schema under
   * several media types (a provider that declares both JSON and XML), so 2.1
   * keeps only the rows carrying the format selected for the comparison.
   */
  media_type?: string | null;
  /** The stored JSON Schema (`api_schema.raw`), used only for top-level shape rules. */
  raw: unknown;
  verified_by: string | null;
  content_hash?: string | null;
  fields: readonly SchemaFieldRecord[];
}

/** `public.api_schema_field`. */
export interface SchemaFieldRecord {
  path: string;
  leaf_name: string;
  leaf_name_norm: string;
  json_type: string | null;
  format: string | null;
  is_required: boolean;
  is_array_item: boolean;
  depth: number;
  enum_values: readonly string[] | null;
  description: string | null;
}

/** `public.api_parameter`. */
export interface ParameterRecord {
  name: string;
  name_norm?: string | null;
  location: string | null;
  json_type: string | null;
  format?: string | null;
  is_required: boolean;
  enum_values?: readonly string[] | null;
  description: string | null;
}

/** One side of the ordered pair with everything the checks need about it. */
export interface ApiSideInput {
  api: ApiRecord;
  schemas: readonly SchemaRecord[];
  parameters: readonly ParameterRecord[];
  /** Directional invoice-standard claims (check 2.0b); absent when not loaded. */
  standard_claims?: readonly StandardClaim[];
}

/** `public.format_alias` rows. */
export interface FormatAliasRow {
  alias: string;
  canonical: string;
}

/**
 * One answer event for one target field of the ordered pair (step 2.2c), as
 * stored in `check_choice`. The table is append-only: every answer is kept.
 * The engine merges the history of a field into one of three states:
 *   agreed   — every user answer is the same → applied at once, nobody reviews it
 *   conflict — users disagree, or a user answer disagrees with the registry's
 *              automatic match → nothing is applied; the field waits for an
 *              administrator (`SemanticsResult.conflicts`)
 *   resolved — an administrator answered (`kind = "admin"`) → that answer is
 *              final and applied
 * The two hashes record which schemas the answer was given against: an answer
 * whose hash no longer matches is stale, is reported and is not applied.
 */
export interface UserChoice {
  target_path: string;
  /** A source path chosen from the candidates, or one of the two fixed options. */
  chosen_source_path: string | null;
  option: "candidate" | "none" | "external";
  /** Who answered: a user, or an administrator settling a conflict. Missing means `user`. */
  kind?: "user" | "admin";
  chosen_by?: string | null;
  chosen_at?: string | null;
  /** `api_schema.content_hash` of the source response schema at the time of the choice; omit to skip the check. */
  source_content_hash?: string | null;
  /** `api_schema.content_hash` of the target request schema at the time of the choice; omit to skip the check. */
  target_content_hash?: string | null;
}

export interface PairInput {
  source: ApiSideInput;
  target: ApiSideInput;
  formatAliases: readonly FormatAliasRow[];
  /** The full answer history saved for this (source, target) pair, if any (see `UserChoice`). */
  choices?: readonly UserChoice[];
  /**
   * The canonical format the comparison is made in, as chosen on the page.
   * It decides which stored schema 2.1 uses on each side. Omitted, the engine
   * picks the default of Check 1 (`format_selected`).
   */
  selectedFormat?: string | null;
  /**
   * The saved schemas explicitly chosen by the Compatibility workspace.
   * When omitted, the engine keeps its existing automatic selection rules.
   *
   * The complete schema collections remain on source and target so saved
   * answer hashes can still distinguish another representation from a schema
   * that has changed.
   */
  selectedSourceSchemaId?: string | null;
  selectedTargetSchemaId?: string | null;
  /**
   * Set by the composition engine when a Validation step of the same process
   * stands between source and target: in convert → validate → send, the send
   * step reads the converted document, so the pair Transformation →
   * Communication is checked, but the process does not skip validation.
   * Omitted, the pair is judged as two adjacent steps.
   */
  validatedBetween?: boolean;
}

// ---------------------------------------------------------------------------
// Field model used by check items 2.1–2.4 (schema fields and parameters
// share one shape; `(body)` is the synthetic field of a scalar body).
// ---------------------------------------------------------------------------

export interface Field {
  path: string;
  leaf: string;
  /** Normalised name — the registry key. */
  name: string;
  /** Parent path, or null for a top-level field / parameter. */
  parent: string | null;
  jsonType: string;
  format: string | null;
  required: boolean;
  arrayItem: boolean;
  depth: number;
  enumValues: readonly string[] | null;
  description: string | null;
  isParameter: boolean;
}

// ---------------------------------------------------------------------------
// Verdicts and reason codes (Check Manual §4.2, §4.3).
// ---------------------------------------------------------------------------

export type Verdict = "pass" | "fail" | "unknown" | "not_voting";

export type ReasonCode =
  | "source_no_format"
  | "target_no_format"
  | "source_no_output_schema"
  | "source_no_output_body"
  | "target_no_input_schema"
  | "schema_unsupported_shape"
  | "field_type_unknown"
  | "shape_unsupported"
  | "shape_transformation_required"
  | "required_field_uncovered"
  | "operation_category_unknown"
  | "operation_sequence_reversed"
  | "operation_sequence_skips_validation"
  | "operation_sequence_repeats_stage"
  | "value_constraint_incompatible"
  | "value_constraint_unknown"
  | "invoice_standard_mismatch"
  | "invoice_standard_unconfirmed";

// ---------------------------------------------------------------------------
// Per-check results — the fields of Check Manual chapter 9, by position.
// ---------------------------------------------------------------------------

/** Check 0 · operation logic. */
export interface Check0Result {
  status: Verdict;
  reason_code:
    | "operation_category_unknown"
    | "operation_sequence_reversed"
    | "operation_sequence_skips_validation"
    | "operation_sequence_repeats_stage"
    | null;
  source_category: string | null;
  target_category: string | null;
  sequence: Array<
    "Transformation" | "Validation" | "Communication"
  >;
  flags: Array<
    "same_operation_category" | "validated_in_between"
  >;
}

/** Check 1 · format check (Check Manual §6.5). */
/**
 * One entry of the format selector on the page. Every value either side
 * declares is listed, annotated rather than hidden: a format the other side
 * does not accept, or one with no stored schema, is a fact the user should
 * see instead of silently getting a different comparison.
 */
export interface FormatOption {
  /** The canonical name, or the raw value when `format_alias` does not know it. */
  format: string;
  /** False for a value absent from `format_alias`; such an option cannot be chosen. */
  recognised: boolean;
  /** Declared in the source's `output_formats` / the target's `input_formats`. */
  in_source: boolean;
  in_target: boolean;
  /** Takes part in the intersection of 1.3 (a source UBL counts against a target XML). */
  common: boolean;
  /** A stored schema on that side carries this format (`api_schema.media_type`). */
  source_has_schema: boolean;
  target_has_schema: boolean;
  selectable: boolean;
}

export interface Check1Result {
  status: Verdict;
  reason_code: ReasonCode | null;
  source_formats: string[];
  target_formats: string[];
  common_formats: string[];
  unrecognised_values: string[];
  /** Everything either side declares, ordered as the page should offer it. */
  format_options: FormatOption[];
  /** The format this run compared in: the page's choice, or the default of §6.4. */
  format_selected: string | null;
  flags: Array<"input_in_parameters">;
}

/** Check item 2.0 · authentication comparison (Check Manual §7.3). */
export interface AuthResult {
  status: "pass";
  credential_sets: 0 | 1 | 2;
  source_auth: { method: string | null; details: string | null };
  target_auth: { method: string | null; details: string | null };
  auth_requires_prior_call: boolean;
}

/** Check item 2.1 · schema availability (Check Manual §7.4). */
export interface SchemaReference {
  schema_id: string;
  status_code: string | null;
  media_type: string | null;
}

export interface SchemaAvailabilityResult {
  status: Verdict;
  reason_code: ReasonCode | null;
  source_schema_used: SchemaReference | null;
  source_schema_alternatives: SchemaReference[];
  /** The target request schema actually compared, when the target has a body. */
  target_schema_used?: SchemaReference | null;
  target_schema_alternatives?: SchemaReference[];
  target_inputs: Array<"body" | "parameters">;
  /**
   * `no_schema_for_format`: the side does hold schemas, but none of them
   * carries the selected format. The verdict still uses the ordinary reason
   * code; the flag lets the page say which of the two situations it is.
   */
  flags: Array<"thin_schema" | "schema_unverified" | "no_schema_for_format" | "document_exchange">;
}

export type FieldDetection = "determined" | "ambiguous" | "not_found" | "envelope" | "constant";

export interface Mapping {
  target_path: string;
  source_path: string;
  unit_id: string;
  origin: "auto" | "user_choice";
  notes: string[];
}

export interface Candidate {
  source_path: string;
  unit_id: string;
  basis: string;
  source_type: string;
  source_format: string | null;
  source_required: boolean;
}

export interface AmbiguousField {
  target_path: string;
  target_type: string;
  target_format: string | null;
  required: boolean;
  candidates: Candidate[];
}

export interface NotFoundField {
  target_path: string;
  target_type: string;
  target_format: string | null;
  required: boolean;
  /** String-similarity suggestions; never a match (rule S-6). */
  suggestions: Candidate[];
}

/** One answer taking part in a conflict. */
export interface ConflictAnswer {
  /** `user` / `admin` answers come from the history; `registry` is the engine's own automatic match. */
  source: "user" | "admin" | "registry";
  option: "candidate" | "none" | "external";
  chosen_source_path: string | null;
  chosen_by: string | null;
  chosen_at: string | null;
}

export interface ConflictField {
  target_path: string;
  required: boolean;
  answers: ConflictAnswer[];
}

/** The answer applied to a field, and the state it was merged from. */
export interface AppliedChoice {
  target_path: string;
  state: "agreed" | "resolved";
  option: "candidate" | "none" | "external";
  chosen_source_path: string | null;
}

/** Check item 2.2 · field-semantics check (Check Manual §7.5.6, Semantic Manual chapter 8). */
export interface SemanticsResult {
  /** `pending_admin` — a required field is in conflict; `pending_user` — a required field awaits a user; otherwise complete. */
  status: "complete" | "pending_user" | "pending_admin";
  mappings: Mapping[];
  ambiguous: AmbiguousField[];
  not_found: NotFoundField[];
  /** `envelope` — rule S-1; `constant` — rule S-9, an enum of exactly one value. */
  excluded: Array<{ path: string; reason: "envelope" | "constant" }>;
  /** Target fields resolved by the user as "None of the above". */
  uncovered_by_choice: string[];
  /** Target fields resolved by the user as "Provided externally". */
  external_by_choice: string[];
  /** Saved choices ignored because a schema changed since they were made; the page asks again. */
  stale_choices: Array<{
    target_path: string;
    /**
     * `format_changed`: the answer was given while the pair was being compared
     * in another format, so it was recorded against a different stored schema.
     * The schema itself did not change and the answer is not wrong — it simply
     * belongs to the other format, and the page says so rather than claiming a
     * schema changed.
     */
    reason: "source_schema_changed" | "target_schema_changed" | "format_changed";
  }>;
  /** Answers applied from the history, with the state they were merged from. */
  applied: AppliedChoice[];
  /** Fields held for an administrator: users disagree, or a user answer disagrees with the registry. */
  conflicts: ConflictField[];
}

export type ConversionKind = "same" | "lossless" | "conditional" | "incompatible" | "undetermined" | "container" | "shape";

export interface Conversion {
  target_path: string;
  source_path: string;
  source_type: string;
  target_type: string;
  kind: ConversionKind;
  condition: string;
}

/** Check item 2.3 · type compatibility (Check Manual §7.6.3). */
export interface TypeResult {
  status: Verdict;
  reason_code: ReasonCode | null;
  conversions: Conversion[];
  flags: Array<"conversion_conditional">;
}

export type RequiredKind = "unconditional" | "conditional" | "array_item";
export type CoverageState = "covered" | "external" | "uncovered" | "unknown" | "not_applicable";

export interface RequiredFieldCoverage {
  target_path: string;
  kind: RequiredKind;
  state: CoverageState;
  source_path: string | null;
}

/** Check item 2.4 · required-field coverage (Check Manual §7.7.1). */
export interface RequiredResult {
  status: Verdict;
  reason_code: ReasonCode | null;
  required_fields: RequiredFieldCoverage[];
  uncovered: string[];
  external_inputs: string[];
  flags: Array<"required_info_missing" | "source_field_optional">;
  /** Field pairs behind `source_field_optional`. */
  source_optional_pairs: Array<{ target_path: string; source_path: string }>;
}

export type ConstraintIssueKind =
  | "source_values_unknown"
  | "source_type_mismatch"
  | "enum_partial_overlap"
  | "enum_no_overlap"
  | "conditional_conversion"
  | "conversion_impossible"
  | "conversion_always_succeeds";

export interface ConstraintIssue {
  target_path: string;
  source_path: string;
  kind: ConstraintIssueKind;
  source_values: string[];
  target_values: string[];
  unsupported_values: string[];
  condition: string | null;
  message: string;
}

/** Check 3 · value / constraint compatibility. */
export interface Check3Result {
  status: Verdict;
  reason_code:
    | "value_constraint_incompatible"
    | "value_constraint_unknown"
    | null;
  issues: ConstraintIssue[];
  /**
   * Field pairs for which Check 2 noted a different representation (rule
   * S-7: a code against a name, another format). Information only: a
   * transformation step may be needed; it does not decide the verdict.
   */
  representation_differs: Array<{
    target_path: string;
    source_path: string;
    note: string;
  }>;
  /**
   * Type conversions 2.3 marked conditional, such as string to number. Each
   * is decided in `issues` (`conversion_always_succeeds`,
   * `conversion_impossible`, or `conditional_conversion` when undecidable).
   */
  conditional_conversions: Conversion[];
  /**
   * `runtime_validation_required`: at least one conversion is undecidable
   * from the records. `value_mapping_required`: a transformation step must
   * rewrite at least one value (representation difference or a conversion
   * that always succeeds). `no_declared_constraints`: nothing to judge.
   */
  flags: Array<
    | "no_declared_constraints"
    | "runtime_validation_required"
    | "value_mapping_required"
    | "check3_waiting_for_semantics"
  >;
}


/** Check 2.0b · invoice standard (issue #42). */
export type StandardRelation = "same" | "subset" | "superset" | "fillable" | "version_differs" | "disjoint";

export interface ResolvedStandard {
  /** The value as stored. */
  raw: string;
  /** Canonical name from invoice_standards.csv, or the raw name without its version. */
  standard: string;
  version: string | null;
  parent: string | null;
  /** cbc:CustomizationID a document of this standard carries, when recorded. */
  customization_id: string | null;
}

export interface StandardResult {
  /**
   * pass; fail (standards do not overlap); unknown (the source records only a
   * parent standard and the target requires one of its CIUS: the identifier the
   * source writes is not known); not_voting (a side records no standard, or
   * only versions differ).
   */
  status: "pass" | "fail" | "unknown" | "not_voting";
  reason_code: "invoice_standard_mismatch" | "invoice_standard_unconfirmed" | null;
  source_standards: ResolvedStandard[];
  target_standards: ResolvedStandard[];
  /** Where each side's standards came from: directional claims, the catalogue label, or nothing. */
  source_basis: "claims" | "catalogue" | "none";
  target_basis: "claims" | "catalogue" | "none";
  /** Informational review state; never a compatibility gate. Absent in older saved reports. */
  review?: { source: StandardReview; target: StandardReview };
  /** Every source x target combination that is not disjoint. */
  matches: Array<{ source: string; target: string; relation: StandardRelation; note: string | null }>;
  /**
   * Request options a side must set for a matched standard to apply, as the
   * claim states them (beliq: `standard=peppol-bis; output=xml`). The verdict
   * does not change; the caller has to configure the call. Since 14 October 2026.
   */
  conditions: Array<{ side: "source" | "target"; standard: string; condition: string }>;
  flags: Array<"standard_not_recorded" | "version_differs" | "fill_required" | "claims_unreviewed" | "customization_unconfirmed" | "configuration_required">;
}

export interface StandardReview {
  /** Direction actually read, including validators passing on their input document. */
  direction: "input" | "output";
  /** Catalogue labels have no directional review; missing standards cannot be called confirmed. */
  status: "confirmed" | "unreviewed" | "not_assessed" | "not_recorded";
}

export interface Check2Result {
  auth: AuthResult;
  /** Absent only in reports built before 2.0b existed. */
  standard?: StandardResult;
  schema: SchemaAvailabilityResult;
  semantics: SemanticsResult | null;
  types: TypeResult | null;
  required: RequiredResult | null;
}

/** Overall verdict (Check Manual §4.2, chapter 9 last row). */
export interface OverallResult {
  /** `pending_user` — waiting for a user's choice; `pending_admin` — waiting for an administrator to settle a conflict. */
  overall: "pass" | "fail" | "pending_user" | "pending_admin";
  blocking_checks: string[];
  blocking_reason: "incompatible" | "insufficient_info" | null;
  reason_codes: ReasonCode[];
}

export interface CheckReport {
  source: { id: string; name: string };
  target: { id: string; name: string };
  check0: Check0Result;
  check1: Check1Result;
  check2: Check2Result;
  check3: Check3Result;
  overall: OverallResult;
}
