import assert from "node:assert/strict";
import test from "node:test";
import { comparisonReadySchemas, defaultApiPair, schemaAvailabilityLabel, schemaSourceLink } from "../../lib/compatibility/schema-selection.ts";
import type { ApiSchemaRecord } from "../../lib/compatibility/ui-types.ts";
import { selectedFormats } from "../../lib/compatibility/selection.ts";

test("default API pair skips empty legacy records and chooses saved schemas in the required directions", () => {
  const apis = ["empty", "request-only", "response-only"].map((id) => ({ id }));
  const counts = new Map([
    ["empty", { api_id: "empty", request_count: 0, response_count: 0 }],
    ["request-only", { api_id: "request-only", request_count: 2, response_count: 0 }],
    ["response-only", { api_id: "response-only", request_count: 0, response_count: 1 }],
  ]);
  assert.deepEqual(defaultApiPair(apis, counts), { sourceId: "response-only", targetId: "request-only" });
});

test("comparison-ready schema choices exclude zero-field PDF and XML shells", () => {
  const schema = (id: string, direction: "request" | "response", fields: number): ApiSchemaRecord => ({
    id,
    direction,
    media_type: id.includes("pdf") ? "application/pdf" : "application/xml",
    status_code: direction === "response" ? "200" : null,
    origin: "extracted",
    source_url: "https://example.test/schema",
    created_by: "",
    created_at: "2026-09-22T00:00:00Z",
    warnings: [],
    raw: {},
    fields: Array.from({ length: fields }, (_, index) => ({
      path: `field${index}`,
      leaf_name: `field${index}`,
      leaf_name_norm: `field${index}`,
      json_type: "string",
      format: null,
      is_required: false,
      is_array_item: false,
      depth: 0,
      enum_values: null,
      description: null,
    })),
  });
  const schemas = [
    schema("empty-pdf", "response", 0),
    schema("empty-xml", "response", 0),
    schema("structured-xml", "response", 2),
    schema("request", "request", 1),
  ];

  assert.deepEqual(comparisonReadySchemas(schemas, "response").map((item) => item.id), ["structured-xml"]);
  assert.deepEqual(comparisonReadySchemas(schemas, "request").map((item) => item.id), ["request"]);
});

test("default API pair chooses a second source when the first source is the only available target", () => {
  const apis = [{ id: "both" }, { id: "source" }];
  const counts = new Map([
    ["both", { api_id: "both", request_count: 1, response_count: 1 }],
    ["source", { api_id: "source", request_count: 0, response_count: 1 }],
  ]);
  assert.deepEqual(defaultApiPair(apis, counts), { sourceId: "source", targetId: "both" });
});

test("missing availability has a predictable fallback and never selects the same API twice", () => {
  assert.deepEqual(defaultApiPair([{ id: "one" }, { id: "two" }], new Map()), { sourceId: "one", targetId: "two" });
  assert.deepEqual(defaultApiPair([{ id: "one" }], new Map()), { sourceId: "one", targetId: "" });
  assert.deepEqual(defaultApiPair([], new Map()), { sourceId: "", targetId: "" });
  assert.equal(schemaAvailabilityLabel(undefined, "request"), "Schema availability unknown");
  assert.equal(schemaAvailabilityLabel(0, "request"), "No saved request schema");
  assert.equal(schemaAvailabilityLabel(2, "response"), "2 saved response schemas");
});

test("schema provenance links permit public web URLs and reject executable or credential-bearing URLs", () => {
  assert.equal(schemaSourceLink("https://docs.example.test/source.wadl"), "https://docs.example.test/source.wadl");
  for (const source of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/source", "https://user:password@example.test/doc", ""]) {
    assert.equal(schemaSourceLink(source), undefined);
  }
});
