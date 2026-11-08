import assert from "node:assert/strict";
import test from "node:test";
import { groundDiscoveryResult, type DiscoveryReview } from "../../lib/discovery/grounding.ts";
import { discoverProcess } from "../../lib/discovery/provider.ts";
import { parseProcessJson } from "../../lib/composition/process-format.ts";

const step = (category: string, task: string, fields: Record<string, unknown> = {}) => ({ order: 1, category, task, input_format: null, output_format: null, rule_set: null, candidate_ids: null, ...fields });
const evidence = (step_quote: string | null, fields: Record<string, unknown> = {}) => ({ step_quote, input_format: null, output_format: null, rule_set: null, suggested: false, ...fields });
function grounded(source: string, steps: ReturnType<typeof step>[], proof: ReturnType<typeof evidence>[], extra: object = {}) {
  const raw = { version: "1.0", input_text: source, steps: steps.map((s, i) => ({ ...s, order: i + 1 })), unmatched: [], source_text: null, source_evidence: proof, suggested_order: false, ...extra };
  return groundDiscoveryResult(raw, { mode: "text", text: source }) as { process: typeof raw; review: DiscoveryReview[] };
}

test("conversion formats cannot leak into validation, delivery or their task keywords", async () => {
  const source = "Convert PDF to UBL XML, validate using AU rules, then send via Peppol";
  const reply = { version: "1.0", input_text: source, unmatched: [], source_text: null, suggested_order: false,
    steps: [step("Transformation", "Convert PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML" }),
      step("Validation", "Validate UBL XML using PINT A-NZ rules", { input_format: "UBL XML", output_format: "UBL XML", rule_set: "PINT A-NZ rules" }),
      step("Communication", "Send UBL XML via Peppol", { input_format: "UBL XML", output_format: "UBL XML" })].map((s, i) => ({ ...s, order: i + 1 })),
    source_evidence: [evidence("Convert PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML" }),
      evidence("validate using AU rules", { input_format: "UBL XML", output_format: "UBL XML", rule_set: "AU rules" }),
      evidence("send via Peppol", { input_format: "UBL XML", output_format: "UBL XML" })] };
  let review: DiscoveryReview[] = [];
  const result: any = await discoverProcess({ mode: "text", text: source }, { apiKey: "test-only", onReview: notes => { review = notes; },
    fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }) });
  assert.deepEqual(result.steps.map((s: any) => [s.input_format, s.output_format, s.rule_set]), [["PDF", "UBL XML", null], [null, null, "AU rules"], [null, null, null]]);
  assert.equal(result.steps[1].task, "validate using AU rules");
  assert.equal(result.steps[2].task, "send via Peppol");
  assert.ok(!JSON.stringify(result).includes("source_evidence"));
  assert.ok(parseProcessJson(result).ok);
  assert.equal(review.filter(note => note.order === 2).length, 2);
});

for (const [category, quote, fields] of [
  ["Validation", "Validate UBL XML", { input_format: "UBL XML" }],
  ["Validation", "Validate XML_UBL and return a JSON report", { input_format: "XML_UBL", output_format: "JSON" }],
  ["Communication", "Send UBL_XML and return a JSON receipt", { input_format: "UBL_XML", output_format: "JSON" }],
  ["Communication", "发送 UBL XML 发票并返回 JSON 回执", { input_format: "UBL XML", output_format: "JSON" }],
  ["Validation", "按澳大利亚规则校验 XML_UBL", { input_format: "XML_UBL", rule_set: "澳大利亚规则" }],
] as const) {
  test(`explicit step labels remain usable: ${quote}`, () => {
    const out = grounded(quote, [step(category, quote, fields)], [evidence(quote, fields)]);
    const s = out.process.steps[0];
    assert.equal(s.input_format, "UBL XML");
    assert.equal(s.output_format, fields.output_format ?? null);
    assert.equal(s.rule_set, fields.rule_set ?? null);
    assert.deepEqual(out.review, []);
  });
}

test("bare UBL is copied from its citation, rather than expanded to XML or a version", () => {
  const out = grounded("Convert PDF to UBL", [step("Transformation", "Convert PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML" })],
    [evidence("Convert PDF to UBL", { input_format: "PDF", output_format: "UBL" })]);
  assert.equal(out.process.steps[0].output_format, "UBL");
  assert.equal(out.process.steps[0].task, "Convert PDF to UBL");
});

test("a whole-sentence citation cannot be reused to justify later-step fields", () => {
  const source = "Convert PDF to XML_UBL, validate it, then send it";
  const out = grounded(source, [step("Transformation", "Convert PDF to XML_UBL", { input_format: "PDF", output_format: "XML_UBL" }),
    step("Validation", "Validate UBL XML", { input_format: "XML_UBL" })],
    [evidence("Convert PDF to XML_UBL", { input_format: "PDF", output_format: "XML_UBL" }), evidence(source, { input_format: "XML_UBL" })]);
  assert.equal(out.process.steps[1].input_format, null);
  assert.equal(out.process.steps[1].task, "validate it");
  assert.ok(out.review.length);
});

test("two sequential sends keep their separate source channels when model wording differs", () => {
  const source = "First send it via Peppol, then send it via email.";
  const out = grounded(source,
    [step("Communication", "Send via Peppol"), step("Communication", "Send via email")],
    [evidence("Send via Peppol"), evidence("Send via email")]);
  assert.match(out.process.steps[0].task, /Peppol/i);
  assert.doesNotMatch(out.process.steps[0].task, /email/i);
  assert.match(out.process.steps[1].task, /email/i);
  assert.doesNotMatch(out.process.steps[1].task, /Peppol/i);
  assert.ok(out.process.steps.every(s => s.task !== "Send invoice"));
});

test("a short or swapped citation cannot erase or exchange sequential delivery channels", () => {
  const source = "Send invoice via Peppol, then send invoice via email.";
  const out = grounded(source,
    [step("Communication", "Send invoice"), step("Communication", "Send invoice")],
    [evidence("send invoice via email"), evidence("Send invoice via Peppol")]);
  assert.match(out.process.steps[0].task, /Peppol/i);
  assert.match(out.process.steps[1].task, /email/i);
  assert.doesNotMatch(out.process.steps[0].task, /email/i);
  assert.doesNotMatch(out.process.steps[1].task, /Peppol/i);
  const single = grounded("Send invoice via Peppol", [step("Communication", "Send invoice")], [evidence("Send invoice")]);
  assert.match(single.process.steps[0].task, /Peppol/i);
});

test("suggested conversions bind only source goal formats and remain labelled suggestions", () => {
  const source = "The supplier sends PDF. The customer needs UBL XML. Use Australian rules and deliver via Peppol.";
  const out = grounded(source, [step("Transformation", "Infer PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML", rule_set: "Australian rules" })],
    [evidence(null, { input_format: "PDF", output_format: "UBL XML", rule_set: "Australian rules", suggested: true })], { suggested_order: true });
  assert.deepEqual([out.process.steps[0].input_format, out.process.steps[0].output_format, out.process.steps[0].rule_set], ["PDF", "UBL XML", null]);
  assert.ok(out.review.some(note => note.message.includes("order is suggested")));
  assert.ok(out.review.some(note => note.order === 1));
});

test("an explicit unsupported sequence is left for the planner, not reordered", () => {
  const out = grounded("First validate using AU rules, then convert PDF to UBL XML", [step("Validation", "validate using AU rules", { rule_set: "AU rules" }), step("Transformation", "convert PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML" })],
    [evidence("validate using AU rules", { rule_set: "AU rules" }), evidence("convert PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML" })]);
  assert.deepEqual(out.process.steps.map(s => s.category), ["Validation", "Transformation"]);
});

test("an invented citation and a mismatched format label cannot establish a field", () => {
  for (const citation of ["UBL XML", "Validate invoice"]) {
    const out = grounded("Validate invoice", [step("Validation", "Validate invoice", { input_format: "UBL XML" })], [evidence("Validate invoice", { input_format: citation })]);
    assert.equal(out.process.steps[0].input_format, null);
  }
});

test("a report's JSON format does not justify calling the invoice XML an API response", () => {
  const quote = "Validate UBL XML and return a JSON report";
  const out = grounded(quote, [step("Validation", quote, { input_format: "UBL XML", output_format: "UBL XML" })], [evidence(quote, { input_format: "UBL XML", output_format: "UBL XML" })]);
  assert.equal(out.process.steps[0].input_format, "UBL XML");
  assert.equal(out.process.steps[0].output_format, null);
});

test("networks and substrings of a label do not become document formats", () => {
  for (const [quote, format] of [["Send via Peppol", "Peppol"], ["Validate XML_UBL", "XML"]]) {
    const out = grounded(quote, [step("Communication", quote, { input_format: format })], [evidence(quote, { input_format: format })]);
    assert.equal(out.process.steps[0].input_format, null);
  }
});

test("uploaded media labels are checked against the transcription and identified as model readings", () => {
  const raw = { version: "1.0", input_text: "A diagram", steps: [step("Validation", "Validate UBL XML", { input_format: "XML_UBL" })], unmatched: [], source_text: "Validate XML_UBL", source_evidence: [evidence("Validate XML_UBL", { input_format: "XML_UBL" })] };
  const out: any = groundDiscoveryResult(raw, { mode: "bpmn", file: new File(["synthetic"], "test.png", { type: "image/png" }) });
  assert.equal(out.process.steps[0].input_format, "UBL XML");
  assert.match(out.review[0].message, /model transcription/);
  const xml: any = groundDiscoveryResult({ ...raw, source_text: null }, { mode: "bpmn", file: new File([""], "test.bpmn"), bpmn_xml: '<task name="Validate XML_UBL"/>' });
  assert.equal(xml.process.steps[0].input_format, "UBL XML");
});

test("malformed public fields are not hidden by evidence handling", () => {
  const out = grounded("Validate invoice", [step("Validation", "Validate invoice", { input_format: 17, unexpected: true })], [evidence("Validate invoice")]);
  assert.equal(parseProcessJson(out.process).ok, false);
});

const invoiceGoal = "Can you please list down some possible business processes for the ‘Send an Invoice’ scenario, where the input is in PDF format, validated for the Australian rules, and is sent in UBL XML format via Peppol network.";
for (const proofStyle of ["short clauses", "whole sentence", "missing citations"] as const) {
  test(`source-stated invoice goals survive ${proofStyle} without manual re-entry`, () => {
    const proof = proofStyle === "short clauses" ? [
      evidence("Input is in PDF format", { input_format: "PDF", output_format: null, suggested: true }),
      evidence("validated for the Australian rules", { rule_set: "Australian rules" }),
      evidence("sent in UBL XML format via Peppol network"),
    ] : proofStyle === "whole sentence" ? [
      evidence(invoiceGoal, { input_format: "PDF", output_format: "UBL XML", suggested: true }),
      evidence(invoiceGoal, { rule_set: "Australian rules", suggested: true }),
      evidence(invoiceGoal, { suggested: true }),
    ] : [];
    const out = grounded(invoiceGoal, [step("Transformation", "Convert PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML" }),
      step("Validation", "Validate invoice", { rule_set: proofStyle === "missing citations" ? null : "Australian rules" }),
      step("Communication", "Send invoice")], proof, { suggested_order: true });
    const [convert, validate, send] = out.process.steps;
    assert.deepEqual([convert.input_format, convert.output_format], ["PDF", "UBL XML"]);
    assert.equal(convert.task, "Convert PDF to UBL XML");
    assert.equal(validate.rule_set, "Australian rules");
    assert.match(String(validate.task), /Australian rules/);
    assert.match(String(send.task), /Peppol/);
    assert.equal(send.input_format, "UBL XML");
    assert.equal(validate.input_format, null, "The validation input still need not be inferred");
    assert.equal(validate.output_format, null);
    assert.equal(send.output_format, null);
    assert.ok(!out.review.some(note => /can stay blank/.test(note.message)), "Explicit goals are retained automatically");
    assert.ok(parseProcessJson(out.process).ok);
  });
}

test("a reported response format cannot be adopted as an input format", () => {
  const quote = "Validate UBL XML and return a JSON report";
  const out = grounded(quote, [step("Validation", quote, { input_format: "JSON", output_format: "JSON" })], [evidence(quote, { input_format: "JSON", output_format: "JSON" })]);
  assert.equal(out.process.steps[0].input_format, null);
  assert.equal(out.process.steps[0].output_format, "JSON");
});

test("goal recovery preserves explicitly named versions and does not repair malformed contract fields", () => {
  const source = "Input is PDF, validated for Australian rules, sent in UBL XML 2.1 via Peppol.";
  const out = grounded(source, [step("Transformation", "Convert invoice", { input_format: "PDF", output_format: "UBL XML 2.1" })], [evidence(null, { suggested: true })]);
  assert.equal(out.process.steps[0].output_format, "UBL XML 2.1");
  const malformed = grounded(source, [step("Transformation", "Convert invoice", { input_format: 17, output_format: "UBL XML" })], [evidence(null, { suggested: true })]);
  assert.equal(parseProcessJson(malformed.process).ok, false);
});

test("R-30: a gateway image cited as two boxes still reaches both channels after the BPMN boundary", async () => {
  const { collapseBpmnDeliveryBranches } = await import("../../lib/discovery/gateway-branches.ts");
  const raw = {
    version: "1.0",
    input_text: "Invoice process (BPMN) starting with PDF invoice, converting to UBL XML, validating using Australian rules, and then sending via email or Peppol.",
    steps: [
      step("Transformation", "Convert PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML" }),
      step("Validation", "Validate using Australian rules", { rule_set: "Australian rules" }),
      step("Communication", "send via email or Peppol"),
    ].map((s, i) => ({ ...s, order: i + 1 })),
    unmatched: [],
    source_text: "PDF invoice. Convert PDF to UBL XML. Validate using Australian rules. Send via email. Send via Peppol. Delivered.",
    source_evidence: [
      evidence("Convert PDF to UBL XML", { input_format: "PDF", output_format: "UBL XML" }),
      evidence("Validate using Australian rules", { rule_set: "Australian rules" }),
      evidence("Send via email"),
    ],
    suggested_order: false,
  };
  const out: any = groundDiscoveryResult(raw, { mode: "bpmn", file: new File(["synthetic"], "use-case-bpmn-gateway.png", { type: "image/png" }) });
  // Grounding alone keeps one box's label, as seen on the live site on 30 October.
  assert.match(out.process.steps[2].task, /email/i);
  assert.doesNotMatch(out.process.steps[2].task, /peppol/i);
  const parsed = parseProcessJson(out.process);
  assert.ok(parsed.ok);
  const collapsed = collapseBpmnDeliveryBranches(out.process);
  assert.equal(collapsed.steps.length, 3);
  assert.equal(collapsed.steps[2].task, "send via email or Peppol");
});
