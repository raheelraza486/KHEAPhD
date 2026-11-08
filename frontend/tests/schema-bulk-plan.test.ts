import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, unlink, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  databaseFingerprint, documentKey, groupDocuments, plannedSchemas, planDigest, planSummary,
  sameApiIdentity, validatePlan, type BulkApi, type BulkPlan,
} from "../lib/schema/bulk-plan.ts";
import { extractDocumentSchemas } from "../lib/schema/extract.ts";
import { main, parseOptions, readAll } from "../scripts/backfill-schemas.ts";

const DATABASE = "https://database.example.test";
const SOURCE = "https://docs.example.test/openapi.json";
const poland = JSON.parse(readFileSync(new URL("./fixtures/poland-ksef.json", import.meta.url), "utf8"));
const extracted = extractDocumentSchemas(poland);
const api: BulkApi = {
  id: "10000000-0000-4000-8000-000000000001", api_name: "Recorded API", company_name: "Provider",
  api_endpoint: "https://api.example.test/invoices", http_method: null, documentation_url: SOURCE,
  is_active: true, duplicate_of: null,
};

function fixturePlan(): BulkPlan {
  const schemas = plannedSchemas(extracted.find((item) => plannedSchemas(item.schemas).length > 0)!.schemas);
  const fill = [{ api, source_url: SOURCE, document_sha256: "document-body-hash", schemas,
    field_count: schemas.reduce((n, item) => n + item.fields.length, 0) }];
  const documents = [{ source_url: SOURCE, fetched_at: "2026-09-12T00:00:00Z", api_ids: [api.id], fetches: [],
    ok: true, format: "openapi_3", final_url: SOURCE, content_sha256: "document-body-hash" }];
  const plan: BulkPlan = { version: 1, mode: "dry-run", created_at: "2026-09-12T00:00:00Z",
    database_fingerprint: databaseFingerprint(DATABASE), scope: "active-nonduplicate", api_count: 1,
    documents, fill, skipped: [], summary: planSummary(fill, [], documents), plan_sha256: "" };
  plan.plan_sha256 = planDigest(plan);
  return plan;
}

test("group document fragments together while preserving query-specific specs and missing links", () => {
  const rows = [api, { ...api, id: "two", documentation_url: `${SOURCE}#tag` },
    { ...api, id: "three", documentation_url: `${SOURCE}?version=2` }, { ...api, id: "missing", documentation_url: "" }];
  const result = groupDocuments(rows);
  assert.equal(result.groups.size, 2);
  assert.deepEqual(result.groups.get(SOURCE)?.map((row) => row.id), [api.id, "two"]);
  assert.equal(result.missing[0]?.id, "missing");
  assert.equal(documentKey("https://EXAMPLE.test:443/spec#tag"), "https://example.test/spec");
});

test("saved plan round trip validates provenance, schema content and derived fields", () => {
  const plan = fixturePlan();
  assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(plan)), DATABASE), plan);
});

test("every real Poland schema planned for storage re-derives the same fields", () => {
  for (const operation of extracted) {
    const schemas = plannedSchemas(operation.schemas);
    if (!schemas.length) continue;
    const plan = fixturePlan();
    plan.fill[0]!.schemas = schemas;
    plan.plan_sha256 = planDigest(plan);
    assert.doesNotThrow(() => validatePlan(plan, DATABASE), operation.operation_path);
  }
});

test("plan validation rejects changed content, cross-database use and mismatched source provenance", () => {
  const changed = fixturePlan(); changed.fill[0]!.api = { ...api, api_endpoint: "https://changed.example.test" };
  assert.throws(() => validatePlan(changed, DATABASE), /content hash/);
  assert.throws(() => validatePlan(fixturePlan(), "https://other-database.example.test"), /different database/);
  const source = fixturePlan(); source.fill[0]!.source_url = "https://unrelated.example.test/spec";
  source.plan_sha256 = planDigest(source);
  assert.throws(() => validatePlan(source, DATABASE), /provenance/);
});

test("plan validation rejects duplicated APIs and inconsistent derived fields even after rehashing", () => {
  const duplicate = fixturePlan(); duplicate.fill.push(duplicate.fill[0]!); duplicate.plan_sha256 = planDigest(duplicate);
  assert.throws(() => validatePlan(duplicate, DATABASE), /duplicate/);
  const fields = fixturePlan(); fields.fill[0]!.schemas[0]!.fields = []; fields.plan_sha256 = planDigest(fields);
  assert.throws(() => validatePlan(fields, DATABASE), /fields do not agree/);
});

test("apply identity check refuses changed API facts and inactive/duplicate records", () => {
  assert.equal(sameApiIdentity(api, { ...api }), true);
  for (const update of [{ api_endpoint: "https://other.example.test" }, { http_method: "POST" },
    { documentation_url: `${SOURCE}?new` }, { api_name: "Renamed" }, { is_active: false }, { duplicate_of: "another" }]) {
    assert.equal(sameApiIdentity(api, { ...api, ...update }), false);
  }
});

test("CLI writes require an explicit apply flag, saved plan and administrator identity", () => {
  assert.equal(parseOptions([]).apply, false);
  assert.throws(() => parseOptions(["--apply"]), /requires/);
  assert.throws(() => parseOptions(["--from-plan", "plan.json"]), /only used with/);
  assert.throws(() => parseOptions(["--apply", "--from-plan", "plan.json", "--actor-user-id", "not-a-uuid"]), /requires/);
  assert.throws(() => parseOptions(["--concurrency", "9"]), /between 1 and 8/);
  assert.equal(parseOptions(["--apply", "--from-plan", "plan.json", "--actor-user-id", api.id]).apply, true);
});

test("database pagination reads all rows even when the server page cap is smaller than requested", async (t) => {
  const previous = globalThis.fetch;
  const seen: number[] = [];
  const records = Array.from({ length: 7 }, (_, i) => ({ id: String(i) }));
  globalThis.fetch = (async (request) => {
    const params = new URL(String(request)).searchParams;
    const offset = Number(params.get("offset")); seen.push(offset);
    return new Response(JSON.stringify(records.slice(offset, offset + 3)), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  const rows = await readAll({ url: DATABASE, key: "test-only", opaqueSecret: false }, "apis", { select: "id" });
  assert.deepEqual(rows, records);
  assert.deepEqual(seen, [0, 3, 6, 7]);
});

test("applying a saved plan only inserts eligible missing schemas and audits the verified admin", async (t) => {
  const folder = resolve(".schema-backfill");
  await mkdir(folder, { recursive: true });
  const temporary = await mkdtemp(join(folder, "test-"));
  const planPath = join(temporary, "plan.json");
  const reportPath = join(temporary, "report.json");
  const plan = fixturePlan();
  const existingApi = { ...api, id: "10000000-0000-4000-8000-000000000002" };
  const changedApi = { ...api, id: "10000000-0000-4000-8000-000000000003" };
  plan.fill.push({ ...plan.fill[0]!, api: existingApi }, { ...plan.fill[0]!, api: changedApi });
  plan.documents[0]!.api_ids.push(existingApi.id, changedApi.id);
  plan.api_count = 3;
  plan.summary = planSummary(plan.fill, plan.skipped, plan.documents);
  plan.plan_sha256 = planDigest(plan);
  await writeFile(planPath, JSON.stringify(plan));
  const oldFetch = globalThis.fetch;
  const oldLog = console.log;
  const savedEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  const calls: { table: string; method: string; data: unknown }[] = [];
  const actor = { id: "20000000-0000-4000-8000-000000000001", display_name: "Verified admin", role: "admin", is_active: true };
  process.env.SUPABASE_URL = DATABASE;
  process.env.SUPABASE_SECRET_KEY = "test-only-secret";
  console.log = () => {};
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, DATABASE, "apply must not refetch external documents");
    const table = url.pathname.split("/").at(-1)!;
    const method = init?.method ?? "GET";
    const data = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ table, method, data });
    if (method === "GET") {
      if (Number(url.searchParams.get("offset")) > 0) return Response.json([]);
      if (table === "app_user") return Response.json([actor]);
      if (table === "apis") {
        const id = url.searchParams.get("id")!.slice(3);
        const row = [api, existingApi, changedApi].find((entry) => entry.id === id)!;
        return Response.json([{ ...row, ...(id === changedApi.id ? { api_endpoint: "https://changed.example.test" } : {}) }]);
      }
      if (table === "api_schema") return Response.json(url.searchParams.get("api_id") === `eq.${existingApi.id}` ? [{ id: "existing" }] : []);
    }
    if (method === "POST" && table === "api_schema") {
      return Response.json((data as Record<string, unknown>[]).map((row, i) => ({
        id: `schema-${i}`, direction: row.direction, status_code: row.status_code, media_type: row.media_type,
      })));
    }
    if (method === "POST" && ["api_schema_field", "api_audit_events"].includes(table)) return new Response(null, { status: 201 });
    throw new Error(`Unexpected database operation ${method} ${table}`);
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = oldFetch; console.log = oldLog;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await unlink(planPath);
    await unlink(reportPath).catch(() => {});
    await rmdir(temporary);
  });
  await main(["--apply", "--from-plan", planPath, "--actor-user-id", actor.id, "--report", reportPath]);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.results.map((row: { status: string; reason?: string }) => [row.status, row.reason]),
    [["written", undefined], ["skipped", "has_schemas"], ["skipped", "api_changed_since_plan"]]);
  assert.equal(report.summary.written_apis, 1);
  assert.equal(report.summary.audit_failures, 0);
  assert.equal(calls.filter((call) => call.table === "api_schema" && call.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.table === "apis").every((call) => call.method === "GET"), true);
  const audit = calls.find((call) => call.table === "api_audit_events")!.data as Record<string, unknown>;
  assert.equal(audit.actor_user_id, actor.id);
  assert.equal(audit.actor_name, actor.display_name);
  assert.match(String(audit.details), /Automated bulk schema extraction/);
  assert.match(String(audit.details), new RegExp(plan.plan_sha256));
  assert.equal((await readFile(reportPath, "utf8")).includes("test-only-secret"), false);
});
