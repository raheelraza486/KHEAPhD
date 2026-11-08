// Which catalogue records a fetched document can give schemas to. Pure: no
// network, no database, no clock.
//
// Records imported before schema extraction existed have no schemas. Their
// documentation is still where it was, so the schemas can be recovered by
// fetching it again -- the question this answers is which record gets which
// operation's schemas.
//
// Imported records use the same (api_endpoint, http_method) key as import.
// Older records have no method. They can still be recovered when their
// endpoint identifies exactly one operation in this document. Never choose a
// method by name, schema availability, or the order operations appear in.

import { operationKey } from "../import/session-candidates.ts";
import type { Candidate } from "../import/types.ts";
import type { DocumentSchemas, ExtractedSchema } from "./extract.ts";
import type { ExtractedParameter } from "./parameters.ts";
import { chainableSchemas, parametersForOperation, schemasForOperation } from "./rows.ts";

export type BackfillRow = { id: string; api_endpoint: string; http_method: string | null };

export type SkipReason =
  /** Already has schemas, extracted or uploaded. Backfill fills gaps; it replaces nothing. */
  | "has_schemas"
  /** The document no longer states this operation: it was renamed, moved or withdrawn. */
  | "not_in_document"
  /** Without a saved method, the endpoint identifies more than one operation. */
  | "ambiguous_operation"
  /**
   * The operation is there but states no input or output at all: no request
   * body, no success-response body, and no path/query parameters either.
   *
   * Before migration 0017 this also covered an operation whose whole input is
   * parameters -- a download such as GET /sales-invoice/xml?invoiceId=N --
   * which is an input, not the absence of one. Those are now filled.
   */
  | "no_schema_stated";

export type BackfillPlan = {
  fill: {
    api_id: string;
    schemas: ExtractedSchema[];
    /** The operation's path/query parameters; may be the only thing it states. */
    parameters: ExtractedParameter[];
    /** Evidence for reporting; filling schemas does not change catalogue metadata. */
    matched_http_method: string;
    match_basis: "operation_key" | "unique_endpoint" | "unique_endpoint_without_query"
      | "method_and_base_endpoint";
  }[];
  skipped: { api_id: string; reason: SkipReason }[];
};

type Operation = Pick<Candidate, "api_endpoint" | "http_method" | "operation_path">;

function endpointParts(endpoint: string): { full: string; base: string; hasQuery: boolean } | null {
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    // URL normalises host casing and default ports. Keep protocol, path casing,
    // trailing slashes and query values: any of them can distinguish endpoints.
    // Fragments are never sent to the API server.
    return { full: `${url.origin}${url.pathname}${url.search}`, base: `${url.origin}${url.pathname}`, hasQuery: !!url.search };
  } catch {
    return null;
  }
}

function distinctOperations(candidates: readonly Operation[]): Operation[] {
  const unique = new Map<string, Operation>();
  for (const candidate of candidates) {
    const key = JSON.stringify([
      endpointParts(candidate.api_endpoint)?.full ?? candidate.api_endpoint,
      candidate.http_method,
      candidate.operation_path,
    ]);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

/** A query string that names its parameters instead of giving them values. */
function hasQueryTemplate(endpoint: string): boolean {
  const query = endpoint.split("?")[1];
  return query !== undefined && /\{[^}]+\}/.test(query);
}

/**
 * A record whose saved endpoint carries a query *template*, matched on its
 * base path and its own method.
 *
 * 22 live records hold a query template inside api_endpoint --
 * `.../documentpackages/requests?pageNo={pageNo}&pageSize={pageSize}`,
 * `.../RequestDocs?mark={mark}&dateFrom={dateFrom}` -- because that is how
 * they were entered. An OpenAPI path never carries a query, so the exact
 * operation key cannot match one of these, and until now knowing the method
 * made a record *harder* to fill: it left the query-dropping path, which only
 * runs when the method is unknown.
 *
 * This is the stricter half of that rule. The method is known, so nothing has
 * to be chosen between GET and POST; only the query is dropped. A documented
 * operation that carries its own query at the same base path still refuses the
 * match, exactly as the method-less rule does -- a query the document states
 * is a discriminator, not noise.
 */
function matchMethodAndBase(row: BackfillRow, candidates: readonly Operation[]): {
  match?: Operation;
  ambiguous: boolean;
} {
  const endpoint = endpointParts(row.api_endpoint);
  if (!endpoint || !row.http_method) return { ambiguous: false };
  // Only a template. A concrete query (`?page=1`, `?op=FECompConsultar`) may
  // be the thing that distinguishes one operation from another at the same
  // path, and dropping it would be guessing; a template cannot distinguish
  // anything, because it names a parameter rather than choosing a value.
  if (!hasQueryTemplate(row.api_endpoint)) return { ambiguous: false };
  const method = row.http_method.toUpperCase();
  const sameBase = distinctOperations(candidates.filter((candidate) => {
    const parts = endpointParts(candidate.api_endpoint);
    return parts?.base === endpoint.base && candidate.http_method.toUpperCase() === method;
  }));
  if (sameBase.some((candidate) => endpointParts(candidate.api_endpoint)?.hasQuery)) {
    return { ambiguous: false };
  }
  if (sameBase.length > 1) return { ambiguous: true };
  return { match: sameBase[0], ambiguous: false };
}

function matchLegacyEndpoint(row: BackfillRow, candidates: readonly Operation[]): {
  matches: Operation[];
  basis: "unique_endpoint" | "unique_endpoint_without_query";
} {
  const endpoint = endpointParts(row.api_endpoint);
  if (!endpoint) return { matches: [], basis: "unique_endpoint" };
  const exact = distinctOperations(candidates.filter((c) => endpointParts(c.api_endpoint)?.full === endpoint.full));
  if (exact.length || !endpoint.hasQuery) return { matches: exact, basis: "unique_endpoint" };

  // OpenAPI paths omit query parameters. A legacy endpoint may include sample
  // values, but drop them only when a single operation is stated at this base
  // endpoint and that operation itself has no query. Never erase a documented
  // query discriminator or choose between GET/POST at the same path.
  const samePath = distinctOperations(candidates.filter((c) => endpointParts(c.api_endpoint)?.base === endpoint.base));
  if (samePath.length === 1 && endpointParts(samePath[0]!.api_endpoint)?.hasQuery) {
    return { matches: [], basis: "unique_endpoint_without_query" };
  }
  return { matches: samePath, basis: "unique_endpoint_without_query" };
}

export function planBackfill(
  rows: readonly BackfillRow[],
  candidates: readonly Operation[],
  documentSchemas: readonly DocumentSchemas[],
  withSchemas: ReadonlySet<string>,
): BackfillPlan {
  const byOperation = new Map(candidates.map((c) => [operationKey(c), c]));
  const plan: BackfillPlan = { fill: [], skipped: [] };
  for (const row of rows) {
    if (withSchemas.has(row.id)) {
      plan.skipped.push({ api_id: row.id, reason: "has_schemas" });
      continue;
    }
    let candidate: Operation | undefined;
    let matchBasis: BackfillPlan["fill"][number]["match_basis"] = "operation_key";
    if (row.http_method) {
      candidate = byOperation.get(operationKey({ api_endpoint: row.api_endpoint, http_method: row.http_method }));
      if (!candidate) {
        const fallback = matchMethodAndBase(row, candidates);
        if (fallback.ambiguous) {
          plan.skipped.push({ api_id: row.id, reason: "ambiguous_operation" });
          continue;
        }
        candidate = fallback.match;
        if (candidate) matchBasis = "method_and_base_endpoint";
      }
    } else {
      const { matches, basis } = matchLegacyEndpoint(row, candidates);
      if (matches.length > 1) {
        plan.skipped.push({ api_id: row.id, reason: "ambiguous_operation" });
        continue;
      }
      candidate = matches[0];
      matchBasis = basis;
    }
    if (!candidate) {
      plan.skipped.push({ api_id: row.id, reason: "not_in_document" });
      continue;
    }
    const schemas = chainableSchemas(schemasForOperation(candidate, documentSchemas));
    const parameters = parametersForOperation(candidate, documentSchemas);
    // Either one is an input worth storing. Requiring a body here is what
    // left the Serbian SEF downloads with nothing, although their document
    // states the query parameter they need perfectly clearly.
    if (schemas.length === 0 && parameters.length === 0) {
      plan.skipped.push({ api_id: row.id, reason: "no_schema_stated" });
      continue;
    }
    plan.fill.push({
      api_id: row.id, schemas, parameters,
      matched_http_method: candidate.http_method, match_basis: matchBasis,
    });
  }
  return plan;
}
