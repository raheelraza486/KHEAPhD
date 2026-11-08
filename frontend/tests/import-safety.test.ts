import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGeneralImportScope,
  candidateHasEInvoiceEvidence,
  documentHasEInvoiceEvidence,
  MAX_CONFIRM_OPERATIONS,
  MAX_PARSED_OPERATIONS,
  MAX_PREVIEW_SESSION_BYTES,
  utf8Bytes,
} from "../lib/import/import-safety.ts";
import type { ApiCategory } from "../lib/types.ts";
import type { Candidate } from "../lib/import/types.ts";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    api_endpoint: "https://api.example.test/v1/operation",
    http_method: "POST",
    api_name: "Example operation",
    official_api_name: "exampleOperation",
    description: "Processes a payload.",
    company_name: "Example",
    operation_id: "exampleOperation",
    operation_summary: "Process payload",
    operation_path: "/operation",
    operation_tags: [],
    input_formats: ["application/json"],
    output_formats: ["application/json"],
    authentication_raw: [],
    data_quality: "ok",
    warnings: [],
    ...overrides,
  };
}

function item(category: ApiCategory, overrides: Partial<Candidate> = {}) {
  return { candidate: candidate(overrides), row: { category } };
}

test("an unrelated OpenAPI operation is excluded even if it resembles communication", () => {
  const result = applyGeneralImportScope(
    [item("Communication", {
      operation_id: "downloadPetFile",
      operation_summary: "Download pet file",
      operation_path: "/pets/{id}/file",
    })],
    { info: { title: "Swagger Petstore" }, components: { schemas: { Pet: {} } } },
  );
  assert.equal(result.items.length, 0);
  assert.equal(result.excluded_count, 1);
  assert.equal(result.excluded_operations[0].reason_code, "outside_catalogue_scope");
  assert.equal(result.excluded_operations[0].rule_id, "general_einvoice_evidence_v1");
  assert.match(result.warnings[0], /without explicit e-invoicing/);
});

test("Other is excluded even when the operation changes an invoice", () => {
  const result = applyGeneralImportScope(
    [item("Other", { operation_id: "cancelInvoice", operation_path: "/invoices/{id}/cancel" })],
    { info: { title: "E-Invoice API" } },
  );
  assert.equal(result.items.length, 0);
  assert.equal(result.excluded_count, 1);
  assert.equal(result.excluded_operations[0].reason_code, "unsupported_catalogue_category");
  assert.equal(result.excluded_operations[0].rule_id, "general_capability_scope_v1");
  assert.match(result.warnings[0], /outside Communication, Transformation and Validation/);
});

test("the three catalogue capabilities survive when the document has invoice evidence", () => {
  const items = [
    item("Communication"),
    item("Transformation"),
    item("Validation"),
  ];
  const result = applyGeneralImportScope(items, {
    info: { title: "Government document gateway" },
    components: { schemas: { InvoiceSubmission: {}, InvoiceResponse: {} } },
  });
  assert.deepEqual(result.items, items);
  assert.equal(result.excluded_count, 0);
  assert.deepEqual(result.excluded_operations, []);
});

test("national and fiscalisation terms provide positive evidence", () => {
  assert.equal(documentHasEInvoiceEvidence({ info: { title: "KSeF API" } }), true);
  assert.equal(documentHasEInvoiceEvidence({ info: { title: "RRA EBM service" } }), true);
  assert.equal(candidateHasEInvoiceEvidence(candidate({ api_name: "Invio FatturaPA" })), true);
});

test("payload examples do not make an unrelated document relevant", () => {
  assert.equal(documentHasEInvoiceEvidence({
    info: { title: "Generic storage API" },
    components: { schemas: { Payload: { example: { type: "invoice" } } } },
  }), false);
});

test("resource ceilings are finite and byte counting is UTF-8 aware", () => {
  assert.equal(MAX_PARSED_OPERATIONS, 200);
  assert.equal(MAX_CONFIRM_OPERATIONS, 100);
  assert.equal(MAX_PREVIEW_SESSION_BYTES, 2 * 1024 * 1024);
  assert.equal(utf8Bytes("发票"), 6);
});
