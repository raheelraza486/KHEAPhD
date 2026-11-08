/**
 * API Composition: from a business process of at most four steps to the
 * combinations of catalogue APIs that can carry it out.
 *
 * The existing checks judge one ordered pair at a time. A process is not a
 * plain pipe, though: a validation step examines the document and lets it
 * through, so the step after it has to accept the document the last
 * transformation produced, not the validator's report. `planProcess` works out,
 * for every step, whose output its input is compared with; `composeChains`
 * then checks only those links and keeps the combinations in which none fails.
 *
 * The checking itself is injected (`checkLink`), so this file decides which
 * pairs to check and how to combine the verdicts, and nothing else. The
 * server adapter passes `runChecks` from lib/checks.
 */
import type { ApiSideInput } from "../checks/types.ts";
import {
  MAX_STEPS,
  STEP_CATEGORIES,
  type BusinessProcess,
  type Chain,
  type ChainLink,
  type CompositionResult,
  type LinkVerdict,
  type ProcessIssue,
  type StepCategory,
  type StepPlan,
  type StepRole,
} from "./types.ts";

const ROLE: Record<StepCategory, StepRole> = {
  Transformation: "produces",
  Validation: "checks",
  Communication: "delivers",
};

export function roleOf(category: StepCategory): StepRole {
  return ROLE[category];
}

function categoryOf(value: string | null | undefined): StepCategory | null {
  const v = value?.trim().toLowerCase();
  return STEP_CATEGORIES.find((c) => c.toLowerCase() === v) ?? null;
}

/**
 * Validates the order of the steps against the client's sequence and works
 * out where each step's input comes from. Steps of the same category may
 * follow each other (two Transformations: client, 3 October 2026). Going
 * backwards is refused, and so is a Transformation followed directly by a
 * Communication: the client ruled out skipping Validation on 1 October 2026.
 * A process may still start at Validation or end before Communication.
 */
export function planProcess(process: BusinessProcess): { plan: StepPlan[]; issues: ProcessIssue[] } {
  const issues: ProcessIssue[] = [];
  const steps = [...process.steps].sort((a, b) => a.order - b.order);

  if (steps.length === 0) issues.push({ code: "empty_process", message: "The process has no steps." });
  if (steps.length > MAX_STEPS) {
    issues.push({ code: "too_many_steps", message: `A business process has at most ${MAX_STEPS} steps; this one has ${steps.length}.` });
  }
  const seen = new Set<number>();
  for (const s of steps) {
    if (seen.has(s.order)) issues.push({ code: "duplicate_order", step: s.order, message: `Two steps are numbered ${s.order}.` });
    seen.add(s.order);
    if (!categoryOf(s.category)) {
      issues.push({ code: "unknown_category", step: s.order, message: `Step ${s.order} has category "${s.category}"; it must be one of ${STEP_CATEGORIES.join(", ")}.` });
    }
  }
  for (let i = 1; i < steps.length; i++) {
    const a = categoryOf(steps[i - 1].category);
    const b = categoryOf(steps[i].category);
    if (a && b && STEP_CATEGORIES.indexOf(b) < STEP_CATEGORIES.indexOf(a)) {
      issues.push({
        code: "order_reversed",
        step: steps[i].order,
        message: `Step ${steps[i].order} (${b}) comes after step ${steps[i - 1].order} (${a}); the order is ${STEP_CATEGORIES.join(" → ")}.`,
      });
    } else if (a === "Transformation" && b === "Communication") {
      issues.push({
        code: "validation_skipped",
        step: steps[i].order,
        message: `Step ${steps[i].order} (Communication) follows step ${steps[i - 1].order} (Transformation) directly; a Validation step must come between them.`,
      });
    }
  }

  // An unknown category is already an issue, and composeChains stops on any
  // issue; the plan still lists the step so the caller can show where it went wrong.
  const plan: StepPlan[] = steps.map((s) => {
    const category = (categoryOf(s.category) ?? s.category) as StepCategory;
    return { order: s.order, category, role: ROLE[category] ?? "delivers", input_from: null, output_used: false };
  });
  for (let i = 0; i < plan.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      if (plan[j].role === "produces") {
        plan[i].input_from = plan[j].order;
        plan[j].output_used = true;
        break;
      }
    }
  }
  return { plan, issues };
}

const SUCCESS = /^2\d\d$/;

function isSuccess(status: string | null | undefined): boolean {
  const s = (status ?? "").trim();
  return SUCCESS.test(s) || s.toUpperCase() === "2XX" || s.toLowerCase() === "default";
}

/** A request schema, or path/query parameters, that a comparison can read. */
export function hasInput(side: ApiSideInput): boolean {
  return side.parameters.length > 0 || side.schemas.some((s) => s.direction === "request");
}

/** A successful response the next step could consume. */
export function hasOutput(side: ApiSideInput): boolean {
  return side.schemas.some((s) => s.direction === "response" && isSuccess(s.status_code));
}

/**
 * Only the ends of a link need the matching side. A first step takes its
 * input from the user and a last step returns its output to the user, so
 * requiring both sides everywhere would drop valid first and last steps.
 */
export function eligible(side: ApiSideInput, step: StepPlan): boolean {
  if (step.input_from !== null && !hasInput(side)) return false;
  if (step.output_used && !hasOutput(side)) return false;
  return true;
}

/** What the checks need to know about a link beyond its two APIs. */
export interface LinkContext {
  /**
   * A Validation step stands between the two steps, as in convert → validate
   * → send, where the send step reads the converted document. Check 0 then
   * accepts Transformation → Communication.
   */
  validated_between: boolean;
}

export interface ComposeOptions {
  /** At most this many chains are returned; the counts still cover them all. */
  maxChains?: number;
  /** Keep operations with undocumented sides so the link check can explain missing evidence. */
  includeIncompleteSides?: boolean;
}

export function composeChains(
  process: BusinessProcess,
  catalogue: readonly ApiSideInput[],
  checkLink: (source: ApiSideInput, target: ApiSideInput, context: LinkContext) => LinkVerdict,
  options: ComposeOptions = {},
): CompositionResult {
  const maxChains = options.maxChains ?? 50;
  const { plan, issues } = planProcess(process);
  const empty: CompositionResult = { plan, issues, candidates: {}, chains: [], counts: { feasible: 0, needs_decision: 0 }, truncated: false };
  if (issues.length > 0) return empty;

  const stepsByOrder = new Map(process.steps.map((s) => [s.order, s]));
  const candidates: ApiSideInput[][] = plan.map((step) => {
    const wanted = stepsByOrder.get(step.order)?.candidate_ids;
    const allow = wanted ? new Set(wanted) : null;
    return catalogue.filter((side) =>
      categoryOf(side.api.category) === step.category
      && (!allow || allow.has(side.api.id))
      && (options.includeIncompleteSides || eligible(side, step)));
  });

  const verdicts = new Map<string, LinkVerdict>();
  const verdictOf = (s: ApiSideInput, t: ApiSideInput, context: LinkContext): LinkVerdict => {
    const key = `${s.api.id}->${t.api.id}${context.validated_between ? " via validation" : ""}`;
    let v = verdicts.get(key);
    if (v === undefined) {
      v = checkLink(s, t, context);
      verdicts.set(key, v);
    }
    return v;
  };
  const contextOf = (from: number, to: number): LinkContext => ({
    validated_between: plan.some((p) => p.order > from && p.order < to && p.category === "Validation"),
  });

  const indexOfOrder = new Map(plan.map((p, i) => [p.order, i]));
  const feasible: Chain[] = [];
  const needsDecision: Chain[] = [];
  const counts = { feasible: 0, needs_decision: 0 };
  const chosen: ApiSideInput[] = [];
  const links: ChainLink[] = [];

  const walk = (i: number): void => {
    if (i === plan.length) {
      const status = links.every((l) => l.verdict === "pass") ? "feasible" : "needs_decision";
      counts[status]++;
      const bucket = status === "feasible" ? feasible : needsDecision;
      if (bucket.length < maxChains) bucket.push({ api_ids: chosen.map((c) => c.api.id), links: [...links], status });
      return;
    }
    const step = plan[i];
    for (const candidate of candidates[i]) {
      if (chosen.some((c) => c.api.id === candidate.api.id)) continue;
      let link: ChainLink | null = null;
      if (step.input_from !== null) {
        const from = chosen[indexOfOrder.get(step.input_from)!];
        const verdict = verdictOf(from, candidate, contextOf(step.input_from, step.order));
        if (verdict === "fail") continue;
        link = { from_order: step.input_from, to_order: step.order, source_id: from.api.id, target_id: candidate.api.id, verdict };
      }
      chosen.push(candidate);
      if (link) links.push(link);
      walk(i + 1);
      chosen.pop();
      if (link) links.pop();
    }
  };
  walk(0);

  const chains = [...feasible, ...needsDecision].slice(0, maxChains);
  return {
    plan,
    issues,
    candidates: Object.fromEntries(plan.map((p, i) => [p.order, candidates[i].length])),
    chains,
    counts,
    truncated: counts.feasible + counts.needs_decision > chains.length,
  };
}
