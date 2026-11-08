import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCatalogueScope } from "../lib/import/catalogue-scope.ts";
import type { Candidate, ParseResult } from "../lib/import/types.ts";

function candidate(
  operationId: string,
  method: Candidate["http_method"],
  path: string,
  endpointHost = "api.infast.fr",
): Candidate {
  return {
    api_endpoint: `https://${endpointHost}/api/v2${path}`,
    http_method: method,
    api_name: `INFast API ${operationId}`,
    official_api_name: operationId,
    description: operationId,
    company_name: "Intia",
    operation_id: operationId,
    operation_summary: operationId,
    operation_path: path,
    operation_tags: ["Documents"],
    input_formats: [],
    output_formats: ["application/json"],
    authentication_raw: ["oauth2"],
    data_quality: "ok",
    warnings: [],
  };
}

function parsed(candidates: Candidate[], title = "INFast API"): ParseResult {
  return {
    candidates,
    info_title: title,
    info_version: "2.0.1",
    warnings: [],
  };
}

test("INFast import retains only reviewed invoice-document operations", () => {
  const all = [
    candidate("authenticate", "POST", "/oauth2/token"),
    candidate("listTransactionUsages", "GET", "/transaction-usages"),
    candidate("getTransactionUsage", "GET", "/transaction-usages/{id}"),
    candidate("listTransactions", "GET", "/transactions"),
    candidate("getTransaction", "GET", "/transactions/{id}"),
    candidate("getMe", "GET", "/me"),
    candidate("findItems", "GET", "/items"),
    candidate("createItem", "POST", "/items"),
    candidate("getItem", "GET", "/items/{id}"),
    candidate("deleteItem", "DELETE", "/items/{id}"),
    candidate("updateItem", "PATCH", "/items/{id}"),
    candidate("findCustomers", "GET", "/customers"),
    candidate("createCustomer", "POST", "/customers"),
    candidate("getCustomer", "GET", "/customers/{id}"),
    candidate("deleteCustomer", "DELETE", "/customers/{id}"),
    candidate("updateCustomer", "PATCH", "/customers/{id}"),
    candidate("listCustomerTransactions", "GET", "/customers/{id}/transactions"),
    candidate("findDocuments", "GET", "/documents"),
    candidate("createDocument", "POST", "/documents"),
    candidate("getDocument", "GET", "/documents/{id}"),
    candidate("deleteDocument", "DELETE", "/documents/{id}"),
    candidate("listDocumentTransactionUsages", "GET", "/documents/{id}/transaction-usages"),
    candidate("exportPdf", "GET", "/documents/{id}/pdf"),
    candidate("sendMessage", "POST", "/documents/{id}/messages"),
    candidate("acceptQuotation", "POST", "/documents/{id}/accept-quotation"),
    candidate("refuseQuotation", "POST", "/documents/{id}/refuse-quotation"),
    candidate("validateDocument", "POST", "/documents/{id}/validate"),
    candidate("convertToInvoice", "POST", "/documents/{id}/convert/invoice"),
    candidate("addPaymentOnInvoice", "POST", "/documents/{id}/payment"),
    candidate("getPortal", "GET", "/portal"),
    candidate("updatePortal", "PATCH", "/portal"),
    candidate("listWebhooks", "GET", "/webhooks"),
    candidate("createWebhook", "POST", "/webhooks"),
    candidate("getWebhook", "GET", "/webhooks/{id}"),
    candidate("deleteWebhook", "DELETE", "/webhooks/{id}"),
  ];

  const result = applyCatalogueScope(
    parsed(all),
    "https://doc.api.infast.fr/assets/files/openapi.json",
  );

  assert.deepEqual(
    result.candidates.map((item) => item.operation_id),
    [
      "findDocuments",
      "createDocument",
      "getDocument",
      "exportPdf",
      "validateDocument",
      "convertToInvoice",
    ],
  );
  assert.equal(result.excluded_count, 29);
  assert.equal(result.excluded_operations.length, 29);
  assert.deepEqual(result.excluded_operations[0], {
    api_endpoint: "https://api.infast.fr/api/v2/oauth2/token",
    http_method: "POST",
    operation_id: "authenticate",
    operation_path: "/oauth2/token",
    reason_code: "outside_catalogue_scope",
    rule_id: "infast_reviewed_scope_v1",
  });
  assert.match(result.warnings[0], /excluded 29 INFast operations/);
});

test("future INFast operations remain visible instead of being rejected by an allow-list", () => {
  const update = candidate("updateDocument", "PATCH", "/documents/{id}");
  const unrelated = candidate("futurePortalSetting", "POST", "/portal/settings");
  const result = applyCatalogueScope(
    parsed([update, unrelated]),
    "https://doc.api.infast.fr/openapi.json",
  );
  assert.deepEqual(
    result.candidates.map((item) => item.operation_id),
    ["updateDocument", "futurePortalSetting"],
  );
  assert.equal(result.excluded_count, 0);
  assert.deepEqual(result.excluded_operations, []);
});

test("INFast route and method still exclude a reviewed operation if operationId is absent", () => {
  const withoutId = candidate("", "GET", "/customers");
  const result = applyCatalogueScope(
    parsed([withoutId]),
    "https://doc.api.infast.fr/openapi.json",
  );
  assert.equal(result.candidates.length, 0);
  assert.equal(result.excluded_count, 1);
  assert.equal(result.excluded_operations[0].rule_id, "infast_reviewed_scope_v1");
});

test("the INFast boundary does not filter another provider with similar operation names", () => {
  const customers = candidate("findCustomers", "GET", "/customers", "api.other.test");
  const result = applyCatalogueScope(
    parsed([customers], "Another API"),
    "https://docs.other.test/openapi.json",
  );
  assert.deepEqual(result.candidates, [customers]);
  assert.equal(result.excluded_count, 0);
  assert.deepEqual(result.excluded_operations, []);
  assert.deepEqual(result.warnings, []);
});
