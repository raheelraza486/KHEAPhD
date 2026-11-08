import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dereferenceSchema,
  extractDocumentSchemas,
  flattenSchema,
  type ExtractedSchema,
} from "../lib/schema/extract.ts";
import { parseOpenApi3 } from "../lib/openapi/parse.ts";
import {
  chainableSchemas,
  forStorage,
  isChainable,
  restoreFields,
  schemaIdentity,
  schemasForOperation,
  toFieldRows,
  toSchemaRows,
} from "../lib/schema/rows.ts";

const poland = JSON.parse(
  readFileSync(new URL("./fixtures/poland-ksef.json", import.meta.url), "utf8"),
);

function schema(partial: Partial<ExtractedSchema>): ExtractedSchema {
  return {
    direction: "request",
    media_type: "application/json",
    status_code: null,
    raw: { type: "object", properties: { a: { type: "string" } } },
    fields: [],
    warnings: [],
    ...partial,
  };
}

// -------------------------------------------------------- dereferencing

test("Poland: after dereferencing, no stored schema points into the document", () => {
  // 0016 promises the fields can be rebuilt from raw alone. Before this,
  // 196 of 441 KSeF schemas still carried a $ref into components that are
  // not stored with them.
  for (const entry of extractDocumentSchemas(poland)) {
    for (const s of entry.schemas) {
      assert.ok(
        !JSON.stringify(s.raw).includes('"$ref":"#/'),
        `${entry.http_method} ${entry.operation_path} ${s.status_code ?? "request"} still refers into the document`,
      );
    }
  }
});

test("Poland: fields rebuilt from raw alone equal the fields extracted from the document", () => {
  for (const entry of extractDocumentSchemas(poland)) {
    for (const s of entry.schemas) {
      assert.deepEqual(flattenSchema(s.raw, {}).fields, s.fields);
    }
  }
});

test("a recursive reference is replaced by a marked node that keeps the target's type", () => {
  const doc = {
    components: {
      schemas: {
        Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } },
      },
    },
  } as Record<string, unknown>;
  const warnings: string[] = [];
  const raw = dereferenceSchema({ $ref: "#/components/schemas/Node" }, doc, warnings) as {
    properties: { child: Record<string, unknown> };
  };
  assert.equal(raw.properties.child.type, "object");
  assert.equal(raw.properties.child["x-recursive-ref"], "#/components/schemas/Node");
  assert.ok(!("$ref" in raw.properties.child));
  assert.ok(warnings.some((w) => w.includes("recursive $ref not expanded")));
});

test("an external reference is left in place and warned about, never fetched", () => {
  const warnings: string[] = [];
  const raw = dereferenceSchema({ $ref: "https://example.test/s.json" }, {}, warnings);
  assert.deepEqual(raw, { $ref: "https://example.test/s.json" });
  assert.ok(warnings.some((w) => w.includes("external $ref not resolved")));
});

// ---------------------------------------------------------- what is stored

test("requests and success responses are chainable; error responses are not", () => {
  assert.equal(isChainable({ direction: "request", status_code: null }), true);
  for (const s of ["200", "201", "202", "204", "2XX", "2xx", "default"]) {
    assert.equal(isChainable({ direction: "response", status_code: s }), true, s);
  }
  for (const s of ["400", "401", "403", "429", "500", "4XX", "302"]) {
    assert.equal(isChainable({ direction: "response", status_code: s }), false, s);
  }
});

test("'default' is kept only when the operation states no success status", () => {
  // Every 'default' response stored from the live catalogue carried an error
  // shape, and 32 of them belonged to operations that also had a 2XX. Those
  // were reaching the compatibility checks as an operation's output.
  const request = schema({});
  const success = schema({ direction: "response", status_code: "200" });
  const fallback = schema({ direction: "response", status_code: "default" });

  assert.deepEqual(
    chainableSchemas([request, success, fallback]).map((s) => s.status_code),
    [null, "200"],
    "with a 2XX present, default is the error branch",
  );
  assert.deepEqual(
    chainableSchemas([request, fallback]).map((s) => s.status_code),
    [null, "default"],
    "with no success status, default is where the success shape lives",
  );
  assert.deepEqual(
    chainableSchemas([schema({ direction: "response", status_code: "2XX" }), fallback]).map((s) => s.status_code),
    ["2XX"],
    "a 2XX wildcard counts as a success status",
  );
  assert.deepEqual(
    chainableSchemas([schema({ direction: "response", status_code: "400" }), fallback]).map((s) => s.status_code),
    ["default"],
    "an error status is not a success status, so default still stands",
  );
});

test("forStorage applies the whole-operation rule, not only the per-schema one", () => {
  const stored = forStorage([
    schema({}),
    schema({ direction: "response", status_code: "201" }),
    schema({ direction: "response", status_code: "default" }),
    schema({ direction: "response", status_code: "500" }),
  ]);
  assert.deepEqual(stored.map((s) => s.status_code), [null, "201"]);
});

test("Poland: storage keeps requests and successes, drops the error envelopes", () => {
  const all = extractDocumentSchemas(poland).flatMap((e) => e.schemas);
  const stored = forStorage(all);
  assert.ok(stored.length < all.length / 3, `${stored.length} of ${all.length} kept`);
  assert.ok(stored.every((s) => isChainable(s)));
  assert.ok(stored.some((s) => s.direction === "request"));
  assert.ok(stored.some((s) => s.direction === "response"));
});

test("stored schemas carry raw but not fields, and restore to the same fields", () => {
  const all = extractDocumentSchemas(poland).flatMap((e) => e.schemas).filter(isChainable);
  const stored = forStorage(all);
  for (const s of stored) assert.ok(!("fields" in s));
  const restored = restoreFields(stored);
  assert.deepEqual(restored.map((s) => s.fields), all.map((s) => s.fields));
});

test("stored schemas survive the JSON round trip the session column puts them through", () => {
  const stored = forStorage(extractDocumentSchemas(poland).flatMap((e) => e.schemas));
  const roundTripped = JSON.parse(JSON.stringify(stored));
  assert.deepEqual(restoreFields(roundTripped), restoreFields(stored));
});

// ------------------------------------------------------ operation matching

test("schemas attach to the operation with the same path and method", () => {
  const documentSchemas = [
    { operation_path: "/invoices", http_method: "POST", schemas: [schema({})] },
    { operation_path: "/invoices", http_method: "GET", schemas: [schema({ direction: "response", status_code: "200" })] },
  ];
  assert.equal(schemasForOperation({ operation_path: "/invoices", http_method: "POST" }, documentSchemas).length, 1);
  assert.equal(
    schemasForOperation({ operation_path: "/invoices", http_method: "GET" }, documentSchemas)[0]?.status_code,
    "200",
  );
  assert.deepEqual(schemasForOperation({ operation_path: "/other", http_method: "POST" }, documentSchemas), []);
});

test("a candidate from before operation_path existed gets no schemas, not a guess", () => {
  const documentSchemas = [{ operation_path: "/invoices", http_method: "POST", schemas: [schema({})] }];
  assert.deepEqual(schemasForOperation({ http_method: "POST" }, documentSchemas), []);
});

test("Poland: the parser's candidates and the extractor's schemas meet on path and method", () => {
  // The join the route relies on, run against the real document: candidates
  // come from parseOpenApi3, schemas from extractDocumentSchemas, and every
  // operation the extractor found schemas for must be claimed by a candidate.
  const { candidates } = parseOpenApi3(poland, "https://api.ksef.mf.gov.pl/docs/v2/openapi.json");
  const documentSchemas = extractDocumentSchemas(poland);
  const claimed = candidates.filter((c) => schemasForOperation(c, documentSchemas).length > 0);
  assert.equal(
    claimed.length,
    documentSchemas.length,
    `${documentSchemas.length} operations have schemas, ${claimed.length} candidates found theirs`,
  );
});

// ------------------------------------------------------------ row shapes

test("extracted rows record the document and no uploader", () => {
  const [row] = toSchemaRows("api-1", [schema({})], { kind: "extracted", sourceUrl: "https://x.test/doc" });
  assert.equal(row?.origin, "extracted");
  assert.equal(row?.source_url, "https://x.test/doc");
  assert.equal(row?.created_by, "");
  assert.equal(row?.api_id, "api-1");
  assert.match(row?.content_hash ?? "", /^[0-9a-f]{64}$/);
});

test("uploaded rows record the uploader and no document -- the shape 0016 requires", () => {
  const [row] = toSchemaRows("api-1", [schema({})], { kind: "uploaded", createdBy: "Jackie" });
  assert.equal(row?.origin, "uploaded");
  assert.equal(row?.source_url, "");
  assert.equal(row?.created_by, "Jackie");
});

test("a repeated identity is written once, so one duplicate cannot fail the whole insert", () => {
  const rows = toSchemaRows("api-1", [schema({}), schema({})], { kind: "extracted", sourceUrl: "x" });
  assert.equal(rows.length, 1);
});

test("identity treats a null status and an empty one alike, as 0016's coalesce does", () => {
  assert.equal(
    schemaIdentity({ direction: "request", status_code: null, media_type: "application/json" }),
    schemaIdentity({ direction: "request", status_code: "", media_type: "application/json" }),
  );
});

test("field rows are written only for schemas the database returned an id for", () => {
  const withFields = schema({
    fields: [{
      path: "a", leaf_name: "a", leaf_name_norm: "a", json_type: "string", format: null,
      is_required: false, is_array_item: false, depth: 0, enum_values: null, description: "",
    }],
  });
  const orphan = schema({ direction: "response", status_code: "200", fields: withFields.fields });
  const ids = new Map([[schemaIdentity(withFields), "schema-1"]]);
  const rows = toFieldRows([withFields, orphan], ids);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.schema_id, "schema-1");
});
