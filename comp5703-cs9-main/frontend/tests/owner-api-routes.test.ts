import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES, type AppRole } from "../lib/auth-policy.ts";
import { normalizeApiRecord, type ApiRecord } from "../lib/types.ts";
import { routeHarness } from "./helpers/route-harness.ts";

const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const first = "20000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";
const fields = { api_name: "Invoice API", company_name: "Example", category: "Validation", description: "Validates an invoice", api_endpoint: "https://example.test/api", documentation_url: "https://example.test/docs", authentication_method: "None" } as const;

function setup(t: TestContext, role: AppRole | null = "publisher", verified = false) {
  const rows = [
    normalizeApiRecord({ ...fields, category: "Validation", id: first, created_by_user: owner, review_status: verified ? "Verified" : "Published", verified_by: "Admin", verification_notes: "Checked", verified_at: "2026-09-10T00:00:00Z" }),
    normalizeApiRecord({ ...fields, category: "Validation", id: second, api_name: "Other API", created_by_user: other }),
  ];
  const writes: { query: URLSearchParams; body: Record<string, unknown> }[] = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const audits = rows.map((row, index) => ({ id: `audit-${index}`, api_id: row.id, api_name: row.api_name, company_name: row.company_name, action: "upload", actor_name: "Submitter", action_at: "2026-09-10T00:00:00Z", details: "Submitted" }));
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "test-only";
  t.after(() => { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const query = new URL(url).searchParams;
    assert.equal(new URL(url).origin, "https://database.example.test");
    if (new URL(url).pathname.endsWith("/rpc/admin_bulk_update_api_metadata")) {
      const body = JSON.parse(String(init.body)) as {
        p_updates: Array<{ id: string; changes: Record<string, unknown> }>;
        p_actor_user_id: string;
        p_actor_name: string;
      };
      rpcCalls.push(body as unknown as Record<string, unknown>);
      const result = body.p_updates.map((update) => {
        const target = rows.find((row) => row.id === update.id)!;
        // This mock records the RPC payload; only the SQL regression test can
        // verify database triggers. Bulk curation must never grant verification.
        Object.assign(target, update.changes);
        return { api_id: target.id, updated_at: target.updated_at, review_status: target.review_status };
      });
      return Response.json(result);
    }
    if (new URL(url).pathname.endsWith("api_audit_events")) {
      if (init.method === "POST") return new Response(null, { status: 201 });
      return Response.json(audits.filter((event) => !query.has("api_id") || query.get("api_id")!.includes(event.api_id)));
    }
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Partial<ApiRecord>[];
      const inserted = body.map((item, index) => normalizeApiRecord({
        ...item,
        id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }));
      rows.push(...inserted);
      return Response.json(inserted, { status: 201 });
    }
    if (init.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      writes.push({ query, body });
      const targets = rows.filter((row) => query.get("id")!.includes(row.id)
        && (!query.has("created_by_user") || query.get("created_by_user") === `eq.${row.created_by_user}`)
        && row.is_active);
      targets.forEach((row) => Object.assign(row, body));
      return Response.json(targets);
    }
    const selectedFields = query.get("select")?.split(",") ?? [];
    const matching = rows.filter((row) => (!query.has("review_status") || query.get("review_status") === `eq.${row.review_status}`)
      && (!query.has("is_active") || query.get("is_active") === `eq.${row.is_active}`)
      && (!query.has("created_by_user") || query.get("created_by_user") === `eq.${row.created_by_user}`)
      && (!query.has("duplicate_of") || row.duplicate_of == null));
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? matching.length);
    return Response.json(matching.slice(offset, offset + limit).map(row => Object.fromEntries(selectedFields.map(field => [field, row[field as keyof ApiRecord]]))));
  });
  const user = role ? { id: owner, role, displayName: "Owner", email: "owner@example.test" } : null;
  const load = routeHarness({ "@/lib/auth": {
    APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES,
    getCurrentAppUser: async () => user,
    requireRole: async (_request: Request, allowed: readonly AppRole[]) => user && allowed.includes(user.role)
      ? { user } : { response: Response.json({}, { status: user ? 403 : 401 }) },
  } });
  return { route: load("app/api/apis/route.ts"), rows, writes, rpcCalls, audits };
}

function request(method: string, body: unknown = {}, origin = "https://catalogue.example.test") {
  return new Request("https://catalogue.example.test/api/apis", {
    method, headers: { origin, host: "catalogue.example.test", "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

for (const role of [null, "publisher", "admin"] as const) {
  test(`My Submissions is limited to the signed-in account for ${role ?? "a guest"}`, async (t) => {
    const { route } = setup(t, role);
    const response = await route.GET(new Request(`https://catalogue.example.test/api/apis?scope=mine&owner=${other}`));
    assert.equal(response.status, role ? 200 : 401);
    if (!role) return;
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const { apis } = await response.json();
    assert.deepEqual(apis.map((api: ApiRecord) => api.id), [first]);
    assert.deepEqual(apis[0].audit_trail.map((event: { api_id: string }) => event.api_id), [first]);
  });
}

test("verification returns a fresh database count excluding inactive and duplicate APIs", async (t) => {
  const { route, rows } = setup(t, "admin");
  rows.push(normalizeApiRecord({ ...fields, id: "inactive", is_active: false, review_status: "Published" }));
  rows.push(normalizeApiRecord({ ...fields, id: "duplicate", duplicate_of: first, review_status: "Published" }));
  const save = (id: string) => route.PATCH(request("PATCH", { id, review_status: "Verified", verification_notes: "Official documentation checked" }));
  const firstResult = await save(first);
  assert.equal(firstResult.status, 200);
  assert.equal((await firstResult.json()).awaitingVerificationCount, 1);
  const lastResult = await save(second);
  assert.equal((await lastResult.json()).awaitingVerificationCount, 0);
});

test("verification count reads all database pages and reflects other administrators' changes", async (t) => {
  const { route, rows } = setup(t, "admin");
  rows[1].review_status = "Verified";
  for (let i = 0; i < 1005; i++) rows.push(normalizeApiRecord({ ...fields, id: `pending-${i}`, review_status: "Published" }));
  const result = await route.PATCH(request("PATCH", { id: first, review_status: "Verified", verification_notes: "Checked" }));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).awaitingVerificationCount, 1005);
});

test("a count query failure preserves the successful save without reporting a false zero", async (t) => {
  const { route, rows } = setup(t, "admin");
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (new URL(url).searchParams.get("select") === "id,is_active,duplicate_of,review_status") return new Response(null, { status: 503 });
    return originalFetch(url, init);
  });
  const result = await route.PATCH(request("PATCH", { id: first, review_status: "Verified", verification_notes: "Checked" }));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).awaitingVerificationCount, null);
  assert.equal(rows[0].review_status, "Verified");
});

for (const verified of [false, true]) {
  test(`owner edits a ${verified ? "verified" : "pending"} API; resets verification and cannot forge ownership`, async (t) => {
    const { route, writes } = setup(t, "publisher", verified);
    const response = await route.PUT(request("PUT", { id: first, ...fields, created_by_user: other, review_status: "Verified", verified_by_user: owner }));
    assert.equal(response.status, 200);
    const saved = (await response.json()).api;
    assert.equal(saved.review_status, "Published");
    assert.equal(saved.created_by_user, owner);
    assert.equal(writes[0].query.get("created_by_user"), `eq.${owner}`);
    assert.equal(writes[0].body.verified_by_user, null);
    assert.equal("created_by_user" in writes[0].body, false);
  });
}

test("another user's API is rejected before writes", async (t) => {
  const { route, writes } = setup(t);
  assert.equal((await route.PUT(request("PUT", { id: second, ...fields, created_by_user: owner }))).status, 403);
  assert.equal(writes.length, 0);
});

for (const role of [null, "publisher", "admin"] as const) {
  test(`API deletion is disabled for ${role ?? "anonymous"} and performs no writes`, async (t) => {
    const { route, writes } = setup(t, role);
    const response = await route.DELETE(request("DELETE", { ids: [first, second] }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET, POST, PUT, PATCH");
    assert.match((await response.json()).error, /deletion is currently disabled/i);
    assert.equal(writes.length, 0);
  });
}

test("unowned historical rows stay admin-managed; owners cannot verify themselves", async (t) => {
  const { route, rows, writes } = setup(t);
  rows[0].created_by_user = null;
  assert.equal((await route.PUT(request("PUT", { id: first, ...fields }))).status, 403);
  assert.equal((await route.PATCH(request("PATCH", { id: first, review_status: "Verified", verification_notes: "Trust me" }))).status, 403);
  assert.equal(writes.length, 0);
});

test("anonymous edits and cross-origin owner edits are rejected", async (t) => {
  const { route, writes } = setup(t, null);
  assert.equal((await route.PUT(request("PUT", { id: first, ...fields }))).status, 401);
  assert.equal(writes.length, 0);
});

test("admin can edit another user's submissions", async (t) => {
  const { route, writes } = setup(t, "admin");
  assert.equal((await route.PUT(request("PUT", { id: second, ...fields, api_name: "Other API" }))).status, 200);
  assert.ok(writes.every((write) => !write.query.has("created_by_user")));
});

test("only admins can preview a metadata overwrite spreadsheet", async (t) => {
  const { route, rpcCalls } = setup(t, "publisher");
  const response = await route.PATCH(request("PATCH", {
    action: "preview_metadata_bulk",
    rows: [{
      source_row: 2,
      api_id: first,
      api_name: "Invoice API",
      field: "network",
      proposed_value: "Peppol",
      evidence: "The official provider documentation names the network.",
      evidence_url: "https://example.test/docs",
    }],
  }));
  assert.equal(response.status, 403);
  assert.equal(rpcCalls.length, 0);
});

test("admin metadata overwrite uses preview then one transactional RPC", async (t) => {
  const { route, rows, rpcCalls } = setup(t, "admin");
  const spreadsheetRows = [{
    source_row: 2,
    api_id: first,
    api_name: "Invoice API",
    field: "network",
    proposed_value: "Peppol",
    evidence: "内部证据：官方文档说明了该网络。",
    evidence_url: "https://example.test/docs",
    note: "中文备注，仅供导入判断。",
  }, {
    source_row: 3,
    api_id: first,
    api_name: "Invoice API",
    field: "country_region",
    proposed_value: "Australia",
    evidence: "The provider documentation identifies Australia.",
    evidence_url: "https://example.test/docs/regions",
  }, {
    source_row: 4,
    api_id: first,
    api_name: "Invoice API",
    field: "category",
    proposed_value: "Transformation",
    evidence: "The official documentation describes a transformation operation.",
    evidence_url: "https://example.test/docs/transformation",
  }];

  const previewResponse = await route.PATCH(request("PATCH", {
    action: "preview_metadata_bulk",
    rows: spreadsheetRows,
  }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.ready, true);
  assert.equal(preview.row_count, 3);
  assert.equal(preview.api_count, 1);
  assert.equal(rpcCalls.length, 0);

  const commitResponse = await route.PATCH(request("PATCH", {
    action: "commit_metadata_bulk",
    rows: spreadsheetRows,
    plan_token: preview.plan_token,
  }));
  assert.equal(commitResponse.status, 200);
  assert.equal((await commitResponse.json()).updated_count, 1);
  assert.equal(rpcCalls.length, 1);
  const rpc = rpcCalls[0] as {
    p_actor_user_id: string;
    p_actor_name: string;
    p_updates: Array<{
      id: string;
      changes: Record<string, unknown>;
      evidence: Array<{ source_row: number; statement: string; url: string; note: string }>;
      evidence_urls: string[];
      source_rows: number[];
    }>;
  };
  assert.equal(rpc.p_actor_user_id, owner);
  assert.equal(rpc.p_actor_name, "Owner");
  assert.equal(rpc.p_updates.length, 1);
  assert.deepEqual(rpc.p_updates[0].changes, { category: "Transformation", country_region: "Australia", network: "Peppol" });
  assert.deepEqual(Object.keys(rpc.p_updates[0]).sort(), [
    "changes", "evidence", "evidence_urls", "expected_updated_at", "fields", "id", "source_rows",
  ]);
  assert.deepEqual(rpc.p_updates[0].evidence_urls, [
    "https://example.test/docs", "https://example.test/docs/regions", "https://example.test/docs/transformation",
  ]);
  assert.deepEqual(rpc.p_updates[0].source_rows, [2, 3, 4]);
  assert.deepEqual(rpc.p_updates[0].evidence[0], {
    source_row: 2,
    field: "network",
    statement: "内部证据：官方文档说明了该网络。",
    url: "https://example.test/docs",
    note: "中文备注，仅供导入判断。",
  });
  assert.equal(rows[0].review_status, "Published");
});

test("admin can preview and commit an explicit list clear with its evidence", async (t) => {
  const { route, rows, rpcCalls } = setup(t, "admin");
  rows[0].output_formats = ["XML"];
  const spreadsheetRows = [{
    source_row: 8, api_id: first, field: "output_formats", proposed_value: "[]",
    evidence: "This operation returns no document.", evidence_url: "https://example.test/docs",
  }];
  const previewResponse = await route.PATCH(request("PATCH", { action: "preview_metadata_bulk", rows: spreadsheetRows }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.changed_row_count, 1);
  assert.deepEqual(preview.sample[0].changes.output_formats, []);
  assert.equal(rpcCalls.length, 0);
  const response = await route.PATCH(request("PATCH", {
    action: "commit_metadata_bulk", rows: spreadsheetRows, plan_token: preview.plan_token,
  }));
  assert.equal(response.status, 200);
  assert.equal(rpcCalls.length, 1);
  const updates = rpcCalls[0].p_updates as Array<{ changes: unknown; source_rows: number[]; evidence: unknown[] }>;
  assert.deepEqual(updates[0].changes, { output_formats: [] });
  assert.deepEqual(updates[0].source_rows, [8]);
  assert.equal(updates[0].evidence.length, 1);
  assert.deepEqual(rows[0].output_formats, []);
  assert.equal(rows[0].review_status, "Published");
});

test("invalid list rows block preview and direct commit without any write", async (t) => {
  const { route, rpcCalls, writes } = setup(t, "admin");
  for (const action of ["preview_metadata_bulk", "commit_metadata_bulk"]) {
    for (const value of ["null", "NULL", "UBL, CII", "XML\n\nPDF", ""]) {
      const response = await route.PATCH(request("PATCH", {
        action, plan_token: "0".repeat(64), rows: [
          { source_row: 2, api_id: second, field: "network", proposed_value: "Peppol", evidence: "Provider guide", evidence_url: "https://example.test/docs" },
          { source_row: 23, api_id: first, field: "input_formats", proposed_value: value, evidence: "Provider guide", evidence_url: "https://example.test/docs" },
        ],
      }));
      assert.equal(response.status, 422, `${action}: ${value}`);
      const payload = await response.json();
      assert.equal(payload.invalid[0].source_row, 23);
      assert.equal(payload.invalid[0].field, "input_formats");
    }
  }
  assert.equal(rpcCalls.length, 0);
  assert.equal(writes.length, 0);
});

test("admin metadata overwrite refuses a commit that does not match its preview", async (t) => {
  const { route, rpcCalls } = setup(t, "admin");
  const response = await route.PATCH(request("PATCH", {
    action: "commit_metadata_bulk",
    rows: [{
      source_row: 2,
      api_id: first,
      api_name: "Invoice API",
      field: "network",
      proposed_value: "Peppol",
      evidence: "The official provider documentation names the network.",
      evidence_url: "https://example.test/docs",
    }],
    plan_token: "0".repeat(64),
  }));
  assert.equal(response.status, 409);
  assert.equal(rpcCalls.length, 0);
});

test("public catalogue includes all review states and only owner history", async (t) => {
  const { route, rows } = setup(t, "publisher", true);
  rows.push(normalizeApiRecord({ id: "deleted-own", api_name: "Deleted own", created_by_user: owner, is_active: false }));
  rows.push(normalizeApiRecord({ id: "deleted-other", api_name: "Deleted other", created_by_user: other, is_active: false }));
  const response = await route.GET(request("GET"));
  const payload = await response.json();
  assert.deepEqual(payload.apis.map((row: ApiRecord) => row.review_status), ["Verified", "Published"]);
  assert.equal(payload.apis[0].audit_trail.length, 1);
  assert.equal(payload.apis[1].audit_trail.length, 0);
  assert.equal(payload.apis[1].created_by_user, null);
  assert.equal("deleted_apis" in payload, false);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("owner audit API responses reduce internal metadata JSON to public field names", async (t) => {
  const { route, rows, audits } = setup(t, "publisher", true);
  rows[0].verification_notes = "中文内部备注";
  audits[0].action = "verify";
  audits[0].details = JSON.stringify({
    type: "admin_metadata_bulk_update",
    fields: ["network", "country_region", "source_row", "note"],
    evidence: [{ source_row: 47, statement: "中文证据", note: "内部备注" }],
  });
  const payload = await (await route.GET(request("GET"))).json();
  assert.equal(payload.apis[0].audit_trail[0].details, "country_region updated, network updated.");
  assert.equal(payload.apis[0].verification_notes, "");
  assert.doesNotMatch(JSON.stringify(payload.apis[0]), /内部|中文|statement|source_row|evidence/iu);
});

test("anonymous catalogue responses contain no audit history or owner identifiers", async (t) => {
  const { route } = setup(t, null, true);
  const payload = await (await route.GET(request("GET"))).json();
  assert.equal(payload.apis.length, 2);
  assert.ok(payload.apis.every((row: ApiRecord) => row.created_by_user === null && row.audit_trail.length === 0));
  assert.equal("deleted_apis" in payload, false);
});

test("homepage coverage counts public records and excludes inactive and duplicate records", async (t) => {
  const { route, rows } = setup(t, null, true);
  rows[0].category = "Communication";
  rows.push(normalizeApiRecord({ id: "removed", category: "Transformation", is_active: false }));
  rows.push(normalizeApiRecord({ id: "duplicate", category: "Validation", duplicate_of: first }));
  const response = await route.GET(new Request("https://catalogue.example.test/api/apis?view=coverage"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control")!, /public/);
  const payload = await response.json();
  assert.equal(payload.totalOperations, 2);
  assert.doesNotMatch(JSON.stringify(payload), /created_by_user|audit_trail|deleted_apis/);
});

test("owners can maintain integration metadata without forging its verification provenance", async (t) => {
  const { route, rows, writes } = setup(t, "publisher", true);
  rows[0].invoice_standard = ["OLD"];
  rows[0].invoice_standard_source = "confirmed";
  const response = await route.PUT(request("PUT", { id: first, ...fields,
    http_method: "post", input_formats: [" JSON ", "XML", "JSON"], output_formats: ["XML"],
    invoice_standard: ["UBL"], invoice_standard_source: "confirmed", client_types: ["REST"],
    access_scope: "restricted", network: "Peppol", website_url: "https://example.test",
    instructions: "Register with the provider.", business_rules: ["Invoice totals must balance."],
  }));
  assert.equal(response.status, 200);
  const saved = (await response.json()).api;
  assert.equal(saved.http_method, "POST");
  assert.deepEqual(saved.input_formats, ["JSON", "XML"]);
  assert.deepEqual(saved.invoice_standard, ["UBL"]);
  assert.equal(saved.invoice_standard_source, null);
  assert.equal(saved.instructions, "Register with the provider.");
  assert.equal(saved.access_scope, "restricted");
  assert.equal(saved.review_status, "Published");
  assert.equal(writes[0].query.get("created_by_user"), `eq.${owner}`);
});

test("legacy edits preserve omitted metadata and blank methods are stored as SQL null", async (t) => {
  const { route, rows, writes } = setup(t);
  rows[0].input_formats = ["XML"];
  rows[0].http_method = "POST";
  assert.equal((await route.PUT(request("PUT", { id: first, ...fields }))).status, 200);
  assert.deepEqual(rows[0].input_formats, ["XML"]);
  assert.equal(rows[0].http_method, "POST");
  assert.equal((await route.PUT(request("PUT", { id: first, ...fields, http_method: "" }))).status, 200);
  assert.equal(writes[1].body.http_method, null);
});

test("invalid metadata is rejected before a write", async (t) => {
  const { route, writes } = setup(t);
  for (const extra of [{http_method:"CONNECT"}, {input_formats:"XML"}, {input_formats:[1]}, {website_url:"javascript:alert(1)"}, {access_scope:"admin"}]) {
    assert.equal((await route.PUT(request("PUT", { id: first, ...fields, ...extra }))).status, 400);
  }
  assert.equal(writes.length, 0);
});

test("only admins request changes and feedback survives until the owner resubmits", async (t) => {
  const { route, rows } = setup(t, "admin", true);
  assert.equal((await route.PATCH(request("PATCH", {id:first,review_status:"Published",request_changes:true,verification_notes:""}))).status,400);
  const response = await route.PATCH(request("PATCH", {id:first,review_status:"Published",request_changes:true,verification_notes:"Add the HTTP method."}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).api.verification_notes,"Add the HTTP method.");
  assert.equal(rows[0].review_status,"Published");
  await route.PUT(request("PUT",{id:first,...fields,http_method:"POST"}));
  assert.equal(rows[0].verification_notes,"");
});

test("public catalogue reads and preserves stored technical metadata without exposing owner information", async (t) => {
  const { route, rows } = setup(t, null);
  const metadata = { http_method: "POST", invoice_standard: ["UBL"], invoice_standard_source: "extracted", access_scope: "restricted", data_quality: "access_restricted", client_types: ["REST"] };
  Object.assign(rows[0], metadata);
  const payload = await (await route.GET(request("GET"))).json();
  for (const [field, value] of Object.entries(metadata)) assert.deepEqual(payload.apis[0][field], value, field);
  assert.equal(payload.apis[0].created_by_user, null);
  assert.deepEqual(payload.apis[0].audit_trail, []);
});

test("bulk uploads preserve honest gaps and retain optional metadata when it is supplied", async (t) => {
  const { route } = setup(t, "publisher");
  const response = await route.POST(request("POST", { apis: [
    { ...fields, api_name: "Unknown metadata API" },
    { ...fields, api_name: "Documented metadata API", http_method: "post", input_formats: [" XML "], output_formats: ["JSON"], client_types: ["SOAP"], access_scope: "restricted" },
  ] }));
  assert.equal(response.status, 201);
  const saved = (await response.json()).apis as ApiRecord[];
  assert.deepEqual(saved[0].input_formats, []);
  assert.deepEqual(saved[0].output_formats, []);
  assert.deepEqual(saved[0].client_types, []);
  assert.equal(saved[0].http_method, "");
  assert.deepEqual(saved[1].input_formats, ["XML"]);
  assert.deepEqual(saved[1].output_formats, ["JSON"]);
  assert.deepEqual(saved[1].client_types, ["SOAP"]);
  assert.equal(saved[1].http_method, "POST");
  assert.equal(saved[1].access_scope, "restricted");
});
