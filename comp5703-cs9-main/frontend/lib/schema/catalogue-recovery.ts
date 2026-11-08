// Recover a failed documentation link only from another catalogue document
// already fetched in this run. No guessed hosts, paths, methods or schemas.
import type { Candidate } from "../import/types.ts";
import { schemaContentHash, type DocumentSchemas } from "./extract.ts";
import { schemasForOperation } from "./rows.ts";
import { plannedSchemas, type BulkFill, type BulkSkip } from "./bulk-plan.ts";

type Operation = Pick<Candidate, "api_endpoint" | "http_method" | "operation_path">;
export type RecoveryDocument = {
  /** Index of the original fetched document in the bulk report. */
  document_index: number;
  source_url: string;
  content_sha256: string;
  candidates: readonly Operation[];
  document_schemas: readonly DocumentSchemas[];
};
export type RecoveryEvidence = { document_index: number; api_id: string; warning: string };

// Operation-level exclusions remain authoritative. In particular, an
// ambiguous/missing-schema operation must not be rescued by a more convenient
// document. Only a document that could not be loaded/understood is eligible.
const ELIGIBLE_REASONS = new Set([
  "unsupported_document", "spec_link_not_found", "requires_credentials", "unresolvable_host",
  "unreachable", "timeout", "too_large", "too_many_redirects", "document_processing_failed",
]);

function endpointParts(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return { full: `${url.origin}${url.pathname}${url.search}`, base: `${url.origin}${url.pathname}`, query: url.search };
  } catch { return null; }
}

/**
 * A full endpoint and method must identify one operation across every fetched
 * document. Repeated statements of that operation are accepted only when
 * every document states the same complete set of chainable schema identities
 * and raw-content hashes. Choose a stable source URL among identical copies.
 */
export function planCatalogueRecovery(
  skipped: readonly BulkSkip[], documents: readonly RecoveryDocument[],
): { fill: BulkFill[]; skipped: BulkSkip[]; evidence: RecoveryEvidence[] } {
  const entries = documents.flatMap((document) => document.candidates.map((candidate) => ({
    document, candidate, endpoint: endpointParts(candidate.api_endpoint),
  }))).filter((entry) => entry.endpoint !== null);
  const fill: BulkFill[] = [];
  const remaining: BulkSkip[] = [];
  const evidence: RecoveryEvidence[] = [];
  for (const skippedApi of skipped) {
    const api = skippedApi.api;
    const endpoint = endpointParts(api.api_endpoint);
    if (!ELIGIBLE_REASONS.has(skippedApi.reason) || !api.is_active || api.duplicate_of || !endpoint) {
      remaining.push(skippedApi); continue;
    }
    const eligible = entries.filter((entry) => !api.http_method || entry.candidate.http_method === api.http_method);
    let matches = eligible.filter((entry) => entry.endpoint!.full === endpoint.full);
    let queryFallback = false;
    if (!matches.length && endpoint.query) {
      matches = eligible.filter((entry) => entry.endpoint!.base === endpoint.base);
      queryFallback = true;
    }
    if (!matches.length) { remaining.push(skippedApi); continue; }
    const operations = new Set(matches.map((entry) => JSON.stringify([entry.endpoint!.full, entry.candidate.http_method])));
    if (operations.size !== 1) {
      remaining.push({ ...skippedApi, reason: "cross_document_ambiguous_operation",
        detail: `Original documentation outcome: ${skippedApi.reason}. Fetched catalogue documents declare multiple matching operations.` });
      continue;
    }
    if (queryFallback && matches.some((entry) => !!entry.endpoint!.query)) {
      // Never erase a query that the operation itself declares.
      remaining.push(skippedApi); continue;
    }
    const variants = matches.map((entry) => {
      const schemas = plannedSchemas(schemasForOperation(entry.candidate, entry.document.document_schemas));
      const signature = schemaContentHash(schemas.map((schema) => ({
        direction: schema.direction, status_code: schema.status_code, media_type: schema.media_type, content_hash: schema.content_hash,
      })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      return { ...entry, schemas, signature };
    });
    if (new Set(variants.map((variant) => variant.signature)).size !== 1) {
      remaining.push({ ...skippedApi, reason: "cross_document_schema_conflict",
        detail: `Original documentation outcome: ${skippedApi.reason}. Fetched documents disagree on this operation's schema definitions or available schema identities.` });
      continue;
    }
    const chosen = variants.sort((a, b) => a.document.source_url.localeCompare(b.document.source_url)
      || a.document.document_index - b.document.document_index)[0]!;
    if (!chosen.schemas.length) {
      remaining.push({ ...skippedApi, reason: "cross_document_no_schema_stated",
        detail: `Original documentation outcome: ${skippedApi.reason}. Other catalogue documents name this operation but state no chainable schema.` });
      continue;
    }
    const warning = `Cross-document recovery for API ${api.id}: its original documentation link (${api.documentation_url ?? ""}) returned ${skippedApi.reason}; ${chosen.document.source_url} explicitly declares ${chosen.candidate.http_method} ${chosen.candidate.api_endpoint}.`;
    const schemas = chosen.schemas.map((schema) => ({ ...schema, warnings: [...schema.warnings, warning] }));
    fill.push({ api, source_url: chosen.document.source_url, document_sha256: chosen.document.content_sha256,
      matched_http_method: chosen.candidate.http_method,
      match_basis: queryFallback ? "catalogue_document_unique_endpoint_without_query"
        : api.http_method ? "catalogue_document_operation_key" : "catalogue_document_unique_endpoint",
      schemas, field_count: schemas.reduce((n, schema) => n + schema.fields.length, 0) });
    evidence.push({ document_index: chosen.document.document_index, api_id: api.id, warning });
  }
  return { fill, skipped: remaining, evidence };
}
