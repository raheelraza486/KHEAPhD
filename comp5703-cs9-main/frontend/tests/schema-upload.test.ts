import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_UPLOAD_CHARS, resolveUpload } from "../lib/schema/upload.ts";

// Hand-written documents in the shape the client's demonstration inputs take
// -- one OpenAPI 3 document, one operation. The client's own files stay out
// of this repository: client material may not be committed here.

const oneOperation = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Invoice fetch", version: "1.0.0" },
  paths: {
    "/invoices/{id}": {
      get: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["invoiceNumber"],
                  properties: {
                    invoiceNumber: { type: "string" },
                    total: { type: "number" },
                  },
                },
              },
            },
          },
          "404": {
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
        },
      },
    },
  },
});

const twoOperations = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Invoices", version: "1.0.0" },
  paths: {
    "/invoices": {
      post: {
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { number: { type: "string" } } } } },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } },
      },
    },
    "/invoices/{id}": {
      get: {
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { number: { type: "string" } } } } } } },
      },
    },
  },
});

// ----------------------------------------------------------------- openapi

test("a one-operation document attaches without asking which operation", () => {
  const result = resolveUpload({ kind: "openapi", text: oneOperation });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.schemas.length, 1, "the 404 error response must not be stored");
  assert.equal(result.schemas[0]?.status_code, "200");
  assert.deepEqual(result.schemas[0]?.fields.map((f) => f.path).sort(), ["invoiceNumber", "total"]);
});

test("a YAML document is accepted as well as JSON", () => {
  const yaml = [
    "openapi: 3.0.3",
    "info: { title: Y, version: '1' }",
    "paths:",
    "  /x:",
    "    post:",
    "      requestBody:",
    "        content:",
    "          application/json:",
    "            schema:",
    "              type: object",
    "              properties:",
    "                amount: { type: number }",
    "      responses: {}",
  ].join("\n");
  const result = resolveUpload({ kind: "openapi", text: yaml });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.schemas[0]?.fields[0]?.path, "amount");
});

test("a document with several operations must say which one, and lists them", () => {
  const result = resolveUpload({ kind: "openapi", text: twoOperations });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /2 operations/);
  assert.deepEqual(
    result.operations?.map((o) => `${o.method} ${o.path}`).sort(),
    ["GET /invoices/{id}", "POST /invoices"],
  );
});

test("naming the operation picks it, case of the method notwithstanding", () => {
  const result = resolveUpload({
    kind: "openapi", text: twoOperations, operation: { path: "/invoices", method: "post" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.schemas.map((s) => s.direction).sort(), ["request", "response"]);
});

test("naming an operation the document does not have is refused, with the real list", () => {
  const result = resolveUpload({
    kind: "openapi", text: twoOperations, operation: { path: "/nope", method: "GET" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.operations?.length, 2);
});

test("Swagger 2.0 is named as such rather than rejected as unreadable", () => {
  const result = resolveUpload({
    kind: "openapi", text: JSON.stringify({ swagger: "2.0", info: { title: "s", version: "1" }, paths: {} }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Swagger 2\.0/);
});

test("a document with only error responses has nothing to store", () => {
  const result = resolveUpload({
    kind: "openapi",
    text: JSON.stringify({
      openapi: "3.0.0", info: { title: "e", version: "1" },
      paths: { "/x": { get: { responses: { "500": { content: { "application/json": { schema: { type: "object", properties: { e: { type: "string" } } } } } } } } } },
    }),
  });
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------------ schema

test("a bare JSON Schema becomes one schema for the side named", () => {
  const result = resolveUpload({
    kind: "schema", direction: "request",
    text: JSON.stringify({ type: "object", required: ["abn"], properties: { abn: { type: "string" } } }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [s] = result.schemas;
  assert.equal(s?.direction, "request");
  assert.equal(s?.status_code, null);
  assert.equal(s?.media_type, "application/json");
  assert.equal(s?.fields[0]?.is_required, true);
});

test("a response schema with no status is recorded as 200, not left blank", () => {
  const result = resolveUpload({
    kind: "schema", direction: "response",
    text: JSON.stringify({ type: "object", properties: { id: { type: "string" } } }),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.schemas[0]?.status_code, "200");
});

test("an error status is refused for an upload, as it is for extraction", () => {
  const result = resolveUpload({
    kind: "schema", direction: "response", status_code: "400",
    text: JSON.stringify({ type: "object", properties: { e: { type: "string" } } }),
  });
  assert.equal(result.ok, false);
});

test("a pasted schema's own #/definitions references are resolved against itself", () => {
  const result = resolveUpload({
    kind: "schema", direction: "request",
    text: JSON.stringify({
      type: "object",
      properties: { seller: { $ref: "#/definitions/Party" } },
      definitions: { Party: { type: "object", properties: { name: { type: "string" } } } },
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.schemas[0]?.fields.some((f) => f.path === "seller.name"));
  assert.ok(!JSON.stringify(result.schemas[0]?.raw).includes('"$ref":"#/'));
});

test("an example payload is told apart from a schema and refused with the reason", () => {
  // The commonest mistake: pasting an invoice instead of the schema of one.
  const result = resolveUpload({
    kind: "schema", direction: "request",
    text: JSON.stringify({ invoiceNumber: "INV-001", total: 110 }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /example payload/);
});

test("text that is neither JSON nor YAML is refused", () => {
  const result = resolveUpload({ kind: "schema", direction: "request", text: "{ not: [valid" });
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------------ limits

test("empty and oversized uploads are refused before any parsing", () => {
  assert.equal(resolveUpload({ kind: "openapi", text: "   " }).ok, false);
  const big = "x".repeat(MAX_UPLOAD_CHARS + 1);
  const result = resolveUpload({ kind: "openapi", text: big });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /larger than/);
});
