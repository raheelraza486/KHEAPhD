import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogueFormatOptions, matchesCatalogueFormat, UNRECORDED_FORMAT } from "../lib/catalog-format-filter.ts";

test("format choices include every recorded value, merge case variants and keep missing data distinct", () => {
  assert.deepEqual(catalogueFormatOptions([["JSON", " XML "], ["json", "Form URL encoded"], [], [" "]]), [
    { value: "form url encoded", label: "Form URL encoded" },
    { value: "json", label: "JSON" },
    { value: "xml", label: "XML" },
    { value: UNRECORDED_FORMAT, label: "Not recorded" },
  ]);
  assert.deepEqual(catalogueFormatOptions([]), []);
});

test("request-body absence is labelled only for input formats and omitted from output choices", () => {
  const rows = [["NULL", "JSON"], [" null ", "XML"]];
  assert.deepEqual(catalogueFormatOptions(rows, "input"), [
    { value: "json", label: "JSON" },
    { value: "null", label: "No request body" },
    { value: "xml", label: "XML" },
  ]);
  assert.deepEqual(catalogueFormatOptions(rows, "output"), [
    { value: "json", label: "JSON" },
    { value: "xml", label: "XML" },
  ]);
});

test("each side matches any of its recorded formats without guessing compatibility", () => {
  assert.equal(matchesCatalogueFormat(["JSON", " XML "], "xml"), true);
  assert.equal(matchesCatalogueFormat(["json"], "JSON"), true);
  assert.equal(matchesCatalogueFormat(["Form URL encoded"], "form url encoded"), true);
  assert.equal(matchesCatalogueFormat(["JSON-LD"], "json"), false);
  assert.equal(matchesCatalogueFormat([], "json"), false);
  assert.equal(matchesCatalogueFormat([], ""), true);
});

test("comma-separated formats become individual options and use membership matching", () => {
  assert.deepEqual(catalogueFormatOptions([["JSON, XML"], ["XML", "PDF, ZIP"]]), [
    { value: "json", label: "JSON" },
    { value: "pdf", label: "PDF" },
    { value: "xml", label: "XML" },
    { value: "zip", label: "ZIP" },
  ]);
  assert.equal(matchesCatalogueFormat(["JSON, XML"], "json"), true);
  assert.equal(matchesCatalogueFormat(["JSON, XML"], "xml"), true);
  assert.equal(matchesCatalogueFormat(["JSON, XML"], "pdf"), false);
});

test("missing format selection never treats recorded formats as missing", () => {
  assert.equal(matchesCatalogueFormat([], UNRECORDED_FORMAT), true);
  assert.equal(matchesCatalogueFormat([" "], UNRECORDED_FORMAT), true);
  assert.equal(matchesCatalogueFormat(["JSON"], UNRECORDED_FORMAT), false);
});

test("input and output combinations preserve direction for transformations", () => {
  const records = [
    { id: "json-to-xml", input: ["JSON"], output: ["XML"] },
    { id: "xml-to-json", input: ["XML"], output: ["JSON"] },
    { id: "multi-input", input: ["XML", "JSON"], output: ["XML"] },
    { id: "unknown-output", input: ["JSON"], output: [] },
  ];
  const match = (input: string, output: string) => records.filter((row) =>
    matchesCatalogueFormat(row.input, input) && matchesCatalogueFormat(row.output, output),
  ).map((row) => row.id);
  assert.deepEqual(match("json", "xml"), ["json-to-xml", "multi-input"]);
  assert.deepEqual(match("", "json"), ["xml-to-json"]);
  assert.deepEqual(match("json", UNRECORDED_FORMAT), ["unknown-output"]);
  assert.deepEqual(match("", ""), records.map((row) => row.id));
});
