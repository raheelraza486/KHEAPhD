import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { flattenSchema, type ExtractedSchema } from "../lib/schema/extract.ts";
import { writeSchemaSet } from "../lib/schema/store.ts";

const CONFIG = { url: "https://database.example.test", key: "test-only-secret", opaqueSecret: true };
const API_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "20000000-0000-4000-8000-000000000001";
const RESPONSE_ID = "20000000-0000-4000-8000-000000000002";
const EXISTING_ID = "20000000-0000-4000-8000-000000000099";

function schema(direction: "request" | "response", property: string): ExtractedSchema {
  const raw = { type: "object", required: [property], properties: { [property]: { type: "string" } } };
  return { direction, media_type: "application/json", status_code: direction === "request" ? null : "200",
    raw, fields: flattenSchema(raw, {}).fields, warnings: [] };
}
const SCHEMAS = [schema("request", "submittedInvoice"), schema("response", "receiptId")];
const ORIGIN = { kind: "extracted" as const, sourceUrl: "https://docs.example.test/openapi.json" };
type Call = { url: URL; init: RequestInit; body: unknown };

function setup(t: TestContext, options: {
  fields?: "http-failure" | "throw";
  cleanup?: "http-failure" | "throw";
  initial?: "conflict" | "throw";
} = {}) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body });
    assert.equal(url.origin, CONFIG.url);
    assert.ok(init.signal instanceof AbortSignal, "each database operation must have a timeout signal");
    if (url.pathname.endsWith("/api_schema") && init.method === "POST") {
      if (options.initial === "conflict") return new Response(null, { status: 409 });
      if (options.initial === "throw") throw new Error("Connection interrupted");
      // PostgREST does not promise returned rows preserve submitted order.
      return Response.json([
        { id: RESPONSE_ID, direction: "response", status_code: "200", media_type: "application/json" },
        { id: REQUEST_ID, direction: "request", status_code: null, media_type: "application/json" },
      ]);
    }
    if (url.pathname.endsWith("/api_schema_field") && init.method === "POST") {
      if (options.fields === "http-failure") return new Response(null, { status: 503 });
      if (options.fields === "throw") throw new Error("Field request timed out");
      return new Response(null, { status: 201 });
    }
    if (url.pathname.endsWith("/api_schema") && init.method === "DELETE") {
      if (options.cleanup === "http-failure") return new Response(null, { status: 503 });
      if (options.cleanup === "throw") throw new Error("Cleanup timed out");
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected database operation ${init.method} ${url.pathname}`);
  });
  return calls;
}

test("schema writes pair fields with returned schema identities even when IDs arrive out of order", async (t) => {
  const calls = setup(t);
  const outcome = await writeSchemaSet(CONFIG, API_ID, SCHEMAS, ORIGIN);
  assert.deepEqual(outcome, { ok: true, schemas: 2, fields: 2 });
  assert.equal(calls.length, 2);
  const fields = calls[1]!.body as { path: string; schema_id: string }[];
  assert.deepEqual(fields.map((field) => ({ path: field.path, schema_id: field.schema_id })), [
    { path: "submittedInvoice", schema_id: REQUEST_ID },
    { path: "receiptId", schema_id: RESPONSE_ID },
  ]);
  const rows = calls[0]!.body as { api_id: string; origin: string; source_url: string }[];
  assert.ok(rows.every((row) => row.api_id === API_ID && row.origin === "extracted" && row.source_url === ORIGIN.sourceUrl));
});

for (const fields of ["http-failure", "throw"] as const) {
  test(`${fields} during field insertion cleans up only schemas created by this call`, async (t) => {
    const calls = setup(t, { fields });
    const outcome = await writeSchemaSet(CONFIG, API_ID, SCHEMAS, ORIGIN);
    assert.deepEqual(outcome, { ok: false, error: "schema_fields_not_recorded" });
    const deletions = calls.filter((call) => call.init.method === "DELETE");
    assert.equal(deletions.length, 1);
    const cleanup = deletions[0]!.url;
    assert.equal(cleanup.searchParams.get("id"), `in.(${RESPONSE_ID},${REQUEST_ID})`);
    assert.equal(cleanup.searchParams.has("api_id"), false, "cleanup must never delete all schemas for an API");
    assert.equal(cleanup.toString().includes(EXISTING_ID), false);
  });
}

for (const cleanup of ["http-failure", "throw"] as const) {
  test(`${cleanup} during cleanup reports partially stored schema data`, async (t) => {
    const calls = setup(t, { fields: "throw", cleanup });
    assert.deepEqual(await writeSchemaSet(CONFIG, API_ID, SCHEMAS, ORIGIN), { ok: false, error: "schema_fields_partial" });
    assert.equal(calls.length, 3);
    assert.equal(calls[2]!.init.method, "DELETE");
  });
}

test("an existing-schema uniqueness conflict never triggers an upsert, replacement or deletion", async (t) => {
  const calls = setup(t, { initial: "conflict" });
  assert.deepEqual(await writeSchemaSet(CONFIG, API_ID, SCHEMAS, ORIGIN), { ok: false, error: "schemas_not_recorded" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.url.searchParams.has("on_conflict"), false);
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("prefer"), "return=representation");
  assert.equal(headers.has("authorization"), false, "opaque server secrets use apikey only");
});

test("a failed initial schema request cannot attempt fields or delete preexisting schemas", async (t) => {
  const calls = setup(t, { initial: "throw" });
  assert.deepEqual(await writeSchemaSet(CONFIG, API_ID, SCHEMAS, ORIGIN), { ok: false, error: "schemas_not_recorded" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.method, "POST");
});

test("an empty schema set performs no database operation", async (t) => {
  const calls = setup(t);
  assert.deepEqual(await writeSchemaSet(CONFIG, API_ID, [], ORIGIN), { ok: true, schemas: 0, fields: 0 });
  assert.deepEqual(calls, []);
});
