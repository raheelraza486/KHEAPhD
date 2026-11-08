// The import route's confirm phase writing schemas, run through the real
// route module with only the database and the session replaced.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES, type AppRole } from "../lib/auth-policy.ts";
import type { StoredSchema } from "../lib/schema/rows.ts";
import { routeHarness } from "./helpers/route-harness.ts";

const USER = "10000000-0000-4000-8000-000000000001";
const SESSION = "30000000-0000-4000-8000-000000000001";
const API_ID = "40000000-0000-4000-8000-000000000001";
const DOC_URL = "https://ksef.example.test/openapi.json";

const requestSchema: StoredSchema = {
  direction: "request",
  media_type: "application/json",
  status_code: null,
  raw: {
    type: "object",
    required: ["invoiceNumber"],
    properties: {
      invoiceNumber: { type: "string" },
      lines: { type: "array", items: { type: "object", properties: { unitPrice: { type: "number" } } } },
    },
  },
  warnings: [],
};
const responseSchema: StoredSchema = {
  direction: "response",
  media_type: "application/json",
  status_code: "200",
  raw: { type: "object", properties: { referenceNumber: { type: "string" } } },
  warnings: [],
};

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };

function setup(
  t: TestContext,
  options: { schemas?: StoredSchema[] | undefined; failFields?: boolean } = {},
) {
  const calls: Call[] = [];
  const item = {
    candidate: {
      api_endpoint: "https://ksef.example.test/v2/invoices", http_method: "POST",
      api_name: "KSeF Send invoice", official_api_name: "", description: "", company_name: "",
      operation_path: "/v2/invoices", input_formats: ["application/json"], output_formats: ["application/json"],
      authentication_raw: [], data_quality: "ok", warnings: [],
    },
    row: {
      api_name: "KSeF Send invoice", company_name: "Ministry of Finance", category: "Communication",
      communication_direction: "Send", api_endpoint: "https://ksef.example.test/v2/invoices",
      http_method: "POST", documentation_url: DOC_URL, description: "", authentication_method: "None",
    },
    predicted_outcome: "insert",
    ...(options.schemas !== undefined ? { schemas: options.schemas } : {}),
  };
  const session = {
    id: SESSION, documentation_url: DOC_URL, outcome: "previewed", created_by_user: USER,
    expires_at: new Date(Date.now() + 60_000).toISOString(), info_version: null, content_hash: null,
    candidates: JSON.stringify({ items: [item], info_title: "KSeF", warnings: [] }),
  };

  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "test-only";
  t.after(() => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  let schemaSeq = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const table = u.pathname.replace("/rest/v1/", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: table, query: u.searchParams, body });

    if (table === "import_session" && method === "GET") return Response.json([session]);
    if (table === "import_session" && method === "PATCH") return Response.json([{ id: SESSION }]);
    if (table === "apis" && method === "GET") return Response.json([]); // nothing existing, name free
    if (table === "apis" && method === "POST") return Response.json([{ id: API_ID }], { status: 201 });
    if (table === "api_audit_events") return new Response(null, { status: 201 });
    if (table === "api_schema" && method === "POST") {
      const rows = body as { direction: string; status_code: string | null; media_type: string }[];
      // Returned in reverse on purpose: the route must pair ids by identity,
      // not by position.
      return Response.json(
        rows.map((r) => ({ id: `schema-${++schemaSeq}`, ...r })).reverse(),
        { status: 201 },
      );
    }
    if (table === "api_schema_field" && method === "POST") {
      return options.failFields ? new Response("boom", { status: 500 }) : new Response(null, { status: 201 });
    }
    if (table === "api_schema" && method === "DELETE") return new Response(null, { status: 204 });
    return new Response("unexpected " + method + " " + table, { status: 500 });
  });

  const user = { id: USER, role: "publisher" as AppRole, displayName: "Jackie", email: "j@example.test" };
  const load = routeHarness({
    "@/lib/auth": {
      APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES,
      getCurrentAppUser: async () => user,
      requireRole: async () => ({ user }),
    },
  });
  return { route: load("app/api/import/route.ts"), calls };
}

function confirmRequest() {
  return new Request("https://catalogue.example.test/api/import", {
    method: "POST",
    headers: { origin: "https://catalogue.example.test", host: "catalogue.example.test", "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION, selected: [0] }),
  });
}

test("confirm writes the operation's schemas against the id the insert returned", async (t) => {
  const { route, calls } = setup(t, { schemas: [requestSchema, responseSchema] });
  const res = await route.POST(confirmRequest());
  const { summary } = (await res.json()) as { summary: Record<string, unknown> };

  assert.equal(summary.inserted, 1);
  assert.equal(summary.schemas, 2);

  const schemaInsert = calls.find((c) => c.path === "api_schema" && c.method === "POST");
  const rows = schemaInsert?.body as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.api_id, API_ID);
    assert.equal(row.origin, "extracted");
    assert.equal(row.source_url, DOC_URL);
    assert.equal(row.created_by, "");
  }
});

test("field rows point at the right schema even when ids come back out of order", async (t) => {
  const { route, calls } = setup(t, { schemas: [requestSchema, responseSchema] });
  await route.POST(confirmRequest());

  const fields = calls.find((c) => c.path === "api_schema_field")?.body as Record<string, unknown>[];
  const byPath = new Map(fields.map((f) => [f.path, f]));
  // The mock reversed the returned rows, so position-based pairing would swap
  // these two. Request fields must land on the request schema's id.
  assert.equal(byPath.get("invoiceNumber")?.schema_id, byPath.get("lines[].unitPrice")?.schema_id);
  assert.notEqual(byPath.get("invoiceNumber")?.schema_id, byPath.get("referenceNumber")?.schema_id);
  assert.equal(byPath.get("invoiceNumber")?.is_required, true);
  assert.equal(byPath.get("lines[].unitPrice")?.is_array_item, true);
  assert.equal(byPath.get("lines[].unitPrice")?.leaf_name_norm, "unitprice");

  const schemaRows = calls.find((c) => c.path === "api_schema" && c.method === "POST")?.body as { direction: string }[];
  const requestIndex = schemaRows.findIndex((r) => r.direction === "request");
  // schema-1 was assigned to the first row sent; the mock numbered in send order.
  assert.equal(byPath.get("invoiceNumber")?.schema_id, `schema-${requestIndex + 1}`);
});

test("if the fields cannot be written, the schemas are removed and the operation stays imported", async (t) => {
  const { route, calls } = setup(t, { schemas: [requestSchema], failFields: true });
  const res = await route.POST(confirmRequest());
  const { summary } = (await res.json()) as { summary: { inserted: number; schemas: number; details: { action: string; reason: string }[] } };

  assert.equal(summary.inserted, 1, "a schema failure must not turn an import into a failure");
  assert.equal(summary.schemas, 0);
  const undo = calls.find((c) => c.path === "api_schema" && c.method === "DELETE");
  // Exactly the schema this confirm created, and nothing else the API had.
  assert.equal(undo?.query.get("id"), "in.(schema-1)");
  assert.ok(summary.details.some((d) => d.action === "schema_warning" && d.reason === "schema_fields_not_recorded"));
});

test("a preview created before schemas existed still confirms, and writes none", async (t) => {
  const { route, calls } = setup(t, { schemas: undefined });
  const res = await route.POST(confirmRequest());
  const { summary } = (await res.json()) as { summary: Record<string, unknown> };
  assert.equal(summary.inserted, 1);
  assert.equal(summary.schemas, 0);
  assert.ok(!calls.some((c) => c.path.startsWith("api_schema")));
});

test("an operation whose document stated no schemas writes none and warns about nothing", async (t) => {
  const { route, calls } = setup(t, { schemas: [] });
  const res = await route.POST(confirmRequest());
  const { summary } = (await res.json()) as { summary: { details: { action: string }[] } };
  assert.ok(!calls.some((c) => c.path.startsWith("api_schema")));
  assert.ok(!summary.details.some((d) => d.action === "schema_warning"));
});
