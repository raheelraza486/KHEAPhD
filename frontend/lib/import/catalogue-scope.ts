// Provider-specific import boundaries for OpenAPI documents whose scope is
// broader than the public e-invoicing catalogue.
//
// These rules run after parsing and before preview/session storage. Excluded
// operations therefore cannot be selected by the browser or restored during
// confirmation. Rules are deliberately exact: a broad keyword filter would
// silently discard valid government and network APIs that use local-language
// or domain-specific operation names.

import type { Candidate, ImportScopeExclusion, ParseResult } from "./types.ts";

export type CatalogueScopeResult = ParseResult & {
  excluded_count: number;
  excluded_operations: ImportScopeExclusion[];
};

// These are reviewed exclusions from INFast's current specification. This is
// intentionally a deny-list, not an allow-list: a future INFast operation must
// remain visible for human review instead of being silently discarded merely
// because its new name is not known here.
const INFAST_EXCLUDED_OPERATION_IDS = new Set([
  "authenticate",
  "listTransactionUsages",
  "getTransactionUsage",
  "listTransactions",
  "getTransaction",
  "getMe",
  "findItems",
  "createItem",
  "getItem",
  "deleteItem",
  "updateItem",
  "findCustomers",
  "createCustomer",
  "getCustomer",
  "deleteCustomer",
  "updateCustomer",
  "listCustomerTransactions",
  "listDocumentTransactionUsages",
  "deleteDocument",
  "sendMessage",
  "acceptQuotation",
  "refuseQuotation",
  "addPaymentOnInvoice",
  "getPortal",
  "updatePortal",
  "listWebhooks",
  "createWebhook",
  "getWebhook",
  "deleteWebhook",
]);

// Route fallback for the reviewed exclusions, in case a later document omits
// an operationId while retaining the same operation. Method stays in the key
// because one path may contain both relevant and irrelevant methods.
const INFAST_EXCLUDED_OPERATIONS = new Set([
  "POST /oauth2/token",
  "GET /transaction-usages",
  "GET /transaction-usages/{id}",
  "GET /transactions",
  "GET /transactions/{id}",
  "GET /me",
  "GET /items",
  "POST /items",
  "GET /items/{id}",
  "DELETE /items/{id}",
  "PATCH /items/{id}",
  "GET /customers",
  "POST /customers",
  "GET /customers/{id}",
  "DELETE /customers/{id}",
  "PATCH /customers/{id}",
  "GET /customers/{id}/transactions",
  "GET /documents/{id}/transaction-usages",
  "DELETE /documents/{id}",
  "POST /documents/{id}/messages",
  "POST /documents/{id}/accept-quotation",
  "POST /documents/{id}/refuse-quotation",
  "POST /documents/{id}/payment",
  "GET /portal",
  "PATCH /portal",
  "GET /webhooks",
  "POST /webhooks",
  "GET /webhooks/{id}",
  "DELETE /webhooks/{id}",
]);

function hostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isInfastDocument(result: ParseResult, documentUrl: string): boolean {
  const officialDocumentHost = hostname(documentUrl) === "doc.api.infast.fr";
  const officialEndpoint = result.candidates.some(
    (candidate) => hostname(candidate.api_endpoint) === "api.infast.fr",
  );
  return result.info_title.trim().toLowerCase() === "infast api"
    && (officialDocumentHost || officialEndpoint);
}

function isExcludedInfastOperation(candidate: Candidate): boolean {
  if (INFAST_EXCLUDED_OPERATION_IDS.has(candidate.operation_id ?? "")) return true;
  const path = (candidate.operation_path ?? "").replace(/\/$/, "") || "/";
  return INFAST_EXCLUDED_OPERATIONS.has(`${candidate.http_method} ${path}`);
}

/**
 * Apply the catalogue's reviewed provider boundaries to parsed operations.
 * Providers without a reviewed rule are returned unchanged.
 */
export function applyCatalogueScope(
  result: ParseResult,
  documentUrl: string,
): CatalogueScopeResult {
  if (!isInfastDocument(result, documentUrl)) {
    return { ...result, excluded_count: 0, excluded_operations: [] };
  }

  const excluded = result.candidates.filter(isExcludedInfastOperation);
  const candidates = result.candidates.filter((candidate) => !isExcludedInfastOperation(candidate));
  const excludedCount = excluded.length;
  const warnings = [...result.warnings];
  if (excludedCount > 0) {
    warnings.push(
      `Catalogue scope rule excluded ${excludedCount} INFast operation${excludedCount === 1 ? "" : "s"}: `
      + "reviewed customer, item, quotation, account, payment, email, webhook and document-state administration are outside the catalogue's transformation, validation and communication scope. "
      + "Unknown future operations remain visible for review.",
    );
  }

  return {
    ...result,
    candidates,
    warnings,
    excluded_count: excludedCount,
    excluded_operations: excluded.map((candidate) => ({
      api_endpoint: candidate.api_endpoint,
      http_method: candidate.http_method,
      operation_id: candidate.operation_id ?? "",
      operation_path: candidate.operation_path ?? "",
      reason_code: "outside_catalogue_scope",
      rule_id: "infast_reviewed_scope_v1",
    })),
  };
}
