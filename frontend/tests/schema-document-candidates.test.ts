import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { buildSchemaCandidates } from "../lib/schema/document-candidates.ts";

const SOURCE = "https://docs.test.dev/openapi/spec.json";

test("IRIS includes both declared core and portal servers for the export operation", () => {
  const document = parseYaml(readFileSync(new URL("./fixtures/india-irp.yaml", import.meta.url), "utf8"));
  const before = JSON.stringify(document);
  const candidates = buildSchemaCandidates(document, "https://developer.irisirp.com/irp.yaml");
  const matching = candidates.filter((c) => c.operation_path === "/portal/download/buyer/view/file");
  assert.equal(matching.length, 2);
  assert.deepEqual(matching.map((c) => new URL(c.api_endpoint).hostname).sort(), [
    "api.sandbox.core.irisirp.com", "api.sandbox.portal.irisirp.com",
  ]);
  assert.equal(JSON.stringify(document), before, "source specification must stay unchanged");
});

test("path and operation servers override root servers instead of adding unrelated hosts", () => {
  const document = {
    openapi: "3.0.3", info: {}, servers: [{ url: "https://root.test.dev/v1" }],
    paths: {
      "/root": { get: {} },
      "/overrides": {
        servers: [{ url: "/path-v2" }, { url: "https://path.test.dev" }],
        get: {}, post: { servers: [{ url: "https://operation.test.dev/v3" }] },
      },
    },
  };
  const candidates = buildSchemaCandidates(document, SOURCE);
  assert.deepEqual(candidates.map((c) => [c.http_method, c.api_endpoint]), [
    ["GET", "https://root.test.dev/v1/root"],
    ["GET", "https://docs.test.dev/path-v2/overrides"],
    ["GET", "https://path.test.dev/overrides"],
    ["POST", "https://operation.test.dev/v3/overrides"],
  ]);
});

test("missing root servers use only the normative OpenAPI '/' default with a warning", () => {
  for (const servers of [undefined, []]) {
    const candidates = buildSchemaCandidates({
      openapi: "3.0.3", info: {}, servers,
      paths: { "/api/invoices": { get: {} } },
    }, SOURCE);
    assert.equal(candidates[0].api_endpoint, "https://docs.test.dev/api/invoices");
    assert.match(candidates[0].warnings.join(" "), /OpenAPI default/);
  }
});

test("duplicate servers collapse per endpoint and method while distinct methods survive", () => {
  const candidates = buildSchemaCandidates({
    openapi: "3.0.3", info: {},
    servers: [{ url: "https://api.test.dev/v1" }, { url: "https://api.test.dev/v1/" }],
    paths: { "/invoices": { get: {}, post: {} } },
  }, SOURCE);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.http_method), ["GET", "POST"]);
});

test("server variables use stated defaults and never substitute a guessed value", () => {
  const candidates = buildSchemaCandidates({
    openapi: "3.0.3", info: {}, servers: [
      { url: "https://{region}.test.dev/{version}", variables: {
        region: { default: "eu" }, version: { default: "v2" },
      } },
      { url: "https://{unknown}.test.dev" },
      { url: "javascript:alert(1)" },
      { url: "https://user:secret@api.test.dev" },
    ],
    paths: { "/invoices/{id}": { get: {} } },
  }, SOURCE);
  assert.deepEqual(candidates.map((c) => c.api_endpoint), ["https://eu.test.dev/v2/invoices/{id}"]);
});

test("an explicit empty operation server override cannot fall back to another host", () => {
  const candidates = buildSchemaCandidates({
    openapi: "3.0.3", info: {}, servers: [{ url: "https://api.test.dev" }],
    paths: { "/invoices": { get: { servers: [] } } },
  }, SOURCE);
  assert.deepEqual(candidates, []);
});

test("a Swagger 2.0 document's candidates carry its basePath, not the OpenAPI default", () => {
  // Without schemes/host/basePath the default '/' applies and every endpoint
  // loses the basePath, so no catalogue record matches: Storecove's real
  // endpoints all sit under /api/v2.
  const candidates = buildSchemaCandidates({
    swagger: "2.0",
    info: { contact: { name: "Vendor" } },
    schemes: ["https"],
    host: "api.vendor.test",
    basePath: "/api/v2",
    consumes: ["application/json"],
    paths: { "/document_submissions": { post: { operationId: "submit", responses: { "200": { description: "ok" } } } } },
  }, "https://api.vendor.test/api/v2/openapi.json");
  assert.deepEqual(candidates.map((candidate) => candidate.api_endpoint),
                   ["https://api.vendor.test/api/v2/document_submissions"]);
});
