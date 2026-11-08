import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOpenApiCandidate } from "../lib/import/category-classifier.ts";
import type { Candidate } from "../lib/import/types.ts";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    api_endpoint: "https://api.example.test/invoices/42",
    http_method: "POST",
    api_name: "Invoice operation",
    official_api_name: "invoiceOperation",
    description: "Performs an invoice operation.",
    company_name: "Example",
    input_formats: ["application/json"],
    output_formats: ["application/json"],
    authentication_raw: [],
    data_quality: "ok",
    warnings: [],
    ...overrides,
  };
}

test("an explicit capability tag is the highest-confidence signal", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_tags: ["Document Validation"],
    operation_summary: "Send invoice to a recipient",
  }));
  assert.equal(result.category, "Validation");
  assert.equal(result.communication_direction, "");
  assert.equal(result.confidence, "high");
  assert.ok(result.evidence.every((item) => item.source === "tag"));
});

test("camelCase operationId and summary classify validation and transformation", () => {
  assert.equal(classifyOpenApiCandidate(candidate({
    operation_id: "validateInvoiceSchema",
  })).category, "Validation");
  assert.equal(classifyOpenApiCandidate(candidate({
    operation_summary: "Convert invoice from UBL to JSON",
  })).category, "Transformation");
});

test("creation maps to Transformation because the controlled taxonomy has no Creation category", () => {
  assert.equal(classifyOpenApiCandidate(candidate({
    operation_id: "generateInvoice",
  })).category, "Transformation");
});

test("retrieving an invoice is Communication", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_id: "getInvoice",
  }));
  assert.equal(result.category, "Communication");
  assert.equal(result.communication_direction, "Receive");
});

test("a verb and invoice object split across summary and path can classify together", () => {
  assert.equal(classifyOpenApiCandidate(candidate({
    operation_summary: "Generate IRN",
    operation_path: "/Invoice",
  })).category, "Transformation");
});

test("known Polish operation terms remain classifiable without translating the document", () => {
  const receiving = classifyOpenApiCandidate(candidate({
    operation_summary: "Pobranie faktury",
  }));
  assert.equal(receiving.category, "Communication");
  assert.equal(receiving.communication_direction, "Receive");
  assert.equal(classifyOpenApiCandidate(candidate({
    operation_summary: "Walidacja dokumentu",
  })).category, "Validation");
});

test("a declared callback supports an explicit communication description", () => {
  const result = classifyOpenApiCandidate(candidate({
    has_callbacks: true,
    description: "Sends a delivery notification to the recipient.",
  }));
  assert.equal(result.category, "Communication");
  assert.equal(result.communication_direction, "Unspecified");
  assert.ok(result.evidence.some((item) => item.signal === "OpenAPI callbacks"));
});

test("a callback alone remains Other", () => {
  const result = classifyOpenApiCandidate(candidate({ has_callbacks: true }));
  assert.equal(result.category, "Other");
  assert.equal(result.communication_direction, "");
});

test("disjoint media types support an explicit transformation description", () => {
  const result = classifyOpenApiCandidate(candidate({
    description: "Formats the invoice document for the requested output.",
    input_formats: ["application/xml; charset=utf-8"],
    output_formats: ["application/pdf"],
  }));
  assert.equal(result.category, "Transformation");
});

test("different request and response media types alone remain Other", () => {
  const result = classifyOpenApiCandidate(candidate({
    input_formats: ["application/xml"],
    output_formats: ["application/json"],
  }));
  assert.equal(result.category, "Other");
});

test("overlapping media types do not claim format conversion", () => {
  const result = classifyOpenApiCandidate(candidate({
    input_formats: ["application/json", "application/xml"],
    output_formats: ["application/json", "application/pdf"],
  }));
  assert.equal(result.category, "Other");
});

test("a primary retrieval signal outweighs incidental description wording", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_id: "getInvoice",
    operation_summary: "Get invoice",
    operation_path: "/invoices/{id}",
    description: "The result may include validation and delivery status.",
  }));
  assert.equal(result.category, "Communication");
  assert.equal(result.communication_direction, "Receive");
});

test("description alone is supporting evidence and stays Other", () => {
  assert.equal(classifyOpenApiCandidate(candidate({
    operation_id: "processInvoice",
    operation_summary: "Process invoice",
    operation_path: "/invoices/{id}",
    description: "The result may include validation and delivery status.",
  })).category, "Other");
});

test("conflicting high-confidence operation signals fall back to Other", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_id: "validateInvoice",
    operation_summary: "Convert invoice format",
  }));
  assert.equal(result.category, "Other");
  assert.equal(result.confidence, "low");
});

test("conflicting category-bearing tags fall back to Other", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_tags: ["Communication", "Validation"],
  }));
  assert.equal(result.category, "Other");
  assert.equal(result.communication_direction, "");
});

test("explicit sending metadata sets the caller-facing Send direction", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_id: "sendInvoice",
    operation_summary: "Send an invoice to the delivery network",
    operation_path: "/outbound/invoices",
  }));
  assert.equal(result.category, "Communication");
  assert.equal(result.communication_direction, "Send");
});

test("explicit receiving metadata sets the caller-facing Receive direction", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_tags: ["Inbound invoices"],
    operation_id: "downloadInvoice",
  }));
  assert.equal(result.category, "Communication");
  assert.equal(result.communication_direction, "Receive");
});

test("generic Communication metadata leaves direction Unspecified", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_tags: ["Communication"],
    operation_id: "processInvoice",
    operation_summary: "Process invoice",
  }));
  assert.equal(result.category, "Communication");
  assert.equal(result.communication_direction, "Unspecified");
});

test("description direction is supporting evidence and cannot decide by itself", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_tags: ["Communication"],
    operation_id: "processInvoice",
    description: "Receives an invoice from a supplier.",
  }));
  assert.equal(result.category, "Communication");
  assert.equal(result.communication_direction, "Unspecified");
});

test("an explicitly bidirectional operation is Send and receive", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_id: "sendAndReceiveInvoices",
    operation_summary: "Send and receive invoices",
  }));
  assert.equal(result.category, "Communication");
  assert.equal(result.communication_direction, "Send and receive");
});

test("HTTP method alone never guesses Communication direction", () => {
  const post = classifyOpenApiCandidate(candidate({
    http_method: "POST",
    operation_id: "processInvoice",
  }));
  const get = classifyOpenApiCandidate(candidate({
    http_method: "GET",
    operation_id: "status",
  }));
  assert.equal(post.communication_direction, "");
  assert.equal(get.communication_direction, "");
});

test("a non-Communication result always clears directional evidence", () => {
  const result = classifyOpenApiCandidate(candidate({
    operation_tags: ["Validation"],
    operation_id: "receiveInvoice",
  }));
  assert.equal(result.category, "Validation");
  assert.equal(result.communication_direction, "");
});
