// Writing a set of schemas for one API to migration 0016's tables, through
// Supabase's REST endpoint with the server's key.
//
// Import, upload and backfill all write schemas the same way: insert the
// schema rows, pair the returned ids by identity, insert the field rows, and
// remove the schemas again if the fields cannot be written. It lives here once
// because three copies of a two-step write with a cleanup is how one of them
// comes to clean up differently from the others.

import type { ExtractedSchema } from "./extract.ts";
import type { ExtractedParameter } from "./parameters.ts";
import {
  schemaIdentity, toFieldRows, toParameterRows, toSchemaRows, type SchemaOrigin,
} from "./rows.ts";

export type RestConfig = { url: string; key: string; opaqueSecret: boolean };

export function restHeaders(config: RestConfig, write = false): Record<string, string> {
  const h: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) h.Authorization = `Bearer ${config.key}`;
  if (write) h["Content-Type"] = "application/json";
  return h;
}

export type WriteOutcome =
  | { ok: true; schemas: number; fields: number }
  | { ok: false; error: "schemas_not_recorded" | "schema_fields_not_recorded" | "schema_fields_partial" };

/**
 * Insert one API's schemas and their fields.
 *
 * Two requests, so not one transaction. If the fields fail after the schemas
 * were written, exactly the schemas this call created are deleted -- the
 * cascade takes any fields that did land -- so no schema is left without its
 * fields and nothing else the API already had is touched. If that deletion
 * fails as well the outcome says so; the rows left are derived data that a
 * later extraction or upload replaces.
 */
export async function writeSchemaSet(
  config: RestConfig,
  apiId: string,
  schemas: readonly ExtractedSchema[],
  origin: SchemaOrigin,
): Promise<WriteOutcome> {
  const rows = toSchemaRows(apiId, schemas, origin);
  if (rows.length === 0) return { ok: true, schemas: 0, fields: 0 };
  try {
    const res = await fetch(`${config.url}/rest/v1/api_schema?select=id,direction,status_code,media_type`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { ...restHeaders(config, true), Prefer: "return=representation" },
      body: JSON.stringify(rows),
    });
    if (!res.ok) return { ok: false, error: "schemas_not_recorded" };
    const created = (await res.json()) as {
      id: string; direction: string; status_code: string | null; media_type: string;
    }[];
    // Paired by the identity the database enforces, not by position:
    // nothing promises a bulk insert returns its rows in the order sent.
    const ids = new Map(created.map((c) => [schemaIdentity(c), c.id]));

    const fieldRows = toFieldRows(schemas, ids);
    if (fieldRows.length > 0) {
      const fieldsRecorded = await fetch(`${config.url}/rest/v1/api_schema_field`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: restHeaders(config, true),
        body: JSON.stringify(fieldRows),
      }).then((response) => response.ok).catch(() => false);
      if (!fieldsRecorded) {
        const undo = await fetch(
          `${config.url}/rest/v1/api_schema?id=in.(${created.map((c) => c.id).join(",")})`,
          { method: "DELETE", headers: restHeaders(config, true), signal: AbortSignal.timeout(30_000) },
        ).then((r) => r.ok).catch(() => false);
        return { ok: false, error: undo ? "schema_fields_not_recorded" : "schema_fields_partial" };
      }
    }
    return { ok: true, schemas: created.length, fields: fieldRows.length };
  } catch {
    return { ok: false, error: "schemas_not_recorded" };
  }
}

/**
 * Insert one operation's path/query parameters (migration 0017).
 *
 * Deliberately a separate call from writeSchemaSet rather than a step inside
 * it. A parameters-only operation has no schemas at all, so the two are not
 * two halves of one write, and a failure to record parameters must not undo
 * schemas that were written correctly: the outcome says which happened and
 * the caller reports it as a warning, the way import already treats a failed
 * schema write as additive.
 *
 * Existing parameters for the API are replaced, because a re-read of the same
 * document is the authority on what the operation declares now. That is a
 * delete and an insert, not one transaction; if the insert fails after the
 * delete the outcome says so.
 */
export async function writeParameterSet(
  config: RestConfig,
  apiId: string,
  parameters: readonly ExtractedParameter[],
  origin: SchemaOrigin,
): Promise<{ ok: true; parameters: number } | { ok: false; error: "parameters_not_recorded" | "parameters_lost" }> {
  const rows = toParameterRows(apiId, parameters, origin);
  try {
    const cleared = await fetch(`${config.url}/rest/v1/api_parameter?api_id=eq.${apiId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
      headers: restHeaders(config, true),
    }).then((r) => r.ok).catch(() => false);
    if (!cleared) return { ok: false, error: "parameters_not_recorded" };
    if (rows.length === 0) return { ok: true, parameters: 0 };
    const res = await fetch(`${config.url}/rest/v1/api_parameter`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: restHeaders(config, true),
      body: JSON.stringify(rows),
    });
    // The delete already happened, so a failure here leaves the operation
    // with none rather than with the old set: named separately so a report
    // can tell "nothing was written" from "what was there is gone".
    if (!res.ok) return { ok: false, error: "parameters_lost" };
    return { ok: true, parameters: rows.length };
  } catch {
    return { ok: false, error: "parameters_lost" };
  }
}
