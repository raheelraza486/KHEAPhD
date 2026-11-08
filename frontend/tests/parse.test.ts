import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOpenApi3 } from "../lib/openapi/parse.ts";

const POLAND_URL = "https://api.ksef.mf.gov.pl/docs/v2/openapi.json";
const poland = JSON.parse(
  readFileSync(new URL("./fixtures/poland-ksef.json", import.meta.url), "utf8"),
);

test("Poland: one candidate per operation, not per document", () => {
  const { candidates } = parseOpenApi3(poland, POLAND_URL);
  // 59 paths carrying 61 operations at the time the fixture was captured.
  assert.ok(candidates.length >= 55, `got ${candidates.length}`);
});

test("Poland: every endpoint is assembled from servers[0] and the path", () => {
  const { candidates } = parseOpenApi3(poland, POLAND_URL);
  for (const c of candidates) {
    assert.match(c.api_endpoint, /^https:\/\/api\.ksef\.mf\.gov\.pl\/v2\//);
    assert.equal(c.data_quality, "ok");
  }
});

test("Poland: http_method is always set and valid", () => {
  const { candidates } = parseOpenApi3(poland, POLAND_URL);
  const methods = new Set(candidates.map((c) => c.http_method));
  for (const m of methods) assert.match(m, /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/);
  assert.ok(methods.has("GET") && methods.has("POST") && methods.has("DELETE"));
});

test("Poland: no operationId anywhere, so labels fall back to the summary", () => {
  const { candidates } = parseOpenApi3(poland, POLAND_URL);
  assert.ok(candidates.every((c) => c.official_api_name.length > 0));
  // Summaries are Polish and must arrive untranslated.
  assert.ok(candidates.some((c) => /Pobranie|Wysyłka|Sesje/i.test(c.api_name)));
});

test("Poland: names are unique within the import", () => {
  const { candidates } = parseOpenApi3(poland, POLAND_URL);
  const names = candidates.map((c) => c.api_name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
});

test("Poland: output formats come through $ref-resolved responses", () => {
  const { candidates } = parseOpenApi3(poland, POLAND_URL);
  const withJson = candidates.filter((c) => c.output_formats.includes("application/json"));
  assert.ok(withJson.length > 0, "no candidate carries application/json output");
});

test("Poland: the provider is not stated, and that surfaces as a warning, not a guess", () => {
  const result = parseOpenApi3(poland, POLAND_URL);
  assert.ok(result.candidates.every((c) => c.company_name === ""));
  assert.ok(result.warnings.some((w) => w.includes("no provider")));
});

test("info_version is recorded, never interpreted", () => {
  const { info_version, info_title } = parseOpenApi3(poland, POLAND_URL);
  assert.equal(info_title, "KSeF API PR");
  assert.equal(typeof info_version, "string");
});

// ---------------------------------------------------------- synthetic cases

const tiny = (over: Record<string, unknown> = {}) => ({
  openapi: "3.0.0",
  info: { title: "T", version: "1", contact: { name: "Example Co" } },
  servers: [{ url: "https://api.t.example.dev/v1" }],
  paths: {
    "/a": {
      get: { summary: "Read A" },
      post: { summary: "Write A" },
    },
  },
  ...over,
});

test("same path under two methods is two candidates (0007's reason to exist)", () => {
  const { candidates } = parseOpenApi3(tiny(), "https://docs.t.example.dev/openapi.json");
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].http_method, candidates[1].http_method);
  assert.equal(candidates[0].api_endpoint, candidates[1].api_endpoint);
});

test("operation-level classification signals are preserved as stated", () => {
  const doc = tiny({
    paths: {
      "/messages": {
        post: {
          operationId: "sendInvoice",
          summary: "Send an invoice",
          tags: ["Communication"],
          callbacks: { delivered: { "{$request.body#/callbackUrl}": {} } },
        },
      },
    },
  });
  const { candidates } = parseOpenApi3(doc, "https://docs.t.example.dev/openapi.json");
  assert.equal(candidates[0].operation_id, "sendInvoice");
  assert.equal(candidates[0].operation_summary, "Send an invoice");
  assert.equal(candidates[0].operation_path, "/messages");
  assert.deepEqual(candidates[0].operation_tags, ["Communication"]);
  assert.equal(candidates[0].has_callbacks, true);
});

test("successful response formats are not polluted by JSON error envelopes", () => {
  const doc = tiny({
    paths: {
      "/convert": {
        post: {
          summary: "Convert invoice",
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "200": { content: { "application/xml": { schema: { type: "string" } } } },
            "400": { content: { "application/json": { schema: { type: "object" } } } },
            default: { content: { "application/problem+json": { schema: { type: "object" } } } },
          },
        },
      },
    },
  });
  const { candidates } = parseOpenApi3(doc, "https://docs.t.example.dev/openapi.json");
  assert.deepEqual(candidates[0].input_formats, ["application/json"]);
  assert.deepEqual(candidates[0].output_formats, ["application/xml"]);
});

test("absent servers -> empty endpoint, suspected_placeholder, no guessing", () => {
  const { candidates } = parseOpenApi3(
    tiny({ servers: [] }),
    "https://docs.t.example.dev/openapi.json",
  );
  for (const c of candidates) {
    assert.equal(c.api_endpoint, "");
    assert.equal(c.data_quality, "suspected_placeholder");
  }
});

test("a relative servers url resolves against the document's own URL", () => {
  const { candidates } = parseOpenApi3(
    tiny({ servers: [{ url: "/v2" }] }),
    "https://host.test.dev/docs/openapi.json",
  );
  assert.match(candidates[0].api_endpoint, /^https:\/\/host\.test\.dev\/v2\/a$/);
});

test("a document served from an RFC 2606 domain is unreachable_documentation", () => {
  const { candidates } = parseOpenApi3(tiny(), "https://developer.example.com/openapi.json");
  for (const c of candidates) assert.equal(c.data_quality, "unreachable_documentation");
});

test("colliding names inside one document get method and path appended", () => {
  const doc = tiny({
    paths: {
      "/a": { get: { summary: "Same" } },
      "/b": { get: { summary: "Same" } },
    },
  });
  const { candidates } = parseOpenApi3(doc, "https://docs.t.example.dev/openapi.json");
  const names = new Set(candidates.map((c) => c.api_name));
  assert.equal(names.size, 2);
});

// This test used to assert that Swagger 2.0 was refused outright, and said
// why: better refused than half-parsed. It is now parsed, and the reasoning
// still holds -- so what it asserts is that every field the parser reads is
// read from the 2.0 document's own shape, not from the 3.x field that happens
// to be absent. Storecove publishes 2.0, and a catalogue that refuses it reads
// nothing for that provider at all.
test("a Swagger 2.0 document is parsed from its own fields, not half-read as 3.x", () => {
  const { candidates, warnings } = parseOpenApi3({
    swagger: "2.0",
    info: { title: "Vendor", contact: { name: "Vendor Ltd" } },
    schemes: ["https"],
    host: "api.vendor.test",
    basePath: "/api/v2",
    consumes: ["application/json"],
    produces: ["application/json"],
    securityDefinitions: { key: { type: "apiKey", name: "Authorization", in: "header" } },
    security: [{ key: [] }],
    paths: {
      "/document_submissions": {
        post: {
          operationId: "submit",
          parameters: [{ name: "body", in: "body", schema: { $ref: "#/definitions/Doc" } }],
          responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Result" } } },
        },
      },
    },
    definitions: { Doc: { type: "object" }, Result: { type: "object" } },
  }, "https://api.vendor.test/api/v2/openapi.json");

  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  // schemes + host + basePath, not servers.
  assert.equal(candidate.api_endpoint, "https://api.vendor.test/api/v2/document_submissions");
  // consumes/produces, not content keys.
  assert.deepEqual(candidate.input_formats, ["application/json"]);
  assert.deepEqual(candidate.output_formats, ["application/json"]);
  // securityDefinitions, not components.securitySchemes.
  assert.deepEqual(candidate.authentication_raw, ["apiKey"]);
  assert.equal(candidate.data_quality, "ok");
  assert.ok(warnings.some((warning) => /Swagger 2\.0 document/.test(warning)));
});

test("a document that is neither OpenAPI 3.x nor Swagger 2.0 is still refused", () => {
  assert.throws(
    () => parseOpenApi3({ info: {}, paths: {} }, "https://x.test.dev/s.json"),
    /not an OpenAPI 3\.x or Swagger 2\.0 document/,
  );
  assert.throws(
    () => parseOpenApi3({ swagger: "1.2", info: {}, paths: {} }, "https://x.test.dev/s.json"),
    /not an OpenAPI 3\.x or Swagger 2\.0 document/,
  );
});

test("a Swagger 2.0 document with no host falls back to where it was fetched from", () => {
  const { candidates } = parseOpenApi3({
    swagger: "2.0", info: { contact: { name: "V" } }, basePath: "/v1",
    paths: { "/x": { get: { operationId: "x" } } },
  }, "https://fetched.vendor.test/spec.json");
  assert.equal(candidates[0].api_endpoint, "https://fetched.vendor.test/v1/x");
});
