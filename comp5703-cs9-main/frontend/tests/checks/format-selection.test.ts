import { test } from "node:test";
import assert from "node:assert/strict";
import { api, pair, schema, side } from "./helpers.ts";
import { defaultFormat } from "../../lib/checks/check1-format.ts";
import { selectSourceSchema, selectTargetRequestSchema } from "../../lib/checks/check2-schema.ts";
import { runChecks } from "../../lib/checks/run.ts";
import type { SchemaRecord } from "../../lib/checks/types.ts";

// A provider that publishes the same operation as JSON and as XML stores one
// api_schema row per content type. Which row is compared decides the verdict,
// so it must follow the format the two APIs exchange rather than the order the
// database returned the rows in.

const res = (specs: string[], over: Partial<SchemaRecord> = {}) =>
  schema({ direction: "response", status_code: "200", verified_by: "reviewer", ...over }, specs);
const req = (specs: string[], over: Partial<SchemaRecord> = {}) =>
  schema({ direction: "request", verified_by: "reviewer", ...over }, specs);

const JSON_FIELDS = ["invoiceNumber:string:req", "issueDate:string:req:date"];
const XML_FIELDS = ["invoiceNumber:string:req", "sellerName:string:req"];

function bothFormats() {
  const source = side(api({ company_name: "A", output_formats: ["JSON", "XML"] }), [
    res(JSON_FIELDS, { media_type: "application/json" }),
    res(XML_FIELDS, { media_type: "application/xml" }),
  ]);
  const target = side(api({ company_name: "B", input_formats: ["JSON", "XML"] }), [
    req(["invoiceNumber:string:req"], { media_type: "application/json" }),
    req(["invoiceNumber:string:req"], { media_type: "text/xml" }),
  ]);
  return { source, target };
}

test("2.1 compares the schema of the selected format on both sides", () => {
  const { source, target } = bothFormats();
  const asJson = runChecks({ ...pair(source, target), selectedFormat: "JSON" });
  assert.equal(asJson.check2.schema.source_schema_used?.media_type, "application/json");
  assert.equal(asJson.check2.schema.target_schema_used?.media_type, "application/json");

  const asXml = runChecks({ ...pair(source, target), selectedFormat: "XML" });
  assert.equal(asXml.check2.schema.source_schema_used?.media_type, "application/xml");
  assert.equal(asXml.check2.schema.target_schema_used?.media_type, "text/xml");
});

test("the format list annotates every declared format, and the default is one that can actually be compared", () => {
  const { source, target } = bothFormats();
  const report = runChecks(pair(source, target));
  assert.deepEqual(report.check1.format_options.map((o) => [o.format, o.common, o.source_has_schema, o.target_has_schema]), [
    ["JSON", true, true, true],
    ["XML", true, true, true],
  ]);
  assert.equal(report.check1.format_selected, "JSON");
  assert.equal(defaultFormat([
    { format: "PDF", recognised: true, in_source: true, in_target: true, common: true, source_has_schema: false, target_has_schema: false, selectable: true },
    { format: "XML", recognised: true, in_source: true, in_target: true, common: true, source_has_schema: true, target_has_schema: true, selectable: true },
  ]), "XML", "a format with schemas on both sides is preferred over one merely declared");
});

test("a declared format with no stored schema is reported as missing information, not as a different verdict", () => {
  const source = side(api({ company_name: "A", output_formats: ["JSON", "XML"] }), [res(JSON_FIELDS, { media_type: "application/json" })]);
  // The target does have an XML request, so 2.1 passes its rule (1) and the
  // missing side is unambiguously the source (the manual's rule order is
  // target first, then source).
  const target = side(api({ company_name: "B", input_formats: ["JSON", "XML"] }), [
    req(["invoiceNumber:string:req"], { media_type: "application/json" }),
    req(["invoiceNumber:string:req"], { media_type: "application/xml" }),
  ]);
  const report = runChecks({ ...pair(source, target), selectedFormat: "XML" });
  assert.equal(report.check2.schema.status, "unknown");
  assert.equal(report.check2.schema.reason_code, "source_no_output_schema");
  assert.ok(report.check2.schema.flags.includes("no_schema_for_format"), "the page must be able to say which of the two situations it is");
  const option = report.check1.format_options.find((o) => o.format === "XML")!;
  assert.equal(option.common, true);
  assert.equal(option.source_has_schema, false);
});

test("a row with no media type recorded is kept for every format", () => {
  // One empty column must not be able to remove the only schema a pair has.
  const schemas = [res(JSON_FIELDS, { media_type: null })];
  assert.equal(selectSourceSchema(schemas, "XML").used?.id, schemas[0].id);
  assert.equal(selectSourceSchema(schemas, "XML").filteredOut, false);
});

test("within one format the plainly named media type wins, not the alphabetically first", () => {
  const schemas = [
    req(["a:string"], { media_type: "text/xml" }),
    req(["a:string"], { media_type: "application/*+xml" }),
    req(["a:string"], { media_type: "application/xml" }),
  ];
  assert.equal(selectTargetRequestSchema(schemas, "XML").used?.media_type, "application/xml");
  assert.equal(selectTargetRequestSchema(schemas, "XML").alternatives.map((s) => s.media_type).join(","), "text/xml,application/*+xml");
});

test("an answer given in another format is reported as such, not as a changed schema", () => {
  const source = side(api({ company_name: "A", output_formats: ["JSON", "XML"] }), [
    res(JSON_FIELDS, { media_type: "application/json", content_hash: "src-json" }),
    res(XML_FIELDS, { media_type: "application/xml", content_hash: "src-xml" }),
  ]);
  const target = side(api({ company_name: "B", input_formats: ["JSON", "XML"] }), [
    req(["dueDate:string:req"], { media_type: "application/json", content_hash: "tgt-json" }),
    req(["dueDate:string:req"], { media_type: "application/xml", content_hash: "tgt-xml" }),
  ]);
  const given = [{
    target_path: "dueDate", option: "external" as const, chosen_source_path: null,
    kind: "user" as const, chosen_by: "reviewer-1", chosen_at: "2026-09-19T04:00:00Z",
    source_content_hash: "src-json", target_content_hash: "tgt-json",
  }];

  const inJson = runChecks({ ...pair(source, target), selectedFormat: "JSON", choices: given });
  assert.deepEqual(inJson.check2.semantics?.stale_choices, []);
  assert.equal(inJson.check2.semantics?.applied[0]?.option, "external");

  const inXml = runChecks({ ...pair(source, target), selectedFormat: "XML", choices: given });
  assert.deepEqual(inXml.check2.semantics?.stale_choices, [{ target_path: "dueDate", reason: "format_changed" }]);
  assert.deepEqual(inXml.check2.semantics?.applied, [], "an answer from another format is not applied here");
});
