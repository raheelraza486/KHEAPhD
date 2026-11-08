import { test } from "node:test";
import assert from "node:assert/strict";
import { commonFormats } from "../../lib/checks/check1-format.ts";
import { effectiveFormats, findCarrier, passThrough, schemaCarries } from "../../lib/checks/documents.ts";
import { runChecks } from "../../lib/checks/run.ts";
import { ALIASES, api, pair, schema, side } from "./helpers.ts";
import type { PairInput } from "../../lib/checks/types.ts";

// Issue #41: a whole invoice file is exchanged, not fields. The shapes below
// are the stored schemas of real catalogue records (snapshot of 12 Oct 2026).

const aliases = [
  ...ALIASES,
  { alias: "application/xml", canonical: "XML" },
  { alias: "multipart/form-data", canonical: "Multipart form data" },
  { alias: "application/octet-stream", canonical: "Binary" },
];
const withAliases = (p: PairInput): PairInput => ({ ...p, formatAliases: aliases });

// beliq generateInvoice: the 200 response is the XML file itself.
const beliq = () =>
  side(api({ category: "Transformation", input_formats: ["JSON"], output_formats: ["XML", "PDF", "JSON"] }), [
    schema({ direction: "response", media_type: "application/xml", raw: { type: "string", format: "binary" } }),
    schema({ direction: "response", media_type: "application/json" }, ["success:boolean:req", "data.id:string"]),
  ]);
// Peppol Validator validateInvoice: XML body, or a multipart form with `file`.
const peppolValidator = () =>
  side(api({ category: "Validation", input_formats: ["application/xml", "multipart/form-data"], output_formats: ["JSON"] }), [
    schema({ direction: "request", media_type: "application/xml", raw: { type: "string" } }),
    schema({ direction: "request", media_type: "multipart/form-data" }, ["file:string:req:binary"]),
    schema({ direction: "response", media_type: "application/json" }, ["valid:boolean:req", "errors[].message:string"]),
  ]);
// ESS SmartDocFlow: the file is base64 in `content`; `filename` and `profile` are settings.
const ess = () =>
  side(api({ category: "Validation", input_formats: ["JSON"], output_formats: ["JSON"] }), [
    schema({ direction: "request", media_type: "application/json", raw: { allOf: [{ oneOf: [] }] } }, ["content:string:req:base64", "profile:string:req", "filename:string:req"]),
    schema({ direction: "response", media_type: "application/json" }, ["status:string:req", "summary:string:req"]),
  ]);
// AmitTransform: the converted XML comes back as a string in `xml`.
const amit = () =>
  side(api({ category: "Transformation", input_formats: ["JSON"], output_formats: ["JSON"] }), [
    schema({ direction: "response", media_type: "application/json" }, ["xml:string:req", "missingFields:object:req", "missingFields.summary:string:req"]),
  ]);
// B2Brouter Import Invoice: the request body is the file.
const b2brouter = () =>
  side(api({ category: "Communication", input_formats: ["XML"], output_formats: ["JSON"] }), [
    schema({ direction: "request", media_type: "application/octet-stream", raw: { type: "string", format: "binary" } }),
  ]);
// Mailgun: multipart form; the invoice goes in `attachment[]`; to/subject are settings.
const mailgun = () =>
  side(api({ category: "Communication", input_formats: ["multipart/form-data"], output_formats: ["JSON"] }), [
    schema({ direction: "request", media_type: "multipart/form-data" }, ["to:array:req", "subject:string:req", "attachment[]:string:binary", "inline[]:string:binary"]),
  ]);
// A JSON invoice, field by field.
const jsonInvoice = () =>
  side(api({ category: "Transformation", output_formats: ["JSON"] }), [
    schema({ direction: "response", media_type: "application/json" }, ["invoiceNumber:string:req", "total:number:req"]),
  ]);

test("#41 carriers: body, multipart file, base64 field and xml text are each recognised", () => {
  assert.equal(findCarrier(beliq().schemas[0], "Transformation")?.kind, "body");
  assert.deepEqual(findCarrier(beliq().schemas[0], "Transformation")?.formats, ["XML"]);
  assert.equal(findCarrier(peppolValidator().schemas[1], "Validation")?.path, "file");
  assert.equal(findCarrier(ess().schemas[0], "Validation")?.kind, "base64");
  assert.equal(findCarrier(amit().schemas[0], "Transformation")?.path, "xml");
  assert.equal(findCarrier(mailgun().schemas[0], "Communication")?.path, "attachment[]");
  assert.equal(findCarrier(jsonInvoice().schemas[0], "Transformation"), null);
});

test("#41 effective formats: an envelope accepts the document, not its JSON or multipart wrapper", () => {
  assert.deepEqual(effectiveFormats(ess(), "input", aliases).formats, ["XML"]);
  assert.deepEqual(effectiveFormats(peppolValidator(), "input", aliases).formats, ["XML"]);
  assert.deepEqual(effectiveFormats(mailgun(), "input", aliases).formats, ["XML"]);
  // A text carrier adds the document and keeps JSON.
  assert.deepEqual(effectiveFormats(amit(), "output", aliases).formats, ["JSON", "XML"]);
});

test("#41 a validator hands on the document it received; one queried with fields does not", () => {
  const out = passThrough(ess());
  assert.deepEqual(out.api.output_formats, ["JSON"]);
  assert.ok(out.schemas.every((s) => s.direction === "response" && s.status_code === "200"));
  const query = side(api({ category: "Validation" }), [schema({ direction: "request", media_type: "application/json" }, ["invoiceId:string:req"])]);
  assert.equal(passThrough(query), query);
});

test("#41 beliq -> Peppol Validator: the same XML file, no value mapping asked (was fail on check3)", () => {
  const r = runChecks(withAliases(pair(beliq(), peppolValidator())));
  assert.equal(r.overall.overall, "pass");
  assert.equal(r.check1.format_selected, "XML");
  assert.ok(r.check2.schema.flags.includes("document_exchange"));
  assert.deepEqual(r.check2.semantics?.mappings.map((m) => `${m.source_path}>${m.target_path}`), ["(body)>(body)"]);
  assert.notEqual(r.check3.status, "unknown");
});

test("#41 beliq -> ESS: compared as XML (not beliq's JSON report); filename and profile are settings", () => {
  const r = runChecks(withAliases(pair(beliq(), ess())));
  assert.equal(r.overall.overall, "pass");
  assert.equal(r.check1.format_selected, "XML");
  const m = r.check2.semantics!.mappings[0];
  assert.equal(m.target_path, "content");
  assert.ok(m.notes.includes("encode_base64"));
  assert.deepEqual(r.check2.semantics!.excluded.map((e) => e.path).sort(), ["filename", "profile"]);
  assert.equal(r.check2.required?.status, "pass");
});

test("#41 AmitTransform -> ESS: the xml string is the file", () => {
  const r = runChecks(withAliases(pair(amit(), ess())));
  assert.equal(r.overall.overall, "pass");
  assert.equal(r.check2.semantics!.mappings[0].source_path, "xml");
});

test("#41 validate -> send: ESS -> B2Brouter and Peppol Validator -> Mailgun pass on the document", () => {
  const a = runChecks(withAliases(pair(ess(), b2brouter())));
  assert.equal(a.overall.overall, "pass");
  assert.ok(a.check2.semantics!.mappings[0].notes.includes("decode_base64"));
  const b = runChecks(withAliases(pair(peppolValidator(), mailgun())));
  assert.equal(b.overall.overall, "pass");
  assert.equal(b.check2.semantics!.mappings[0].target_path, "attachment[]");
});

test("#32 a selected validator response preserves document pass-through", () => {
  const source = ess();
  const requestSchema = source.schemas.find((entry) => entry.direction === "request");
  const responseSchema = source.schemas.find((entry) => entry.direction === "response");
  assert.ok(requestSchema);
  assert.ok(responseSchema);
  const input = withAliases(pair(source, b2brouter()));
  input.selectedSourceSchemaId = responseSchema.id;
  const report = runChecks(input);
  assert.equal(report.overall.overall, "pass");
  assert.equal(report.check1.format_selected, "XML");
  assert.equal(report.check2.schema.source_schema_used?.schema_id, requestSchema.id);
  assert.ok(report.check2.schema.flags.includes("document_exchange"));
  assert.ok(report.check2.semantics?.mappings[0]?.notes.includes("decode_base64"));
  assert.equal(JSON.stringify(report.check2.semantics).includes("summary"), false);
});

test("#41 a JSON invoice cannot be given to a validator that takes a file", () => {
  const r = runChecks(withAliases(pair(jsonInvoice(), ess())));
  assert.equal(r.check1.status, "fail");
  assert.equal(r.overall.overall, "fail");
});

test("#41 an XML schema with fields is not taken for an invoice file (a query written in XML)", () => {
  const xmlQuery = side(api({ category: "Communication", input_formats: ["XML"], output_formats: ["XML"] }), [
    schema({ direction: "response", media_type: "application/xml" }, ["transactionList.transaction[].id:string", "result.funcCode:string:req"]),
  ]);
  const r = runChecks(withAliases(pair(xmlQuery, b2brouter())));
  assert.ok(!r.check2.schema.flags.includes("document_exchange"));
  assert.notEqual(r.overall.overall, "pass");
});

test("#41 an encrypted base64 payload (Poland KSeF) is not taken for the invoice file", () => {
  const ksef = schema({ direction: "request", media_type: "application/json" }, ["encryptedInvoiceContent:string:req:byte", "invoiceHash:string:req", "invoiceSize:integer:req"]);
  assert.equal(findCarrier(ksef, "Communication"), null);
});

// e-invoice conversion convertInvoice: a multipart upload of CSV, XML or
// EDIFACT (GET /v1/formats); a PDF only as ZUGFeRD / Factur-X (migration 0050).
const einvoice = (inputFormats: string[]) =>
  side(api({ category: "Transformation", input_formats: inputFormats, output_formats: ["XML", "PDF"] }), [
    schema({ direction: "request", media_type: "multipart/form-data" }, ["file:string:req:binary", "format:string:req", "profile:string:req"]),
    schema({ direction: "response", media_type: "application/xml", raw: { type: "string" } }),
  ]);

const hybridAliases = [...aliases, { alias: "CSV", canonical: "CSV" }, { alias: "EDIFACT", canonical: "EDIFACT" },
  { alias: "Hybrid PDF", canonical: "Hybrid PDF" }, { alias: "Factur-X PDF", canonical: "Hybrid PDF" }];

test("document formats a record declares replace the category's guess for an upload", () => {
  // Only the envelope declared: a Transformation's upload is read as a PDF or an image.
  assert.deepEqual(effectiveFormats(einvoice(["multipart/form-data"]), "input", hybridAliases).formats, ["Images", "PDF"]);
  // The record names its documents: those, and no plain PDF.
  assert.deepEqual(effectiveFormats(einvoice(["XML", "CSV", "EDIFACT", "Hybrid PDF"]), "input", hybridAliases).formats, ["CSV", "EDIFACT", "Hybrid PDF", "XML"]);
  // And the upload is found when a pair is compared in one of them (check 2.1).
  const request = einvoice(["XML"]).schemas[0];
  assert.equal(schemaCarries(request, "XML", "Transformation", ["XML"]), true);
  assert.equal(schemaCarries(request, "XML", "Transformation"), false);
  // A body that is the document itself is not a guess and still counts.
  assert.deepEqual(effectiveFormats(beliq(), "output", aliases).formats, ["JSON", "PDF", "XML"]);
});

// beliq convertInvoice: "XML or hybrid PDF in" (docs.beliq.eu, migration 0051).
const beliqConvert = (inputFormats: string[]) =>
  side(api({ category: "Transformation", input_formats: inputFormats, output_formats: ["XML", "Hybrid PDF"] }), [
    schema({ direction: "request", media_type: "application/xml", raw: { type: "string" } }),
    schema({ direction: "request", media_type: "application/pdf", raw: { type: "string" } }),
    schema({ direction: "request", media_type: "application/octet-stream", raw: { type: "string" } }),
    schema({ direction: "response", media_type: "application/xml", raw: { type: "string", format: "binary" } }),
  ]);

test("a record that declares Hybrid PDF reads only that kind of PDF; a Hybrid PDF is still a PDF to anyone else", () => {
  assert.deepEqual(effectiveFormats(beliqConvert(["XML", "Hybrid PDF"]), "input", hybridAliases).formats, ["Hybrid PDF", "XML"]);
  // Without the declaration the PDF body is any PDF, and raw bytes are guessed as a PDF or an image.
  assert.deepEqual(effectiveFormats(beliqConvert(["application/xml", "application/pdf"]), "input", hybridAliases).formats, ["PDF", "XML"]);
  assert.deepEqual(commonFormats(["PDF"], ["Hybrid PDF", "XML"]), []);
  assert.deepEqual(commonFormats(["Hybrid PDF"], ["PDF"]), ["Hybrid PDF"]);
  assert.deepEqual(commonFormats(["Hybrid PDF"], ["Hybrid PDF"]), ["Hybrid PDF"]);
});

// 14 October 2026: the string that holds the XML need not be named exactly `xml`.
test("text carrier on a request: Billit `POST /v1/peppol/sendxml` takes the UBL file as the one required string `XML`", () => {
  const billit = () =>
    side(api({ category: "Communication", input_formats: ["JSON"], output_formats: ["JSON"] }), [
      schema({ direction: "request", media_type: "application/json" }, ["XML:string:req"]),
      schema({ direction: "response", media_type: "application/json", status_code: "200" }, ["(body):integer"]),
    ]);
  assert.equal(findCarrier(billit().schemas[0], "Communication")?.path, "XML");
  assert.deepEqual(effectiveFormats(billit(), "input", aliases).formats, ["JSON", "XML"]);
  // ESS hands on the validated XML file; Billit takes it as the whole document.
  const r = runChecks(withAliases(pair(ess(), billit())));
  assert.equal(r.check1.status, "pass");
  assert.ok(r.check2.schema.flags.includes("document_exchange"));
  assert.equal(r.overall.overall, "pass");
  // A JSON request with the XML string among other required business fields is still compared field by field.
  const mixed = side(api({ category: "Communication" }), [schema({ direction: "request", media_type: "application/json" }, ["xml:string:req", "signed_xml:string:req"])]);
  assert.equal(findCarrier(mixed.schemas[0], "Communication"), null);
});

test("#41 text carrier: `invoice_xml` (the group's extracted-invoice endpoint) is the file; `xmlns` or two candidates are not", () => {
  const extracted = () =>
    side(api({ category: "Transformation", input_formats: ["JSON"], output_formats: ["JSON"] }), [
      schema({ direction: "response", media_type: "application/json" }, ["invoice_xml:string:req", "profile:string:req", "currency:string:req"]),
    ]);
  assert.equal(findCarrier(extracted().schemas[0], "Transformation")?.path, "invoice_xml");
  assert.deepEqual(effectiveFormats(extracted(), "output", aliases).formats, ["JSON", "XML"]);
  const r = runChecks(withAliases(pair(extracted(), ess())));
  assert.equal(r.overall.overall, "pass");
  assert.equal(r.check2.semantics!.mappings[0].source_path, "invoice_xml");
  const ns = side(api({ category: "Transformation" }), [schema({ direction: "response", media_type: "application/json" }, ["xmlns:string:req", "id:string:req"])]);
  assert.equal(findCarrier(ns.schemas[0], "Transformation"), null);
  const two = side(api({ category: "Transformation" }), [schema({ direction: "response", media_type: "application/json" }, ["xml:string:req", "signed_xml:string:req"])]);
  assert.equal(findCarrier(two.schemas[0], "Transformation"), null);
});
