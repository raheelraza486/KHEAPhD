import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogCardSummary } from "../lib/catalog-card-summary.ts";
import { normalizeApiRecord } from "../lib/types.ts";

test("a body-less request still communicates its required URL values", () => {
  const summary = catalogCardSummary(normalizeApiRecord({ api_name: "convertToInvoice", api_endpoint: "https://example.test/documents/{id}/convert/invoice", input_formats: ["null"], output_formats: ["JSON"] }));
  assert.equal(summary.input, "ID in the URL; no request body");
  assert.equal(summary.output, "JSON");
});

test("a body-less operation without recorded path values asks users to check parameters", () => {
  const summary = catalogCardSummary(normalizeApiRecord({ api_endpoint: "https://example.test/invoices", input_formats: ["No request body"] }));
  assert.equal(summary.input, "No request body; check parameter details");
});

test("alternative request formats are retained rather than interpreted as always body-less", () => {
  const summary = catalogCardSummary(normalizeApiRecord({ input_formats: ["null", "JSON"], api_endpoint: "https://example.test/{accountId}/{invoiceId}" }));
  assert.equal(summary.input, "No request body / JSON; URL values: accountId, invoiceId");
});

test("the card promotes recorded purpose while retaining the actual usage conditions", () => {
  const record = normalizeApiRecord({ api_name: "INFast API convertToInvoice", description: "Converts a quotation to an invoice. This method returns the new invoice.", business_rules: ["Only ACCEPTED quotations can be converted; the resulting invoice is DRAFT."] });
  const summary = catalogCardSummary(record);
  assert.equal(summary.title, "Converts a quotation to an invoice");
  assert.deepEqual(summary.rules, record.business_rules);
});

test("missing information is not replaced with guessed requirements or responses", () => {
  const summary = catalogCardSummary(normalizeApiRecord({ api_name: "Example API" }));
  assert.equal(summary.title, "Example API");
  assert.equal(summary.input, "Input details not recorded");
  assert.equal(summary.output, "Response details not recorded");
  assert.deepEqual(summary.rules, []);
});

test("long source text falls back to the API name and additional rules remain accounted for", () => {
  const description = "A detailed source description ".repeat(5);
  const summary = catalogCardSummary(normalizeApiRecord({ api_name: "Example API", description, business_rules: ["First condition", "Second condition", "Third condition"] }));
  assert.equal(summary.title, "Example API");
  assert.equal(summary.description, description.trim());
  assert.equal(summary.moreRules, 1);
  assert.deepEqual(summary.rules, ["First condition", "Second condition"]);
});
