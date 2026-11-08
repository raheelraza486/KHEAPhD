// Generic safety gates for URL imports. These limits and scope checks run
// before a preview session is stored, so an arbitrary or oversized OpenAPI
// document cannot turn into an unbounded jsonb row or a bulk catalogue write.

import type { ApiCategory } from "../types.ts";
import type { Candidate, ImportScopeExclusion } from "./types.ts";

export const MAX_PARSED_OPERATIONS = 200;
export const MAX_PREVIEW_SESSION_BYTES = 2 * 1024 * 1024;
export const MAX_CONFIRM_OPERATIONS = 100;

const CATALOGUE_CATEGORIES = new Set<ApiCategory>([
  "Communication",
  "Transformation",
  "Validation",
]);

// Positive domain evidence, not a provider or operation allow-list. The
// catalogue spans local languages and national systems, so this deliberately
// recognises common invoice terms, standards and fiscalisation platforms.
// Generic words such as "document", "file" and "transaction" are excluded:
// by themselves they do not establish e-invoicing relevance.
const E_INVOICE_EVIDENCE = /(?:\be[-\s]?invoic(?:e|es|ing)\b|\binvoic(?:e|es|ing)\b|\btax[\s-]?invoice\b|\bcredit[\s-]?note\b|\bdebit[\s-]?note\b|\bfactur(?:a|as|ae|e|es|ation)\b|\bfaktur(?:a|y|en)?\b|\bfattur(?:a|e|azione)\b|\bfatura(?:s)?\b|\bfactuur\b|\btimolog(?:io|ia)\b|\bubl\b|\bpeppol\b|\ben[\s-]?16931\b|\bcfdi\b|\bksef\b|\bmydata\b|\bnf[\s-]?e\b|\bnfe\b|\bfatoora\b|\bzatca\b|\bmyinvois\b|\befaktura\b|\bfacturae\b|\bxrechnung\b|\bzugferd\b|\bebm\b|\bvsdc\b|\bsmart[\s-]?invoice\b|\bfiscal(?:i[sz](?:e|ed|es|ing|ation))?\b|\bfiscal[\s-]?receipt\b|\birn\b|\bgstn\b|\bsdi\b|\bcpe\b)/i;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function searchableEvidence(values: readonly string[]): string {
  const original = values.join(" ");
  const tokenised = original
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_/.:]+/g, " ");
  return `${original} ${tokenised}`;
}

/** Evidence from document-level metadata and schema names only. Examples and
 * arbitrary payload values are intentionally ignored to avoid a stray invoice
 * example admitting an unrelated API. */
export function documentHasEInvoiceEvidence(document: unknown): boolean {
  const root = objectValue(document);
  if (!root) return false;
  const info = objectValue(root.info);
  const tags = Array.isArray(root.tags) ? root.tags : [];
  const components = objectValue(root.components);
  const schemas = objectValue(components?.schemas);
  const definitions = objectValue(root.definitions);
  const externalDocs = objectValue(root.externalDocs);

  const evidence = searchableEvidence([
    text(info?.title),
    text(info?.description),
    text(externalDocs?.description),
    text(externalDocs?.url),
    ...tags.flatMap((tag) => {
      const item = objectValue(tag);
      return item ? [text(item.name), text(item.description)] : [];
    }),
    ...Object.keys(schemas ?? {}),
    ...Object.keys(definitions ?? {}),
  ]);

  return E_INVOICE_EVIDENCE.test(evidence);
}

export function candidateHasEInvoiceEvidence(candidate: Candidate): boolean {
  return E_INVOICE_EVIDENCE.test(searchableEvidence([
    candidate.api_name,
    candidate.official_api_name,
    candidate.description,
    candidate.api_endpoint,
    candidate.operation_id ?? "",
    candidate.operation_summary ?? "",
    candidate.operation_path ?? "",
    ...(candidate.operation_tags ?? []),
  ]));
}

type ClassifiedCandidate = {
  candidate: Candidate;
  row: { category: ApiCategory };
};

export type GeneralScopeResult<T> = {
  items: T[];
  excluded_count: number;
  excluded_operations: ImportScopeExclusion[];
  warnings: string[];
};

/** Keep only operations inside the catalogue's three capabilities and with
 * positive e-invoicing evidence. Unknown/Other operations never become a
 * selectable or stored preview candidate. */
export function applyGeneralImportScope<T extends ClassifiedCandidate>(
  items: readonly T[],
  document: unknown,
): GeneralScopeResult<T> {
  const documentIsRelevant = documentHasEInvoiceEvidence(document);
  let unsupportedCategoryCount = 0;
  let unrelatedCount = 0;
  const kept: T[] = [];
  const excludedOperations: ImportScopeExclusion[] = [];

  for (const item of items) {
    if (!CATALOGUE_CATEGORIES.has(item.row.category)) {
      unsupportedCategoryCount++;
      excludedOperations.push({
        api_endpoint: item.candidate.api_endpoint,
        http_method: item.candidate.http_method,
        operation_id: item.candidate.operation_id ?? "",
        operation_path: item.candidate.operation_path ?? "",
        reason_code: "unsupported_catalogue_category",
        rule_id: "general_capability_scope_v1",
      });
      continue;
    }
    if (!documentIsRelevant && !candidateHasEInvoiceEvidence(item.candidate)) {
      unrelatedCount++;
      excludedOperations.push({
        api_endpoint: item.candidate.api_endpoint,
        http_method: item.candidate.http_method,
        operation_id: item.candidate.operation_id ?? "",
        operation_path: item.candidate.operation_path ?? "",
        reason_code: "outside_catalogue_scope",
        rule_id: "general_einvoice_evidence_v1",
      });
      continue;
    }
    kept.push(item);
  }

  const warnings: string[] = [];
  if (unsupportedCategoryCount > 0) {
    warnings.push(
      `General catalogue rule excluded ${unsupportedCategoryCount} operation${unsupportedCategoryCount === 1 ? "" : "s"} outside Communication, Transformation and Validation.`,
    );
  }
  if (unrelatedCount > 0) {
    warnings.push(
      `General catalogue rule excluded ${unrelatedCount} operation${unrelatedCount === 1 ? "" : "s"} without explicit e-invoicing or fiscal-document evidence.`,
    );
  }

  return {
    items: kept,
    excluded_count: unsupportedCategoryCount + unrelatedCount,
    excluded_operations: excludedOperations,
    warnings,
  };
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
