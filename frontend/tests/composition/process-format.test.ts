import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { composeChains, planProcess } from "../../lib/composition/compose.ts";
import { parseProcessJson, PROCESS_JSON_SCHEMA } from "../../lib/composition/process-format.ts";

const ID_A = "0b0f3c1e-5a57-4c8e-9d2e-1f6a7b8c9d01";

const example = () => ({
  version: "1.0",
  input_text: "convert PDF to UBL XML, validate with Australian rules and send by email",
  steps: [
    { order: 1, category: "Transformation", task: "convert PDF to UBL XML", input_format: "PDF", output_format: "UBL XML", rule_set: null, candidate_ids: [ID_A] },
    { order: 2, category: "Validation", task: "validate with Australian rules", input_format: null, output_format: null, rule_set: "Australian rules", candidate_ids: null },
    { order: 3, category: "Communication", task: "send by email" },
  ],
  unmatched: [],
});

const paths = (value: unknown) => {
  const r = parseProcessJson(value);
  return r.ok ? [] : r.errors.map((e) => e.path);
};

test("the documented example passes and becomes the engine's process unchanged", () => {
  const r = parseProcessJson(example());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.process.steps.map((s) => [s.order, s.category, s.task, s.candidate_ids]), [
    [1, "Transformation", "convert PDF to UBL XML", [ID_A]],
    [2, "Validation", "validate with Australian rules", null],
    [3, "Communication", "send by email", null],
  ]);
  assert.equal(r.process.steps[0].output_format, "UBL XML");
  assert.equal(r.process.steps[1].rule_set, "Australian rules");
  assert.deepEqual(planProcess(r.process).issues, []);
});

test("nothing recognised is a valid answer: no steps, the text in unmatched", () => {
  const r = parseProcessJson({ version: "1.0", input_text: "archive my invoices", steps: [], unmatched: ["archive my invoices"] });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(planProcess(r.process).issues.map((i) => i.code), ["empty_process"]);
});

test("a category must be spelled exactly, and Other has no place", () => {
  for (const category of ["transformation", "Other", "Send", null]) {
    const v = example();
    (v.steps[0] as Record<string, unknown>).category = category;
    assert.deepEqual(paths(v), ["steps[0].category"], String(category));
  }
});

test("steps are listed in order and numbered from 1", () => {
  const v = example();
  v.steps[1].order = 3;
  v.steps[2].order = 2;
  assert.deepEqual(paths(v), ["steps[1].order", "steps[2].order"]);
});

test("an unknown or misspelt field is an error, not silently dropped", () => {
  const v = example() as Record<string, unknown>;
  (v.steps as Record<string, unknown>[])[0].input_fromat = "PDF";
  v.confidence = 0.9;
  assert.deepEqual(paths(v).sort(), ["confidence", "steps[0].input_fromat"]);
});

test("candidate ids are repository UUIDs, each once; null means not narrowed, [] means none found", () => {
  const bad = example();
  bad.steps[0].candidate_ids = ["beliq API generateInvoice"];
  assert.deepEqual(paths(bad), ["steps[0].candidate_ids"]);
  const twice = example();
  twice.steps[0].candidate_ids = [ID_A, ID_A];
  assert.deepEqual(paths(twice), ["steps[0].candidate_ids"]);

  const none = example();
  none.steps[0].candidate_ids = [];
  const r = parseProcessJson(none);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const result = composeChains(r.process, [], () => "pass");
  assert.equal(result.chains.length, 0);
});

test("version, input_text, steps and unmatched are required", () => {
  assert.deepEqual(paths({}).sort(), ["input_text", "steps", "unmatched", "version"]);
  assert.deepEqual(paths({ ...example(), version: "2.0" }), ["version"]);
  assert.deepEqual(paths("not an object"), [""]);
});

test("more than four steps, or a reversed order, passes the format and is refused by the plan", () => {
  const v = example();
  v.steps.push({ order: 4, category: "Communication", task: "send again" }, { order: 5, category: "Communication", task: "and again" });
  const r = parseProcessJson(v);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(planProcess(r.process).issues.map((i) => i.code), ["too_many_steps"]);

  const reversed = example();
  reversed.steps[0].category = "Communication";
  reversed.steps[2].category = "Transformation";
  const r2 = parseProcessJson(reversed);
  assert.equal(r2.ok, true);
  if (r2.ok) assert.ok(planProcess(r2.process).issues.some((i) => i.code === "order_reversed"));
});

test("the schema file the LLM stream uses is the same contract as the code", () => {
  const file = JSON.parse(readFileSync(new URL("../../lib/composition/process-format.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(file, JSON.parse(JSON.stringify(PROCESS_JSON_SCHEMA)));
});
