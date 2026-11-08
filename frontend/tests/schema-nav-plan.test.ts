import assert from "node:assert/strict";
import test from "node:test";
import { buildNavPlan } from "../scripts/plan-nav-schemas.ts";
import { databaseFingerprint, planDigest, planSummary, type BulkPlan } from "../lib/schema/bulk-plan.ts";

const database = "https://database.example.test";
const documentation = "https://github.com/nav-gov-hu/Online-Invoice/blob/master/sample/WADL/application.wadl";
const source = "https://raw.githubusercontent.com/nav-gov-hu/Online-Invoice/master/sample/WADL/application.wadl";
const readme = "Test: https://api-test.onlineszamla.nav.gov.hu/ Production: https://api.onlineszamla.nav.gov.hu/";
function fixture() {
  const api = { id: "10000000-0000-4000-8000-000000000001", api_name: "NAV query", company_name: "NAV",
    api_endpoint: "https://api.onlineszamla.nav.gov.hu/invoiceService/v3/queryTransactionList", http_method: null,
    documentation_url: documentation, is_active: true, duplicate_of: null };
  const skipped = [{ api, reason: "unsupported_document" }];
  const base: BulkPlan = { version: 1, mode: "dry-run", created_at: "2026-09-12T00:00:00Z",
    database_fingerprint: databaseFingerprint(database), scope: "active-nonduplicate", api_count: 1,
    documents: [], fill: [], skipped, summary: planSummary([], skipped, []), plan_sha256: "" };
  base.plan_sha256 = planDigest(base);
  const extracted = { source_url: source,
    candidates: [{ api_endpoint: "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/queryTransactionList", http_method: "POST", operation_path: "/invoiceService/v3/queryTransactionList" }],
    documentSchemas: [{ operation_path: "/invoiceService/v3/queryTransactionList", http_method: "POST", schemas: [{
      direction: "response" as const, media_type: "application/xml", status_code: "default", fields: [], warnings: [],
      raw: { type: "object", xml_root: "QueryTransactionListResponse", properties: { transactionId: { type: "string" } } },
    }] }],
  };
  return { base, extracted };
}

test("NAV plan preserves catalogue identity, XML media/root, source evidence and derived fields", () => {
  const { base, extracted } = fixture();
  const result = buildNavPlan(base, extracted, "<application/>", readme, database);
  assert.equal(result.fill.length, 1);
  assert.deepEqual(result.fill[0].api, base.skipped[0].api);
  assert.equal(result.fill[0].schemas[0].media_type, "application/xml");
  assert.equal(result.fill[0].schemas[0].fields[0].path, "transactionId");
  assert.equal(result.fill[0].source_url, source);
  assert.equal(result.documents[0].fetches.length, 2);
  assert.match(result.fill[0].schemas[0].warnings[0], /README.md.*SHA256/);
});

test("NAV plan refuses unsupported environment/method evidence instead of broad host rewriting", () => {
  const { base, extracted } = fixture();
  assert.throws(() => buildNavPlan(base, extracted, "xml", "No environment evidence", database), /README/);
  const other = structuredClone(extracted);
  other.candidates[0].api_endpoint = "https://unrelated.example/invoiceService/v3/queryTransactionList";
  assert.throws(() => buildNavPlan(base, other, "xml", readme, database), /unexpected NAV endpoint/);
  const method = structuredClone(extracted); method.candidates[0].http_method = "DELETE";
  assert.throws(() => buildNavPlan(base, method, "xml", readme, database), /unexpected NAV endpoint/);
});

test("NAV plan never matches a different operation path", () => {
  const { base, extracted } = fixture();
  extracted.candidates[0].api_endpoint += "Other";
  const result = buildNavPlan(base, extracted, "xml", readme, database);
  assert.equal(result.fill.length, 0);
  assert.equal(result.skipped[0].reason, "not_in_document");
});
