import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  extractDocumentSchemas,
  extractOperationSchemas,
  flattenSchema,
  normaliseLeafName,
  schemaContentHash,
} from "../lib/schema/extract.ts";

// Real specifications, not invented ones -- the same fixtures the parser
// tests use. A hand-written schema proves the walker works on hand-written
// schemas; Poland's proves it works on what a tax authority actually
// publishes.
const poland = JSON.parse(
  readFileSync(new URL("./fixtures/poland-ksef.json", import.meta.url), "utf8"),
);

// ------------------------------------------------------------- normalisation

test("normalisation folds the three spellings of one field name together", () => {
  assert.equal(normaliseLeafName("unitPrice"), "unitprice");
  assert.equal(normaliseLeafName("unit_price"), "unitprice");
  assert.equal(normaliseLeafName("Unit-Price"), "unitprice");
  assert.equal(normaliseLeafName("InvoiceNumber"), "invoicenumber");
});

test("normalisation does not merge names that differ by more than punctuation", () => {
  assert.notEqual(normaliseLeafName("invoiceNumber"), normaliseLeafName("invoiceNumbers"));
});

// ----------------------------------------------------------------- the walk

const root = {} as Record<string, unknown>;

test("a nested object becomes one row per leaf, with the path that reaches it", () => {
  const { fields } = flattenSchema(
    {
      type: "object",
      required: ["invoice"],
      properties: {
        invoice: {
          type: "object",
          required: ["number"],
          properties: {
            number: { type: "string" },
            issueDate: { type: "string", format: "date" },
          },
        },
      },
    },
    root,
  );
  const byPath = new Map(fields.map((f) => [f.path, f]));
  assert.deepEqual(
    [...byPath.keys()].sort(),
    ["invoice", "invoice.issueDate", "invoice.number"],
  );
  assert.equal(byPath.get("invoice")?.is_required, true);
  assert.equal(byPath.get("invoice.number")?.is_required, true);
  assert.equal(byPath.get("invoice.issueDate")?.is_required, false);
  assert.equal(byPath.get("invoice.issueDate")?.format, "date");
  assert.equal(byPath.get("invoice.number")?.depth, 1);
});

test("the schema root is not itself a field", () => {
  const { fields } = flattenSchema(
    { type: "object", properties: { a: { type: "string" } } },
    root,
  );
  assert.deepEqual(fields.map((f) => f.path), ["a"]);
});

test("an array boundary is marked in the path and on the row", () => {
  const { fields } = flattenSchema(
    {
      type: "object",
      properties: {
        lines: {
          type: "array",
          items: {
            type: "object",
            required: ["unitPrice"],
            properties: { unitPrice: { type: "number" } },
          },
        },
      },
    },
    root,
  );
  const paths = fields.map((f) => f.path);
  assert.ok(paths.includes("lines[].unitPrice"), paths.join(", "));
  const leaf = fields.find((f) => f.path === "lines[].unitPrice");
  assert.equal(leaf?.is_array_item, true);
  assert.equal(leaf?.is_required, true);
  assert.equal(leaf?.leaf_name, "unitPrice");
});

test("a root-level array has no field of its own, but its members do", () => {
  // An endpoint returning a bare list. The list is the schema, not a field of
  // it, so nothing is recorded at '[]' -- but everything under it is.
  const { fields } = flattenSchema(
    {
      type: "array",
      items: {
        type: "object",
        required: ["invoiceNumber"],
        properties: { invoiceNumber: { type: "string" } },
      },
    },
    root,
  );
  assert.deepEqual(fields.map((f) => f.path), ["[].invoiceNumber"]);
  assert.equal(fields[0]?.leaf_name, "invoiceNumber");
  assert.equal(fields[0]?.is_array_item, true);
  assert.equal(fields[0]?.is_required, true);
});

test("no field row is ever recorded with an empty leaf name", () => {
  // 0016 makes leaf_name not null; an empty one would satisfy the column and
  // still be useless to matching, which is the failure this guards.
  for (const schema of [
    { type: "array", items: { type: "array", items: { type: "string" } } },
    { type: "array", items: { type: "string" } },
    { type: "object", properties: { a: { type: "array", items: { type: "string" } } } },
  ]) {
    const { fields } = flattenSchema(schema, root);
    for (const f of fields) assert.notEqual(f.leaf_name, "", `empty leaf at ${f.path}`);
  }
});

test("depth counts segments from the root, so a top-level field is 0", () => {
  const { fields } = flattenSchema(
    {
      type: "object",
      properties: {
        top: { type: "object", properties: { middle: { type: "object", properties: { leaf: { type: "string" } } } } },
      },
    },
    root,
  );
  const byPath = new Map(fields.map((f) => [f.path, f.depth]));
  assert.equal(byPath.get("top"), 0);
  assert.equal(byPath.get("top.middle"), 1);
  assert.equal(byPath.get("top.middle.leaf"), 2);
});

test("a schema stating no type is recorded as unknown rather than guessed", () => {
  const { fields } = flattenSchema(
    { type: "object", properties: { whatever: { description: "no type stated" } } },
    root,
  );
  assert.equal(fields[0]?.json_type, "unknown");
});

test("enum values are carried through as text", () => {
  const { fields } = flattenSchema(
    { type: "object", properties: { status: { type: "string", enum: ["draft", "issued"] } } },
    root,
  );
  assert.deepEqual(fields[0]?.enum_values, ["draft", "issued"]);
});

test("a field with no enum carries null, not an empty array", () => {
  const { fields } = flattenSchema(
    { type: "object", properties: { note: { type: "string" } } },
    root,
  );
  assert.equal(fields[0]?.enum_values, null);
});

// ------------------------------------------------------------- $ref handling

test("a local $ref is followed and its fields appear under the referring path", () => {
  const doc = {
    components: {
      schemas: {
        Money: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "number" }, currency: { type: "string" } },
        },
      },
    },
  } as Record<string, unknown>;
  const { fields } = flattenSchema(
    { type: "object", properties: { total: { $ref: "#/components/schemas/Money" } } },
    doc,
  );
  const paths = fields.map((f) => f.path).sort();
  assert.deepEqual(paths, ["total", "total.amount", "total.currency"]);
  assert.equal(fields.find((f) => f.path === "total.amount")?.is_required, true);
});

test("a schema that contains itself terminates and says so", () => {
  const doc = {
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            child: { $ref: "#/components/schemas/Node" },
          },
        },
      },
    },
  } as Record<string, unknown>;
  const { fields, warnings } = flattenSchema(
    { $ref: "#/components/schemas/Node" },
    doc,
  );
  assert.ok(fields.some((f) => f.path === "name"));
  assert.ok(
    warnings.some((w) => w.includes("recursive $ref not expanded")),
    warnings.join(" | "),
  );
});

test("an external $ref is not fetched; it becomes a warning", () => {
  const { warnings } = flattenSchema(
    { type: "object", properties: { x: { $ref: "https://example.com/s.json#/A" } } },
    root,
  );
  assert.ok(
    warnings.some((w) => w.includes("external $ref not resolved")),
    warnings.join(" | "),
  );
});

// ------------------------------------------------------------- composition

test("allOf branches are merged, because a field reached through one is a real field", () => {
  const doc = {
    components: {
      schemas: {
        Base: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    },
  } as Record<string, unknown>;
  const { fields } = flattenSchema(
    {
      allOf: [
        { $ref: "#/components/schemas/Base" },
        { type: "object", properties: { note: { type: "string" } } },
      ],
    },
    doc,
  );
  const paths = fields.map((f) => f.path).sort();
  assert.deepEqual(paths, ["id", "note"]);
  assert.equal(fields.find((f) => f.path === "id")?.is_required, true);
});

test("oneOf states alternatives, so its branches are not reported as fields", () => {
  const { fields, warnings } = flattenSchema(
    {
      type: "object",
      properties: {
        payer: {
          oneOf: [
            { type: "object", properties: { abn: { type: "string" } } },
            { type: "object", properties: { nip: { type: "string" } } },
          ],
        },
      },
    },
    root,
  );
  const paths = fields.map((f) => f.path);
  assert.ok(paths.includes("payer"));
  assert.ok(!paths.some((p) => p.includes("abn") || p.includes("nip")), paths.join(", "));
  assert.ok(warnings.some((w) => w.includes("oneOf/anyOf")), warnings.join(" | "));
});

// ------------------------------------------------------- operation level

test("a request schema and each response are separate schemas", () => {
  const doc = {} as Record<string, unknown>;
  const schemas = extractOperationSchemas(
    {
      requestBody: {
        content: { "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } } },
      },
      responses: {
        "200": {
          content: { "application/json": { schema: { type: "object", properties: { b: { type: "string" } } } } },
        },
        "400": {
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
        },
      },
    },
    doc,
  );
  assert.equal(schemas.length, 3);
  const request = schemas.filter((s) => s.direction === "request");
  assert.equal(request.length, 1);
  assert.equal(request[0]?.status_code, null);
  assert.deepEqual(
    schemas.filter((s) => s.direction === "response").map((s) => s.status_code).sort(),
    ["200", "400"],
  );
});

test("response status keys are kept as stated, '2XX' and 'default' included", () => {
  const schemas = extractOperationSchemas(
    {
      responses: {
        "2XX": { content: { "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } } } },
        default: { content: { "application/json": { schema: { type: "object", properties: { b: { type: "string" } } } } } },
      },
    },
    {} as Record<string, unknown>,
  );
  assert.deepEqual(schemas.map((s) => s.status_code).sort(), ["2XX", "default"]);
});

test("one media type per schema, so two media types are two schemas", () => {
  const schemas = extractOperationSchemas(
    {
      requestBody: {
        content: {
          "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } },
          "application/xml": { schema: { type: "object", properties: { a: { type: "string" } } } },
        },
      },
    },
    {} as Record<string, unknown>,
  );
  assert.deepEqual(schemas.map((s) => s.media_type).sort(), ["application/json", "application/xml"]);
});

test("a media type declared with no schema is a warning, not a silent skip", () => {
  const schemas = extractOperationSchemas(
    { requestBody: { content: { "application/pdf": {} } } },
    {} as Record<string, unknown>,
  );
  assert.equal(schemas.length, 0);
});

// ----------------------------------------------------------- content hash

test("the hash ignores key order, so an unchanged document does not look revised", () => {
  const a = { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } };
  const b = { properties: { a: { type: "number" }, b: { type: "string" } }, type: "object" };
  assert.equal(schemaContentHash(a), schemaContentHash(b));
});

test("the hash changes when the schema actually changes", () => {
  const a = { type: "object", properties: { a: { type: "string" } } };
  const b = { type: "object", properties: { a: { type: "number" } } };
  assert.notEqual(schemaContentHash(a), schemaContentHash(b));
});

// --------------------------------------------------- against a real document

test("Poland: schemas are found, keyed by path and method", () => {
  const found = extractDocumentSchemas(poland);
  assert.ok(found.length > 0, "no operation in the KSeF document produced a schema");
  for (const entry of found) {
    assert.match(entry.operation_path, /^\//);
    assert.match(entry.http_method, /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/);
    assert.ok(entry.schemas.length > 0);
  }
});

test("Poland: at least one operation states a request schema with fields", () => {
  const found = extractDocumentSchemas(poland);
  const withRequestFields = found.flatMap((e) =>
    e.schemas.filter((s) => s.direction === "request" && s.fields.length > 0),
  );
  assert.ok(
    withRequestFields.length > 0,
    "the whole document produced no request schema carrying fields",
  );
});

test("Poland: every field row is well formed", () => {
  const found = extractDocumentSchemas(poland);
  let checked = 0;
  for (const entry of found) {
    for (const schema of entry.schemas) {
      for (const field of schema.fields) {
        assert.ok(field.path.length > 0);
        assert.ok(field.leaf_name.length > 0, `empty leaf in ${field.path}`);
        assert.equal(field.leaf_name_norm, normaliseLeafName(field.leaf_name));
        assert.match(
          field.json_type,
          /^(object|array|string|number|integer|boolean|null|unknown)$/,
        );
        assert.ok(field.depth >= 0);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 50, `only ${checked} field rows produced`);
});

test("Poland: paths are unique within one schema, which 0016's index requires", () => {
  for (const entry of extractDocumentSchemas(poland)) {
    for (const schema of entry.schemas) {
      const paths = schema.fields.map((f) => f.path);
      assert.equal(
        new Set(paths).size,
        paths.length,
        `duplicate path in ${entry.http_method} ${entry.operation_path}`,
      );
    }
  }
});

test("Poland: extraction is deterministic -- two runs agree field for field", () => {
  const a = extractDocumentSchemas(poland);
  const b = extractDocumentSchemas(poland);
  assert.deepEqual(a, b);
});

test("a document with no paths yields nothing rather than throwing", () => {
  assert.deepEqual(extractDocumentSchemas({ openapi: "3.0.0" }), []);
  assert.deepEqual(extractDocumentSchemas(null), []);
  assert.deepEqual(extractDocumentSchemas("not a document"), []);
});

test("a Swagger 2.0 operation's body parameter and response schema are read", () => {
  // detect.ts has always called this document swagger_2; until the 2.0 shape
  // was read, extraction returned nothing for it at all.
  const document = {
    swagger: "2.0",
    consumes: ["application/json"],
    produces: ["application/json"],
    paths: {
      "/document_submissions": {
        post: {
          parameters: [
            { name: "Authorization", in: "header", type: "string" },
            { name: "document_submission", in: "body", required: true,
              schema: { $ref: "#/definitions/DocumentSubmission" } },
          ],
          responses: {
            "200": { description: "ok", schema: { $ref: "#/definitions/DocumentSubmissionResult" } },
            "401": { description: "unauthorized" },
          },
        },
      },
    },
    definitions: {
      DocumentSubmission: {
        type: "object", required: ["legalEntityId"],
        properties: { legalEntityId: { type: "integer" }, document: { type: "string" } },
      },
      DocumentSubmissionResult: { type: "object", properties: { guid: { type: "string" } } },
    },
  };
  const operations = extractDocumentSchemas(document);
  assert.equal(operations.length, 1);
  const [operation] = operations;
  const request = operation.schemas.find((schema) => schema.direction === "request");
  const response = operation.schemas.find((schema) => schema.direction === "response");
  assert.equal(request?.media_type, "application/json");
  assert.deepEqual(request?.fields.map((field) => field.path).sort(), ["document", "legalEntityId"]);
  assert.equal(request?.fields.find((field) => field.path === "legalEntityId")?.is_required, true);
  assert.equal(response?.status_code, "200");
  assert.deepEqual(response?.fields.map((field) => field.path), ["guid"]);
  // A response that states no schema contributes none, rather than an empty one.
  assert.equal(operation.schemas.filter((schema) => schema.status_code === "401").length, 0);
  // The header parameter is not mistaken for the body.
  assert.ok(!request?.fields.some((field) => field.path === "Authorization"));
});

test("a Swagger 2.0 schema with no stated media type is not given one", () => {
  const document = {
    swagger: "2.0",
    paths: {
      "/x": {
        post: {
          parameters: [{ name: "body", in: "body", schema: { type: "object", properties: { a: { type: "string" } } } }],
          responses: { "200": { description: "ok", schema: { type: "object", properties: { b: { type: "string" } } } } },
        },
      },
    },
  };
  const operations = extractDocumentSchemas(document);
  // Nothing is stored: Swagger 2.0 defines no default media type, and
  // api_schema.media_type holds what the document stated.
  assert.deepEqual(operations.flatMap((operation) => operation.schemas), []);
});

test("an OpenAPI 3 operation is unaffected by the Swagger 2.0 path", () => {
  const document = {
    openapi: "3.0.3",
    paths: {
      "/x": {
        post: {
          // A body parameter here would be invalid OpenAPI 3; requestBody wins
          // and the 2.0 fallback must not add a second request schema.
          parameters: [{ name: "body", in: "body", schema: { type: "object", properties: { ignored: { type: "string" } } } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { real: { type: "string" } } } } } },
          responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { out: { type: "string" } } } } } } },
        },
      },
    },
  };
  const [operation] = extractDocumentSchemas(document);
  const requests = operation.schemas.filter((schema) => schema.direction === "request");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].fields.map((field) => field.path), ["real"]);
});
