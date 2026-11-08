import assert from "node:assert/strict";
import test from "node:test";

import { composeChains, eligible, planProcess, type LinkContext } from "../../lib/composition/compose.ts";
import type { BusinessProcess, LinkVerdict, StepCategory } from "../../lib/composition/types.ts";
import { runChecks } from "../../lib/checks/run.ts";
import type { ApiSideInput } from "../../lib/checks/types.ts";
import { ALIASES, api, schema, side } from "../checks/helpers.ts";

function process(...categories: StepCategory[]): BusinessProcess {
  return { steps: categories.map((category, i) => ({ order: i + 1, category, task: `${category} step` })) };
}

/** An API with a request schema, a 200 response, both, or neither. */
function apiOf(category: StepCategory, id: string, sides: { input?: boolean; output?: boolean } = { input: true, output: true }): ApiSideInput {
  const schemas = [];
  if (sides.input) schemas.push(schema({ direction: "request" }, ["invoiceNumber:string:req"]));
  if (sides.output) schemas.push(schema({ direction: "response" }, ["invoiceNumber:string"]));
  return side(api({ id, api_name: id, category }), schemas);
}

/** A checkLink stub: every link passes unless listed. */
function verdicts(table: Record<string, LinkVerdict> = {}) {
  const asked: string[] = [];
  const contexts: Record<string, LinkContext> = {};
  const check = (s: ApiSideInput, t: ApiSideInput, context: LinkContext): LinkVerdict => {
    const key = `${s.api.id}->${t.api.id}`;
    asked.push(key);
    contexts[key] = context;
    return table[key] ?? "pass";
  };
  return { check, asked, contexts };
}

test("plan: a validation step is a gate, so the step after it reads the last transformation's output", () => {
  const { plan, issues } = planProcess(process("Transformation", "Validation", "Communication"));
  assert.deepEqual(issues, []);
  assert.deepEqual(plan.map((p) => [p.order, p.role, p.input_from, p.output_used]), [
    [1, "produces", null, true],
    [2, "checks", 1, false],
    [3, "delivers", 1, false],
  ]);
});

test("plan: a second transformation works on the first one's output", () => {
  const { plan, issues } = planProcess(process("Transformation", "Transformation", "Validation", "Communication"));
  assert.deepEqual(issues, []);
  assert.deepEqual(plan.map((p) => p.input_from), [null, 1, 2, 2]);
  assert.deepEqual(plan.map((p) => p.output_used), [true, true, false, false]);
});

test("plan: a transformation followed directly by a communication skips validation and is refused", () => {
  assert.deepEqual(planProcess(process("Transformation", "Communication")).issues.map((i) => [i.code, i.step]), [["validation_skipped", 2]]);
  assert.deepEqual(planProcess(process("Transformation", "Transformation", "Communication")).issues.map((i) => [i.code, i.step]), [["validation_skipped", 3]]);
  assert.deepEqual(planProcess(process("Transformation", "Validation")).issues, []);
  assert.deepEqual(planProcess(process("Validation", "Communication")).issues, []);
  assert.deepEqual(planProcess(process("Communication")).issues, []);
});

test("plan: without a transformation, every step works on the user's own document", () => {
  const { plan } = planProcess(process("Validation", "Communication"));
  assert.deepEqual(plan.map((p) => p.input_from), [null, null]);
});

test("plan: going backwards in Transformation → Validation → Communication is refused", () => {
  const { issues } = planProcess(process("Communication", "Validation"));
  assert.deepEqual(issues.map((i) => [i.code, i.step]), [["order_reversed", 2]]);
});

test("plan: more than four steps, an empty process and an unknown category are refused", () => {
  assert.equal(planProcess(process("Transformation", "Transformation", "Validation", "Validation", "Communication")).issues[0].code, "too_many_steps");
  assert.equal(planProcess({ steps: [] }).issues[0].code, "empty_process");
  const odd = planProcess({ steps: [{ order: 1, category: "Storage" as StepCategory, task: "keep it" }] });
  assert.equal(odd.issues[0].code, "unknown_category");
});

test("eligibility: only the ends of a link need the matching side", () => {
  const { plan } = planProcess(process("Transformation", "Validation", "Communication"));
  const [first, , last] = plan;
  // A first step takes its input from the user; it needs an output for the next step.
  assert.equal(eligible(apiOf("Transformation", "t-out", { output: true }), first), true);
  assert.equal(eligible(apiOf("Transformation", "t-in", { input: true }), first), false);
  // A last step returns its output to the user; it needs only an input.
  assert.equal(eligible(apiOf("Communication", "c-in", { input: true }), last), true);
  assert.equal(eligible(apiOf("Communication", "c-out", { output: true }), last), false);
});

test("compose: the delivery step is checked against the transformation, never against the validator's report", () => {
  const catalogue = [apiOf("Transformation", "T"), apiOf("Validation", "V"), apiOf("Communication", "C")];
  const { check, asked, contexts } = verdicts();
  const result = composeChains(process("Transformation", "Validation", "Communication"), catalogue, check);
  assert.deepEqual(asked.sort(), ["T->C", "T->V"]);
  // The send step reads the converted document, but through the validator: tell the checks so.
  assert.deepEqual(contexts, { "T->V": { validated_between: false }, "T->C": { validated_between: true } });
  assert.deepEqual(result.chains.map((c) => c.api_ids), [["T", "V", "C"]]);
  assert.equal(result.chains[0].status, "feasible");
});

test("compose: a failed link removes every chain through it; a pending one marks the chain for a decision", () => {
  const catalogue = [
    apiOf("Transformation", "T"),
    apiOf("Validation", "V"),
    apiOf("Communication", "C1"),
    apiOf("Communication", "C2"),
    apiOf("Communication", "C3"),
  ];
  const { check } = verdicts({ "T->C1": "fail", "T->C2": "pending_user" });
  const result = composeChains(process("Transformation", "Validation", "Communication"), catalogue, check);
  assert.deepEqual(result.counts, { feasible: 1, needs_decision: 1 });
  assert.deepEqual(result.chains.map((c) => [c.api_ids.at(-1), c.status]), [["C3", "feasible"], ["C2", "needs_decision"]]);
});

test("compose: each pair is checked once however many chains share it", () => {
  const catalogue = [
    apiOf("Transformation", "T"),
    apiOf("Validation", "V1"), apiOf("Validation", "V2"),
    apiOf("Communication", "C1"), apiOf("Communication", "C2"),
  ];
  const { check, asked } = verdicts();
  const result = composeChains(process("Transformation", "Validation", "Communication"), catalogue, check);
  assert.equal(result.counts.feasible, 4);
  assert.equal(asked.length, new Set(asked).size);
});

test("compose: candidates can be narrowed to what Discovery found for a step", () => {
  const catalogue = [apiOf("Transformation", "T1"), apiOf("Transformation", "T2"), apiOf("Validation", "V")];
  const base = process("Transformation", "Validation");
  const narrowed: BusinessProcess = { steps: base.steps.map((s) => (s.order === 1 ? { ...s, candidate_ids: ["T2"] } : s)) };
  const result = composeChains(narrowed, catalogue, verdicts().check);
  assert.deepEqual(result.chains.map((c) => c.api_ids), [["T2", "V"]]);
});

test("compose: an invalid process returns its issues and no chains", () => {
  const result = composeChains(process("Communication", "Transformation"), [apiOf("Transformation", "T"), apiOf("Communication", "C")], verdicts().check);
  assert.equal(result.issues[0].code, "order_reversed");
  assert.deepEqual(result.chains, []);
});

test("compose: the cap limits what is returned, not what is counted", () => {
  const catalogue = [apiOf("Transformation", "T"), ...Array.from({ length: 5 }, (_, i) => apiOf("Validation", `V${i}`))];
  const result = composeChains(process("Transformation", "Validation"), catalogue, verdicts().check, { maxChains: 2 });
  assert.equal(result.chains.length, 2);
  assert.equal(result.counts.feasible, 5);
  assert.equal(result.truncated, true);
});

test("compose with the real checks: a delivery step that cannot read the transformation's format is dropped; one that can passes Check 0 through the validator", () => {
  const t = side(api({ id: "T-xml", category: "Transformation", output_formats: ["XML"] }), [
    schema({ direction: "response" }, ["invoiceNumber:string"]),
  ]);
  const v = side(api({ id: "V-xml", category: "Validation", input_formats: ["XML"] }), [
    schema({ direction: "request" }, ["invoiceNumber:string:req"]),
  ]);
  const cJson = side(api({ id: "C-json", category: "Communication", input_formats: ["JSON"] }), [
    schema({ direction: "request" }, ["invoiceNumber:string:req"]),
  ]);
  const cXml = side(api({ id: "C-xml", category: "Communication", input_formats: ["XML"] }), [
    schema({ direction: "request" }, ["invoiceNumber:string:req"]),
  ]);
  const check = (s: ApiSideInput, tt: ApiSideInput, context: LinkContext) => runChecks({
    source: s, target: tt, formatAliases: ALIASES, choices: [], validatedBetween: context.validated_between,
  }).overall.overall;
  const result = composeChains(process("Transformation", "Validation", "Communication"), [t, v, cJson, cXml], check);
  assert.deepEqual(result.chains.map((c) => [c.api_ids, c.status]), [[["T-xml", "V-xml", "C-xml"], "feasible"]]);
  // The same pair compared on its own, as on the compatibility page, skips validation.
  const alone = runChecks({ source: t, target: cXml, formatAliases: ALIASES, choices: [] });
  assert.equal(alone.check0.reason_code, "operation_sequence_skips_validation");
  assert.equal(alone.overall.overall, "fail");
});
