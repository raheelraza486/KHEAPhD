import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES, type AppRole } from "../lib/auth-policy.ts";
import { parseOpenApi3 } from "../lib/openapi/parse.ts";
import type { FetchOutcome } from "../lib/import/fetch.ts";
import { planBackfill } from "../lib/schema/backfill.ts";
import { extractDocumentSchemas } from "../lib/schema/extract.ts";
import { isChainable, parametersForOperation, schemasForOperation } from "../lib/schema/rows.ts";
import { routeHarness } from "./helpers/route-harness.ts";

const DOC = "https://api.ksef.mf.gov.pl/docs/v2/openapi.json";
const polandText = readFileSync(new URL("./fixtures/poland-ksef.json", import.meta.url), "utf8");
const poland = JSON.parse(polandText);
const { candidates } = parseOpenApi3(poland, DOC);
const documentSchemas = extractDocumentSchemas(poland);

const withSchema = candidates.filter((c) => schemasForOperation(c, documentSchemas).some(isChainable));
// An operation whose whole input is path/query parameters states an input
// too, and since migration 0017 it is filled rather than skipped. On this
// document that is four operations the old rule discarded.
const withInput = candidates.filter((c) => schemasForOperation(c, documentSchemas).some(isChainable)
  || parametersForOperation(c, documentSchemas).length > 0);
const withoutInput = candidates.filter((c) => !schemasForOperation(c, documentSchemas).some(isChainable)
  && parametersForOperation(c, documentSchemas).length === 0);

// ---------------------------------------------------------------- planning

test("Poland: every imported operation that states an input is planned for filling", () => {
  const rows = candidates.map((c, i) => ({ id: `api-${i}`, api_endpoint: c.api_endpoint, http_method: c.http_method }));
  const plan = planBackfill(rows, candidates, documentSchemas, new Set());
  assert.equal(plan.fill.length, withInput.length);
  assert.equal(plan.skipped.filter((s) => s.reason === "no_schema_stated").length, withoutInput.length);
  for (const f of plan.fill) assert.ok(f.schemas.every(isChainable), "error envelopes must not be planned");
  for (const f of plan.fill) {
    assert.ok(f.schemas.length > 0 || f.parameters.length > 0,
      "a planned record must have something stored for it");
  }
});

test("Poland: the operations filled by parameters alone state no body at all", () => {
  const rows = candidates.map((c, i) => ({ id: `api-${i}`, api_endpoint: c.api_endpoint, http_method: c.http_method }));
  const plan = planBackfill(rows, candidates, documentSchemas, new Set());
  const parameterOnly = plan.fill.filter((f) => f.schemas.length === 0);
  assert.equal(parameterOnly.length, withInput.length - withSchema.length,
    "exactly the operations the body-only rule used to discard");
  for (const f of parameterOnly) {
    assert.ok(f.parameters.length > 0);
    assert.ok(f.parameters.every((p) => p.location === "path" || p.location === "query"));
  }
});

test("a record that already has schemas is left alone, whoever put them there", () => {
  const c = withSchema[0]!;
  const plan = planBackfill(
    [{ id: "has", api_endpoint: c.api_endpoint, http_method: c.http_method }],
    candidates, documentSchemas, new Set(["has"]),
  );
  assert.deepEqual(plan.fill, []);
  assert.deepEqual(plan.skipped, [{ api_id: "has", reason: "has_schemas" }]);
});

test("a record whose operation the document no longer states is reported, not guessed at", () => {
  const plan = planBackfill(
    [{ id: "gone", api_endpoint: "https://api.ksef.mf.gov.pl/v2/withdrawn", http_method: "POST" }],
    candidates, documentSchemas, new Set(),
  );
  assert.deepEqual(plan.skipped, [{ api_id: "gone", reason: "not_in_document" }]);
});

test("a legacy record without a method is filled when its endpoint identifies one operation", () => {
  const c = withSchema[0]!;
  const plan = planBackfill(
    [{ id: "legacy", api_endpoint: c.api_endpoint, http_method: null }],
    [c], documentSchemas, new Set(),
  );
  assert.equal(plan.fill.length, 1);
  assert.equal(plan.fill[0]!.matched_http_method, c.http_method);
  assert.equal(plan.fill[0]!.match_basis, "unique_endpoint");
  assert.deepEqual(plan.fill[0]!.schemas, schemasForOperation(c, documentSchemas).filter(isChainable));
});

test("a legacy endpoint with multiple methods is ambiguous even when only one has schemas", () => {
  const c = withSchema[0]!;
  const other = { ...c, http_method: c.http_method === "GET" ? "DELETE" as const : "GET" as const };
  const plan = planBackfill(
    [{ id: "legacy", api_endpoint: c.api_endpoint, http_method: null }],
    [c, other], documentSchemas.filter((d) => d.http_method === c.http_method), new Set(),
  );
  assert.deepEqual(plan, { fill: [], skipped: [{ api_id: "legacy", reason: "ambiguous_operation" }] });
});

test("legacy matching normalises URL host and default port but preserves path and protocol", () => {
  const c = { ...withSchema[0]!, api_endpoint: "https://api.example.test/Invoices" };
  const plan = planBackfill([
    { id: "normalised", api_endpoint: "https://API.EXAMPLE.TEST:443/Invoices#response", http_method: null },
    { id: "path-case", api_endpoint: "https://api.example.test/invoices", http_method: null },
    { id: "slash", api_endpoint: "https://api.example.test/Invoices/", http_method: null },
    { id: "protocol", api_endpoint: "http://api.example.test/Invoices", http_method: null },
    { id: "other-host", api_endpoint: "https://other.example.test/Invoices", http_method: null },
  ], [c], documentSchemas, new Set());
  assert.deepEqual(plan.fill.map((f) => f.api_id), ["normalised"]);
  assert.deepEqual(plan.skipped, ["path-case", "slash", "protocol", "other-host"].map((api_id) => ({ api_id, reason: "not_in_document" })));
});

test("a query-bearing legacy URL matches a unique query-free documented operation", () => {
  const c = withSchema[0]!;
  const plan = planBackfill(
    [{ id: "legacy", api_endpoint: `${c.api_endpoint}?page=1&format=json#details`, http_method: null }],
    [c], documentSchemas, new Set(),
  );
  assert.equal(plan.fill.length, 1);
  assert.equal(plan.fill[0]!.match_basis, "unique_endpoint_without_query");
});

test("query fallback never selects among methods or documented query variants", () => {
  const c = withSchema[0]!;
  const row = { id: "legacy", api_endpoint: `${c.api_endpoint}?mode=third`, http_method: null };
  const otherMethod = { ...c, http_method: c.http_method === "GET" ? "DELETE" as const : "GET" as const };
  for (const possible of [
    [c, otherMethod],
    [c, { ...c, api_endpoint: `${c.api_endpoint}?mode=second` }],
  ]) {
    const plan = planBackfill([row], possible, documentSchemas, new Set());
    assert.deepEqual(plan, { fill: [], skipped: [{ api_id: "legacy", reason: "ambiguous_operation" }] });
  }
  const mismatchedQuery = planBackfill([row], [{ ...c, api_endpoint: `${c.api_endpoint}?mode=first` }], documentSchemas, new Set());
  assert.deepEqual(mismatchedQuery.skipped, [{ api_id: "legacy", reason: "not_in_document" }]);
});

test("a documented query endpoint can match exactly without matching a different query", () => {
  const c = withSchema[0]!;
  const first = { ...c, api_endpoint: `${c.api_endpoint}?mode=first` };
  const second = { ...c, api_endpoint: `${c.api_endpoint}?mode=second` };
  const plan = planBackfill(
    [{ id: "legacy", api_endpoint: first.api_endpoint, http_method: null }],
    [first, second], documentSchemas, new Set(),
  );
  assert.equal(plan.fill.length, 1);
  assert.equal(plan.fill[0]!.match_basis, "unique_endpoint");
});

test("repeated copies of one documented operation do not create false ambiguity", () => {
  const c = withSchema[0]!;
  const plan = planBackfill(
    [{ id: "legacy", api_endpoint: c.api_endpoint, http_method: null }],
    [c, { ...c }], documentSchemas, new Set(),
  );
  assert.equal(plan.fill.length, 1);
});

test("legacy records with saved schemas are preserved even when their endpoint is ambiguous", () => {
  const c = withSchema[0]!;
  const plan = planBackfill(
    [{ id: "legacy", api_endpoint: c.api_endpoint, http_method: null }],
    [c, { ...c, http_method: c.http_method === "GET" ? "DELETE" : "GET" }], documentSchemas, new Set(["legacy"]),
  );
  assert.deepEqual(plan, { fill: [], skipped: [{ api_id: "legacy", reason: "has_schemas" }] });
});

test("an unmatched legacy endpoint is explicitly reported", () => {
  const plan = planBackfill([
    { id: "gone", api_endpoint: "https://api.ksef.mf.gov.pl/v2/withdrawn", http_method: null },
    { id: "empty", api_endpoint: "", http_method: null },
  ], candidates, documentSchemas, new Set());
  assert.deepEqual(plan, { fill: [], skipped: [
    { api_id: "gone", reason: "not_in_document" },
    { api_id: "empty", reason: "not_in_document" },
  ] });
});

test("a unique legacy operation with no schema is reported without fabricating fields", () => {
  const c = withSchema[0]!;
  const plan = planBackfill(
    [{ id: "legacy", api_endpoint: c.api_endpoint, http_method: null }],
    [c], [], new Set(),
  );
  assert.deepEqual(plan, { fill: [], skipped: [{ api_id: "legacy", reason: "no_schema_stated" }] });
});

test("the same endpoint under a different method is a different operation", () => {
  const c = withSchema[0]!;
  const other = c.http_method === "GET" ? "DELETE" : "GET";
  const plan = planBackfill(
    [{ id: "x", api_endpoint: c.api_endpoint, http_method: other }],
    candidates.filter((k) => !(k.api_endpoint === c.api_endpoint && k.http_method === other)),
    documentSchemas, new Set(),
  );
  assert.equal(plan.fill.length, 0);
});

// ---------------------------------- query templates in a saved endpoint

test("a saved endpoint whose query is a parameter template matches on its base path", () => {
  // 22 live records were entered with the parameter names in the address,
  // e.g. .../requests?pageNo={pageNo}&pageSize={pageSize}. An OpenAPI path
  // never carries a query, so the exact key cannot match one of these.
  const c = withSchema[0]!;
  const plan = planBackfill(
    [{ id: "tpl", api_endpoint: `${c.api_endpoint}?pageNo={pageNo}&pageSize={pageSize}`,
       http_method: c.http_method }],
    [c], documentSchemas, new Set(),
  );
  assert.equal(plan.fill.length, 1);
  assert.equal(plan.fill[0]?.match_basis, "method_and_base_endpoint");
  assert.deepEqual(plan.skipped, []);
});

test("the method still has to agree: a template does not let another method in", () => {
  const c = withSchema.find((x) => x.http_method === "POST") ?? withSchema[0]!;
  const other = c.http_method === "POST" ? "DELETE" : "POST";
  const plan = planBackfill(
    [{ id: "tpl", api_endpoint: `${c.api_endpoint}?page={page}`, http_method: other }],
    [c], documentSchemas, new Set(),
  );
  assert.deepEqual(plan.fill, []);
  assert.deepEqual(plan.skipped, [{ api_id: "tpl", reason: "not_in_document" }]);
});

test("a documented query at the same base path refuses the match", () => {
  // A query the document itself states is a discriminator, not noise. This is
  // the same rule the method-less path already follows.
  const c = withSchema[0]!;
  const documented = { ...c, api_endpoint: `${c.api_endpoint}?view=full` };
  const plan = planBackfill(
    [{ id: "tpl", api_endpoint: `${c.api_endpoint}?view={view}`, http_method: c.http_method }],
    [documented], documentSchemas, new Set(),
  );
  assert.deepEqual(plan.fill, []);
  assert.equal(plan.skipped[0]?.reason, "not_in_document");
});

test("records with saved methods still require the exact importer operation key", () => {
  const c = withSchema[0]!;
  const plan = planBackfill(
    [{ id: "known", api_endpoint: `${c.api_endpoint}?page=1`, http_method: c.http_method }],
    [c], documentSchemas, new Set(),
  );
  assert.deepEqual(plan, { fill: [], skipped: [{ api_id: "known", reason: "not_in_document" }] });
});

// ------------------------------------------------------------------ route

const OWNER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = {
  id: string; api_name: string; company_name: string; api_endpoint: string; http_method: string | null;
  documentation_url: string; is_active: boolean; duplicate_of: string | null; created_by_user: string | null;
};
type Call = { method: string; table: string; query: URLSearchParams; body: unknown };

function row(n: number, c: { api_endpoint: string; http_method: string | null } | null, owner = OWNER): Row {
  return {
    id: id(n), api_name: `op ${n}`, company_name: "KSeF",
    api_endpoint: c?.api_endpoint ?? "https://api.ksef.mf.gov.pl/v2/manual",
    http_method: c ? c.http_method : null, documentation_url: DOC,
    is_active: true, duplicate_of: null, created_by_user: owner,
  };
}

function setup(
  t: TestContext,
  rows: Row[],
  opts: { role?: AppRole; userId?: string; hasSchemas?: string[]; refuse?: boolean;
    documentBody?: string; finalUrl?: string; fetchDocument?: (url: string) => Promise<FetchOutcome> } = {},
) {
  const calls: Call[] = [];
  const documentRequests: string[] = [];
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
    if (table === "apis") {
      const byId = u.searchParams.get("id");
      if (byId) return Response.json(rows.filter((r) => `eq.${r.id}` === byId));
      return Response.json(u.searchParams.get("http_method") === "not.is.null" ? rows.filter((r) => r.http_method !== null) : rows);
    }
    if (table === "api_schema" && method === "GET") {
      return Response.json((opts.hasSchemas ?? []).map((api_id) => ({ api_id })));
    }
    if (table === "api_schema" && method === "POST") {
      return Response.json((body as Record<string, unknown>[]).map((r) => ({ id: `s-${++seq}`, ...r })), { status: 201 });
    }
    if (table === "api_schema_field" || table === "api_audit_events") return new Response(null, { status: 201 });
    // Migration 0017. writeParameterSet clears the API's parameters and then
    // inserts the set the document states.
    if (table === "api_parameter" && method === "DELETE") return new Response(null, { status: 204 });
    if (table === "api_parameter" && method === "POST") return new Response(null, { status: 201 });
    return new Response(`unexpected ${method} ${table}`, { status: 500 });
  });

  const role = opts.role ?? "publisher";
  const user = { id: opts.userId ?? OWNER, role, displayName: "Jackie", email: "j@example.test" };
  const load = routeHarness({
    "@/lib/auth": {
      APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES,
      getCurrentAppUser: async () => user,
      requireRole: async (_r: Request, allowed: readonly AppRole[]) => allowed.includes(user.role)
        ? { user } : { response: Response.json({}, { status: 403 }) },
    },
    // The one outside dependency: the document is served from the fixture
    // instead of the network. Detection, parsing and extraction are real.
    "@/lib/import/fetch": {
      safeFetch: async (url: string) => {
        documentRequests.push(url);
        if (opts.fetchDocument) return opts.fetchDocument(url);
        return opts.refuse
          ? { ok: false, refusal: "unresolvable_host" }
          : { ok: true, body: opts.documentBody ?? polandText, finalUrl: opts.finalUrl ?? DOC };
      },
    },
  });
  return { route: load("app/api/schemas/backfill/route.ts"), calls, documentRequests };
}

function backfill(apiId: string) {
  return new Request("https://catalogue.example.test/api/schemas/backfill", {
    method: "POST",
    headers: { origin: "https://catalogue.example.test", host: "catalogue.example.test", "Content-Type": "application/json" },
    body: JSON.stringify({ api_id: apiId }),
  });
}

test("one request fills the asked-for API and its siblings from the same document", async (t) => {
  const rows = [row(1, withSchema[0]!), row(2, withSchema[1]!), row(3, withSchema[2]!)];
  const { route, calls } = setup(t, rows);
  const res = await route.POST(backfill(id(1)));
  const data = (await res.json()) as { filled: number; this_api: string; schemas: number };
  assert.equal(res.status, 200);
  assert.equal(data.filled, 3);
  assert.equal(data.this_api, "filled");
  const inserts = calls.filter((c) => c.table === "api_schema" && c.method === "POST");
  assert.deepEqual(
    inserts.map((c) => (c.body as { api_id: string }[])[0]?.api_id).sort(),
    [id(1), id(2), id(3)],
  );
  for (const c of inserts) {
    for (const r of c.body as { origin: string; source_url: string }[]) {
      assert.equal(r.origin, "extracted");
      assert.equal(r.source_url, DOC);
    }
  }
  assert.equal(calls.filter((c) => c.table === "api_audit_events").length, 3);
});

test("an administrator fills legacy APIs and legacy siblings without changing their metadata", async (t) => {
  const unique = withSchema.filter((c) => candidates.filter((other) => other.api_endpoint === c.api_endpoint).length === 1);
  assert.ok(unique.length >= 2, "fixture must have unambiguous operations");
  const rows = [row(1, { ...unique[0]!, http_method: null }), row(2, { ...unique[1]!, http_method: null }, OTHER)];
  const { route, calls } = setup(t, rows, { role: "admin" });
  const res = await route.POST(backfill(id(1)));
  const data = (await res.json()) as { filled: number; this_api: string };
  assert.equal(res.status, 200);
  assert.equal(data.filled, 2);
  assert.equal(data.this_api, "filled");
  assert.ok(!calls.some((c) => c.table === "apis" && c.method !== "GET"));
});

test("a submitter fills only their own records; the rest are counted, not touched", async (t) => {
  const rows = [row(1, withSchema[0]!), row(2, withSchema[1]!, OTHER)];
  const { route, calls } = setup(t, rows);
  const data = (await (await route.POST(backfill(id(1)))).json()) as { filled: number; skipped: Record<string, number> };
  assert.equal(data.filled, 1);
  assert.equal(data.skipped.not_yours, 1);
  const touched = calls.filter((c) => c.table === "api_schema" && c.method === "POST")
    .map((c) => (c.body as { api_id: string }[])[0]?.api_id);
  assert.deepEqual(touched, [id(1)]);
});

test("an administrator fills every record from the document", async (t) => {
  const rows = [row(1, withSchema[0]!), row(2, withSchema[1]!, OTHER)];
  const { route } = setup(t, rows, { role: "admin", userId: OTHER });
  const data = (await (await route.POST(backfill(id(1)))).json()) as { filled: number };
  assert.equal(data.filled, 2);
});

test("records that already have schemas are skipped and reported", async (t) => {
  const rows = [row(1, withSchema[0]!), row(2, withSchema[1]!)];
  const { route } = setup(t, rows, { hasSchemas: [id(2)] });
  const data = (await (await route.POST(backfill(id(1)))).json()) as { filled: number; skipped: Record<string, number> };
  assert.equal(data.filled, 1);
  assert.equal(data.skipped.has_schemas, 1);
});

test("the answer says plainly when the asked-for API itself states no input", async (t) => {
  if (withoutInput.length === 0) return; // fixture-dependent; KSeF has some
  const { route } = setup(t, [row(1, withoutInput[0]!)]);
  const data = (await (await route.POST(backfill(id(1)))).json()) as { this_api: string; filled: number };
  assert.equal(data.filled, 0);
  assert.equal(data.this_api, "no_schema_stated");
});

test("an unmatched legacy API reports that the document does not contain its endpoint", async (t) => {
  const { route, calls } = setup(t, [row(1, null)]);
  const res = await route.POST(backfill(id(1)));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { this_api: string }).this_api, "not_in_document");
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("a documentation link the fetcher refuses comes back as 422 with the reason", async (t) => {
  const { route } = setup(t, [row(1, withSchema[0]!)], { refuse: true });
  const res = await route.POST(backfill(id(1)));
  assert.equal(res.status, 422);
  assert.match(((await res.json()) as { error: string }).error, /could not be resolved/);
});

test("someone else's API is refused before anything is fetched", async (t) => {
  const { route, calls } = setup(t, [row(1, withSchema[0]!)], { userId: OTHER });
  const res = await route.POST(backfill(id(1)));
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.table === "api_schema"));
});

test("the web route matches legacy endpoints against every explicitly declared OpenAPI server", async (t) => {
  const document = {
    openapi: "3.0.3", info: { title: "Multi-server", version: "1" },
    servers: [{ url: "https://core.example.test" }, { url: "https://portal.example.test" }],
    paths: { "/invoices": { post: {
      requestBody: { content: { "application/json": { schema: { type: "object", properties: { invoice: { type: "string" } } } } } },
      responses: { "200": { description: "Accepted", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } },
    } } },
  };
  const rows = [
    row(1, { api_endpoint: "https://core.example.test/invoices", http_method: null }),
    row(2, { api_endpoint: "https://portal.example.test/invoices", http_method: null }),
    row(3, { api_endpoint: "https://unrelated.example.test/invoices", http_method: null }),
  ];
  const { route, calls, documentRequests } = setup(t, rows, { role: "admin", documentBody: JSON.stringify(document) });
  const response = await route.POST(backfill(id(2)));
  const data = await response.json() as { filled: number; schemas: number; this_api: string; skipped: Record<string, number> };
  assert.equal(response.status, 200);
  assert.equal(data.filled, 2);
  assert.equal(data.schemas, 4);
  assert.equal(data.this_api, "filled");
  assert.equal(data.skipped.not_in_document, 1);
  assert.deepEqual(documentRequests, [DOC], "siblings share one fetched document");
  assert.ok(!calls.some((call) => call.table === "apis" && call.method !== "GET"));
});

test("the web route follows the shared loader's declared UI link and persists the final spec provenance", async (t) => {
  const page = "https://docs.example.test/ui/";
  const spec = "https://docs.example.test/openapi.json";
  const api = { ...row(1, withSchema[0]!), documentation_url: page };
  const { route, calls, documentRequests } = setup(t, [api], {
    fetchDocument: async (url) => ({ ok: true,
      body: url === page ? '<html><redoc spec-url="../openapi.json"></redoc></html>' : polandText,
      finalUrl: url }),
  });
  const response = await route.POST(backfill(id(1)));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { filled: number }).filled, 1);
  assert.deepEqual(documentRequests, [page, spec]);
  for (const call of calls.filter((entry) => entry.table === "api_schema" && entry.method === "POST")) {
    assert.ok((call.body as { source_url: string }[]).every((schema) => schema.source_url === spec));
  }
});

test("the web route reports ambiguous legacy methods and refuses to choose a convenient schema", async (t) => {
  const document = {
    openapi: "3.0.3", info: { title: "Ambiguous", version: "1" }, servers: [{ url: "https://api.example.test" }],
    paths: { "/invoices": {
      get: { responses: { "200": { description: "Invoices", content: { "application/json": { schema: { type: "string" } } } } } },
      post: { responses: { "204": { description: "No content" } } },
    } },
  };
  const { route, calls } = setup(t, [row(1, { api_endpoint: "https://api.example.test/invoices", http_method: null })],
    { role: "admin", documentBody: JSON.stringify(document) });
  const response = await route.POST(backfill(id(1)));
  const data = await response.json() as { filled: number; this_api: string; skipped: Record<string, number> };
  assert.equal(response.status, 200);
  assert.equal(data.filled, 0);
  assert.equal(data.this_api, "ambiguous_operation");
  assert.equal(data.skipped.ambiguous_operation, 1);
  assert.ok(!calls.some((call) => call.method === "POST"));
});

// ------------------------------------------- parameters (migration 0017)

const DOWNLOAD_DOC = "https://provider.example.test/openapi.json";

test("an operation whose whole input is parameters is recovered, body or no body", async (t) => {
  // The shape the Serbian SEF downloads take: a query parameter, a file
  // response, no request body anywhere in the operation.
  const document = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "downloads", version: "1" },
    servers: [{ url: "https://provider.example.test" }],
    paths: {
      "/sales-invoice/xml": {
        get: {
          parameters: [{ name: "invoiceId", in: "query", required: true, schema: { type: "integer", format: "int64" } }],
          responses: { "200": { content: { "application/xml": { schema: { type: "string", format: "binary" } } } } },
        },
      },
    },
  });
  const { route, calls } = setup(t, [{
    id: id(1), api_name: "download", company_name: "co",
    api_endpoint: "https://provider.example.test/sales-invoice/xml",
    http_method: "GET", documentation_url: DOWNLOAD_DOC,
    is_active: true, duplicate_of: null, created_by_user: OWNER,
  }], { documentBody: document, finalUrl: DOWNLOAD_DOC });

  const res = await route.POST(backfill(id(1)));
  assert.equal(res.status, 200);
  const data = (await res.json()) as { filled: number; parameters: number; schemas: number };
  assert.equal(data.filled, 1, "before 0017 this operation was skipped as no_schema_stated");
  assert.equal(data.parameters, 1);

  const written = calls.find((c) => c.table === "api_parameter" && c.method === "POST");
  assert.ok(written, "the parameter has to reach the database, not just the plan");
  const rows = written!.body as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "invoiceId");
  assert.equal(rows[0]?.location, "query");
  assert.equal(rows[0]?.is_required, true);
  assert.equal(rows[0]?.json_type, "integer");
  assert.equal(rows[0]?.name_norm, "invoiceid");
  assert.equal(rows[0]?.origin, "extracted");
  assert.equal(rows[0]?.source_url, DOWNLOAD_DOC, "provenance, as on a schema row");
  // The existing set is cleared first: a re-read of the document is the
  // authority on what the operation declares now.
  assert.ok(calls.some((c) => c.table === "api_parameter" && c.method === "DELETE"));
});

test("a record whose operation states neither a body nor a parameter is still skipped", async (t) => {
  const document = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "bare", version: "1" },
    servers: [{ url: "https://provider.example.test" }],
    paths: { "/ping": { get: { responses: { "204": {} } } } },
  });
  const { route, calls } = setup(t, [{
    id: id(1), api_name: "ping", company_name: "co",
    api_endpoint: "https://provider.example.test/ping",
    http_method: "GET", documentation_url: DOWNLOAD_DOC,
    is_active: true, duplicate_of: null, created_by_user: OWNER,
  }], { documentBody: document, finalUrl: DOWNLOAD_DOC });

  const data = (await (await route.POST(backfill(id(1)))).json()) as { filled: number; this_api: string };
  assert.equal(data.filled, 0);
  assert.equal(data.this_api, "no_schema_stated",
    "the operation is still a candidate; it simply states no input of either kind");
  assert.ok(!calls.some((c) => c.table === "api_parameter" && c.method === "POST"));
});
