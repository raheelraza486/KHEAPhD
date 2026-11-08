import assert from "node:assert/strict";
import test from "node:test";
import { buildSchemaCandidates } from "../lib/schema/document-candidates.ts";
import { extractDocumentSchemas } from "../lib/schema/extract.ts";
import { planCatalogueRecovery, type RecoveryDocument } from "../lib/schema/catalogue-recovery.ts";
import type { BulkApi, BulkSkip } from "../lib/schema/bulk-plan.ts";

const api: BulkApi = {
  id: "10000000-0000-4000-8000-000000000001", api_name: "Invoice API", company_name: "Provider",
  api_endpoint: "https://portal.example.test/invoices", http_method: null,
  documentation_url: "https://docs.example.test/legacy-manual.pdf", is_active: true, duplicate_of: null,
};
const failed: BulkSkip = { api, reason: "unsupported_document", detail: "PDF document" };

function document(options: { index?: number; url?: string; method?: string; type?: string; noSchema?: boolean; endpoint?: string } = {}): RecoveryDocument {
  const endpoint = new URL(options.endpoint ?? api.api_endpoint);
  const doc = {
    openapi: "3.0.3", info: { title: "Published", version: "1" }, servers: [{ url: endpoint.origin }],
    paths: { [endpoint.pathname]: { [options.method ?? "post"]: {
      responses: { "200": { description: "Accepted", ...(options.noSchema ? {} : { content: {
        "application/json": { schema: { type: "object", properties: { invoiceId: { type: options.type ?? "string" } } } },
      } }) } },
    } } },
  };
  const url = options.url ?? "https://docs.example.test/openapi.json";
  return { document_index: options.index ?? 0, source_url: url, content_sha256: "body-sha256",
    candidates: buildSchemaCandidates(doc, url), document_schemas: extractDocumentSchemas(doc) };
}

test("an unavailable original document can reuse one exact operation from an already-fetched catalogue spec", () => {
  const result = planCatalogueRecovery([failed], [document()]);
  assert.equal(result.fill.length, 1);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.fill[0]!.api, api, "retain the original API snapshot and documentation URL");
  assert.equal(result.fill[0]!.source_url, "https://docs.example.test/openapi.json");
  assert.equal(result.fill[0]!.document_sha256, "body-sha256");
  assert.equal(result.fill[0]!.matched_http_method, "POST");
  assert.equal(result.fill[0]!.match_basis, "catalogue_document_unique_endpoint");
  assert.equal(result.evidence[0]!.api_id, api.id);
  assert.equal(result.evidence[0]!.document_index, 0);
  assert.match(result.evidence[0]!.warning, /Cross-document recovery/);
  assert.match(result.fill[0]!.schemas[0]!.warnings.at(-1)!, /legacy-manual\.pdf/);
});

test("recovery never guesses another host, path case or trailing slash", () => {
  for (const endpoint of ["https://other.example.test/invoices", "https://portal.example.test/Invoices", "https://portal.example.test/invoices/"]) {
    const result = planCatalogueRecovery([failed], [document({ endpoint })]);
    assert.deepEqual(result, { fill: [], skipped: [failed], evidence: [] });
  }
});

test("different methods across documents are ambiguous even when one does not have schemas", () => {
  const result = planCatalogueRecovery([failed], [document(), document({ index: 1, method: "get", noSchema: true })]);
  assert.equal(result.fill.length, 0);
  assert.equal(result.skipped[0]!.reason, "cross_document_ambiguous_operation");
});

test("a saved method disambiguates operations without guessing or modifying it", () => {
  const known = { ...failed, api: { ...api, http_method: "POST" } };
  const result = planCatalogueRecovery([known], [document(), document({ index: 1, method: "get", noSchema: true })]);
  assert.equal(result.fill.length, 1);
  assert.equal(result.fill[0]!.matched_http_method, "POST");
  assert.equal(result.fill[0]!.match_basis, "catalogue_document_operation_key");
});

test("conflicting raw schemas or differing schema availability forbid choosing a convenient document", () => {
  for (const other of [document({ index: 1, type: "integer" }), document({ index: 1, noSchema: true })]) {
    const result = planCatalogueRecovery([failed], [document(), other]);
    assert.equal(result.fill.length, 0);
    assert.equal(result.skipped[0]!.reason, "cross_document_schema_conflict");
  }
});

test("identical definitions across documents share one stable canonical provenance source", () => {
  const a = document({ index: 1, url: "https://docs.example.test/a.json" });
  const z = document({ index: 0, url: "https://docs.example.test/z.json" });
  for (const order of [[a, z], [z, a]]) {
    const result = planCatalogueRecovery([failed], order);
    assert.equal(result.fill.length, 1);
    assert.equal(result.fill[0]!.source_url, a.source_url);
    assert.equal(result.evidence[0]!.document_index, 1);
  }
});

test("existing schemas and authoritative operation-level skip reasons cannot be overridden", () => {
  const skipped = ["has_schemas", "no_schema_stated", "ambiguous_operation", "not_in_document", "no_documentation_url"]
    .map((reason) => ({ ...failed, reason }));
  const result = planCatalogueRecovery(skipped, [document()]);
  assert.deepEqual(result, { fill: [], skipped, evidence: [] });
});

test("sample query values may be removed only for one unique query-free operation across all documents", () => {
  const sampleQuery = { ...failed, api: { ...api, api_endpoint: `${api.api_endpoint}?page=1` } };
  const result = planCatalogueRecovery([sampleQuery], [document()]);
  assert.equal(result.fill.length, 1);
  assert.equal(result.fill[0]!.match_basis, "catalogue_document_unique_endpoint_without_query");
  const ambiguous = planCatalogueRecovery([sampleQuery], [document(), document({ index: 1, method: "get" })]);
  assert.equal(ambiguous.fill.length, 0);
  assert.equal(ambiguous.skipped[0]!.reason, "cross_document_ambiguous_operation");
  const specificQuery = document();
  specificQuery.candidates = specificQuery.candidates.map((candidate) => ({ ...candidate, api_endpoint: `${candidate.api_endpoint}?mode=fixed` }));
  assert.equal(planCatalogueRecovery([sampleQuery], [specificQuery]).fill.length, 0);
});

test("successfully fetched documents with no schemas cannot manufacture a recovery", () => {
  const result = planCatalogueRecovery([failed], [document({ noSchema: true })]);
  assert.equal(result.fill.length, 0);
  assert.equal(result.skipped[0]!.reason, "cross_document_no_schema_stated");
});
