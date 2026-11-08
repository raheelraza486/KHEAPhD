import { test } from "node:test";
import assert from "node:assert/strict";
import { runSemantics, applicableRows, tokenise } from "../../lib/checks/check2-semantics.ts";
import { runTypes } from "../../lib/checks/check2-types.ts";
import { runRequired, requiredKind } from "../../lib/checks/check2-required.ts";
import { fieldMap, parameterFields, schemaFields } from "../../lib/checks/fields.ts";
import { normaliseType, conversionOf } from "../../lib/checks/data.ts";
import { fields, param, schema } from "./helpers.ts";

const F = (specs: string[], d: Record<string, string> = {}) => schemaFields(schema({ direction: "request" }, specs, d));
const sem = (src: string[], tgt: string[], extra: Partial<Parameters<typeof runSemantics>[0]> = {}) =>
  runSemantics({ sourceVendor: "Vendor A", targetVendor: "Vendor B", sourceFields: F(src), targetFields: F(tgt), ...extra });

// ---- 2.2 (Semantic Manual chapter 5)

test("S-0/S-3 (case A2): different spellings registered under one unit are the same thing", () => {
  const r = sem(["invoiceNumber:string:req", "issueDate:string:date"], ["invoice_no:string:req", "invoiceDate:string:date"]);
  assert.equal(r.status, "complete");
  assert.deepEqual(r.mappings.map((m) => [m.target_path, m.source_path, m.unit_id]), [["invoice_no", "invoiceNumber", "U01"], ["invoiceDate", "issueDate", "U04"]]);
});

test("S-1 (case B4): envelope fields are excluded on both sides", () => {
  const r = sem(["softwareId:string", "invoiceNumber:string"], ["softwareId:string:req", "invoiceNumber:string:req"]);
  assert.deepEqual(r.excluded, [{ path: "softwareId", reason: "envelope" }]);
  assert.equal(r.mappings.length, 1);
});

test("S-3 (case B3 / allow-list): an unregistered name is not found, similarity only suggests", () => {
  const r = sem(["invoiceNumber:string"], ["invoiceNumbr:string:req"]);
  assert.equal(r.status, "pending_user");
  assert.equal(r.not_found[0].target_path, "invoiceNumbr");
  assert.ok(r.not_found[0].suggestions[0].basis.startsWith("string similarity"));
  assert.equal(r.mappings.length, 0);
});

test("S-2/S-5 (case A4): the role word in the name must agree with the role in the other side's path", () => {
  const r = sem(["seller.name:string", "buyer.name:string"], ["sellerName:string:req", "buyerName:string:req"]);
  assert.deepEqual(
    r.mappings.map((m) => [m.target_path, m.source_path]).sort(),
    [["buyerName", "buyer.name"], ["sellerName", "seller.name"]],
  );
});

test("S-4 (case B1): a generic name is resolved by the parent's unit, otherwise ambiguous", () => {
  const r = sem(["invoice.id:string", "buyer.id:string"], ["invoice.id:string:req"]);
  assert.deepEqual(r.mappings.map((m) => [m.target_path, m.source_path]), [["invoice.id", "invoice.id"]]);
  const amb = sem(["a.invoiceNumber:string", "b.invoiceNumber:string"], ["invoiceNumber:string:req"]);
  assert.equal(amb.status, "pending_user");
  assert.equal(amb.ambiguous[0].candidates.length, 2);
});

test("S-6 contention: one source field determined for two target fields turns both ambiguous", () => {
  const r = sem(["invoiceNumber:string"], ["invoiceNumber:string:req", "invoiceNo:string"]);
  assert.equal(r.mappings.length, 0);
  assert.equal(r.ambiguous.length, 2);
  assert.ok(r.ambiguous[0].required, "required fields are listed first");
});

test("S-7: representation and shape differences are annotated", () => {
  const r = sem(["buyer:object", "buyer.countryCode:string"], ["buyer:object", "buyer.countryName:string:req"]);
  assert.ok(r.mappings.find((m) => m.target_path === "buyer.countryName")!.notes.includes("representation_differs"));
  const s = sem(["items:array"], ["lines[]:object"]);
  assert.ok(s.mappings[0].notes.includes("shape_differs"));
  // the same name in another spelling is not a representation difference
  const same = sem(["filename:string"], ["fileName:string:req"]);
  assert.equal(same.mappings[0]?.source_path, "filename");
  assert.ok(!same.mappings[0].notes.includes("representation_differs"));
});

test("S-8 / 2.2c: user choices are written back (candidate, none, external); optional ambiguity never blocks", () => {
  const pending = sem(["a.invoiceNumber:string", "b.invoiceNumber:string"], ["invoiceNumber:string:req", "x.issueDate:string"]);
  assert.equal(pending.status, "pending_user");
  const chosen = sem(["a.invoiceNumber:string", "b.invoiceNumber:string"], ["invoiceNumber:string:req"], {
    choices: [{ target_path: "invoiceNumber", chosen_source_path: "b.invoiceNumber", option: "candidate" }],
  });
  assert.equal(chosen.status, "complete");
  assert.equal(chosen.mappings[0].origin, "user_choice");
  const ext = sem(["issueDate:string"], ["invoiceNumber:string:req"], { choices: [{ target_path: "invoiceNumber", chosen_source_path: null, option: "external" }] });
  assert.deepEqual(ext.external_by_choice, ["invoiceNumber"]);
  assert.equal(ext.status, "complete");
  const none = sem(["issueDate:string"], ["invoiceNumber:string:req"], { choices: [{ target_path: "invoiceNumber", chosen_source_path: null, option: "none" }] });
  assert.deepEqual(none.uncovered_by_choice, ["invoiceNumber"]);
  const optional = sem(["a.invoiceNumber:string", "b.invoiceNumber:string"], ["invoiceNumber:string"]);
  assert.equal(optional.status, "complete");
  assert.equal(optional.ambiguous.length, 1);
});

test("registry conditions: vendor and parent conditions select the row (uuid, amountIncludingTax)", () => {
  const taiwan = F(["uuid:string"]);
  assert.deepEqual(applicableRows(taiwan[0], { vendor: "Taiwan Ministry of Finance", fields: fieldMap(taiwan) }).map((r) => r.unit_id), ["E"]);
  const face = F(["europeanInvoice:object", "europeanInvoice.uuid:string"]);
  const ctx = { vendor: "General Secretariat for Digital Administration (SGAD)", fields: fieldMap(face) };
  assert.deepEqual(applicableRows(face[1], ctx).map((r) => r.unit_id), ["U35"]);
  const store = F(["invoiceLines[]:object", "invoiceLines[].amountIncludingTax:number"]);
  assert.deepEqual(applicableRows(store[1], { vendor: "Storecove", fields: fieldMap(store) }).map((r) => r.unit_id), ["U63"]);
  assert.deepEqual(applicableRows(store[1], { vendor: "Someone else", fields: fieldMap(store) }), []);
});

test("tokenise splits camel case, acronyms and separators", () => {
  assert.deepEqual(tokenise("amountVatNet"), ["amount", "vat", "net"]);
  assert.deepEqual(tokenise("Customer_VAT_Number"), ["customer", "vat", "number"]);
  assert.deepEqual(tokenise("IRNDetails"), ["irn", "details"]);
});

test("S-5b: an array and its own element are never both offered", () => {
  // `invoice` (U37) is stored twice on the source: the array and its element.
  const r = sem(["invoice:array", "invoice[]:object", "invoice[].invoiceNumber:string"], ["invoice:array:req", "invoice[]:object", "invoice[].invoiceNumber:string:req"]);
  assert.equal(r.status, "complete");
  assert.deepEqual(r.mappings.map((m) => [m.target_path, m.source_path]).sort(), [["invoice", "invoice"], ["invoice[]", "invoice[]"], ["invoice[].invoiceNumber", "invoice[].invoiceNumber"]]);
  assert.equal(r.ambiguous.length, 0);
  // A target that is neither an array nor an element is left to the user.
  const obj = sem(["invoice:array", "invoice[]:object"], ["invoice:object:req"]);
  assert.equal(obj.status, "pending_user");
  assert.equal(obj.ambiguous[0].candidates.length, 2);
  // Candidates on different paths are not touched: still ambiguous.
  const other = sem(["a.invoice:array", "b.invoice:array"], ["invoice:array:req"]);
  assert.equal(other.status, "pending_user");
  assert.equal(other.ambiguous[0].candidates.length, 2);
});

test("S-9: a constant with no source candidate is excluded, not \"not found\"", () => {
  const tgt = F(["invoiceNumber:string:req", "outputFormat:string:req", "invoiceType:string:req"]);
  tgt.find((f) => f.path === "outputFormat")!.enumValues = ["UBL XML"];
  tgt.find((f) => f.path === "invoiceType")!.enumValues = ["JSON", "XML"];
  const r = runSemantics({ sourceVendor: "Vendor A", targetVendor: "Vendor B", sourceFields: F(["invoiceNumber:string"]), targetFields: tgt });
  assert.deepEqual(r.excluded, [{ path: "outputFormat", reason: "constant" }]);
  // Two admissible values are a choice, not a constant: still not found (unregistered name).
  assert.deepEqual(r.not_found.map((n) => n.target_path), ["invoiceType"]);
  assert.equal(r.status, "pending_user");
  // 2.4 does not count the constant as a required field.
  const req = runRequired({ targetFields: tgt, sourceFields: fieldMap(F(["invoiceNumber:string"])), mappings: r.mappings, conversions: [], externalByChoice: [], uncoveredByChoice: [], excludedPaths: r.excluded.map((e) => e.path) });
  assert.ok(!req.required_fields.some((f) => f.target_path === "outputFormat"));
  assert.ok(!req.uncovered.includes("outputFormat"));
});

test("S-9: a constant that has a source candidate keeps its mapping so Check 3 can compare the values", () => {
  // The source only yields INV-001, the target only accepts INV-002: the field must stay in the
  // comparison (Check 3 then fails it), not be skipped as a constant.
  const src = F(["invoiceNumber:string"]);
  src[0].enumValues = ["INV-001"];
  const tgt = F(["invoiceNumber:string:req"]);
  tgt[0].enumValues = ["INV-002"];
  const r = runSemantics({ sourceVendor: "Vendor A", targetVendor: "Vendor B", sourceFields: src, targetFields: tgt });
  assert.deepEqual(r.excluded, []);
  assert.deepEqual(r.mappings.map((m) => [m.target_path, m.source_path]), [["invoiceNumber", "invoiceNumber"]]);
  // A registered name with no source field at all is still a constant: excluded.
  const none = runSemantics({ sourceVendor: "Vendor A", targetVendor: "Vendor B", sourceFields: F(["issueDate:string:date"]), targetFields: tgt });
  assert.deepEqual(none.excluded, [{ path: "invoiceNumber", reason: "constant" }]);
  assert.equal(none.status, "complete");
});

// ---- 2.3 (Check Manual §7.6)

test("2.3: vocabulary and matrix — same, lossless, conditional, incompatible, undetermined, container, shape", () => {
  assert.equal(normaliseType("string", "date-time"), "date-time");
  assert.equal(normaliseType("integer", "int64"), "integer");
  assert.equal(normaliseType(null, null), "unknown");
  assert.equal(conversionOf("integer", "string").kind, "lossless");
  assert.equal(conversionOf("string", "integer").kind, "conditional");
  assert.equal(conversionOf("boolean", "number").kind, "incompatible");
  assert.equal(conversionOf("unknown", "string").kind, "undetermined");
  assert.equal(conversionOf("object", "object").kind, "container");
  assert.equal(conversionOf("object", "array").kind, "shape");
});

test("2.3: only required target fields decide the verdict; conditional conversions are flagged", () => {
  const src = fieldMap(F(["invoiceNumber:integer", "issueDate:string", "vatRate:boolean"]));
  const tgt = fieldMap(F(["invoiceNumber:string:req", "issueDate:string:req:date", "vatRate:number"]));
  const mappings = [
    { target_path: "invoiceNumber", source_path: "invoiceNumber", unit_id: "U01", origin: "auto" as const, notes: [] },
    { target_path: "issueDate", source_path: "issueDate", unit_id: "U04", origin: "auto" as const, notes: [] },
    { target_path: "vatRate", source_path: "vatRate", unit_id: "U14", origin: "auto" as const, notes: [] },
  ];
  const r = runTypes(mappings, src, tgt, new Set(["invoiceNumber", "issueDate"]));
  assert.equal(r.status, "pass");
  assert.deepEqual(r.flags, ["conversion_conditional"]);
  assert.equal(r.conversions.find((c) => c.target_path === "vatRate")?.kind, "incompatible");
  const fail = runTypes(mappings, src, tgt, new Set(["vatRate"]));
  assert.equal(fail.status, "fail");
});

// ---- 2.4 (Check Manual §7.7)

test("2.4 definition of required: unconditional / conditional / array item", () => {
  const f = F(["a:string:req", "opt:object", "opt.b:string:req", "lines[]:object:req", "lines[].q:number:req"]);
  const m = fieldMap(f);
  assert.equal(requiredKind(m.get("a")!, m), "unconditional");
  assert.equal(requiredKind(m.get("opt.b")!, m), "conditional");
  assert.equal(requiredKind(m.get("lines[].q")!, m), "array_item");
  assert.equal(requiredKind(parameterFields([param("id")])[0], m), "unconditional");
});

test("2.4 rule (2): no required fields -> hollow pass flagged; no fields at all -> pass without flag", () => {
  const hollow = runRequired({ targetFields: F(["a:string"]), sourceFields: new Map(), mappings: [], conversions: [], externalByChoice: [], uncoveredByChoice: [] });
  assert.equal(hollow.status, "pass");
  assert.deepEqual(hollow.flags, ["required_info_missing"]);
  const confirmedOptional = runRequired({
    targetFields: F(["a:string"]),
    sourceFields: new Map(),
    mappings: [],
    conversions: [],
    externalByChoice: [],
    uncoveredByChoice: [],
    requiredInformationConfirmed: true,
  });
  assert.deepEqual(confirmedOptional.flags, []);
  const empty = runRequired({ targetFields: [], sourceFields: new Map(), mappings: [], conversions: [], externalByChoice: [], uncoveredByChoice: [] });
  assert.deepEqual(empty.flags, []);
});

test("2.4 rules (3)–(7): coverage states, containers, conditional applicability, external, source optional", () => {
  const tgt = F(["invoiceNumber:string:req", "buyer:object:req", "buyer.name:string:req", "opt:object", "opt.x:string:req", "note:string:req", "extra:string:req"]);
  const src = fieldMap(F(["invoiceNumber:string", "buyer.name:string:req"]));
  const mappings = [
    { target_path: "invoiceNumber", source_path: "invoiceNumber", unit_id: "U01", origin: "auto" as const, notes: [] },
    { target_path: "buyer.name", source_path: "buyer.name", unit_id: "U17", origin: "auto" as const, notes: [] },
  ];
  const conversions = mappings.map((m) => ({ ...m, source_type: "string", target_type: "string", kind: "same" as const, condition: "" }));
  const r = runRequired({ targetFields: tgt, sourceFields: src, mappings, conversions, externalByChoice: ["note"], uncoveredByChoice: ["extra"] });
  const state = Object.fromEntries(r.required_fields.map((f) => [f.target_path, f.state]));
  assert.equal(state["invoiceNumber"], "covered");
  assert.equal(state["buyer"], "covered", "container covered through its required child");
  assert.equal(state["opt.x"], "not_applicable", "optional ancestor not provided");
  assert.equal(state["note"], "external");
  assert.equal(state["extra"], "uncovered");
  assert.equal(r.status, "fail");
  assert.equal(r.reason_code, "required_field_uncovered");
  assert.deepEqual(r.uncovered, ["extra"]);
  assert.deepEqual(r.external_inputs, ["note"]);
  assert.deepEqual(r.flags, ["source_field_optional"]);
  assert.deepEqual(r.source_optional_pairs, [{ target_path: "invoiceNumber", source_path: "invoiceNumber" }]);
});

test("2.4: an undetermined type on a required field makes the check undetermined, never fail", () => {
  const tgt = F(["invoiceNumber:string:req"]);
  const src = fieldMap(F(["invoiceNumber:unknown"]));
  const mappings = [{ target_path: "invoiceNumber", source_path: "invoiceNumber", unit_id: "U01", origin: "auto" as const, notes: [] }];
  const conversions = [{ ...mappings[0], source_type: "unknown", target_type: "string", kind: "undetermined" as const, condition: "" }];
  const r = runRequired({ targetFields: tgt, sourceFields: src, mappings, conversions, externalByChoice: [], uncoveredByChoice: [] });
  assert.equal(r.status, "unknown");
  assert.equal(r.reason_code, "field_type_unknown");
});

test("fields(): helper produces required flags and array-item markers", () => {
  const f = fields(["lines[].q:number:req"]);
  assert.equal(f[0].is_array_item, true);
  assert.equal(f[0].is_required, true);
});

// ---- 14 October 2026: what a shape difference asks for, and containers decided by their children

test("2.3 shape: a list where the target takes one object is a transformation to add, not missing information", () => {
  // Upbrains `extractor_result.documents` (array) auto-matched to AmitTransform `invoiceData` (object).
  const src = fieldMap(F(["documents:array", "documents[]:object", "documents[].InvoiceId:string"]));
  const tgt = fieldMap(F(["invoiceData:object:req", "invoiceData.Invoice:array"]));
  const mappings = [{ target_path: "invoiceData", source_path: "documents", unit_id: "", origin: "auto" as const, notes: [] }];
  const r = runTypes(mappings, src, tgt, new Set(["invoiceData"]));
  assert.equal(r.status, "unknown");
  assert.equal(r.reason_code, "shape_transformation_required");
  assert.match(r.conversions[0].condition, /take the first element/);
  // The other direction asks for wrapping; a container against a scalar for building or unpacking.
  const up = runTypes([{ target_path: "lines", source_path: "line", unit_id: "", origin: "auto" as const, notes: [] }],
    fieldMap(F(["line:object"])), fieldMap(F(["lines:array:req"])), new Set(["lines"]));
  assert.match(up.conversions[0].condition, /wrap the value/);
  const unpack = runTypes([{ target_path: "total", source_path: "totals", unit_id: "", origin: "auto" as const, notes: [] }],
    fieldMap(F(["totals:object"])), fieldMap(F(["total:number:req"])), new Set(["total"]));
  assert.match(unpack.conversions[0].condition, /pick the value out/);
  // 2.4 carries the same reason.
  const req = runRequired({ targetFields: F(["invoiceData:object:req"]), sourceFields: src, mappings, conversions: r.conversions, externalByChoice: [], uncoveredByChoice: [] });
  assert.equal(req.status, "unknown");
  assert.equal(req.reason_code, "shape_transformation_required");
});

test("2.2: a required container whose children are matched needs no answer of its own (whole response nested in one field)", () => {
  // The group's extracted-invoice endpoint takes Upbrains' whole result as `extraction`.
  const sourceFields = F(["result_id:string", "extractor_result:object", "extractor_result.documents:array", "extractor_result.documents[].fields.InvoiceId:string"]);
  const targetFields = F(["extraction:object:req", "extraction.result_id:string", "extraction.extractor_result:object", "extraction.extractor_result.documents:array", "extraction.extractor_result.documents[].fields.InvoiceId:string", "options:object"]);
  const r = runSemantics({ sourceVendor: "Upbrains", targetVendor: "CS9-5", sourceFields, targetFields });
  assert.equal(r.status, "complete", JSON.stringify({ nf: r.not_found, amb: r.ambiguous }));
  const wrapper = r.not_found.find((n) => n.target_path === "extraction");
  assert.ok(wrapper && wrapper.required === false, "the wrapper stays listed, as optional");
  assert.ok(r.mappings.some((m) => m.target_path === "extraction.extractor_result.documents[].fields.InvoiceId"));
  // A required container with nothing matched underneath still asks.
  const alone = runSemantics({ sourceVendor: "A", targetVendor: "B", sourceFields: F(["foo:string"]), targetFields: F(["extraction:object:req", "extraction.bar:string"]) });
  assert.equal(alone.status, "pending_user");
});
