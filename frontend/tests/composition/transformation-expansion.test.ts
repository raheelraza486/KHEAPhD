import assert from "node:assert/strict";
import test from "node:test";
import { runChecks } from "../../lib/checks/run.ts";
import { composeChains } from "../../lib/composition/compose.ts";
import type { InvoiceStandardCapability } from "../../lib/composition/invoice-standard-capabilities.ts";
import { narrowProcessCandidates, type CandidateApi } from "../../lib/composition/task-candidates.ts";
import { expandTransformations, transformationCandidateIds } from "../../lib/composition/transformation-expansion.ts";
import type { BusinessProcess } from "../../lib/composition/types.ts";
import { ALIASES, api, schema, side } from "../checks/helpers.ts";

// Representative stored schemas; these tests never call a provider.
const extract = side(api({ id: "extract", api_name: "Extract invoice data", category: "Transformation" }), [
  schema({ direction: "request", media_type: "application/json" }, ["fileBase64:string:req:byte"]),
  schema({ direction: "response", media_type: "application/json" }, ["invoiceNumber:string:req"]),
]);
const convert = side(api({ id: "convert", api_name: "Convert UBL JSON to UBL XML", category: "Transformation" }), [
  schema({ direction: "request", media_type: "application/json" }, ["invoiceNumber:string:req"]),
  schema({ direction: "response", media_type: "application/json" }, ["xml:string:req"]),
]);
const validate = side(api({ id: "validate", category: "Validation" }), [
  schema({ direction: "request", media_type: "application/json" }, ["content:string:req:byte"]),
]);
const send = side(api({ id: "send", category: "Communication", input_formats: ["XML"] }), [
  schema({ direction: "request", media_type: "application/xml", raw: { type: "string" } }),
]);
const goal = { order: 1, category: "Transformation" as const, task: "Convert PDF to UBL XML",
  input_format: "PDF", output_format: "UBL XML", candidate_ids: null };
const process: BusinessProcess = { steps: [goal,
  { order: 2, category: "Validation", task: "Validate invoice", candidate_ids: ["validate"] },
  { order: 3, category: "Communication", task: "Send invoice", candidate_ids: ["send"] },
] };
const sides = [extract, convert, validate, send];
function record(row: ReturnType<typeof api>): CandidateApi {
  return { id: row.id, api_name: row.api_name, category: row.category as CandidateApi["category"], is_active: true,
    input_formats: [...(row.input_formats ?? [])], output_formats: [...(row.output_formats ?? [])],
    invoice_standard: [...(row.invoice_standard ?? [])] };
}
const catalogue = sides.map(({ api: row }) => record(row));

function resolve(given = process, records = catalogue, documents = sides) {
  return expandTransformations(given, narrowProcessCandidates(given, records), records, documents, ALIASES);
}

function generatorFixture(overrides: Partial<InvoiceStandardCapability> = {}) {
  const generator = side(api({ id: "generate", api_name: "beliq API generateInvoice", category: "Transformation",
    input_formats: ["JSON"], output_formats: ["XML"], invoice_standard: ["Peppol BIS Billing 3.0"] }), [
    schema({ direction: "request", media_type: "application/json" }, ["invoiceNumber:string:req"]),
    schema({ direction: "response", media_type: "application/xml", raw: { type: "string" } }),
  ]);
  const claim: InvoiceStandardCapability = {
    id: "generate-ubl", api_id: generator.api.id, direction: "output", standard: "Peppol BIS Billing", version: "3.0",
    profile: "", condition: "", status: "confirmed", evidence_url: "https://docs.beliq.eu/api-reference/generate/",
    ...overrides,
  };
  const candidate: CandidateApi = { ...record(generator.api), standard_capabilities: [claim] };
  return { generator, candidate };
}

function hybridFixture() {
  const converter = side(api({ id: "hybrid", api_name: "beliq API convertInvoice", category: "Transformation",
    input_formats: ["XML", "PDF"], output_formats: ["XML"] }), [
    schema({ direction: "request", media_type: "application/octet-stream", raw: { type: "string", description: "XML or hybrid PDF" } }),
    schema({ direction: "response", media_type: "application/xml", raw: { type: "string" } }),
  ]);
  const candidate: CandidateApi = { ...record(converter.api),
    description: "Converts XML or hybrid PDF invoices to another invoice format.", standard_capabilities: [{
    id: "hybrid-ubl", api_id: "hybrid", direction: "output", standard: "Peppol BIS Billing", version: "3.0",
    profile: "", condition: "", status: "reported", evidence_url: "https://provider.example/convert",
  }] };
  return { converter, candidate };
}

test("a claim-only hybrid PDF converter cannot hide extraction and conversion for the client PDF goal", () => {
  const { converter: hybrid, candidate } = hybridFixture();
  const records = [...catalogue, candidate], documents = [...sides, hybrid];
  for (const given of [process, { steps: [goal] }]) {
    const result = resolve(given, records, documents);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.narrowed.process.steps.slice(0, 2).map((step) => step.candidate_ids), [["extract"], ["convert"]]);
    assert.equal(result.added.length, 1);
    const composition = composeChains(result.narrowed.process, documents, () => "unknown");
    assert.ok(composition.chains.length > 0);
    assert.ok(composition.chains.every((chain) => chain.api_ids[0] === "extract" && chain.api_ids[1] === "convert" && chain.status === "needs_decision"));
    assert.ok(composition.chains.every((chain) => !chain.api_ids.includes("hybrid")));
  }
});

test("JSON to UBL retains all direct candidates when an explicit converter exists", () => {
  const beliq = generatorFixture({ status: "reported" });
  const attestwire = generatorFixture({ api_id: "attestwire", status: "reported" });
  attestwire.generator.api.id = "attestwire";
  attestwire.generator.api.api_name = "Attestwire invoice conversion";
  attestwire.candidate.id = "attestwire";
  const other = structuredClone(convert); other.api.id = "other";
  const records = [catalogue[1], record(other.api), beliq.candidate, attestwire.candidate];
  const given = { steps: [{ ...goal, input_format: "JSON", task: "Convert JSON to UBL XML" }] };
  const result = resolve(given, records, [convert, other, beliq.generator, attestwire.generator]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.narrowed.steps[0].total_matches, 4);
  assert.deepEqual(new Set(result.narrowed.process.steps[0].candidate_ids), new Set(["convert", "other", "generate", "attestwire"]));
  assert.deepEqual(result.added, []);
});

test("explicit direct PDF conversion still wins when extraction and claim-only alternatives exist", () => {
  const { converter: hybrid, candidate } = hybridFixture();
  const direct = side(api({ id: "direct", api_name: "Convert PDF to UBL XML", category: "Transformation",
    input_formats: ["PDF"], output_formats: ["UBL XML"] }));
  const result = resolve(process, [...catalogue, candidate, record(direct.api)], [...sides, hybrid, direct]);
  assert.equal(result.narrowed.process.steps.length, 3);
  assert.ok(result.narrowed.process.steps[0].candidate_ids?.includes("direct"));
  assert.deepEqual(result.added, []);
});

test("unrecognised input or output formats are distinct from missing conversions, even with selected candidates", () => {
  for (const name of ["XRechnung", "CII", "image", "CSV"]) {
    for (const direction of ["input", "output"] as const) {
      const given = { steps: [{ ...goal, [`${direction}_format`]: name, candidate_ids: ["convert"] }] };
      const result = resolve(given);
      assert.equal(result.issues[0].code, "unrecognised_format");
      assert.ok(result.issues[0].message.includes(`${direction} format "${name}"`));
      assert.equal(result.narrowed.steps[0].issue, "unrecognised_format");
      assert.deepEqual(result.narrowed.process.steps[0].candidate_ids, []);
      assert.deepEqual(result.added, []);
    }
  }
  const both = resolve({ steps: [{ ...goal, input_format: "CII", output_format: "CSV" }] });
  assert.match(both.issues[0].message, /input format "CII" and output format "CSV"/);
});

test("an unrecognised CSV goal cannot fall back to a keyword match", () => {
  const given = { steps: [{ ...goal, task: "Convert CSV to UBL XML", input_format: "CSV" }] };
  assert.ok(narrowProcessCandidates(given, catalogue).process.steps[0].candidate_ids?.includes("convert"));
  const result = resolve(given);
  assert.equal(result.issues[0].code, "unrecognised_format");
  assert.deepEqual(result.narrowed.process.steps[0].candidate_ids, []);
});

test("documented UBL output claims find a generator for direct and two-step conversions", () => {
  for (const standard of ["Peppol BIS Billing", "Peppol BIS Billing 3.0", "UBL", "UBL XML"]) {
    const { generator, candidate } = generatorFixture({ standard, version: standard.startsWith("UBL") ? "2.1" : "3.0" });
    const direct = resolve({ steps: [{ ...goal, task: "Convert JSON to UBL XML", input_format: "JSON" }] },
      [candidate], [generator]);
    assert.deepEqual(direct.issues, []);
    assert.deepEqual(direct.narrowed.process.steps[0].candidate_ids, ["generate"]);
    assert.deepEqual(direct.added, []);
    const expanded = resolve({ steps: [goal] }, [catalogue[0], candidate], [extract, generator]);
    assert.deepEqual(expanded.issues, []);
    assert.deepEqual(expanded.narrowed.process.steps.map((step) => step.candidate_ids), [["extract"], ["generate"]]);
  }
});

test("UBL output evidence does not override an explicitly requested standard version", () => {
  const { generator, candidate } = generatorFixture();
  const given = { steps: [{ ...goal, input_format: "JSON", rule_set: "Peppol BIS Billing 3.0.2" }] };
  assert.equal(resolve(given, [candidate], [generator]).issues[0].code, "conversion_unresolved");
});

test("a keyword conversion does not hide another direct API found through its output claims", () => {
  const { generator, candidate } = generatorFixture();
  const given = { steps: [{ ...goal, task: "Convert JSON to UBL XML", input_format: "JSON" }] };
  const records = [catalogue[1], candidate];
  assert.deepEqual(narrowProcessCandidates(given, records).process.steps[0].candidate_ids, ["convert"]);
  const result = resolve(given, records, [convert, generator]);
  assert.deepEqual(result.narrowed.process.steps[0].candidate_ids, ["convert", "generate"]);
  assert.equal(result.narrowed.steps[0].total_matches, 2);
  assert.equal(result.narrowed.steps[0].source, "formats");
});

test("input claims, rejected or undocumented claims, and unrelated standards cannot establish UBL output", () => {
  const invalid: Partial<InvoiceStandardCapability>[] = [
    { direction: "input" }, { status: "rejected" }, { evidence_url: "" }, { api_id: "another-api" },
    { standard: "Peppol" }, { standard: "EN 16931" }, { standard: "XRechnung" }, { version: "2.0" },
  ];
  for (const overrides of invalid) {
    const { generator, candidate } = generatorFixture(overrides);
    const result = resolve({ steps: [{ ...goal, input_format: "JSON" }] }, [candidate], [generator]);
    assert.equal(result.issues[0].code, "conversion_unresolved", JSON.stringify(overrides));
  }
  const { generator, candidate } = generatorFixture();
  candidate.standard_capabilities = [];
  assert.equal(resolve({ steps: [{ ...goal, input_format: "JSON" }] }, [candidate], [generator]).issues[0].code,
    "conversion_unresolved", "an aggregate Peppol label has no output direction");
  candidate.standard_capabilities = [generatorFixture().candidate.standard_capabilities![0]];
  generator.api.output_formats = ["JSON"];
  generator.schemas = generator.schemas.filter((s) => s.direction === "request");
  assert.equal(resolve({ steps: [{ ...goal, input_format: "JSON" }] }, [candidate], [generator]).issues[0].code,
    "conversion_unresolved", "a claim still needs an XML output format or carrier");
});

test("a PDF to UBL goal becomes two Transformations, followed by validation and delivery", () => {
  const before = structuredClone(process);
  const result = resolve();
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.narrowed.process.steps.map((step) => step.candidate_ids), [["extract"], ["convert"], ["validate"], ["send"]]);
  assert.deepEqual(result.narrowed.process.steps.map((step) => step.order), [1, 2, 3, 4]);
  assert.equal(result.narrowed.process.steps[0].output_format, "JSON");
  assert.equal(result.narrowed.process.steps[1].input_format, "JSON");
  assert.deepEqual(result.added.map(({ order, original_order }) => [order, original_order]), [[2, 1]]);
  assert.deepEqual(process, before);
  const composition = composeChains(result.narrowed.process, sides, (source, target, context) =>
    runChecks({ source, target, formatAliases: ALIASES, choices: [], validatedBetween: context.validated_between }).overall.overall);
  assert.deepEqual(composition.chains.map(({ api_ids }) => api_ids), [["extract", "convert", "validate", "send"]]);
});

test("a direct PDF to UBL API keeps the original step and keyword ranking", () => {
  const direct = side(api({ id: "direct", api_name: "Convert PDF to UBL XML", category: "Transformation",
    input_formats: ["PDF"], output_formats: ["UBL XML"] }));
  const records = [...catalogue, record(direct.api)];
  const result = resolve(process, records, [...sides, direct]);
  assert.equal(result.narrowed.process.steps.length, 3);
  assert.deepEqual(result.narrowed.process.steps[0].candidate_ids, ["direct"]);
  assert.equal(result.narrowed.steps[0].source, "keywords");
  assert.deepEqual(result.added, []);
});

test("JSON-wrapped XML needs output-specific UBL evidence; arbitrary XML does not qualify", () => {
  const generic = structuredClone(convert);
  generic.api.api_name = "Convert JSON to XML";
  const records = catalogue.map((row) => row.id === "convert" ? { ...row, api_name: generic.api.api_name } : row);
  const result = resolve(process, records, [extract, generic, validate, send]);
  assert.equal(result.issues[0].code, "conversion_unresolved");
  assert.deepEqual(result.added, []);
});

test("a generator that outputs UBL but cannot read PDF is not a direct conversion", () => {
  const generator = side(api({ id: "generate", category: "Transformation", api_name: "Generate UBL XML",
    input_formats: ["JSON"], output_formats: ["UBL XML"] }));
  const result = resolve(process, [...catalogue, record(generator.api)], [...sides, generator]);
  assert.equal(result.narrowed.process.steps[0].candidate_ids?.includes("generate"), false);
  assert.equal(result.added.length, 1);
});

test("an already explicit extraction and conversion sequence is not expanded again", () => {
  const given: BusinessProcess = { steps: [
    { ...goal, output_format: "JSON", candidate_ids: ["extract"] },
    { ...goal, order: 2, input_format: "JSON", candidate_ids: ["convert"] },
    { ...process.steps[1], order: 3 }, { ...process.steps[2], order: 4 },
  ] };
  const result = resolve(given);
  assert.equal(result.narrowed.process.steps.length, 4);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.issues, []);
});

test("a split that would exceed four steps returns a reason without adding a step", () => {
  const result = resolve({ steps: [...process.steps, { ...process.steps[2], order: 4 }] });
  assert.equal(result.issues[0].code, "too_many_steps");
  assert.match(result.issues[0].message, /more than 4 steps/);
  assert.equal(result.narrowed.process.steps.length, 4);
  assert.deepEqual(result.added, []);
});

test("explicit empty candidates remain empty; an explicit first API stays selected", () => {
  const empty = { steps: [{ ...goal, candidate_ids: [] }] };
  assert.deepEqual(transformationCandidateIds(empty, catalogue), []);
  assert.deepEqual(resolve(empty).added, []);
  const selected = resolve({ steps: [{ ...goal, candidate_ids: ["extract"] }] });
  assert.deepEqual(selected.narrowed.process.steps.map((step) => step.candidate_ids), [["extract"], ["convert"]]);
});

test("format search excludes inactive and duplicate operations", () => {
  const records = catalogue.map((row) => row.id === "convert" ? { ...row, is_active: false } : row);
  assert.equal(transformationCandidateIds(process, records).includes("convert"), false);
  assert.equal(resolve(process, records).issues[0].code, "conversion_unresolved");
  const duplicates = catalogue.map((row) => row.id === "convert" ? { ...row, duplicate_of: "kept" } : row);
  assert.equal(resolve(process, duplicates).issues[0].code, "conversion_unresolved");
});

test("named standards and output versions still constrain the added conversion", () => {
  const given = { steps: [{ ...goal, task: "Convert PDF to XRechnung 3.0 UBL XML" }] };
  assert.equal(resolve(given).issues[0].code, "conversion_unresolved");
  const records = catalogue.map((row) => row.id === "convert" ? { ...row, invoice_standard: ["XRechnung 3.0.2"] } : row);
  assert.equal(resolve(given, records).issues[0].code, "conversion_unresolved");
  records[1].invoice_standard = ["XRechnung 3.0"];
  assert.equal(resolve(given, records).added.length, 1);
});

test("a format connection does not bypass field compatibility or missing schemas", () => {
  const missing = { ...convert, schemas: [] };
  const result = resolve(process, catalogue, [extract, missing, validate, send]);
  assert.equal(result.issues[0].code, "conversion_unresolved");
  const mapped = structuredClone(convert);
  mapped.schemas[0].fields[0].json_type = "object";
  const documents = [extract, mapped, validate, send];
  const planned = resolve(process, catalogue, documents);
  const composition = composeChains(planned.narrowed.process, documents, (source, target, context) =>
    runChecks({ source, target, formatAliases: ALIASES, choices: [], validatedBetween: context.validated_between }).overall.overall);
  assert.deepEqual(composition.chains, []);
});

test("a goal with no input format keeps the existing keyword results and avoids broad schema reads", () => {
  const given = { steps: [{ ...goal, input_format: null, task: "Convert UBL JSON to UBL XML" }] };
  assert.deepEqual(transformationCandidateIds(given, catalogue), []);
  assert.deepEqual(resolve(given).narrowed, narrowProcessCandidates(given, catalogue));
});
