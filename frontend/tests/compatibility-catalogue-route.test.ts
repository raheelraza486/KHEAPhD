import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { routeHarness } from "./helpers/route-harness.ts";

function configuredRoute(t: TestContext, rows: Record<string, unknown>[], status = 200) {
  const previous = {
    url: process.env.SUPABASE_URL,
    secret: process.env.SUPABASE_SECRET_KEY,
    legacy: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.secret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.secret;
    if (previous.legacy === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.legacy;
  });

  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(init.method ?? "GET", "GET");
    return status === 200 ? Response.json(rows) : new Response("private database failure", { status });
  });
  return {
    route: routeHarness({})("app/api/compatibility/apis/route.ts"),
    calls,
  };
}

test("compatibility catalogue reads only the comparison-ready database view", async (t) => {
  const ready = {
    id: "ready", api_name: "Ready API", company_name: "Supplier", category: "Validation",
    api_endpoint: "https://example.test/ready", input_formats: ["JSON"], output_formats: ["JSON"],
    is_active: true, duplicate_of: null, request_count: 2, response_count: 1,
  };
  const { route, calls } = configuredRoute(t, [
    ready,
    { ...ready, id: "request-only", request_count: 1, response_count: 0 },
    { ...ready, id: "duplicate", duplicate_of: "ready" },
  ]);

  const response = await route.GET(new Request("https://catalogue.test/api/compatibility/apis"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body.apis.map((api: { id: string }) => api.id), ["ready"]);
  assert.deepEqual(body.availability, [{ api_id: "ready", request_count: 2, response_count: 1 }]);
  assert.equal(body.mode, "supabase");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, "/rest/v1/v_compatibility_catalogue");
  assert.match(calls[0].searchParams.get("select") ?? "", /request_count,response_count/);
});

test("a deployment awaiting the view still fetches metadata only for schema-complete APIs", async (t) => {
  const previous = {
    url: process.env.SUPABASE_URL,
    secret: process.env.SUPABASE_SECRET_KEY,
  };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  t.after(() => {
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.secret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.secret;
  });

  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith("/v_compatibility_catalogue")) return new Response("missing view", { status: 404 });
    if (url.pathname.endsWith("/api_schema")) {
      return Response.json([
        { id: "ready-request", api_id: "ready", direction: "request", status_code: null },
        { id: "ready-response", api_id: "ready", direction: "response", status_code: "200" },
        { id: "empty-request", api_id: "fieldless", direction: "request", status_code: null },
        { id: "empty-pdf", api_id: "fieldless", direction: "response", status_code: "200" },
      ]);
    }
    if (url.pathname.endsWith("/api_schema_field")) {
      return Response.json([
        { schema_id: "ready-request" },
        { schema_id: "ready-response" },
        { schema_id: "empty-request" },
      ]);
    }
    assert.ok(url.pathname.endsWith("/apis"));
    assert.equal(url.searchParams.get("id"), "in.(ready)");
    return Response.json([{
      id: "ready", api_name: "Ready API", company_name: "Supplier", category: "Validation",
      is_active: true, duplicate_of: null,
    }]);
  });

  const route = routeHarness({})("app/api/compatibility/apis/route.ts");
  const response = await route.GET(new Request("https://catalogue.test/api/compatibility/apis"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.apis.map((api: { id: string }) => api.id), ["ready"]);
  assert.deepEqual(body.availability, [{ api_id: "ready", request_count: 1, response_count: 1 }]);
  assert.deepEqual(calls.map((call) => call.pathname), [
    "/rest/v1/v_compatibility_catalogue",
    "/rest/v1/api_schema",
    "/rest/v1/api_schema_field",
    "/rest/v1/apis",
  ]);
});

test("compatibility catalogue fails closed without leaking database errors", async (t) => {
  const { route } = configuredRoute(t, [], 500);
  const response = await route.GET(new Request("https://catalogue.test/api/compatibility/apis"));
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.error, "The comparison-ready API catalogue is temporarily unavailable.");
  assert.ok(!JSON.stringify(body).includes("private database failure"));
});

test("compatibility catalogue is empty when the repository is not configured", async (t) => {
  const previous = {
    url: process.env.SUPABASE_URL,
    secret: process.env.SUPABASE_SECRET_KEY,
    legacy: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    if (previous.url !== undefined) process.env.SUPABASE_URL = previous.url;
    if (previous.secret !== undefined) process.env.SUPABASE_SECRET_KEY = previous.secret;
    if (previous.legacy !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = previous.legacy;
  });

  const route = routeHarness({})("app/api/compatibility/apis/route.ts");
  const response = await route.GET(new Request("https://catalogue.test/api/compatibility/apis"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.apis, []);
  assert.deepEqual(body.availability, []);
  assert.equal(body.mode, "dataset");
});
