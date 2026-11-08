import assert from "node:assert/strict";
import test from "node:test";
import { collapseBpmnDeliveryBranches } from "../../lib/discovery/gateway-branches.ts";
import type { DiscoveryProcessJson } from "../../lib/discovery/types.ts";

function process(...tasks: string[]): DiscoveryProcessJson {
  return {
    version: "1.0",
    input_text: tasks.join(", then "),
    steps: tasks.map((task, index) => ({
      order: index + 1,
      category: "Communication",
      task,
      input_format: null,
      output_format: null,
      rule_set: null,
      candidate_ids: null,
    })),
    unmatched: [],
  };
}

test("collapses adjacent email and Peppol send branches in either model order", () => {
  for (const tasks of [
    ["send invoice by email", "send invoice over Peppol"],
    ["deliver through Peppol", "email the invoice"],
  ]) {
    const input = { ...process(...tasks), input_text: "send via email or Peppol" };
    const before = structuredClone(input);
    const result = collapseBpmnDeliveryBranches(input);
    assert.deepEqual(result.steps.map(({ order, task }) => [order, task]), [[1, "send via email or Peppol"]]);
    assert.deepEqual(input, before);
  }
});

test("keeps two explicitly sequential sending steps", () => {
  for (const tasks of [
    ["send invoice by email", "send invoice over Peppol"],
    ["send invoice over Peppol", "send invoice by email"],
  ]) {
    const result = collapseBpmnDeliveryBranches(process(...tasks));
    assert.deepEqual(result.steps.map(({ task }) => task), tasks);
  }
});

test("keeps non-sending Communication work separate even when channels are alternatives", () => {
  for (const tasks of [
    ["send invoice by email", "archive delivery receipt", "send invoice over Peppol"],
    ["receive invoice by email", "send invoice over Peppol"],
    ["send invoice by email", "receive invoice over Peppol"],
  ]) {
    const result = collapseBpmnDeliveryBranches({ ...process(...tasks), input_text: "send via email or Peppol" });
    assert.deepEqual(result.steps.map(({ task }) => task), tasks);
    assert.deepEqual(result.steps.map(({ order }) => order), tasks.map((_, index) => index + 1));
  }
});

function useCase(sendTask: string, inputText: string): DiscoveryProcessJson {
  return {
    version: "1.0",
    input_text: inputText,
    steps: [
      { order: 1, category: "Transformation", task: "Convert PDF to UBL XML", input_format: "PDF", output_format: "UBL XML", rule_set: null, candidate_ids: null },
      { order: 2, category: "Validation", task: "Validate using Australian rules", input_format: null, output_format: null, rule_set: "Australian rules", candidate_ids: null },
      { order: 3, category: "Communication", task: sendTask, input_format: null, output_format: null, rule_set: null, candidate_ids: null },
    ],
    unmatched: [],
  };
}

test("a single send step that kept one gateway branch's label stands for both channels", () => {
  // R-30 / R-43: the gateway diagram came back as one step named after the email box.
  for (const task of ["Send invoice via email", "Send via email", "Send via Peppol"]) {
    const input = useCase(task, "Invoice process (BPMN) starting with PDF invoice, converting to UBL XML, validating using Australian rules, and then sending via email or Peppol.");
    const before = structuredClone(input);
    const result = collapseBpmnDeliveryBranches(input);
    assert.deepEqual(result.steps.map(({ order, task }) => [order, task]), [
      [1, "Convert PDF to UBL XML"], [2, "Validate using Australian rules"], [3, "send via email or Peppol"],
    ]);
    assert.equal(result.steps[2].candidate_ids, null);
    assert.equal(result.steps[1].rule_set, "Australian rules");
    assert.deepEqual(input, before);
  }
});

test("a single send step that joins both box labels without \"or\" stands for both channels", () => {
  // R-43 (#151): the gateway image came back as "Send via email Send via Peppol" and found no APIs.
  const flow = "Invoice process (BPMN) starting with PDF invoice, converting to UBL XML, validating using Australian rules, and then sending via email or Peppol.";
  for (const task of ["Send via email Send via Peppol", "Send invoice via Peppol and email"]) {
    const result = collapseBpmnDeliveryBranches(useCase(task, flow));
    assert.equal(result.steps[2].task, "send via email or Peppol");
    assert.equal(result.steps[2].candidate_ids, null);
  }
  // Already stated as alternatives: left as written.
  assert.equal(collapseBpmnDeliveryBranches(useCase("Send invoice via email or Peppol", flow)).steps[2].task, "Send invoice via email or Peppol");
  // Without alternatives in the recognised flow, both channels stay as written.
  const sequential = "convert PDF to UBL XML, validate, then send via email and via Peppol";
  assert.equal(collapseBpmnDeliveryBranches(useCase("Send via email Send via Peppol", sequential)).steps[2].task, "Send via email Send via Peppol");
});

test("a single send step keeps its channel when the flow names no alternative", () => {
  for (const text of ["convert PDF to UBL XML, validate using Australian rules, then send via email", "send via email, then archive it"]) {
    const result = collapseBpmnDeliveryBranches(useCase("Send via email", text));
    assert.equal(result.steps[2].task, "Send via email");
  }
});

test("a send step with no channel, or a receiving step, is not widened", () => {
  const text = "receive the invoice by email or Peppol";
  assert.equal(collapseBpmnDeliveryBranches(useCase("Send invoice", text)).steps[2].task, "Send invoice");
  assert.equal(collapseBpmnDeliveryBranches(useCase("Receive invoice via email", text)).steps[2].task, "Receive invoice via email");
});


test("repeated mentions of the same channel cannot introduce the other channel", () => {
  for (const text of ["send via email or email", "send via Peppol or Peppol"]) {
    const input = useCase("Send via email", text);
    assert.deepEqual(collapseBpmnDeliveryBranches(input), input);
  }
});
