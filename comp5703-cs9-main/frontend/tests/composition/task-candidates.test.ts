import assert from "node:assert/strict";
import test from "node:test";

import { composeChains } from "../../lib/composition/compose.ts";
import { narrowProcessCandidates, type CandidateApi } from "../../lib/composition/task-candidates.ts";
import type { BusinessProcess } from "../../lib/composition/types.ts";
import { api, schema, side } from "../checks/helpers.ts";

const catalogue: CandidateApi[] = [
  { id: "T-peppol", category: "Transformation", api_name: "generateInvoice", description: "Generate a Peppol BIS invoice", output_formats: ["UBL XML"], is_active: true },
  { id: "T-generic", category: "Transformation", api_name: "generateInvoice", description: "Generate a UBL XML invoice", output_formats: ["UBL XML"], is_active: true },
  { id: "T-pdf", category: "Transformation", api_name: "convertPDF", description: "Convert an invoice PDF to UBL XML", input_formats: ["PDF"], output_formats: ["UBL XML"], is_active: true },
  { id: "V-peppol", category: "Validation", api_name: "validateInvoice", description: "Validate an invoice against Peppol BIS rules", is_active: true },
  { id: "V-tax", category: "Validation", api_name: "validateTaxId", description: "Validate an Australian tax identifier", is_active: true },
  { id: "C-email", category: "Communication", api_name: "sendEmail", description: "Send an invoice by email", communication_direction: "Send", is_active: true },
  { id: "C-gateway", category: "Communication", api_name: "submitInvoice", description: "Submit invoice to government gateway", communication_direction: "Send", is_active: true },
  { id: "C-receive", category: "Communication", api_name: "receiveEmail", description: "Receive invoice by email", communication_direction: "Receive", is_active: true },
  { id: "C-inactive", category: "Communication", api_name: "sendEmail", description: "Send invoice by email", is_active: false },
  { id: "C-duplicate", category: "Communication", api_name: "sendEmail", description: "Send invoice by email", duplicate_of: "C-email" },
];

const process: BusinessProcess = { steps: [
  { order: 1, category: "Transformation", task: "convert PDF to UBL XML", input_format: "PDF", output_format: "UBL XML" },
  { order: 2, category: "Validation", task: "validate Peppol BIS invoice", rule_set: "Peppol BIS" },
  { order: 3, category: "Communication", task: "send invoice by email" },
] };

// Mailgun advertises its channel only in network, not its operation name or description.
const mailgun: CandidateApi = {
  id: "mailgun", category: "Communication", api_name: "Mailgun Send Message API",
  official_api_name: "POST-v3--domain-name--messages", network: "Email",
  description: "Pass To, From, Subject, HTML, text parts and attachments. Mailgun builds a MIME message and sends it.",
  communication_direction: "Send", is_active: true,
};
const peppolSender: CandidateApi = {
  id: "peppol", category: "Communication", api_name: "Send Peppol Invoice",
  network: "Peppol", description: "Send an invoice", communication_direction: "Send",
};
const sending = (task: string): BusinessProcess => ({ steps: [{ order: 1, category: "Communication", task }] });

test("network-only Mailgun metadata matches email delivery and invoice attachments", () => {
  for (const task of ["send by email", "send via email", "send invoice by email", "send via e-mail", "send email", "send via EMAIL"]) {
    const result = narrowProcessCandidates(sending(task), [mailgun, peppolSender]);
    assert.deepEqual(result.process.steps[0].candidate_ids, ["mailgun"], task);
    assert.equal(result.steps[0].issue, null);
    assert.ok(result.steps[0].matches[0].matched_terms.includes("email"));
  }
});

test("email or Peppol returns both delivery alternatives without mutating the task", () => {
  for (const task of ["send via email or peppol", "send invoice by email or peppol", "send via peppol or email", "send email or peppol", "send via e-mail or via peppol"]) {
    const input = sending(task);
    const before = structuredClone(input);
    const result = narrowProcessCandidates(input, [mailgun, peppolSender, ...catalogue]);
    assert.ok(result.process.steps[0].candidate_ids?.includes("mailgun"), task);
    assert.ok(result.process.steps[0].candidate_ids?.includes("peppol"), task);
    assert.ok(!result.process.steps[0].candidate_ids?.includes("C-gateway"));
    assert.ok(!result.process.steps[0].candidate_ids?.includes("C-receive"));
    assert.ok(!result.process.steps[0].candidate_ids?.includes("C-inactive"));
    assert.ok(!result.process.steps[0].candidate_ids?.includes("C-duplicate"));
    assert.deepEqual(input, before);
  }
});

test("delivery alternatives survive the shortlist cap and keep an honest match count", () => {
  const records = [mailgun, ...Array.from({ length: 7 }, (_, index) => ({ ...peppolSender, id: `peppol-${index}` }))];
  const input = sending("send invoice via email or peppol");
  const result = narrowProcessCandidates(input, records);
  assert.equal(result.steps[0].matches.length, 5);
  assert.equal(result.steps[0].total_matches, 8);
  assert.ok(result.process.steps[0].candidate_ids?.includes("mailgun"));
  assert.ok(result.process.steps[0].candidate_ids?.some((id) => id.startsWith("peppol-")));
  assert.deepEqual(narrowProcessCandidates(input, [...records].reverse()), result);
  const capped = narrowProcessCandidates(input, records, { maxKeywordCandidates: 1 });
  assert.equal(capped.steps[0].matches.length, 1);
  assert.equal(capped.steps[0].total_matches, 8);
});

test("a sender supporting both delivery channels is returned once", () => {
  const both = { ...peppolSender, network: "Email, Peppol" };
  const result = narrowProcessCandidates(sending("send via email or peppol"), [both]);
  assert.deepEqual(result.process.steps[0].candidate_ids, ["peppol"]);
  assert.equal(result.steps[0].total_matches, 1);
});

test("equivalent text and diagram flows follow each operation's documented document input", () => {
  const order: CandidateApi = { id: "order-only", category: "Communication", api_name: "Send Peppol Order API",
    api_endpoint: "https://example.test/sendOrder", description: "This provider also exposes a separate UBL XML send operation",
    instructions: "/sendOrder takes an Order JSON, not a UBL file.", network: "Peppol", communication_direction: "Send" };
  const xml: CandidateApi = { id: "xml-sender", category: "Communication", api_name: "Send Peppol XML API",
    api_endpoint: "https://example.test/sendxml", description: "Send a UBL XML invoice",
    instructions: "The /sendOrder endpoint does not accept UBL XML. Use /sendxml for a complete UBL document.",
    network: "Peppol", communication_direction: "Send" };
  const textFlow: BusinessProcess = { steps: [
    { order: 1, category: "Transformation", task: "Convert PDF to UBL XML", input_format: "PDF", output_format: "UBL XML" },
    { order: 2, category: "Validation", task: "Validate using Australian rules", rule_set: "Australian rules" },
    { order: 3, category: "Communication", task: "send UBL XML via Peppol", input_format: "UBL XML" },
  ] };
  const diagramFlow: BusinessProcess = { steps: [
    { order: 1, category: "Transformation", task: "Create UBL Invoice", input_format: "PDF", output_format: "UBL XML" },
    { order: 2, category: "Validation", task: "Validate for Australian Rules", input_format: "UBL XML", rule_set: "Australian Rules" },
    { order: 3, category: "Communication", task: "Send via PEPPOL" },
  ] };
  for (const flow of [textFlow, diagramFlow]) {
    const original = structuredClone(flow);
    assert.deepEqual(narrowProcessCandidates(flow, [order, xml]).process.steps[2].candidate_ids, ["xml-sender"]);
    const withExplicitIds = structuredClone(flow);
    withExplicitIds.steps[2].candidate_ids = ["order-only", "xml-sender"];
    assert.deepEqual(narrowProcessCandidates(withExplicitIds, [order, xml]).process.steps[2].candidate_ids, ["xml-sender"]);
    assert.deepEqual(flow, original);
  }
  const other: CandidateApi[] = [
    { id: "extract", category: "Transformation", api_name: "Upbrains Extract Invoice From PDF API",
      input_formats: ["PDF"], output_formats: ["JSON"] },
    { id: "validate-au", category: "Validation", api_name: "ESS Validate PINT A-NZ Invoice API",
      business_rules: ["Peppol PINT A-NZ invoice rules"] },
    { id: "peppol", category: "Communication", api_name: "AdemicoPeppolREST",
      description: "Send a UBL XML invoice over Peppol", network: "Peppol", communication_direction: "Send" },
  ];
  const matches = (flow: BusinessProcess) => narrowProcessCandidates(flow, [order, xml, ...other]).process.steps.map(step => step.candidate_ids);
  assert.deepEqual(matches(textFlow), matches(diagramFlow), "equivalent goals should shortlist the same operations");
  const withValidationReport = structuredClone(diagramFlow);
  withValidationReport.steps[1].output_format = "JSON";
  assert.deepEqual(narrowProcessCandidates(withValidationReport, [order, xml]).process.steps[2].candidate_ids,
    ["xml-sender"], "a validation report is not the invoice being sent");
  assert.ok(narrowProcessCandidates(sending("send order via Peppol"), [order, xml]).process.steps[0].candidate_ids?.includes("order-only"));
  const namedOrderThatAcceptsUbl = { ...order, id: "ubl-order", instructions: "This operation accepts a complete UBL XML document." };
  assert.ok(narrowProcessCandidates(textFlow, [namedOrderThatAcceptsUbl]).process.steps[2].candidate_ids?.includes("ubl-order"),
    "the endpoint name alone must not exclude a documented UBL operation");
  const noPdf: CandidateApi = { id: "no-pdf", category: "Communication", api_name: "Send Email API",
    network: "Email", instructions: "This operation does not accept PDF documents." };
  assert.deepEqual(narrowProcessCandidates({ steps: [{ order: 1, category: "Communication", task: "send via email", input_format: "PDF" }] },
    [noPdf]).process.steps[0].candidate_ids, [], "negative format evidence applies beyond UBL");
});

test("email and Peppol remains a joint requirement", () => {
  const both = { ...peppolSender, id: "both", network: "Email, Peppol" };
  const result = narrowProcessCandidates(sending("send via email and peppol"), [mailgun, peppolSender, both]);
  assert.deepEqual(result.process.steps[0].candidate_ids, ["both"]);
});

test("delivery alternatives preserve a named invoice standard and release elsewhere", () => {
  const specialEmail = { ...mailgun, id: "bis-email", description: "Send an invoice", invoice_standard: ["Peppol BIS Billing 3.0"] };
  const specialPeppol = { ...peppolSender, invoice_standard: ["Peppol BIS Billing 3.0"] };
  const wrongVersion = { ...specialEmail, id: "wrong-version", invoice_standard: ["Peppol BIS Billing 2.0"] };
  const records = [mailgun, specialEmail, specialPeppol, wrongVersion];
  const result = narrowProcessCandidates(sending("send Peppol BIS Billing 3.0 invoice via email or peppol"), records);
  assert.deepEqual(new Set(result.process.steps[0].candidate_ids), new Set(["bis-email", "peppol"]));
  const withRuleSet = sending("send invoice via email or peppol");
  withRuleSet.steps[0].rule_set = "Peppol BIS Billing 3.0";
  assert.deepEqual(new Set(narrowProcessCandidates(withRuleSet, records).process.steps[0].candidate_ids), new Set(["bis-email", "peppol"]));
});

test("an invoice standard following or is not parsed as a bare delivery channel", () => {
  for (const task of ["send via email or Peppol BIS Billing 3.0 invoice", "send via email or Peppol 3.0 invoice"]) {
    const result = narrowProcessCandidates(sending(task), [mailgun]);
    assert.deepEqual(result.process.steps[0].candidate_ids, []);
  }
});

test("network metadata prevents an email mention from qualifying a Peppol-only sender", () => {
  const notifications = { ...peppolSender, description: "Send invoice through Peppol with an email notification" };
  assert.deepEqual(narrowProcessCandidates(sending("send via email"), [notifications]).process.steps[0].candidate_ids, []);
});

test("delivery networks do not relax category, direction or explicit Discovery IDs", () => {
  const records: CandidateApi[] = [mailgun, { ...mailgun, id: "receive", api_name: "Receive Message", communication_direction: "Receive" },
    { ...mailgun, id: "transform", category: "Transformation" }];
  assert.deepEqual(narrowProcessCandidates(sending("send via email"), records).process.steps[0].candidate_ids, ["mailgun"]);
  assert.deepEqual(narrowProcessCandidates(sending("receive via email"), records).process.steps[0].candidate_ids, ["receive"]);
  const input = sending("send via email or peppol");
  input.steps[0].candidate_ids = [];
  assert.deepEqual(narrowProcessCandidates(input, records).process.steps[0].candidate_ids, []);
});

test("keyword search narrows each step to the task and does not mutate the LLM process", () => {
  const before = structuredClone(process);
  const result = narrowProcessCandidates(process, catalogue);
  assert.deepEqual(result.process.steps.map((step) => step.candidate_ids), [["T-pdf"], ["V-peppol"], ["C-email"]]);
  assert.deepEqual(result.steps.map((step) => step.source), ["keywords", "keywords", "keywords"]);
  assert.deepEqual(process, before);
});

test("extraction action aliases do not return invoice generators", () => {
  const records: CandidateApi[] = [
    { id: "extract", category: "Transformation", api_name: "OCR Extract Invoice", description: "Extract invoice data from PDF", input_formats: ["PDF"], output_formats: ["JSON"] },
    { id: "generate", category: "Transformation", api_name: "Generate Invoice", description: "Generate PDF invoice", output_formats: ["PDF"] },
  ];
  for (const action of ["extract", "extraction", "OCR", "scan", "capture", "read", "parse", "\u63d0\u53d6", "\u8bc6\u522b"]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: `${action} invoice data from PDF` }] };
    assert.deepEqual(narrowProcessCandidates(given, records).process.steps[0].candidate_ids, ["extract"]);
  }
});

test("Discovery IDs are checked against the active catalogue and category", () => {
  const given: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "send invoice by email", candidate_ids: ["C-email", "C-inactive", "C-duplicate", "T-pdf", "missing"] }] };
  const result = narrowProcessCandidates(given, catalogue);
  assert.deepEqual(result.process.steps[0].candidate_ids, ["C-email"]);
  assert.equal(result.steps[0].source, "discovery");
});

test("common Chinese task words map to the same catalogue search", () => {
  const given: BusinessProcess = { steps: [
    { order: 1, category: "Transformation", task: "\u5c06 PDF \u53d1\u7968\u8f6c\u6362\u6210 UBL XML" },
    { order: 2, category: "Communication", task: "\u901a\u8fc7\u90ae\u4ef6\u53d1\u9001\u53d1\u7968" },
  ] };
  const result = narrowProcessCandidates(given, catalogue);
  assert.deepEqual(result.process.steps.map((step) => step.candidate_ids), [["T-pdf"], ["C-email"]]);
});

test("invoice validation is not confused with validating a tax identifier", () => {
  const given: BusinessProcess = { steps: [{ order: 1, category: "Validation", task: "validate invoice with Australian rules" }] };
  const result = narrowProcessCandidates(given, catalogue);
  assert.deepEqual(result.process.steps[0].candidate_ids, []);
  assert.equal(result.steps[0].issue, "no_match");
});

test("a named invoice standard cannot be outvoted by generic format words", () => {
  const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: "generate Peppol BIS invoice", output_format: "UBL XML" }] };
  const result = narrowProcessCandidates(given, catalogue);
  assert.deepEqual(result.process.steps[0].candidate_ids, ["T-peppol"]);
});

test("hyphenated and mixed-case standard names remain hard candidate constraints", () => {
  const candidates: CandidateApi[] = [
    { id: "generic", category: "Transformation", api_name: "generateInvoice", description: "Generate invoice XML" },
    { id: "facturx", category: "Transformation", api_name: "generateInvoice", description: "Generate invoice XML", invoice_standard: ["Factur-X 1.09.2"] },
    { id: "zugferd", category: "Transformation", api_name: "generateInvoice", description: "Generate invoice XML", invoice_standard: ["ZUGFeRD 2.x"] },
    { id: "ksef", category: "Transformation", api_name: "generateInvoice", description: "Generate invoice XML", invoice_standard: ["KSeF FA(3)"] },
  ];
  for (const [label, id] of [["Factur-X", "facturx"], ["ZUGFeRD", "zugferd"], ["KSeF", "ksef"]]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: `generate ${label} invoice XML` }] };
    assert.deepEqual(narrowProcessCandidates(given, candidates).process.steps[0].candidate_ids, [id]);
  }
});

test("an explicitly requested release excludes a different recorded release", () => {
  const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: "generate XRechnung 3.0 invoice" }] };
  const candidates: CandidateApi[] = [
    { id: "three", category: "Transformation", api_name: "generateInvoice", invoice_standard: ["XRechnung 3.0"] },
    { id: "three-two", category: "Transformation", api_name: "generateInvoice", invoice_standard: ["XRechnung 3.0.2"] },
  ];
  assert.deepEqual(narrowProcessCandidates(given, candidates).process.steps[0].candidate_ids, ["three"]);
});

test("confirmed directional capability takes precedence over an old aggregate label", () => {
  const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: "generate XRechnung 3.0 invoice" }] };
  const base = { category: "Transformation" as const, api_name: "generateInvoice", invoice_standard: ["XRechnung 3.0"] };
  const capability = (direction: "input" | "output", version: string) => ({
    id: `${direction}-${version}`, api_id: "candidate", direction,
    standard: "XRechnung", version, profile: "", condition: "", status: "confirmed" as const,
    evidence_url: "https://provider.example/docs",
  });
  const candidates: CandidateApi[] = [
    { ...base, id: "wrong-output", standard_capabilities: [capability("input", "3.0"), capability("output", "3.0.2")] },
    { ...base, id: "right-output", standard_capabilities: [capability("output", "3.0")] },
  ];
  assert.deepEqual(narrowProcessCandidates(given, candidates).process.steps[0].candidate_ids, ["right-output"]);
});

test("an input-only claim does not exclude a possible output version", () => {
  const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: "generate XRechnung 3.0 invoice" }] };
  const candidates: CandidateApi[] = [{
    id: "unknown-output", category: "Transformation", api_name: "generateInvoice",
    invoice_standard: ["XRechnung 3.0.2"],
    standard_capabilities: [{
      id: "input-claim", api_id: "unknown-output", direction: "input", standard: "XRechnung",
      version: "3.0.2", profile: "", condition: "", status: "confirmed",
      evidence_url: "https://provider.example/docs",
    }],
  }];
  assert.deepEqual(narrowProcessCandidates(given, candidates).process.steps[0].candidate_ids, ["unknown-output"]);
});

test("no details or no matching API yields zero candidates, never the whole category", () => {
  const given: BusinessProcess = { steps: [
    { order: 1, category: "Transformation", task: "convert invoice" },
    { order: 2, category: "Validation", task: "validate a Japanese e-invoice with JP-2028 rules" },
    { order: 3, category: "Communication", task: "send by email", candidate_ids: [] },
  ] };
  const result = narrowProcessCandidates(given, catalogue);
  assert.deepEqual(result.process.steps.map((step) => step.candidate_ids), [[], [], []]);
  assert.deepEqual(result.steps.map((step) => step.issue), ["insufficient_task_detail", "no_match", "no_match"]);
});

test("keyword ranking is deterministic and reports when the result limit hides matches", () => {
  const candidates: CandidateApi[] = [
    { id: "B", category: "Communication", api_name: "sendEmail", description: "Send by email" },
    { id: "A", category: "Communication", api_name: "sendEmail", description: "Send by email" },
  ];
  const given: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "send by email" }] };
  const result = narrowProcessCandidates(given, candidates, { maxKeywordCandidates: 1 });
  assert.deepEqual(result.process.steps[0].candidate_ids, ["A"]);
  assert.equal(result.steps[0].total_matches, 2);
});

test("the narrowed IDs reduce chains before schema compatibility checks", () => {
  const sides = catalogue.filter((item) => ["T-pdf", "T-peppol", "V-peppol", "V-tax", "C-email", "C-gateway"].includes(item.id))
    .map((item) => side(api({ id: item.id, api_name: item.api_name, category: item.category }), [
      schema({ direction: "request" }, ["invoiceNumber:string:req"]),
      schema({ direction: "response" }, ["invoiceNumber:string"]),
    ]));
  const check = () => "pass" as const;
  assert.equal(composeChains(process, sides, check).counts.feasible, 8);
  const narrowed = narrowProcessCandidates(process, catalogue);
  assert.equal(composeChains(narrowed.process, sides, check).counts.feasible, 1);
});

// Representative catalogue metadata, including the sparse records imported by
// migration 0040. Envelope formats must not be mistaken for document formats.
const clientCatalogue: CandidateApi[] = [
  { id: "upbrains", category: "Transformation", api_name: "Upbrains Extract Invoice From PDF API", official_api_name: "extractInvoiceFromPdf", input_formats: ["JSON"], output_formats: ["JSON"] },
  { id: "nanonets", category: "Transformation", api_name: "Nanonets OCR Extract From File API", official_api_name: "OCRModelLabelFileByModelIdPost", description: "Use the model to predict which one of the categories an image (given an image file) belongs to.", input_formats: ["multipart/form-data"], output_formats: ["JSON"] },
  { id: "ezzybills", category: "Transformation", api_name: "EzzyBills Get Extracted Invoice Data API", official_api_name: "getFormData", input_formats: [], output_formats: ["text/plain", "JSON"] },
  { id: "amit", category: "Transformation", api_name: "AmitTransform Convert UBL JSON to UBL XML API", input_formats: ["JSON"], output_formats: ["JSON"] },
  { id: "babelway", category: "Transformation", api_name: "Babelway Convert Invoice JSON to UBL XML API", input_formats: ["JSON"], output_formats: ["XML"] },
  { id: "beliq", category: "Transformation", api_name: "beliq API convertInvoice", instructions: "POST an XML or hybrid PDF body", input_formats: ["application/pdf"], output_formats: ["application/xml"] },
  { id: "e-invoice", category: "Transformation", api_name: "e-invoice conversion API convertInvoice", description: "Upload a ZUGFeRD / Factur-X PDF document", input_formats: ["multipart/form-data"], output_formats: ["XML", "PDF"] },
  { id: "ess", category: "Validation", api_name: "ESS SmartDocFlow Validate PINT A-NZ Invoice API", description: "Runs the Peppol PINT Australia / New Zealand compliance checks on a UBL invoice.", input_formats: ["JSON"] },
  { id: "mailgun", category: "Communication", api_name: "Mailgun Send Message API", description: "Send the message with attachments", network: "Email", communication_direction: "Send" },
  { id: "billit", category: "Communication", api_name: "Billit Peppol Send Order API", description: "Send a direct Peppol message. Compatible with BisV3 Invoice.", network: "Peppol", communication_direction: "Send" },
  { id: "b2brouter", category: "Communication", api_name: "B2Brouter Import Invoice API", network: "Peppol", communication_direction: "Send" },
];

test("the client's three steps find extraction APIs, the Australian validator and either delivery network", () => {
  const given: BusinessProcess = { steps: [
    { order: 1, category: "Transformation", task: "convert pdf to ubl xml" },
    { order: 2, category: "Validation", task: "validate using Australian rules" },
    { order: 3, category: "Communication", task: "send via email or peppol" },
  ] };
  const before = structuredClone(given);
  const result = narrowProcessCandidates(given, clientCatalogue);
  assert.deepEqual(new Set(result.process.steps[0].candidate_ids), new Set(["upbrains", "nanonets", "beliq", "e-invoice"]));
  assert.deepEqual(result.process.steps[1].candidate_ids, ["ess"]);
  assert.deepEqual(new Set(result.process.steps[2].candidate_ids), new Set(["mailgun", "billit", "b2brouter"]));
  assert.deepEqual(result.steps.map((step) => step.issue), [null, null, null]);
  assert.deepEqual(given, before);
});

test("extraction vocabulary finds sparse operations without selecting invoice generators", () => {
  for (const action of ["extract", "extracting", "extraction", "OCR", "read", "parse", "scan", "capture"]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: `${action} invoice data from PDF` }] };
    const result = narrowProcessCandidates(given, [...clientCatalogue, ...catalogue]);
    assert.deepEqual(new Set(result.process.steps[0].candidate_ids), new Set(["upbrains", "nanonets"]), action);
  }
  const chinese: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: "从 PDF 发票中提取数据" }] };
  assert.deepEqual(new Set(narrowProcessCandidates(chinese, clientCatalogue).process.steps[0].candidate_ids), new Set(["upbrains", "nanonets"]));
});

test("PDF conversion keeps a direct converter and accepts extraction as a possible first stage", () => {
  const given: BusinessProcess = { steps: [process.steps[0]] };
  const result = narrowProcessCandidates(given, [...clientCatalogue.slice(0, 5), catalogue[2]]);
  assert.equal(result.process.steps[0].candidate_ids?.[0], "T-pdf");
  assert.deepEqual(new Set(result.process.steps[0].candidate_ids), new Set(["T-pdf", "upbrains", "nanonets"]));
  // Matching is a shortlist, not a claim that Nanonets outputs UBL XML.
  assert.deepEqual(result.steps[0].matches.find((match) => match.id === "nanonets")?.matched_terms, []);
});

test("extraction expansion preserves named standards, versions and unrelated task details", () => {
  const extractor: CandidateApi = { id: "extractor", category: "Transformation", api_name: "Extract Invoice From PDF", invoice_standard: ["XRechnung 3.0.2"] };
  for (const task of ["convert PDF to Peppol UBL XML", "extract Japanese invoice data from PDF", "convert PDF to XRechnung 3.0 UBL XML"]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task }] };
    assert.deepEqual(narrowProcessCandidates(given, [extractor]).process.steps[0].candidate_ids, [], task);
  }
  const structured: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: "convert PDF to UBL XML", rule_set: "Peppol BIS" }] };
  assert.deepEqual(narrowProcessCandidates(structured, clientCatalogue).process.steps[0].candidate_ids, []);
});

test("extraction expansion follows the requested input, not a PDF output", () => {
  const converter: CandidateApi = { id: "to-pdf", category: "Transformation", api_name: "Convert UBL XML to PDF", input_formats: ["XML"], output_formats: ["PDF"] };
  for (const step of [
    { task: "convert UBL XML to PDF" },
    { task: "convert to PDF from UBL XML" },
    { task: "将 UBL XML 转换成 PDF" },
    { task: "convert invoice", input_format: "UBL XML", output_format: "PDF" },
  ]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", ...step }] };
    assert.deepEqual(narrowProcessCandidates(given, [...clientCatalogue.slice(0, 3), converter]).process.steps[0].candidate_ids, ["to-pdf"]);
  }
  for (const step of [
    { task: "convert to UBL XML from PDF" },
    { task: "将 PDF 发票转换成 UBL XML" },
    { task: "把PDF发票转换成UBL XML" },
    { task: "convert invoice", input_format: "PDF", output_format: "UBL XML" },
  ]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", ...step }] };
    assert.deepEqual(new Set(narrowProcessCandidates(given, clientCatalogue.slice(0, 3)).process.steps[0].candidate_ids), new Set(["upbrains", "nanonets"]));
  }
});

test("network metadata supports email-only and explicit alternative delivery requests", () => {
  for (const task of ["send via email", "send via e-mail"]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Communication", task }] };
    assert.deepEqual(narrowProcessCandidates(given, clientCatalogue).process.steps[0].candidate_ids, ["mailgun"]);
  }
  const dual: CandidateApi = { id: "dual", category: "Communication", api_name: "Send message", network: "Email / Peppol", communication_direction: "Send" };
  const candidates = [...clientCatalogue, dual];
  for (const task of ["send via email or peppol", "send via Peppol OR Email", "send via email or via peppol", "通过邮件或 Peppol 发送", "send via e-mail or Peppol"]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Communication", task }] };
    const result = narrowProcessCandidates(given, candidates);
    assert.deepEqual(new Set(result.process.steps[0].candidate_ids), new Set(["mailgun", "billit", "b2brouter", "dual"]), task);
    assert.equal(result.steps[0].total_matches, 4);
    assert.equal(result.steps[0].matches.length, 4);
  }
});

test("alternative networks do not relax direction, active status, named standards or versions", () => {
  const candidates: CandidateApi[] = [
    ...clientCatalogue,
    { id: "receiver", category: "Communication", api_name: "Message service", network: "Email", communication_direction: "Receive" },
    { id: "inactive", category: "Communication", api_name: "Send message", network: "Email", is_active: false },
    { id: "duplicate", category: "Communication", api_name: "Send message", network: "Peppol", duplicate_of: "billit" },
    { id: "right-version", category: "Communication", api_name: "Send invoice", network: "Email", invoice_standard: ["XRechnung 3.0"], communication_direction: "Send" },
    { id: "wrong-version", category: "Communication", api_name: "Send invoice", network: "Email", invoice_standard: ["XRechnung 3.0.2"], communication_direction: "Send" },
  ];
  const given: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "send XRechnung 3.0 via email or peppol" }] };
  assert.deepEqual(narrowProcessCandidates(given, candidates).process.steps[0].candidate_ids, ["right-version"]);
  const send: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "send via email or peppol" }] };
  assert.deepEqual(new Set(narrowProcessCandidates(send, candidates).process.steps[0].candidate_ids), new Set(["mailgun", "billit", "b2brouter", "right-version", "wrong-version"]));
  const receive: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "receive via email or peppol" }] };
  assert.deepEqual(narrowProcessCandidates(receive, candidates).process.steps[0].candidate_ids, ["receiver"]);
});

test("a separate Peppol requirement survives network alternatives and 'and' is not treated as 'or'", () => {
  for (const step of [
    { task: "send Peppol invoice via email or peppol" },
    { task: "send via email or peppol", rule_set: "Peppol" },
    { task: "send via peppol" },
  ]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Communication", ...step }] };
    assert.deepEqual(new Set(narrowProcessCandidates(given, clientCatalogue).process.steps[0].candidate_ids), new Set(["billit", "b2brouter"]));
  }
  const both: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "send via email and peppol" }] };
  assert.deepEqual(narrowProcessCandidates(both, clientCatalogue).process.steps[0].candidate_ids, []);
  const email: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "send invoice XML via email" }] };
  const unrelated: CandidateApi = { id: "other-network", category: "Communication", api_name: "Send invoice XML", network: "Peppol" };
  assert.deepEqual(narrowProcessCandidates(email, [unrelated]).process.steps[0].candidate_ids, []);
});

test("alternative matches stay deterministic and apply the result limit after deduplication", () => {
  const given: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "send via email or peppol" }] };
  const limited = narrowProcessCandidates(given, clientCatalogue, { maxKeywordCandidates: 2 });
  const reversed = narrowProcessCandidates(given, [...clientCatalogue].reverse(), { maxKeywordCandidates: 2 });
  assert.deepEqual(limited, reversed);
  assert.equal(limited.steps[0].matches.length, 2);
  assert.equal(limited.steps[0].total_matches, 3);
});

test("an extraction name alone is not enough: the record must show it takes a document", () => {
  // EzzyBills' getFormData returns data for a document already uploaded; its
  // record names no PDF, image, file or base64 input.
  for (const task of ["convert PDF to UBL XML", "extract invoice data from PDF"]) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task }] };
    assert.ok(!narrowProcessCandidates(given, clientCatalogue).process.steps[0].candidate_ids?.includes("ezzybills"), task);
  }
});

test("a delivery task that names the invoice still finds the email sender", () => {
  for (const [task, expected] of [
    ["send the invoice by email", ["mailgun"]],
    ["email the invoice", ["mailgun"]],
    ["send invoice via email or peppol", ["mailgun", "billit", "b2brouter"]],
  ] as const) {
    const given: BusinessProcess = { steps: [{ order: 1, category: "Communication", task }] };
    assert.deepEqual(new Set(narrowProcessCandidates(given, clientCatalogue).process.steps[0].candidate_ids), new Set(expected), task);
  }
});

test("a sending step's input format is the document it carries, not a word the sender must advertise", () => {
  // Discovery often fills a later step's input format from the step before it
  // (the client's BPMN diagram gave "UBL XML" on the send step). Senders that
  // mention UBL must not push out Mailgun and B2Brouter, whose records do not.
  const ublSenders: CandidateApi[] = [
    { id: "iras-bulk", category: "Communication", api_name: "Singapore IRAS InvoiceNow C5 Bulk Invoice Data Submission API", description: "Submit UBL XML invoice data", network: "Peppol", communication_direction: "Send" },
    { id: "iras-single", category: "Communication", api_name: "Singapore IRAS InvoiceNow C5 Single Invoice Data Submission API", description: "Submit one UBL XML invoice", network: "Peppol", communication_direction: "Send" },
    { id: "billit-xml", category: "Communication", api_name: "Billit Peppol Send XML API", description: "Sends one UBL 2.1 document over Peppol", input_formats: ["JSON"], network: "Peppol", communication_direction: "Send" },
  ];
  const records = [...clientCatalogue, ...ublSenders];
  const send = (input_format: string | null): BusinessProcess =>
    ({ steps: [{ order: 3, category: "Communication", task: "Send via email or Peppol", input_format }] });
  const plain = narrowProcessCandidates(send(null), records).process.steps[0].candidate_ids;
  for (const format of ["UBL XML", "XML", "PDF"]) {
    const given = send(format);
    const before = structuredClone(given);
    const ids = narrowProcessCandidates(given, records).process.steps[0].candidate_ids;
    assert.deepEqual(ids, plain, format);
    assert.ok(ids?.includes("mailgun") && ids.includes("b2brouter"), format);
    assert.deepEqual(given, before);
  }
  // A standard named in the task itself is still a hard requirement.
  const named: BusinessProcess = { steps: [{ order: 1, category: "Communication", task: "send UBL invoice via email" }] };
  assert.ok(!narrowProcessCandidates(named, records).process.steps[0].candidate_ids?.includes("mailgun"));
});

test("PDF evidence comes from the declared document formats before the description", () => {
  const given: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task: "convert pdf to ubl xml" }] };
  const ids = (records: CandidateApi[]) => narrowProcessCandidates(given, records).process.steps[0].candidate_ids;
  // Only an envelope declared: the description's PDF still counts.
  assert.ok(ids(clientCatalogue)?.includes("e-invoice"));
  // Declared CSV, XML and EDIFACT (migration 0050): a Factur-X PDF in the text is not any PDF.
  const corrected = clientCatalogue.map((api) => api.id === "e-invoice" ? { ...api, input_formats: ["XML", "CSV", "EDIFACT"] } : api);
  assert.ok(!ids(corrected)?.includes("e-invoice"));
  // A record that declares PDF keeps it.
  assert.ok(ids(corrected)?.includes("beliq"));
  // One that declares a Hybrid PDF (ZUGFeRD / Factur-X) is offered only when that kind of PDF is asked for.
  const hybrid = corrected.map((api) => api.id === "beliq" ? { ...api, input_formats: ["XML", "Hybrid PDF"], invoice_standard: ["ZUGFeRD", "Factur-X 1.09.2"] } : api);
  assert.ok(!ids(hybrid)?.includes("beliq"));
  for (const task of ["convert ZUGFeRD PDF to UBL XML", "convert a Factur-X PDF to UBL XML", "convert hybrid PDF invoices to UBL XML"]) {
    const asked: BusinessProcess = { steps: [{ order: 1, category: "Transformation", task }] };
    assert.ok(narrowProcessCandidates(asked, hybrid).process.steps[0].candidate_ids?.includes("beliq"), task);
  }
});

// A sender whose name says how it sends, not that it sends (B2Brouter "Import Invoice").
const importingSender: CandidateApi = {
  id: "importer", category: "Communication", api_name: "B2Brouter Import Invoice API",
  network: "Peppol", description: "Import an invoice into the account and send it to the customer", communication_direction: "Send",
  is_active: true,
};
const peppolNamedSenders: CandidateApi[] = Array.from({ length: 5 }, (_, index) => ({
  id: `named-${index}`, category: "Communication", api_name: `Peppol Gateway ${index}`, network: "Peppol",
  description: "Peppol access point", is_active: true,
}));

test("connective and possessive words do not reject or misdirect a sending step", () => {
  for (const task of ["send over Peppol", "send it over Peppol", "send through Peppol", "send the invoice to the customer over Peppol", "send via Peppol network"]) {
    const result = narrowProcessCandidates(sending(task), [mailgun, importingSender]);
    assert.equal(result.steps[0].issue, null, task);
    assert.deepEqual(result.process.steps[0].candidate_ids, ["importer"], task);
  }
  const myInvois: CandidateApi = { id: "myinvois", category: "Communication", api_name: "MyInvois Submit Documents", description: "Submit my invoice documents to the tax authority", communication_direction: "Send", is_active: true };
  for (const task of ["send my invoice via email", "send it by email"]) {
    const result = narrowProcessCandidates(sending(task), [mailgun, myInvois]);
    assert.deepEqual(result.process.steps[0].candidate_ids, ["mailgun"], task);
  }
});

test("a declared sending direction counts as sending when the name does not say so", () => {
  const result = narrowProcessCandidates(sending("send via Peppol"), [...peppolNamedSenders, importingSender]);
  assert.equal(result.process.steps[0].candidate_ids?.[0], "importer");
  // A record without a declared direction gains nothing from it.
  const undeclared = { ...importingSender, communication_direction: undefined };
  const ranked = narrowProcessCandidates(sending("send via Peppol"), [...peppolNamedSenders, undeclared], { maxKeywordCandidates: 6 });
  assert.notEqual(ranked.process.steps[0].candidate_ids?.[0], "importer");
});

test("email or over Peppol still offers both delivery alternatives", () => {
  const result = narrowProcessCandidates(sending("send the invoice by email or over Peppol"), [mailgun, importingSender]);
  assert.deepEqual(new Set(result.process.steps[0].candidate_ids), new Set(["mailgun", "importer"]));
});

test("AU and AUS rules find the validator for Australian rules", () => {
  const australian: CandidateApi = { id: "ess", category: "Validation", api_name: "Validate PINT A-NZ Invoice", description: "Validate an invoice against the Australian and New Zealand rules", is_active: true };
  const other: CandidateApi = { id: "de", category: "Validation", api_name: "Validate XRechnung", description: "Validate an invoice against the German rules", is_active: true };
  for (const [task, rule_set] of [["validate via AU rules", "AU rules"], ["validate with AUS rules", "AUS rules"], ["validate using Australian rules", "Australian rules"]]) {
    const result = narrowProcessCandidates({ steps: [{ order: 1, category: "Validation", task, rule_set }] }, [australian, other]);
    assert.deepEqual(result.process.steps[0].candidate_ids, ["ess"], task);
  }
});
