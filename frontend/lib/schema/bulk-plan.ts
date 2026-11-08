// File-backed plans make bulk recovery reviewable and repeatable. They contain
// published schemas and catalogue identities, never database credentials.
import { createHash } from "node:crypto";
import { schemaContentHash, flattenSchema, type ExtractedSchema } from "./extract.ts";
import { isChainable, schemaIdentity } from "./rows.ts";
import type { DocumentFetch } from "./document-loader.ts";

export type BulkApi = {
  id: string; api_name: string; company_name: string; api_endpoint: string;
  http_method: string | null; documentation_url: string | null;
  is_active: boolean; duplicate_of: string | null;
};

export type PlannedSchema = ExtractedSchema & { content_hash: string };
export type BulkFill = {
  api: BulkApi;
  source_url: string;
  document_sha256: string;
  matched_http_method?: string;
  match_basis?: string;
  schemas: PlannedSchema[];
  field_count: number;
};
export type BulkDocument = {
  source_url: string; fetched_at: string; api_ids: string[]; fetches: DocumentFetch[];
  ok: boolean; format?: string; final_url?: string; content_sha256?: string;
  reason?: string; message?: string; candidate_count?: number; warnings?: string[];
};
export type BulkSkip = { api: BulkApi; reason: string; detail?: string };
export type BulkPlan = {
  version: 1; mode: "dry-run"; created_at: string; database_fingerprint: string;
  scope: "active-nonduplicate"; api_count: number;
  documents: BulkDocument[]; fill: BulkFill[]; skipped: BulkSkip[];
  summary: ReturnType<typeof planSummary>;
  plan_sha256: string;
};

export function databaseFingerprint(url: string): string {
  return createHash("sha256").update(new URL(url).origin).digest("hex");
}

/** Ignore only a browser fragment; paths and queries may identify different specs. */
export function documentKey(url: string): string {
  try { const parsed = new URL(url.trim()); parsed.hash = ""; return parsed.toString(); }
  catch { return url.trim(); }
}

export function groupDocuments(rows: readonly BulkApi[]): { groups: Map<string, BulkApi[]>; missing: BulkApi[] } {
  const groups = new Map<string, BulkApi[]>();
  const missing: BulkApi[] = [];
  for (const row of rows) {
    if (!row.documentation_url?.trim()) { missing.push(row); continue; }
    const key = documentKey(row.documentation_url);
    const list = groups.get(key) ?? [];
    list.push(row); groups.set(key, list);
  }
  return { groups, missing };
}

export function plannedSchemas(schemas: readonly ExtractedSchema[]): PlannedSchema[] {
  const seen = new Set<string>();
  return schemas.filter(isChainable).filter((schema) => {
    const key = schemaIdentity(schema);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map((schema) => ({ ...schema, content_hash: schemaContentHash(schema.raw) }));
}

export function sameApiIdentity(before: BulkApi, now: BulkApi): boolean {
  return before.id === now.id && before.api_name === now.api_name && before.company_name === now.company_name
    && before.api_endpoint === now.api_endpoint && before.http_method === now.http_method
    && before.documentation_url === now.documentation_url && now.is_active && !now.duplicate_of;
}

export function planSummary(fill: readonly BulkFill[], skipped: readonly BulkSkip[], documents: readonly BulkDocument[]) {
  const reasons: Record<string, number> = {};
  for (const row of skipped) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  return {
    documents: documents.length, fetched_documents: documents.filter((d) => d.ok).length,
    failed_documents: documents.filter((d) => !d.ok).length,
    fill_apis: fill.length, schemas: fill.reduce((n, row) => n + row.schemas.length, 0),
    fields: fill.reduce((n, row) => n + row.field_count, 0), skipped_apis: skipped.length, skip_reasons: reasons,
  };
}

export function planDigest(plan: Omit<BulkPlan, "plan_sha256"> | BulkPlan): string {
  const { plan_sha256: _digest, ...content } = plan as BulkPlan;
  return schemaContentHash(content);
}

/** Refuse edited, partial, cross-database, or duplicate plans before any writes. */
export function validatePlan(value: unknown, databaseUrl: string): BulkPlan {
  if (!value || typeof value !== "object") throw new Error("The plan is not an object.");
  const plan = value as BulkPlan;
  if (plan.version !== 1 || plan.mode !== "dry-run" || plan.scope !== "active-nonduplicate"
    || !Array.isArray(plan.fill) || !Array.isArray(plan.skipped) || !Array.isArray(plan.documents)) {
    throw new Error("Unsupported or incomplete bulk schema plan.");
  }
  if (plan.plan_sha256 !== planDigest(plan)) throw new Error("The plan content hash does not match; create a new dry-run plan.");
  if (plan.database_fingerprint !== databaseFingerprint(databaseUrl)) throw new Error("The plan belongs to a different database.");
  const seen = new Set<string>();
  for (const item of plan.fill) {
    if (!item.api?.id || seen.has(item.api.id)) throw new Error("The plan contains duplicate or missing API identities.");
    seen.add(item.api.id);
    if (!item.api.is_active || item.api.duplicate_of || !item.schemas?.length) throw new Error("The plan contains an ineligible API.");
    const doc = plan.documents.find((d) => d.ok && d.final_url === item.source_url
      && d.content_sha256 === item.document_sha256 && d.api_ids.includes(item.api.id));
    if (!doc) throw new Error("A planned API has no matching fetched document provenance.");
    const identities = new Set<string>();
    for (const schema of item.schemas) {
      if ((schema.direction !== "request" && schema.direction !== "response") || !schema.media_type
        || !isChainable(schema) || schema.content_hash !== schemaContentHash(schema.raw)) {
        throw new Error("A planned schema has invalid content or identity.");
      }
      const identity = schemaIdentity(schema);
      if (identities.has(identity)) throw new Error("A planned API has duplicate schema identities.");
      identities.add(identity);
      // Compare derived fields too: --from-plan writes exactly what was reviewed.
      if (schemaContentHash(schema.fields) !== schemaContentHash(flattenSchema(schema.raw, {}).fields)) {
        throw new Error("Planned fields do not agree with the saved schema.");
      }
    }
  }
  return plan;
}
