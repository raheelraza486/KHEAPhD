import assert from "node:assert/strict";
import test from "node:test";
import { narrowProcessCandidates, type CandidateApi } from "../../lib/composition/task-candidates.ts";
import { australianRuleSupport } from "../../lib/composition/validation-rules.ts";
import type { ProcessStep } from "../../lib/composition/types.ts";

const au: CandidateApi = { id: "au", category: "Validation", api_name: "Australian invoice validator", description: "Validate invoice using Australian rules" };
const generic: CandidateApi = { id: "eu", category: "Validation", api_name: "EN 16931 invoice validator", description: "Validate UBL XML invoice using European rules" };
const pint: CandidateApi = { id: "pint", category: "Validation", api_name: "Check PINT A-NZ invoice" };
const given: ProcessStep = { order: 1, category: "Validation", task: "Validate invoice with Australian rules", rule_set: "Australian rules" };

test("format words neither admit a generic validator nor exclude a supported AU validator", () => {
  for (const fields of [{}, { input_format: "UBL XML", output_format: "UBL XML" }]) {
    const out = narrowProcessCandidates({ steps: [{ ...given, ...fields }] }, [au, generic, pint]);
    assert.deepEqual(new Set(out.process.steps[0].candidate_ids), new Set(["au", "pint"]));
    assert.deepEqual(out.steps[0].rule_review, [{ id: "eu", status: "unverified" }]);
  }
});

test("selecting catalogue IDs explicitly cannot bypass a requested rules constraint", () => {
  const out = narrowProcessCandidates({ steps: [{ ...given, candidate_ids: ["eu", "au"] }] }, [au, generic]);
  assert.deepEqual(out.process.steps[0].candidate_ids, ["au"]);
  assert.deepEqual(out.steps[0].rule_review, [{ id: "eu", status: "unverified" }]);
});

test("provider country and generic Peppol/XML support do not establish Australian rules", () => {
  assert.equal(australianRuleSupport({ ...generic, country_region: "Australia" }), "unverified");
  assert.equal(australianRuleSupport({ ...generic, description: "Based in Australia. Validate European UBL XML invoices." }), "unverified");
  assert.equal(australianRuleSupport({ ...generic, invoice_standard: ["Peppol BIS Billing 3.0", "UBL 2.1"] }), "unverified");
  assert.equal(australianRuleSupport({ ...au, description: "Does not support Australian rules." }), "rejected");
});

test("directional capability evidence must be confirmed, input-side and linked", () => {
  const claim = { id: "c", api_id: "eu", direction: "input" as const, standard: "PINT", version: "1.1.3", profile: "PINT A-NZ", status: "confirmed" as const, condition: "", evidence_url: "https://docs.example.test/rules" };
  assert.equal(australianRuleSupport({ ...generic, standard_capabilities: [claim] }), "supported");
  assert.equal(australianRuleSupport({ ...generic, standard_capabilities: [{ ...claim, direction: "output" }] }), "unverified");
  assert.equal(australianRuleSupport({ ...generic, standard_capabilities: [{ ...claim, evidence_url: "" }] }), "unverified");
  assert.equal(australianRuleSupport({ ...au, standard_capabilities: [{ ...claim, api_id: "au", status: "rejected" }] }), "rejected");
});

test("a generic validation request does not impose an Australian constraint", () => {
  const out = narrowProcessCandidates({ steps: [{ ...given, task: "Validate UBL XML invoice", rule_set: null }] }, [generic]);
  assert.deepEqual(out.process.steps[0].candidate_ids, ["eu"]);
});
