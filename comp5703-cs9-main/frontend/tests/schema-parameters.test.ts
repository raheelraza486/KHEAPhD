import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDocumentSchemas } from "../lib/schema/extract.ts";
import {
  extractOperationParameters, parameterFieldPath, parameterIdentity, toOpenApiParameters,
} from "../lib/schema/parameters.ts";
import { compareParameters } from "../lib/compatibility/parameters.ts";

// Hand-written documents in the shape the live catalogue's parameter-only
// operations take: the Serbian SEF downloads are GET .../xml?invoiceId=N with
// no request body and a file response. Client material stays out of the
// repository.

const root = {} as Record<string, unknown>;

test("a path parameter is required whatever the document says", () => {
  const { parameters } = extractOperationParameters(
    {}, { parameters: [{ name: "irn", in: "path", required: false, schema: { type: "string" } }] }, root,
  );
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0]?.is_required, true, "the specification makes path parameters required");
  assert.equal(parameters[0]?.location, "path");
});

test("a query parameter is required only when the document says so", () => {
  const { parameters } = extractOperationParameters({}, {
    parameters: [
      { name: "invoiceId", in: "query", required: true, schema: { type: "integer", format: "int64" } },
      { name: "page", in: "query", schema: { type: "integer" } },
    ],
  }, root);
  assert.deepEqual(parameters.map((p) => [p.name, p.is_required]), [["invoiceId", true], ["page", false]]);
  assert.equal(parameters[0]?.json_type, "integer");
  assert.equal(parameters[0]?.format, "int64");
});

test("header and cookie parameters are not stored", () => {
  const { parameters } = extractOperationParameters({}, {
    parameters: [
      { name: "Authorization", in: "header", required: true, schema: { type: "string" } },
      { name: "session", in: "cookie", schema: { type: "string" } },
      { name: "id", in: "path", schema: { type: "string" } },
    ],
  }, root);
  assert.deepEqual(parameters.map((p) => p.name), ["id"]);
});

test("path-item parameters apply to the operation, and the operation overrides by (name, in)", () => {
  const { parameters } = extractOperationParameters(
    { parameters: [
      { name: "id", in: "path", schema: { type: "string" } },
      { name: "page", in: "query", schema: { type: "integer" } },
    ] },
    { parameters: [{ name: "page", in: "query", required: true, schema: { type: "string" } }] },
    root,
  );
  assert.deepEqual(parameters.map((p) => p.name), ["id", "page"], "path-item order is kept");
  const page = parameters.find((p) => p.name === "page");
  assert.equal(page?.is_required, true, "the operation's entry wins");
  assert.equal(page?.json_type, "string");
});

test("a name that is also a query parameter is a different parameter from the path one", () => {
  const { parameters } = extractOperationParameters({}, {
    parameters: [
      { name: "id", in: "path", schema: { type: "string" } },
      { name: "id", in: "query", schema: { type: "integer" } },
    ],
  }, root);
  assert.equal(parameters.length, 2, "(name, in) is the identity, not name alone");
  assert.deepEqual(parameters.map(parameterIdentity), ["path:id", "query:id"]);
});

test("a parameter $ref is followed, and its schema's own $ref with it", () => {
  const document = {
    components: {
      parameters: { InvoiceId: { name: "invoiceId", in: "query", required: true, schema: { $ref: "#/components/schemas/Id" } } },
      schemas: { Id: { type: "integer", format: "int64" } },
    },
  };
  const { parameters } = extractOperationParameters(
    {}, { parameters: [{ $ref: "#/components/parameters/InvoiceId" }] }, document,
  );
  assert.equal(parameters[0]?.name, "invoiceId");
  assert.equal(parameters[0]?.json_type, "integer");
  assert.equal(parameters[0]?.format, "int64");
  assert.ok(!JSON.stringify(parameters[0]?.schema).includes("$ref"), "nothing stored may point outside itself");
});

test("a parameter with no schema is recorded as a string, not as unknown", () => {
  const { parameters } = extractOperationParameters({}, { parameters: [{ name: "q", in: "query" }] }, root);
  assert.equal(parameters[0]?.json_type, "string");
  assert.deepEqual(parameters[0]?.schema, { type: "string" });
});

test("an enum on a parameter is kept, as it is on a field", () => {
  const { parameters } = extractOperationParameters({}, {
    parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["Draft", "Sent"] } }],
  }, root);
  assert.deepEqual(parameters[0]?.enum_values, ["Draft", "Sent"]);
});

test("a malformed parameters value is a warning, not a failure", () => {
  const { parameters, warnings } = extractOperationParameters({}, { parameters: "nonsense" }, root);
  assert.equal(parameters.length, 0);
  assert.equal(warnings.length, 1);
});

test("an unresolvable parameter reference is skipped and noted", () => {
  const { parameters, warnings } = extractOperationParameters(
    {}, { parameters: [{ $ref: "#/components/parameters/Missing" }, { name: "id", in: "path" }] }, {},
  );
  assert.deepEqual(parameters.map((p) => p.name), ["id"], "the rest of the operation still counts");
  assert.equal(warnings.length, 1);
});

test("a parameter schema that points at itself stops rather than recursing", () => {
  const document = { components: { schemas: { Loop: { type: "array", items: { $ref: "#/components/schemas/Loop" } } } } };
  const { parameters } = extractOperationParameters(
    {}, { parameters: [{ name: "ids", in: "query", schema: { $ref: "#/components/schemas/Loop" } }] }, document,
  );
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0]?.json_type, "array");
});

// ------------------------------------------------- the whole-document walk

const downloadDocument = {
  openapi: "3.0.3",
  info: { title: "SEF-shaped", version: "1" },
  paths: {
    // no request body, a file response: the shape that used to be dropped
    "/sales-invoice/xml": {
      get: {
        parameters: [{ name: "invoiceId", in: "query", required: true, schema: { type: "integer", format: "int64" } }],
        responses: { "200": { content: { "application/xml": { schema: { type: "string", format: "binary" } } } } },
      },
    },
    // a body and parameters together
    "/sales-invoice": {
      post: {
        parameters: [{ name: "dryRun", in: "query", schema: { type: "boolean" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { number: { type: "string" } } } } } },
        responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { id: { type: "integer" } } } } } } },
      },
      // neither a body nor parameters: still nothing to store
      options: { responses: { "204": {} } },
    },
  },
};

test("an operation with only parameters is kept by the document walk", () => {
  const operations = extractDocumentSchemas(downloadDocument);
  const download = operations.find((o) => o.operation_path === "/sales-invoice/xml");
  assert.ok(download, "the operation used to be dropped for having no request or response body schema");
  assert.deepEqual(download?.parameters?.map((p) => p.name), ["invoiceId"]);
});

test("an operation with a body also carries its parameters now", () => {
  const operations = extractDocumentSchemas(downloadDocument);
  const post = operations.find((o) => o.operation_path === "/sales-invoice" && o.http_method === "POST");
  assert.ok(post);
  assert.ok(post!.schemas.length > 0);
  assert.deepEqual(post?.parameters?.map((p) => p.name), ["dryRun"]);
});

test("an operation with neither a body nor a parameter is still dropped", () => {
  const operations = extractDocumentSchemas(downloadDocument);
  assert.equal(operations.some((o) => o.http_method === "OPTIONS"), false);
});

test("extractDocumentSchemas always states both parameter fields", () => {
  for (const operation of extractDocumentSchemas(downloadDocument)) {
    assert.ok(Array.isArray(operation.parameters), "absent would mean 'not looked at'");
    assert.ok(Array.isArray(operation.parameter_warnings));
  }
});

// --------------------------------------- the shape the engine compares with

test("stored parameters rebuild into what compareParameters accepts", () => {
  const { parameters } = extractOperationParameters({}, {
    parameters: [{ name: "invoiceId", in: "query", required: true, schema: { type: "integer" } }],
  }, root);
  const result = compareParameters(
    { type: "object", properties: { invoiceId: { type: "integer" } } },
    toOpenApiParameters(parameters), "source", "target",
  );
  assert.equal(result.compatibility, "directly_compatible", "the id the source returns satisfies the query parameter");
});

test("a parameter the source cannot supply is reported against its own path", () => {
  const { parameters } = extractOperationParameters({}, {
    parameters: [{ name: "merchantRef", in: "path", schema: { type: "string" } }],
  }, root);
  const result = compareParameters(
    { type: "object", properties: { total: { type: "number" } } },
    toOpenApiParameters(parameters), "source", "target",
  );
  assert.notEqual(result.compatibility, "directly_compatible");
  assert.equal(parameterFieldPath(parameters[0]!), "path:merchantRef");
  assert.ok(result.issues.some((issue) => issue.target_path === "path:merchantRef"),
    "field-comparison.ts keys parameter rows by 'in:name'");
});
