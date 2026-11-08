import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { routeHarness } from "./helpers/route-harness.ts";

type Api = { id: string; is_active: boolean; duplicate_of: string | null };
type Schema = { api_id: string; direction: string; status_code: string | null };
const api = (id: string): Api => ({ id, is_active: true, duplicate_of: null });
const schema = (api_id: string, direction = "request", status_code: string | null = null): Schema => ({ api_id, direction, status_code });

function setup(t: TestContext, apis: Api[], schemas: Schema[], fail = false) {
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  t.after(() => { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const calls: { table: string; query: URLSearchParams }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.equal(init.method ?? "GET", "GET", "availability never writes");
    const url = new URL(input), table = url.pathname.replace("/rest/v1/", ""), query = url.searchParams;
    calls.push({ table, query });
    if (fail) return new Response("database details must stay private", { status: 500 });
    const offset = Number(query.get("offset")), limit = Number(query.get("limit"));
    if (table === "apis") {
      const ids = query.has("id") ? (query.get("id") ?? "").slice(4, -1).split(",") : null;
      const matching = ids ? apis.filter((row) => ids.includes(row.id)) : apis;
      return Response.json(matching.slice(offset, offset + limit));
    }
    assert.equal(table, "api_schema", "no fields or audit/profile tables are queried");
    const ids = (query.get("api_id") ?? "").slice(4, -1).split(",");
    return Response.json(schemas.filter((row) => ids.includes(row.api_id)).slice(offset, offset + limit));
  });
  return { route: routeHarness({})("app/api/schemas/availability/route.ts"), calls };
}

test("schema availability publishes only counts for active nonduplicate APIs, without requiring login", async (t) => {
  const { route, calls } = setup(t, [api("visible"), api("empty"), { ...api("inactive"), is_active: false }, { ...api("duplicate"), duplicate_of: "visible" }], [
    schema("visible"), schema("visible", "response", "200"), schema("visible", "response", "default"), schema("visible", "response", "400"),
    schema("inactive"), schema("duplicate"),
  ]);
  const response = await route.GET(new Request("https://catalogue.test/api/schemas/availability"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body.apis, [
    { api_id: "visible", request_count: 1, response_count: 2 },
    { api_id: "empty", request_count: 0, response_count: 0 },
  ]);
  assert.deepEqual(Object.keys(body).sort(), ["apis", "requestId"]);
  assert.equal(calls[0].query.get("is_active"), "eq.true");
  assert.equal(calls[0].query.get("duplicate_of"), "is.null");
  assert.equal(calls[1].query.get("select"), "api_id,direction,status_code");
  assert.ok(!calls[1].query.get("api_id")?.includes("inactive"));
  assert.ok(!calls[1].query.get("api_id")?.includes("duplicate"));
});

test("schema availability pages both catalogue and schemas and bounds API ID query batches", async (t) => {
  const apis = Array.from({ length: 1001 }, (_, index) => api(`api-${index}`));
  const schemas = Array.from({ length: 1002 }, () => schema("api-0"));
  schemas.push(schema("api-1000", "response", "201"));
  const { route, calls } = setup(t, apis, schemas);
  const response = await route.GET(new Request("https://catalogue.test/api/schemas/availability"));
  const body = await response.json();
  assert.equal(body.apis.length, 1001);
  assert.equal(body.apis[0].request_count, 1002);
  assert.equal(body.apis[1000].response_count, 1);
  assert.deepEqual(calls.filter((call) => call.table === "apis").map((call) => call.query.get("offset")), ["0", "1000"]);
  assert.ok(calls.some((call) => call.table === "api_schema" && call.query.get("offset") === "1000"));
  for (const call of calls.filter((item) => item.table === "api_schema")) {
    assert.ok((call.query.get("api_id")?.split(",").length ?? 0) <= 100);
    assert.equal(call.query.get("order"), "id.asc");
  }
});

test("schema availability does not read any schemas when all APIs are hidden", async (t) => {
  const { route, calls } = setup(t, [{ ...api("hidden"), is_active: false }], [schema("hidden")]);
  const response = await route.GET(new Request("https://catalogue.test/api/schemas/availability"));
  assert.deepEqual((await response.json()).apis, []);
  assert.equal(calls.length, 1);
});

test("schema availability returns a retryable error without leaking database details", async (t) => {
  const { route } = setup(t, [], [], true);
  const response = await route.GET(new Request("https://catalogue.test/api/schemas/availability"));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "Schema availability could not be read.");
});

test("one API detail can request only its schema counts", async (t) => {
  const selected = "10000000-0000-4000-8000-000000000001";
  const other = "10000000-0000-4000-8000-000000000002";
  const { route, calls } = setup(t, [api(selected), api(other)], [schema(selected), schema(other, "response", "200")]);
  const response = await route.GET(new Request(`https://catalogue.test/api/schemas/availability?api_id=${selected}`));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).apis, [{ api_id: selected, request_count: 1, response_count: 0 }]);
  assert.equal(calls[0].query.get("id"), `in.(${selected})`);
  assert.ok(!calls[1].query.get("api_id")?.includes(other));
});

test("filtered availability rejects unsafe API identifiers before database access", async (t) => {
  const { route, calls } = setup(t, [], []);
  const response = await route.GET(new Request("https://catalogue.test/api/schemas/availability?api_id=not-a-uuid"));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});
