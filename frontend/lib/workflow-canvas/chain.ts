/**
 * Editing the chain behind the workflow canvas. The canvas never writes the
 * state machine itself: each edit changes the list of APIs, and the Step
 * Functions generator turns the new list into the definition. Here are the
 * edits and the client's rules they must keep (planProcess): at most four
 * steps, Transformation → Validation → Communication, and no Communication
 * straight after a Transformation.
 *
 * Pure: no React, no network.
 */
import { planProcess } from "../composition/compose.ts";
import { MAX_STEPS, STEP_CATEGORIES, type StepCategory } from "../composition/types.ts";

export interface CanvasApi {
  id: string;
  api_name: string;
  company_name: string;
  category: StepCategory;
}

export type ChainEdit =
  | { ok: true; chain: CanvasApi[] }
  | { ok: false; reason: string };

/** Problems with a chain, in plain words; empty when the generator can take it. */
export function chainProblems(chain: readonly CanvasApi[]): string[] {
  if (chain.length === 0) return [];
  const { issues } = planProcess({
    steps: chain.map((api, index) => ({ order: index + 1, category: api.category, task: api.api_name })),
  });
  return issues.map((issue) => {
    switch (issue.code) {
      case "too_many_steps": return `A workflow has at most ${MAX_STEPS} API steps.`;
      case "order_reversed": return `Steps go in the order ${STEP_CATEGORIES.join(" → ")}.`;
      case "validation_skipped": return "A validation step must come between a transformation and a communication step.";
      default: return issue.message;
    }
  });
}

function checked(chain: CanvasApi[]): ChainEdit {
  const problems = chainProblems(chain);
  return problems.length ? { ok: false, reason: problems[0] } : { ok: true, chain };
}

/** Where a new API of this category goes: after the last step that may come before it. */
export function insertionIndex(chain: readonly CanvasApi[], category: StepCategory): number {
  const rank = STEP_CATEGORIES.indexOf(category);
  let index = 0;
  chain.forEach((api, position) => {
    if (STEP_CATEGORIES.indexOf(api.category) <= rank) index = position + 1;
  });
  return index;
}

export function addApi(chain: readonly CanvasApi[], api: CanvasApi): ChainEdit {
  const index = insertionIndex(chain, api.category);
  return checked([...chain.slice(0, index), api, ...chain.slice(index)]);
}

export function replaceApi(chain: readonly CanvasApi[], index: number, api: CanvasApi): ChainEdit {
  if (index < 0 || index >= chain.length) return { ok: false, reason: "That step is no longer in the workflow." };
  if (chain[index].id === api.id) return { ok: false, reason: `${api.api_name} is already this step.` };
  return checked(chain.map((item, position) => (position === index ? api : item)));
}

export function removeApi(chain: readonly CanvasApi[], index: number): ChainEdit {
  if (index < 0 || index >= chain.length) return { ok: false, reason: "That step is no longer in the workflow." };
  const next = chain.filter((_, position) => position !== index);
  const edit = checked(next);
  return edit.ok ? edit : { ok: false, reason: `${edit.reason} Replace this step instead of removing it.` };
}

export function moveApi(chain: readonly CanvasApi[], index: number, offset: -1 | 1): ChainEdit {
  const target = index + offset;
  if (index < 0 || index >= chain.length || target < 0 || target >= chain.length) {
    return { ok: false, reason: "This step cannot move further." };
  }
  const next = [...chain];
  [next[index], next[target]] = [next[target], next[index]];
  return checked(next);
}

/**
 * The pairs the compatibility checks compare: each step against the nearest
 * earlier step that produces the document (a validator passes it on
 * unchanged), as /api/composition links a chain.
 */
export function connectionPairs(chain: readonly CanvasApi[]): Array<{ from: number; to: number }> {
  if (chainProblems(chain).length) return [];
  const { plan } = planProcess({
    steps: chain.map((api, index) => ({ order: index + 1, category: api.category, task: api.api_name })),
  });
  return plan.flatMap((step) => (step.input_from === null ? [] : [{ from: step.input_from - 1, to: step.order - 1 }]));
}
