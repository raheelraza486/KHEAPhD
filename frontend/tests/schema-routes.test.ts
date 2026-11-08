// /api/schemas, run through the real route module with only the database
// and the session replaced.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES, type AppRole } from "../lib/auth-policy.ts";
import { routeHarness } from "./helpers/route-harness.ts";

const OWNER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const API = "40000000-0000-4000-8000-000000000001";
const HIDDEN = "40000000-0000-4000-8000-000000000002";
const MANUAL = "40000000-0000-4000-8000-000000000003";

const schemaText = JSON.stringify({
  type: "object", required: ["abn"], properties: { abn: { type: "string" }, amount: { type: "number" } },
});

type Existing = { id: string; direction: string; status_code: string | null; media_type: string; origin: string };
type Call = { method: string; table: string; query: URLSearchParams; body: unknown };

function setup(
  t: TestContext,
  opts: { role?: AppRole | null; userId?: string; existing?: Existing[]; failFields?: boolean;
          failParameters?: boolean; parameters?: Record<string, unknown>[] } = {},
) {
  const calls: Call[] = [];
  const apis = [
    { id: API, api_name: "Send invoice", company_name: "Acme", is_active: true, duplicate_of: null, created_by_user: OWNER, http_method: "POST", documentation_url: "https://x.test/doc" },
    { id: MANUAL, api_name: "Hand entered", company_name: "Acme", is_active: true, duplicate_of: null, created_by_user: OWNER, http_method: null, documentation_url: "https://x.test/doc" },
    { id: HIDDEN, api_name: "Gone", company_name: "Acme", is_active: false, duplicate_of: null, created_by_user: OWNER },
  ];
  const storedSchemas = [
    { id: "s-1", api_id: API, direction: "request", media_type: "application/json", status_code: null,
      origin: "extracted", source_url: "https://x.test/doc", created_by: "", created_at: "2026-09-12T00:00:00Z",
      warnings: [], raw: { type: "object" } },
  ];
  const storedFields = [
    { schema_id: "s-1", path: "abn", leaf_name: "abn", leaf_name_norm: "abn", json_type: "string" },
    { schema_id: "s-1", path: "amount", leaf_name: "amount", leaf_name_norm: "amount", json_type: "number" },
  ];
  // Migration 0017. Stored against the API, not against a schema, because an
  // operation can have parameters and no body at all.
  const storedParameters = opts.parameters ?? [
    { api_id: API, name: "invoiceId", location: "query", is_required: true,
      schema: { type: "integer" }, json_type: "integer", format: null, enum_values: null,
      name_norm: "invoiceid", description: "", origin: "extracted",
      source_url: "https://provider.example.test/openapi.json" },
  ];

  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "test-only";
  t.after(() => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  let seq = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const table = u.pathname.replace("/rest/v1/", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, table, query: u.searchParams, body });
    const inIds = (key: string) => (u.searchParams.get(key) ?? "").replace(/^in\.\(|\)$/g, "").split(",");

    if (table === "apis") {
      const id = u.searchParams.get("id") ?? "";
      const wanted = id.startsWith("eq.") ? [id.slice(3)] : inIds("id");
      return Response.json(apis.filter((a) => wanted.includes(a.id)));
    }
    if (table === "api_schema" && method === "GET") {
      if (u.searchParams.get("api_id")?.startsWith("eq.")) return Response.json(opts.existing ?? []);
      return Response.json(storedSchemas.filter((s) => inIds("api_id").includes(s.api_id)));
    }
    if (table === "api_schema_field" && method === "GET") {
      return Response.json(storedFields.filter((f) => inIds("schema_id").includes(f.schema_id)));
    }
    if (table === "api_parameter" && method === "GET") {
      return Response.json(storedParameters.filter((p) => inIds("api_id").includes(String(p.api_id))));
    }
    if (table === "api_parameter" && method === "POST") {
      return opts.failParameters ? new Response("no", { status: 500 }) : new Response(null, { status: 201 });
    }
    if (table === "api_parameter" && method === "DELETE") return new Response(null, { status: 204 });
    if (table === "api_schema" && method === "POST") {
      return Response.json((body as Record<string, unknown>[]).map((r) => ({ id: `new-${++seq}`, ...r })), { status: 201 });
    }
    if (table === "api_schema_field" && method === "POST") {
      return opts.failFields ? new Response("no", { status: 500 }) : new Response(null, { status: 201 });
    }
    if (table === "api_schema" && method === "DELETE") return new Response(null, { status: 204 });
    if (table === "api_audit_events") return new Response(null, { status: 201 });
    return new Response(`unexpected ${method} ${table}`, { status: 500 });
  });

  const role = opts.role === undefined ? "publisher" : opts.role;
  const user = role ? { id: opts.userId ?? OWNER, role, displayName: "Jackie", email: "j@example.test" } : null;
  const load = routeHarness({
    "@/lib/auth": {
      APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES,
      getCurrentAppUser: async () => user,
      requireRole: async (_r: Request, allowed: readonly AppRole[]) => user && allowed.includes(user.role)
        ? { user } : { response: Response.json({}, { status: user ? 403 : 401 }) },
    },
  });
  return { route: load("app/api/schemas/route.ts"), calls };
}

function upload(body: Record<string, unknown>, origin = "https://catalogue.example.test") {
  return new Request("https://catalogue.example.test/api/schemas", {
    method: "POST",
    headers: { origin, host: "catalogue.example.test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const schemaUpload = { api_id: API, kind: "schema", direction: "request", text: schemaText };

// ---------------------------------------------------------------- reading

test("GET returns each API's schemas with their fields nested under them", async (t) => {
  const { route } = setup(t);
  const res = await route.GET(new Request(`https://c.test/api/schemas?api_id=${API}`));
  const data = (await res.json()) as { apis: { api_id: string; schemas: { id: string; fields: { path: string }[] }[] }[] };
  assert.equal(res.status, 200);
  assert.equal(data.apis[0]?.api_id, API);
  assert.deepEqual(data.apis[0]?.schemas[0]?.fields.map((f) => f.path), ["abn", "amount"]);
});

test("GET reports an inactive API as missing rather than exposing its schemas", async (t) => {
  const { route, calls } = setup(t);
  const res = await route.GET(new Request(`https://c.test/api/schemas?api_id=${API}&api_id=${HIDDEN}`));
  const data = (await res.json()) as { apis: { api_id: string }[]; missing: string[] };
  assert.deepEqual(data.apis.map((a) => a.api_id), [API]);
  assert.deepEqual(data.missing, [HIDDEN]);
  const schemaRead = calls.find((c) => c.table === "api_schema");
  assert.ok(!(schemaRead?.query.get("api_id") ?? "").includes(HIDDEN), "a hidden API's schemas must not even be queried");
});

test("GET needs no sign-in: every visible record is public, and so are its schemas", async (t) => {
  const { route } = setup(t, { role: null });
  const res = await route.GET(new Request(`https://c.test/api/schemas?api_id=${API}`));
  const data = (await res.json()) as { apis: { can_upload: boolean }[] };
  assert.equal(res.status, 200);
  assert.equal(data.apis[0]?.can_upload, false);
});

test("GET tells the submitter they can upload, and never names the submitter", async (t) => {
  const { route } = setup(t);
  const res = await route.GET(new Request(`https://c.test/api/schemas?api_id=${API}`));
  const data = (await res.json()) as { apis: Record<string, unknown>[] };
  assert.equal(data.apis[0]?.can_upload, true);
  assert.equal(data.apis[0]?.api_name, "Send invoice");
  assert.ok(!JSON.stringify(data).includes(OWNER), "the owner's id must not leave the server");
});

test("GET offers documentation recovery for managed legacy records without a stored method", async (t) => {
  const { route } = setup(t);
  const res = await route.GET(new Request(`https://c.test/api/schemas?api_id=${API}&api_id=${MANUAL}`));
  const data = (await res.json()) as { apis: { api_id: string; can_fetch: boolean; can_upload: boolean }[] };
  const byId = new Map(data.apis.map((a) => [a.api_id, a]));
  assert.equal(byId.get(API)?.can_fetch, true);
  assert.equal(byId.get(MANUAL)?.can_fetch, true, "a legacy endpoint can uniquely identify its documented operation");
  assert.equal(byId.get(MANUAL)?.can_upload, true, "but it can still be uploaded to");
});

test("GET never offers a fetch to someone who cannot manage the record", async (t) => {
  const { route } = setup(t, { role: null });
  const res = await route.GET(new Request(`https://c.test/api/schemas?api_id=${API}`));
  const data = (await res.json()) as { apis: { can_fetch: boolean }[] };
  assert.equal(data.apis[0]?.can_fetch, false);
});

test("GET tells someone else they cannot upload", async (t) => {
  const { route } = setup(t, { userId: OTHER });
  const res = await route.GET(new Request(`https://c.test/api/schemas?api_id=${API}`));
  const data = (await res.json()) as { apis: { can_upload: boolean }[] };
  assert.equal(data.apis[0]?.can_upload, false);
});

test("GET does not offer schema writes that the viewer role cannot perform, even on a legacy owned API", async (t) => {
  const { route } = setup(t, { role: "viewer" });
  const data = await (await route.GET(new Request(`https://c.test/api/schemas?api_id=${API}`))).json();
  assert.equal(data.apis[0]?.can_upload, false);
  assert.equal(data.apis[0]?.can_fetch, false);
  assert.equal(data.apis[0]?.schemas.length, 1);
  assert.equal((await route.POST(upload(schemaUpload))).status, 403);
});

test("GET refuses a malformed id and too many ids", async (t) => {
  const { route } = setup(t);
  assert.equal((await route.GET(new Request("https://c.test/api/schemas?api_id=nope"))).status, 400);
  assert.equal((await route.GET(new Request("https://c.test/api/schemas"))).status, 400);
  const many = Array.from({ length: 11 }, (_, i) => `api_id=40000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`).join("&");
  assert.equal((await route.GET(new Request(`https://c.test/api/schemas?${many}`))).status, 400);
});

// --------------------------------------------------------------- uploading

test("the submitter can upload a schema; it is stored as uploaded, by them", async (t) => {
  const { route, calls } = setup(t);
  const res = await route.POST(upload(schemaUpload));
  assert.equal(res.status, 201);
  const row = (calls.find((c) => c.table === "api_schema" && c.method === "POST")?.body as Record<string, unknown>[])[0];
  assert.equal(row?.origin, "uploaded");
  assert.equal(row?.created_by, "Jackie");
  assert.equal(row?.source_url, "");
  const fields = calls.find((c) => c.table === "api_schema_field" && c.method === "POST")?.body as { schema_id: string }[];
  assert.equal(fields.length, 2);
  assert.ok(fields.every((f) => f.schema_id === "new-1"));
  const audit = calls.find((c) => c.table === "api_audit_events")?.body as { action: string; details: string };
  assert.equal(audit.action, "edit");
  assert.match(audit.details, /Uploaded schema: request/);
});

test("someone else's API is refused, exactly as editing it would be", async (t) => {
  const { route, calls } = setup(t, { userId: OTHER });
  const res = await route.POST(upload(schemaUpload));
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.method !== "GET"), "nothing may be written");
});

test("an administrator may upload to any API", async (t) => {
  const { route } = setup(t, { role: "admin", userId: OTHER });
  assert.equal((await route.POST(upload(schemaUpload))).status, 201);
});

test("a viewer cannot upload at all", async (t) => {
  const { route } = setup(t, { role: "viewer" });
  assert.equal((await route.POST(upload(schemaUpload))).status, 403);
});

test("a cross-origin upload is refused before anything else happens", async (t) => {
  const { route, calls } = setup(t);
  const res = await route.POST(upload(schemaUpload, "https://evil.example.test"));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("an upload never replaces a schema taken from the documentation", async (t) => {
  const { route, calls } = setup(t, {
    existing: [{ id: "old", direction: "request", status_code: null, media_type: "application/json", origin: "extracted" }],
  });
  const res = await route.POST(upload(schemaUpload));
  assert.equal(res.status, 409);
  assert.ok(!calls.some((c) => c.method === "DELETE" || c.method === "POST"));
});

test("an upload replaces an earlier upload for the same side", async (t) => {
  const { route, calls } = setup(t, {
    existing: [{ id: "old", direction: "request", status_code: null, media_type: "application/json", origin: "uploaded" }],
  });
  const res = await route.POST(upload(schemaUpload));
  const data = (await res.json()) as { replaced: number };
  assert.equal(res.status, 201);
  assert.equal(data.replaced, 1);
  const del = calls.find((c) => c.method === "DELETE");
  assert.equal(del?.query.get("id"), "in.(old)");
  const audit = calls.find((c) => c.table === "api_audit_events")?.body as { details: string };
  assert.match(audit.details, /Replaced uploaded/);
});

test("if the fields cannot be saved, the new schema is removed again", async (t) => {
  const { route, calls } = setup(t, { failFields: true });
  const res = await route.POST(upload(schemaUpload));
  assert.equal(res.status, 502);
  const del = calls.find((c) => c.method === "DELETE");
  assert.equal(del?.query.get("id"), "in.(new-1)");
});

test("a document with several operations comes back with the list to choose from", async (t) => {
  const { route } = setup(t);
  const doc = JSON.stringify({
    openapi: "3.0.3", info: { title: "t", version: "1" },
    paths: {
      "/a": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { x: { type: "string" } } } } } }, responses: {} } },
      "/b": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { y: { type: "string" } } } } } }, responses: {} } },
    },
  });
  const res = await route.POST(upload({ api_id: API, kind: "openapi", text: doc }));
  const data = (await res.json()) as { operations: { path: string }[] };
  assert.equal(res.status, 400);
  assert.deepEqual(data.operations.map((o) => o.path).sort(), ["/a", "/b"]);
});

test("an upload to an inactive API is answered as not found", async (t) => {
  const { route } = setup(t);
  assert.equal((await route.POST(upload({ ...schemaUpload, api_id: HIDDEN }))).status, 404);
});
