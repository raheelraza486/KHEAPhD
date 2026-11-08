import type { OverallResult } from "../checks/types.ts";

/**
 * The three operation categories, in the order the client set on
 * 16 September 2026: Transformation → Validation → Communication.
 * Records categorised Other have no place in a business process.
 */
export const STEP_CATEGORIES = ["Transformation", "Validation", "Communication"] as const;
export type StepCategory = (typeof STEP_CATEGORIES)[number];

/**
 * A business process involves at most three APIs (client meeting, 19 September
 * 2026), plus a second Transformation, which the client allowed on 3 October
 * 2026: extraction then conversion, as in the client's paper.
 */
export const MAX_STEPS = 4;

/**
 * One step of a business process, as the BP-Builder needs it.
 *
 * The LLM stream hands each step over in exactly this shape: see
 * process-format.ts, which checks the JSON before it reaches the engine.
 */
export interface ProcessStep {
  /** 1-based position in the process. */
  order: number;
  category: StepCategory;
  /** What the step does, in the user's words ("convert PDF to UBL XML"). */
  task: string;
  /** Formats and rule set the user named, if any ("PDF", "UBL XML", "Australian rules"). */
  input_format?: string | null;
  output_format?: string | null;
  rule_set?: string | null;
  /**
   * Optional narrowing to the APIs that suit the task (from Discovery or
   * task-candidates.ts).
   * Absent or null: not yet narrowed; composeChains alone would use every API
   * of the category. An empty list: no candidate was found.
   */
  candidate_ids?: readonly string[] | null;
}

export interface BusinessProcess {
  steps: readonly ProcessStep[];
}

/**
 * What a step does with the document that travels through the process.
 *
 *   produces  — Transformation: turns its input into a new document, which the next steps work on.
 *   checks    — Validation: examines the current document and lets it through unchanged;
 *               its own output is a report for the user, not an input for the next step.
 *   delivers  — Communication: hands the document over; its output (a receipt or status)
 *               goes back to the user.
 */
export type StepRole = "produces" | "checks" | "delivers";

export interface StepPlan {
  order: number;
  category: StepCategory;
  role: StepRole;
  /**
   * The step whose output this step's input is compared with: the nearest
   * earlier step that produces a document. Null when the document comes from
   * the user, as it does for the first step.
   */
  input_from: number | null;
  /** Whether a later step reads this step's output. */
  output_used: boolean;
}

export type ProcessIssueCode =
  | "empty_process"
  | "too_many_steps"
  | "unknown_category"
  | "order_reversed"
  | "validation_skipped"
  | "duplicate_order"
  | "unrecognised_format"
  | "conversion_unresolved";

export interface ProcessIssue {
  code: ProcessIssueCode;
  step?: number;
  message: string;
}

/** The overall verdict of Check 0–3 for one ordered pair. */
export type LinkVerdict = OverallResult["overall"] | "unknown";

export interface ChainLink {
  from_order: number;
  to_order: number;
  source_id: string;
  target_id: string;
  verdict: LinkVerdict;
}

/**
 * One feasible combination: one API per step, in process order.
 *
 *   feasible        — every checked link passed.
 *   needs_decision  — no proven incompatibility, but missing technical data,
 *                     a field mapping or a standard-version claim needs review.
 */
export interface Chain {
  api_ids: string[];
  links: ChainLink[];
  status: "feasible" | "needs_decision";
}

export interface CompositionResult {
  plan: StepPlan[];
  issues: ProcessIssue[];
  /** Candidates per step order, after category and position eligibility. */
  candidates: Record<number, number>;
  /** Feasible chains first, then those needing a decision; at most `maxChains`. */
  chains: Chain[];
  counts: { feasible: number; needs_decision: number };
  truncated: boolean;
}
