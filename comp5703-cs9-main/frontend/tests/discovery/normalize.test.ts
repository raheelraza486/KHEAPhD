import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDiscoveryResult } from "../../lib/discovery/normalize.ts";
import { discoverProcess } from "../../lib/discovery/provider.ts";
import { parseProcessJson } from "../../lib/composition/process-format.ts";
import { planProcess } from "../../lib/composition/compose.ts";

const diagram = () => ({ version: "1.0", input_text: "Create, validate and send an invoice", unmatched: [], steps: [
  { order: 1, category: "Transformation", task: "Create UBL Invoice", input_format: "PDF", output_format: "XML_UBL", rule_set: null, candidate_ids: null },
  { order: 2, category: "Validation", task: "Validate for Australian rules", input_format: "XML_UBL", output_format: "XML_UBL", rule_set: "Australian rules", candidate_ids: null },
  { order: 3, category: "Communication", task: "Send via Peppol", input_format: "XML_UBL", output_format: "PEPPOL", rule_set: null, candidate_ids: null },
] });

test("a diagram's UBL aliases and Peppol arrow enter composition with document formats", async () => {
  const input = diagram(), before = structuredClone(input);
  const quotes = ["Convert PDF to XML_UBL", "Validate XML_UBL for Australian rules", "Send XML_UBL via Peppol"];
  const reply = { ...input, source_text: quotes.join("; "), suggested_order: false,
    source_evidence: quotes.map((step_quote, index) => ({ step_quote, suggested: false,
      input_format: index === 0 ? "PDF" : "XML_UBL", output_format: index === 0 ? "XML_UBL" : null,
      rule_set: index === 1 ? "Australian rules" : null })) };
  const result: any = await discoverProcess({ mode: "bpmn", file: new File(["image"], "flow.jpg", { type: "image/jpeg" }) }, {
    apiKey: "test-key", fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }),
  });
  assert.deepEqual(result.steps.map((step: any) => [step.input_format, step.output_format]), [
    ["PDF", "UBL XML"], ["UBL XML", null], ["UBL XML", null],
  ]);
  assert.equal(result.steps[2].task, "Send XML_UBL via Peppol");
  assert.equal(result.steps[1].rule_set, "Australian rules");
  const parsed = parseProcessJson(result);
  assert.ok(parsed.ok);
  assert.deepEqual(planProcess(parsed.process).issues, []);
  assert.deepEqual(input, before);
});

test("normalisation preserves explicit invalid order for the planner to reject", () => {
  const input = diagram();
  input.steps = [input.steps[1], input.steps[0], input.steps[2]].map((step, index) => ({ ...step, order: index + 1 }));
  const result: any = normalizeDiscoveryResult(input);
  assert.deepEqual(result.steps.map((step: any) => step.category), ["Validation", "Transformation", "Communication"]);
  const parsed = parseProcessJson(result);
  assert.ok(parsed.ok);
  assert.ok(planProcess(parsed.process).issues.some(issue => issue.code === "order_reversed"));
});

test("unknown formats, versioned standards and absent evidence remain unchanged", () => {
  const input = diagram();
  input.steps[0].output_format = "Hybrid PDF";
  input.steps[1].input_format = "UBL 2.1";
  input.steps[2].output_format = "Peppol BIS Billing 3.0";
  const result: any = normalizeDiscoveryResult(input);
  assert.equal(result.steps[0].output_format, "Hybrid PDF");
  assert.equal(result.steps[1].input_format, "UBL 2.1");
  assert.equal(result.steps[2].output_format, "Peppol BIS Billing 3.0");
  const vague = { steps: [{ category: "Communication", task: "Send document", output_format: "Peppol" }] };
  assert.deepEqual(normalizeDiscoveryResult(vague), vague);
  const absent = { steps: [{ category: "Transformation", task: "Convert" }] };
  assert.deepEqual(normalizeDiscoveryResult(absent), absent);
});

test("normalisation does not hide malformed model fields from contract validation", () => {
  for (const value of [null, [], "invalid", { steps: null }]) assert.deepEqual(normalizeDiscoveryResult(value), value);
  const input: any = diagram();
  input.steps[0].unexpected = true;
  assert.equal(parseProcessJson(normalizeDiscoveryResult(input)).ok, false);
});
