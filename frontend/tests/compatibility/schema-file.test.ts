import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSchemaChoices, extractSchemaInput, inspectSchemaFile, parseSchemaFile } from "../../lib/compatibility/schema-file.ts";

const invoice = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const content = (schema: unknown) => ({ "application/json": { schema } });

test("uploads enumerate operation, response status and every media type", async () => {
  const document = { openapi: "3.0.3", paths: {
    "/invoices": { get: { responses: {
      "400": { content: content({ type: "string" }) },
      "200": { content: { ...content(invoice), "application/xml": { schema: invoice } } },
    } } },
    "/receipts": { post: { responses: { "201": { content: content(invoice) } } } },
  } };
  const file = new File([JSON.stringify(document)], "invoice.json");
  const choices = await inspectSchemaFile(file, "source");
  assert.equal(choices.length, 4);
  assert.equal(new Set(choices.map((choice) => choice.id)).size, 4);
  assert.deepEqual(choices.map((choice) => choice.mediaType), ["application/json", "application/xml", "application/json", "application/json"]);
  assert.match(choices[0].operationLabel, /GET \/invoices.*200 response/);
  assert.match(choices[3].operationLabel, /POST \/receipts.*201 response/);
  assert.deepEqual(await parseSchemaFile(file, "source"), choices[0]);
});

test("OpenAPI local body, parameter and schema refs resolve; operation parameters override path parameters", () => {
  const document = { openapi: "3.0.3", paths: { "/invoices/{id}": {
    parameters: [{ name: "id", in: "path", schema: { $ref: "https://example.test/overridden.json" } }],
    post: { requestBody: { $ref: "#/components/requestBodies/Invoice" }, parameters: [{ $ref: "#/components/parameters/Id" }] },
  } }, components: {
    schemas: { "Invoice/record": invoice },
    requestBodies: { Invoice: { content: content({ $ref: "#/components/schemas/Invoice~1record" }) } },
    parameters: { Id: { name: "id", in: "path", schema: { type: "integer" } } },
  } };
  const choice = extractSchemaInput(document, "target");
  assert.deepEqual(choice.schema, invoice);
  assert.deepEqual(choice.parameters, [{ name: "id", in: "path", required: true, schema: { type: "integer" } }]);
});

test("usable operations remain selectable with explicit warnings for unsupported choices", () => {
  const document = { openapi: "3.0.3", paths: {
    "/bad": { post: { requestBody: { content: content({ $ref: "https://example.test/schema.json" }) } } },
    "/good": { post: { requestBody: { content: content(invoice) } } },
  } };
  const choices = extractSchemaChoices(document, "target");
  assert.equal(choices.length, 1);
  assert.match(choices[0].operationLabel, /\/good/);
  assert.match(choices[0].warnings?.join(" ") ?? "", /\/bad.*External and anchor references are not supported/);
});

test("circular and missing refs fail clearly rather than comparing unknown schemas", () => {
  assert.throws(() => extractSchemaInput({ $ref: "#/$defs/Node", $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } } }, "target"), /Circular reference/);
  assert.throws(() => extractSchemaInput({ $ref: "#/$defs/Missing" }, "source"), /could not be found/);
});

test("fragments resolve used refs without expanding unused recursive definitions or examples", async () => {
  const fragment = {
    type: "object", properties: { id: { $ref: "#/$defs/Id" } },
    $defs: { Id: { type: "string" }, Unused: { $ref: "#/$defs/Unused" } },
    example: { $ref: "a data value, not a reference" },
  };
  const [choice] = await inspectSchemaFile(new File([JSON.stringify(fragment)], "schema.json"), "source");
  assert.equal(choice.mediaType, undefined);
  assert.deepEqual(choice.schema, { type: "object", properties: { id: { type: "string" } }, example: { $ref: "a data value, not a reference" } });
});

test("YAML parameters-only operations retain optional query metadata", async () => {
  const yaml = `openapi: 3.0.3\npaths:\n  /lookup:\n    get:\n      parameters:\n        - name: id\n          in: query\n          required: false\n          schema:\n            type: integer\n`;
  const [choice] = await inspectSchemaFile(new File([yaml], "lookup.yaml"), "target");
  assert.equal(choice.schema, undefined);
  assert.equal(choice.mediaType, undefined);
  assert.deepEqual(choice.parameters, [{ name: "id", in: "query", required: false, schema: { type: "integer" } }]);
});

test("invalid files are rejected with actionable messages", async () => {
  await assert.rejects(inspectSchemaFile(new File(["{"], "broken.json"), "source"), /Source file is not valid JSON or YAML/);
  assert.throws(() => extractSchemaInput({ invoiceId: "42", total: 10 }, "target"), /not example data/);
  assert.throws(() => extractSchemaInput({ openapi: "3.0.3" }, "source"), /does not contain paths/);
  assert.throws(() => extractSchemaInput({ swagger: "2.0", paths: {} }, "source"), /Swagger 2.0 is not supported/);
});
