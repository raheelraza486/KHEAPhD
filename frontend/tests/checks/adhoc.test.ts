import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdhocSide } from "../../lib/checks/adhoc.ts";
import { runChecks } from "../../lib/checks/run.ts";
import { routeHarness } from "../helpers/route-harness.ts";
import { ALIASES } from "./helpers.ts";

// #33: a side read from an OpenAPI document or a schema goes through the
// Publisher's import pipeline and is checked by the same engine as a saved
// record.

const SAVED = "11111111-1111-4111-8111-111111111111";
const SAVED_TARGET_SCHEMA = "89999999-9999-4999-8999-999999999999";
const SAVED_ALT_TARGET_SCHEMA = "8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** An OpenAPI 3 document with one operation that returns an invoice. */
const sourceDocument = {
  openapi: "3.0.3", info: { title: "Invoice Generator", version: "1" },
  servers: [{ url: "https://gen.example.test" }],
  paths: { "/invoices": { post: {
    summary: "Generate an invoice", operationId: "generateInvoice",
    requestBody: { content: { "application/json": { schema: { type: "object", properties: { template: { type: "string" } } } } } },
    responses: { "200": { description: "ok", content: { "application/json": { schema: {
      type: "object", required: ["invoiceNumber", "issueDate", "totalAmount"],
      properties: { invoiceNumber: { type: "string" }, issueDate: { type: "string", format: "date" }, totalAmount: { type: "number" } },
    } } } } },
  } } },
};
/** A target that validates one invoice given as JSON. */
const targetDocument = {
  openapi: "3.0.3", info: { title: "Invoice Validator", version: "1" },
  servers: [{ url: "https://val.example.test" }],
  paths: { "/validate": { post: {
    summary: "Validate an invoice", operationId: "validateInvoice",
    requestBody: { required: true, content: { "application/json": { schema: {
      type: "object", required: ["invoiceNumber", "issueDate"],
      properties: { invoiceNumber: { type: "string" }, issueDate: { type: "string", format: "date" }, totalAmount: { type: "number" } },
    } } } },
    responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { valid: { type: "boolean" } } } } } } },
  } } },
};
const aliases = { format: new Map([["application/json", "JSON"], ["JSON", "JSON"]]), provider: new Map<string, string>() };

test("buildAdhocSide reads an OpenAPI operation as the import would: category, formats, schemas, no identity", () => {
  const source = buildAdhocSide({ kind: "openapi", document: sourceDocument, document_url: "https://gen.example.test/openapi.json" }, "source", aliases);
  assert.equal(source.api.id, "adhoc-source");
  assert.equal(source.api.category, "Transformation");
  assert.deepEqual(source.api.output_formats, ["JSON"]);
  assert.ok(source.schemas.some((s) => s.direction === "response" && s.status_code === "200" && s.fields.some((f) => f.path === "invoiceNumber" && f.is_required)));
  const target = buildAdhocSide({ kind: "openapi", document: targetDocument, document_url: "", operation: { path: "/validate", method: "post" } }, "target", aliases);
  assert.equal(target.api.category, "Validation");
  const report = runChecks({ source, target, formatAliases: ALIASES });
  assert.equal(report.overall.overall, "pass", JSON.stringify(report.overall));
  assert.equal(report.check2.semantics?.mappings.length, 3);
});

test("buildAdhocSide: a lone JSON Schema is one side; a document with several operations asks which", () => {
  const schema = buildAdhocSide({ kind: "schema", text: JSON.stringify({ type: "object", required: ["invoiceNumber"], properties: { invoiceNumber: { type: "string" } } }), direction: "request" }, "target", aliases);
  assert.equal(schema.api.category, null);
  assert.deepEqual(schema.api.input_formats, ["JSON"]);
  assert.equal(schema.schemas[0].fields[0].path, "invoiceNumber");
  const two = { ...sourceDocument, paths: { ...sourceDocument.paths, "/credit-notes": sourceDocument.paths["/invoices"] } };
  assert.throws(() => buildAdhocSide({ kind: "openapi", document: two, document_url: "" }, "source", aliases), /2 operations/);
});

const HOST = "catalogue.example.test";
const post = (body: unknown) => new Request(`https://${HOST}/api/checks/adhoc`, { method: "POST", headers: { origin: `https://${HOST}`, host: HOST, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const GUEST = { APP_ROLES: ["viewer", "publisher", "admin"], ADMIN_ROLES: ["admin"], getCurrentAppUser: async () => null, requireRole: async () => ({ response: new Response("", { status: 401 }) }) };

test("POST /api/checks/adhoc: an uploaded document against a saved record returns a report with the fields compared", async () => {
  const tables: Record<string, Record<string, unknown>[]> = {
    apis: [{ id: SAVED, api_name: "Saved validator", company_name: "Vendor B", category: "Validation", api_endpoint: null, http_method: "POST", input_formats: ["JSON"], output_formats: ["JSON"], authentication_method: "API Key", authentication_details: "", is_active: true, duplicate_of: null }],
    format_alias: [{ alias: "JSON", canonical: "JSON" }, { alias: "application/json", canonical: "JSON" }],
    provider_alias: [],
    api_schema: [
      { id: SAVED_TARGET_SCHEMA, api_id: SAVED, direction: "request", status_code: null, media_type: "application/json", raw: { type: "object" }, verified_by: "r", content_hash: "tgt-v1" },
      { id: SAVED_ALT_TARGET_SCHEMA, api_id: SAVED, direction: "request", status_code: null, media_type: "application/json", raw: { type: "object" }, verified_by: "r", content_hash: "tgt-v2" },
    ],
    api_schema_field: [
      { schema_id: SAVED_TARGET_SCHEMA, path: "invoiceNumber", leaf_name: "invoiceNumber", leaf_name_norm: "invoicenumber", json_type: "string", format: null, is_required: true, is_array_item: false, depth: 0, enum_values: null, description: null, },
      { schema_id: SAVED_TARGET_SCHEMA, path: "issueDate", leaf_name: "issueDate", leaf_name_norm: "issuedate", json_type: "string", format: "date", is_required: true, is_array_item: false, depth: 0, enum_values: null, description: null, },
      { schema_id: SAVED_ALT_TARGET_SCHEMA, path: "totalAmount", leaf_name: "totalAmount", leaf_name_norm: "totalamount", json_type: "number", format: null, is_required: true, is_array_item: false, depth: 0, enum_values: null, description: null, },
    ],
    api_parameter: [], check_choice: [], api_invoice_standard_capability: [],
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    let rows = tables[u.pathname.replace("/rest/v1/", "")] ?? [];
    for (const [k, v] of u.searchParams) {
      if (v.startsWith("in.(")) { const set = new Set(v.slice(4, -1).split(",")); rows = rows.filter((r) => set.has(String(r[k]))); }
    }
    return Response.json(rows);
  }) as typeof fetch;
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  try {
    const route = routeHarness({ "@/lib/auth": GUEST })("app/api/checks/adhoc/route.ts");
    const response = await route.POST(post({ source: { text: JSON.stringify(sourceDocument), operation: { path: "/invoices", method: "POST" } }, target: { api_id: SAVED } }));
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.adhoc, true);
    assert.equal(body.report.overall.overall, "pass");
    assert.equal(body.report.source.name, "Invoice Generator generateInvoice");
    assert.equal(body.fields.source.length, 3);
    assert.equal(body.fields.target.length, 2);
    const selectedResponse = await route.POST( post({source: { text: JSON.stringify(sourceDocument), operation: { path: "/invoices", method: "POST" } },target: { api_id: SAVED, schema_id: SAVED_ALT_TARGET_SCHEMA }, }),);
    const selectedBody = await selectedResponse.json();
    assert.equal(selectedResponse.status, 200, JSON.stringify(selectedBody));
    assert.equal(selectedBody.report.check2.schema.target_schema_used?.schema_id, SAVED_ALT_TARGET_SCHEMA);
    assert.deepEqual(selectedBody.fields.target.map((item: { path: string }) => item.path), ["totalAmount"]);
    // A wrong operation names the ones the document has.
    const missing = await route.POST(post({ source: { text: JSON.stringify(sourceDocument), operation: { path: "/nope", method: "GET" } }, target: { api_id: SAVED } }));
    assert.equal(missing.status, 422);
    assert.deepEqual((await missing.json()).operations.source, [{ path: "/invoices", method: "POST" }]);
    const bad = await route.POST(post({ source: { nothing: true }, target: { api_id: SAVED } }));
    assert.equal(bad.status, 400);
  } finally {
    globalThis.fetch = original;
  }
});
