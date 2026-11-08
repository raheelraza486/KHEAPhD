// Companion to backfill-schemas.ts for NAV's official WADL with embedded XSD.
// Creates a reviewable plan only. The normal --apply path performs all DB writes.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { safeFetch } from "../lib/import/fetch.ts";
import { planBackfill } from "../lib/schema/backfill.ts";
import { flattenSchema, type DocumentSchemas } from "../lib/schema/extract.ts";
import { planDigest, planSummary, plannedSchemas, validatePlan, type BulkPlan, type BulkFill } from "../lib/schema/bulk-plan.ts";

const WADL = "https://raw.githubusercontent.com/nav-gov-hu/Online-Invoice/master/sample/WADL/application.wadl";
const README = "https://raw.githubusercontent.com/nav-gov-hu/Online-Invoice/master/README.md";
const TEST_ORIGIN = "https://api-test.onlineszamla.nav.gov.hu";
const PRODUCTION_ORIGIN = "https://api.onlineszamla.nav.gov.hu";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
type NavExtraction = {
  source_url: string;
  candidates: { api_endpoint: string; http_method: string; operation_path: string }[];
  documentSchemas: DocumentSchemas[];
};

export function buildNavPlan(base: BulkPlan, extracted: NavExtraction, wadl: string, readme: string, databaseUrl: string): BulkPlan {
  validatePlan(base, databaseUrl);
  // This is an explicit provider-specific environment mapping, never a generic
  // rule that treats arbitrary test/production hosts as interchangeable.
  if (extracted.source_url !== WADL || !readme.includes(`${TEST_ORIGIN}/`) || !readme.includes(`${PRODUCTION_ORIGIN}/`)) {
    throw new Error("The official NAV README must document both API environments.");
  }
  const rows = [...base.fill.map((item) => item.api), ...base.skipped.map((item) => item.api)].filter((api) => {
    try {
      const endpoint = new URL(api.api_endpoint);
      const documentation = new URL(api.documentation_url ?? "");
      return endpoint.origin === PRODUCTION_ORIGIN && endpoint.pathname.startsWith("/invoiceService/v3/")
        && documentation.origin === "https://github.com" && documentation.pathname.startsWith("/nav-gov-hu/Online-Invoice/");
    } catch { return false; }
  });
  const candidates = extracted.candidates.map((candidate) => {
    const url = new URL(candidate.api_endpoint);
    if (url.origin !== TEST_ORIGIN || !url.pathname.startsWith("/invoiceService/v3/") || candidate.http_method !== "POST") {
      throw new Error("The WADL contains an unexpected NAV endpoint.");
    }
    return { ...candidate, http_method: "POST" as const, api_endpoint: `${PRODUCTION_ORIGIN}${url.pathname}${url.search}` };
  });
  const evidence = `Production/test API environments are explicitly documented at ${README} (SHA256 ${hash(readme)}). The operation path and method are unchanged.`;
  const schemas = extracted.documentSchemas.map((operation) => ({ ...operation, schemas: operation.schemas.map((schema) => {
    const flattened = flattenSchema(schema.raw, {});
    return { ...schema, fields: flattened.fields, warnings: [...schema.warnings, ...flattened.warnings, evidence] };
  }) }));
  const matched = planBackfill(rows, candidates, schemas, new Set());
  const fill: BulkFill[] = matched.fill.map((item) => {
    const definitions = plannedSchemas(item.schemas);
    return { api: rows.find((api) => api.id === item.api_id)!, source_url: WADL, document_sha256: hash(wadl),
      matched_http_method: item.matched_http_method, match_basis: "documented_nav_environment_and_unique_endpoint",
      schemas: definitions, field_count: definitions.reduce((n, schema) => n + schema.fields.length, 0) };
  });
  const skipped = matched.skipped.map((item) => ({ api: rows.find((api) => api.id === item.api_id)!, reason: item.reason }));
  const documents = [{ source_url: "https://github.com/nav-gov-hu/Online-Invoice/blob/master/sample/WADL/application.wadl",
    fetched_at: new Date().toISOString(), api_ids: rows.map((api) => api.id), ok: true, format: "wadl_xsd",
    final_url: WADL, content_sha256: hash(wadl), candidate_count: candidates.length, warnings: [evidence],
    fetches: [{ url: WADL, final_url: WADL, content_sha256: hash(wadl) }, { url: README, final_url: README, content_sha256: hash(readme) }] }];
  const plan: BulkPlan = { version: 1, mode: "dry-run", created_at: new Date().toISOString(), database_fingerprint: base.database_fingerprint,
    scope: "active-nonduplicate", api_count: rows.length, documents, fill, skipped, summary: planSummary(fill, skipped, documents), plan_sha256: "" };
  plan.plan_sha256 = planDigest(plan);
  return validatePlan(plan, databaseUrl);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--from-plan" || args[2] !== "--plan") {
    throw new Error("Usage: node --env-file=.env.local scripts/plan-nav-schemas.ts --from-plan <bulk.plan.json> --plan <nav.plan.json> (requires PowerShell 7/pwsh)");
  }
  const databaseUrl = process.env.SUPABASE_URL?.trim();
  if (!databaseUrl) throw new Error("SUPABASE_URL is required to validate the plan's database identity.");
  const input = resolve(args[1]), output = resolve(args[3]);
  if (input === output) throw new Error("The NAV plan must not overwrite the original plan.");
  const base = validatePlan(JSON.parse(await readFile(input, "utf8")), databaseUrl);
  const [wadl, readme] = await Promise.all([safeFetch(WADL), safeFetch(README)]);
  if (!wadl.ok || !readme.ok) throw new Error("The official NAV WADL/README could not both be fetched.");
  const sources = resolve(dirname(output), "nav-sources");
  await mkdir(sources, { recursive: true });
  const wadlPath = resolve(sources, "application.wadl");
  await writeFile(wadlPath, wadl.body, "utf8");
  await writeFile(resolve(sources, "README.md"), readme.body, "utf8");
  const scriptPath = fileURLToPath(new URL("./extract-nav-wadl.ps1", import.meta.url));
  const { stdout } = await promisify(execFile)("pwsh", ["-NoProfile", "-NonInteractive", "-File", scriptPath, "-Path", wadlPath, "-SourceUrl", WADL], {
    windowsHide: true, timeout: 30_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8",
  });
  const plan = buildNavPlan(base, JSON.parse(stdout.replace(/^\uFEFF/, "")), wadl.body, readme.body, databaseUrl);
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(plan.summary, null, 2));
  console.log(`NAV dry-run plan: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "NAV planning failed."); process.exitCode = 1; });
}
