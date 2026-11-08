import { test } from "node:test";
import assert from "node:assert/strict";
import { toApiRow, type AliasMaps } from "../lib/import/candidate-record.ts";
import type { Candidate } from "../lib/import/types.ts";

const aliases: AliasMaps = {
  format: new Map([["application/json", "JSON"], ["application/xml", "XML"]]),
  provider: new Map([["ecosio", "Ecosio"], ["ecosio gmbh", "Ecosio"]]),
};

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    api_endpoint: "https://api.x.dev/v1/a",
    http_method: "POST",
    api_name: "X A",
    official_api_name: "opA",
    description: "d",
    company_name: "X",
    input_formats: ["application/json"],
    output_formats: ["application/json"],
    authentication_raw: ["http bearer"],
    data_quality: "ok",
    warnings: [],
    ...over,
  };
}

test("imported rows enter the Published review queue without claiming verification", () => {
  const row = toApiRow(candidate(), "https://doc/x", aliases);
  assert.equal(row.review_status, "Published");
  assert.equal(row.access_scope, "public");
});

test("formats are canonicalised through the alias map, originals preserved", () => {
  const row = toApiRow(
    candidate({ output_formats: ["application/json", "application/xml"] }),
    "https://doc/x",
    aliases,
  );
  assert.deepEqual(row.output_formats, ["JSON", "XML"]);
  assert.deepEqual(row.output_formats_original, ["application/json", "application/xml"]);
});

test("an explicit JSON to XML conversion overrides a JSON response wrapper", () => {
  const row = toApiRow(candidate({
    api_name: "Invoice conversion",
    description: "Converts UBL JSON invoices to UBL XML format.",
  }), "https://doc/x", aliases);
  assert.deepEqual(row.input_formats, ["JSON"]);
  assert.deepEqual(row.output_formats, ["XML"]);
  assert.deepEqual(row.output_formats_original, ["application/json"]);
});

test("an explicitly returned XML result outranks a JSON envelope", () => {
  const row = toApiRow(candidate({
    description: "Validates the invoice and returns the cleared XML with validation results.",
  }), "https://doc/x", aliases);
  assert.deepEqual(row.output_formats, ["XML"]);
});

test("incidental XML mentions and related endpoints do not change output format", () => {
  const validation = toApiRow(candidate({
    description: "Validates XML invoices and returns validation results.",
  }), "https://doc/x", aliases);
  assert.deepEqual(validation.output_formats, ["JSON"]);

  const related = toApiRow(candidate({
    description: "Returns platform invoice identifiers; related endpoints can retrieve XML.",
  }), "https://doc/x", aliases);
  assert.deepEqual(related.output_formats, ["JSON"]);

  const submissionContext = toApiRow(candidate({
    description: "Returns validation outcomes for an asynchronous ZIP submission.",
  }), "https://doc/x", aliases);
  assert.deepEqual(submissionContext.output_formats, ["JSON"]);

  const downloadLink = toApiRow(candidate({
    description: "Returns the export state and a time-limited ZIP download URL.",
  }), "https://doc/x", aliases);
  assert.deepEqual(downloadLink.output_formats, ["JSON"]);
});

test("a format the table does not know is passed through unchanged", () => {
  const row = toApiRow(candidate({ output_formats: ["application/pdf"] }), "https://doc/x", aliases);
  assert.deepEqual(row.output_formats, ["application/pdf"]);
});

test("provider spelling is canonicalised, original kept", () => {
  const row = toApiRow(candidate({ company_name: "ECOSIO GmbH" }), "https://doc/x", aliases);
  assert.equal(row.company_name, "Ecosio");
  assert.equal(row.company_name_original, "ECOSIO GmbH");
});

test("bearer auth -> Token; unknown single scheme -> Other with the raw value", () => {
  assert.equal(toApiRow(candidate({ authentication_raw: ["http bearer"] }), "d", aliases).authentication_method, "Token");
  const weird = toApiRow(candidate({ authentication_raw: ["quantum-handshake"] }), "d", aliases);
  assert.equal(weird.authentication_method, "Other");
  assert.equal(weird.authentication_other, "quantum-handshake");
});

test("more than one scheme -> Composite, listed in the other field", () => {
  const row = toApiRow(candidate({ authentication_raw: ["oauth2", "apiKey"] }), "d", aliases);
  assert.equal(row.authentication_method, "Composite");
  assert.match(row.authentication_other, /oauth2/);
});

test("no scheme -> None", () => {
  assert.equal(toApiRow(candidate({ authentication_raw: [] }), "d", aliases).authentication_method, "None");
});

test("category stays Other without a strong operation-level signal", () => {
  const row = toApiRow(candidate(), "https://doc/x", aliases);
  assert.equal(row.category, "Other");
  assert.equal(row.communication_direction, "");
});

test("a high-confidence OpenAPI operation signal is written as its controlled category", () => {
  const row = toApiRow(candidate({
    operation_tags: ["Invoice Transformation"],
  }), "https://doc/x", aliases);
  assert.equal(row.category, "Transformation");
  assert.equal(row.communication_direction, "");
});

test("a Communication row persists its inferred caller-facing direction", () => {
  const row = toApiRow(candidate({
    operation_id: "sendInvoice",
    operation_summary: "Send an invoice to the network",
  }), "https://doc/x", aliases);
  assert.equal(row.category, "Communication");
  assert.equal(row.communication_direction, "Send");
});

test("generic Communication metadata persists an Unspecified direction", () => {
  const row = toApiRow(candidate({
    operation_tags: ["Communication"],
  }), "https://doc/x", aliases);
  assert.equal(row.category, "Communication");
  assert.equal(row.communication_direction, "Unspecified");
});

test("http_method and endpoint carry through as the identity key parts", () => {
  const row = toApiRow(candidate({ http_method: "GET", api_endpoint: "https://api.x.dev/v1/b" }), "https://doc/x", aliases);
  assert.equal(row.http_method, "GET");
  assert.equal(row.api_endpoint, "https://api.x.dev/v1/b");
});
