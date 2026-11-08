// Run from frontend, with the server environment loaded by Node:
//   pnpm schemas:backfill --plan .schema-backfill/recovery.plan.json
//   pnpm schemas:backfill --apply --from-plan .schema-backfill/recovery.plan.json --actor-user-id <admin UUID>
// A dry run only reads the database and public documentation. Applying a saved
// plan never fetches the outside documents again, never updates apis, and never
// replaces existing schema rows.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planBackfill } from "../lib/schema/backfill.ts";
import { buildSchemaCandidates } from "../lib/schema/document-candidates.ts";
import { planCatalogueRecovery, type RecoveryDocument } from "../lib/schema/catalogue-recovery.ts";
import { loadSchemaDocument } from "../lib/schema/document-loader.ts";
import { extractDocumentSchemas } from "../lib/schema/extract.ts";
import { restHeaders, writeSchemaSet, type RestConfig } from "../lib/schema/store.ts";
import {
  databaseFingerprint, groupDocuments, plannedSchemas, planDigest, planSummary, sameApiIdentity, validatePlan,
  type BulkApi, type BulkDocument, type BulkFill, type BulkPlan, type BulkSkip,
} from "../lib/schema/bulk-plan.ts";

const API_FIELDS = "id,api_name,company_name,api_endpoint,http_method,documentation_url,is_active,duplicate_of";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 500;

type Options = { apply: boolean; help: boolean; plan?: string; fromPlan?: string; report?: string; actorId?: string; concurrency: number };

export function parseOptions(args: readonly string[]): Options {
  const out: Options = { apply: false, help: false, concurrency: 4 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--apply") { out.apply = true; continue; }
    if (flag === "--dry-run") continue;
    if (flag === "--help" || flag === "-h") { out.help = true; continue; }
    if (!["--plan", "--from-plan", "--report", "--actor-user-id", "--concurrency"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--plan") out.plan = value;
    if (flag === "--from-plan") out.fromPlan = value;
    if (flag === "--report") out.report = value;
    if (flag === "--actor-user-id") out.actorId = value;
    if (flag === "--concurrency") out.concurrency = Number(value);
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 8) {
    throw new Error("--concurrency must be an integer between 1 and 8.");
  }
  if (out.help) return out;
  if (out.apply && args.includes("--dry-run")) throw new Error("Choose either --dry-run or --apply.");
  if (out.apply && (!out.fromPlan || !out.actorId || !UUID.test(out.actorId))) {
    throw new Error("--apply requires --from-plan and --actor-user-id with an active administrator UUID.");
  }
  if (out.apply && out.plan) throw new Error("--plan creates a dry-run plan; use --from-plan with --apply.");
  if (!out.apply && out.plan && out.report) throw new Error("Choose --plan or --report for the dry-run output path.");
  if (!out.apply && (out.fromPlan || out.actorId)) throw new Error("--from-plan and --actor-user-id are only used with --apply.");
  return out;
}

function configFromEnv(): RestConfig {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("SUPABASE_URL and a server secret/service-role key are required.");
  return { url, key, opaqueSecret: key.startsWith("sb_secret_") };
}

/** Continue until an empty page, including when PostgREST caps below our requested size. */
export async function readAll<T>(config: RestConfig, table: string, query: Record<string, string>): Promise<T[]> {
  const all: T[] = [];
  for (;;) {
    const response = await fetch(`${config.url}/rest/v1/${table}?${new URLSearchParams({
      ...query, order: "id.asc", offset: String(all.length), limit: String(PAGE_SIZE),
    })}`, { headers: restHeaders(config), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Database read failed for ${table} (HTTP ${response.status}).`);
    const page = await response.json() as T[];
    if (!Array.isArray(page)) throw new Error(`Database returned invalid rows for ${table}.`);
    if (page.length === 0) break;
    all.push(...page);
  }
  return all;
}

async function saveJson(path: string, value: unknown): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const staging = `${absolute}.tmp`;
  await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(staging, absolute);
}

async function mapLimit<T, R>(items: readonly T[], concurrency: number, visit: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await visit(items[index], index);
    }
  }));
  return results;
}

async function createPlan(config: RestConfig, options: Options): Promise<BulkPlan> {
  const [apis, existing] = await Promise.all([
    readAll<BulkApi>(config, "apis", { select: API_FIELDS, is_active: "eq.true", duplicate_of: "is.null" }),
    readAll<{ api_id: string }>(config, "api_schema", { select: "api_id" }),
  ]);
  const withSchemas = new Set(existing.map((row) => row.api_id));
  const hasGaps = apis.some((api) => !withSchemas.has(api.id));
  const skipped: BulkSkip[] = hasGaps ? [] : apis.map((api) => ({ api, reason: "has_schemas" }));
  // A document whose own APIs are covered can still explicitly describe an
  // uncovered API with a broken legacy link. Keep those documents available
  // for the conservative cross-document pass on repeated runs.
  const { groups, missing } = groupDocuments(hasGaps ? apis : []);
  skipped.push(...missing.map((api) => ({ api, reason: withSchemas.has(api.id) ? "has_schemas" : "no_documentation_url" })));
  console.log(`Dry run: ${apis.length} active APIs, ${withSchemas.size} APIs with schemas, ${groups.size} document groups.`);
  let finished = 0;
  const results = await mapLimit([...groups], options.concurrency, async ([url, rows], documentIndex) => {
    const fill: BulkFill[] = [];
    const groupSkipped: BulkSkip[] = rows.filter((row) => withSchemas.has(row.id)).map((api) => ({ api, reason: "has_schemas" }));
    const pending = rows.filter((row) => !withSchemas.has(row.id));
    let recoveryDocument: RecoveryDocument | undefined;
    let document: BulkDocument;
    try {
      const fetched = await loadSchemaDocument(url);
      const { document: _body, ...metadata } = fetched.ok ? fetched : { ...fetched, document: undefined };
      document = { ...metadata, api_ids: rows.map((row) => row.id) };
      if (!fetched.ok) {
        groupSkipped.push(...pending.map((api) => ({ api, reason: fetched.reason, detail: fetched.message })));
      } else {
        const candidates = buildSchemaCandidates(fetched.document, fetched.final_url);
        const extracted = extractDocumentSchemas(fetched.document);
        const plan = planBackfill(pending, candidates, extracted, withSchemas);
        recoveryDocument = { document_index: documentIndex, source_url: fetched.final_url,
          content_sha256: fetched.content_sha256, candidates, document_schemas: extracted };
        document.candidate_count = candidates.length;
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const item of plan.fill) {
          const schemas = plannedSchemas(item.schemas);
          if (schemas.length === 0) continue;
          const match = item as typeof item & { matched_http_method?: string; match_basis?: string };
          fill.push({ api: byId.get(item.api_id)!, source_url: fetched.final_url,
            document_sha256: fetched.content_sha256,
            matched_http_method: match.matched_http_method, match_basis: match.match_basis,
            schemas, field_count: schemas.reduce((n, schema) => n + schema.fields.length, 0) });
        }
        for (const item of plan.skipped) groupSkipped.push({ api: byId.get(item.api_id)!, reason: item.reason });
        // Every input is accounted for, including older planner versions that
        // omitted null-method rows entirely.
        const handled = new Set([...fill.map((item) => item.api.id), ...groupSkipped.map((item) => item.api.id)]);
        for (const api of rows) if (!handled.has(api.id)) groupSkipped.push({ api, reason: "operation_not_resolved" });
      }
    } catch {
      // Never put upstream response bodies or service credentials in a report.
      document = { source_url: url, api_ids: rows.map((row) => row.id), fetched_at: new Date().toISOString(),
        fetches: [], ok: false, reason: "document_processing_failed", message: "The document could not be fetched or parsed." };
      recoveryDocument = undefined;
      groupSkipped.push(...pending.map((api) => ({ api, reason: "document_processing_failed" })));
    }
    finished++;
    console.log(`Documents ${finished}/${groups.size}: ${fill.length} APIs planned, ${groupSkipped.length} skipped.`);
    return { document, fill, skipped: groupSkipped, recoveryDocument };
  });
  const documents = results.map((result) => result.document);
  const fill = results.flatMap((result) => result.fill);
  skipped.push(...results.flatMap((result) => result.skipped));
  const recovery = planCatalogueRecovery(skipped, results.flatMap((result) => result.recoveryDocument ? [result.recoveryDocument] : []));
  fill.push(...recovery.fill);
  for (const evidence of recovery.evidence) {
    const document = documents[evidence.document_index]!;
    if (!document.api_ids.includes(evidence.api_id)) document.api_ids.push(evidence.api_id);
    document.warnings = [...(document.warnings ?? []), evidence.warning];
  }
  console.log(`Cross-document recovery: ${recovery.fill.length} additional APIs matched to already fetched catalogue specifications.`);
  const plan: BulkPlan = {
    version: 1, mode: "dry-run", created_at: new Date().toISOString(), database_fingerprint: databaseFingerprint(config.url),
    scope: "active-nonduplicate", api_count: apis.length, documents, fill, skipped: recovery.skipped,
    summary: planSummary(fill, recovery.skipped, documents), plan_sha256: "",
  };
  plan.plan_sha256 = planDigest(plan);
  // Same validation on creation and application prevents a dry run that cannot
  // later be used, and detects any inconsistency in derived field data early.
  return validatePlan(plan, config.url);
}

type AppliedApi = {
  api_id: string; api_name: string; status: "written" | "skipped" | "failed";
  reason?: string; schemas?: number; fields?: number; audit_recorded?: boolean;
};

async function applyPlan(config: RestConfig, options: Options, reportPath: string) {
  const plan = validatePlan(JSON.parse(await readFile(resolve(options.fromPlan!), "utf8")), config.url);
  const [actor] = await readAll<{ id: string; display_name: string; role: string; is_active: boolean }>(config, "app_user", {
    select: "id,display_name,role,is_active", id: `eq.${options.actorId}`,
  });
  if (!actor || actor.role !== "admin" || !actor.is_active) throw new Error("The selected actor is not an active administrator.");
  const report = {
    version: 1, mode: "apply", started_at: new Date().toISOString(), finished_at: null as string | null,
    plan_path: resolve(options.fromPlan!), plan_sha256: plan.plan_sha256, database_fingerprint: plan.database_fingerprint,
    actor_user_id: actor.id, actor_name: actor.display_name, results: [] as AppliedApi[],
    summary: { written_apis: 0, skipped_apis: 0, failed_apis: 0, schemas: 0, fields: 0, audit_failures: 0 },
  };
  await saveJson(reportPath, report);
  for (const item of plan.fill) {
    const result: AppliedApi = { api_id: item.api.id, api_name: item.api.api_name, status: "failed" };
    try {
      const [current] = await readAll<BulkApi>(config, "apis", { select: API_FIELDS, id: `eq.${item.api.id}` });
      if (!current || !sameApiIdentity(item.api, current)) {
        result.status = "skipped"; result.reason = "api_changed_since_plan";
      } else {
        const existing = await readAll<{ id: string }>(config, "api_schema", { select: "id", api_id: `eq.${item.api.id}` });
        if (existing.length) {
          result.status = "skipped"; result.reason = "has_schemas";
        } else {
          const written = await writeSchemaSet(config, item.api.id, item.schemas, { kind: "extracted", sourceUrl: item.source_url });
          if (!written.ok) {
            result.reason = written.error;
          } else {
            result.status = "written"; result.schemas = written.schemas; result.fields = written.fields;
            const audit = await fetch(`${config.url}/rest/v1/api_audit_events`, {
              method: "POST", headers: restHeaders(config, true), signal: AbortSignal.timeout(30_000),
              body: JSON.stringify({
                api_id: item.api.id, api_name: current.api_name, company_name: current.company_name, action: "edit",
                actor_name: actor.display_name, actor_user_id: actor.id,
                details: `Automated bulk schema extraction: ${written.schemas} schemas, ${written.fields} fields. Source: ${item.source_url}. Document SHA256: ${item.document_sha256}. Plan SHA256: ${plan.plan_sha256}.`,
              }),
            }).then((response) => response.ok).catch(() => false);
            result.audit_recorded = audit;
            if (!audit) result.reason = "schemas_written_audit_failed";
          }
        }
      }
    } catch {
      result.reason = "database_operation_failed";
    }
    report.results.push(result);
    if (result.status === "written") {
      report.summary.written_apis++; report.summary.schemas += result.schemas ?? 0; report.summary.fields += result.fields ?? 0;
      if (!result.audit_recorded) report.summary.audit_failures++;
    } else if (result.status === "skipped") report.summary.skipped_apis++;
    else report.summary.failed_apis++;
    // Each completed API is durable in the local report. Restarting the same
    // plan rechecks the database and leaves already-written schemas alone.
    await saveJson(reportPath, report);
    console.log(`Apply ${report.results.length}/${plan.fill.length}: ${result.status}${result.reason ? ` (${result.reason})` : ""}.`);
  }
  report.finished_at = new Date().toISOString();
  await saveJson(reportPath, report);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Apply report: ${resolve(reportPath)}`);
  if (report.summary.failed_apis || report.summary.audit_failures) process.exitCode = 1;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(`Bulk schema recovery (dry run by default)
  node --env-file=.env.local scripts/backfill-schemas.ts --plan <file.json>
  node --env-file=.env.local scripts/backfill-schemas.ts --apply --from-plan <file.json> --actor-user-id <admin UUID> [--report <file.json>]
  --concurrency 1..8   Public-document fetch concurrency; default 4.

Plans include API identities, published raw schemas and fields, document URLs
and SHA256 hashes, and an explanation for every skipped API. Plans contain no
database keys. Failed documentation links may reuse another catalogue spec
fetched in the same run only when the exact operation and its schemas agree
across all matching documents. Sources and recovery warnings are recorded.
Apply verifies the plan and administrator, rechecks each API,
adds schemas only when it has none, and records an audit event. API records
are never changed. Unavailable/unsupported documentation is reported; schemas
are never invented. Reports default to the ignored .schema-backfill folder.`);
    return;
  }
  const config = configFromEnv();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (options.apply) {
    const report = options.report ?? `.schema-backfill/${stamp}.apply.json`;
    if (resolve(report) === resolve(options.fromPlan!)) throw new Error("The apply report must not overwrite the source plan.");
    await applyPlan(config, options, report);
  } else {
    const path = options.plan ?? options.report ?? `.schema-backfill/${stamp}.plan.json`;
    const plan = await createPlan(config, options);
    await saveJson(path, plan);
    console.log(JSON.stringify(plan.summary, null, 2));
    console.log(`Dry-run plan: ${resolve(path)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Bulk schema recovery failed.");
    process.exitCode = 1;
  });
}
