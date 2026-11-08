import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadSchemaDocument } from "../lib/schema/document-loader.ts";
import type { FetchOutcome } from "../lib/import/fetch.ts";

const SPEC = JSON.stringify({ openapi: "3.0.0", info: { title: "Test", version: "1" }, paths: {} });
const body = (body: string, finalUrl: string): FetchOutcome => ({ ok: true, body, finalUrl });

test("direct OpenAPI documents retain exact final URL and source body SHA256", async () => {
  const loaded = await loadSchemaDocument("https://docs.example.test/spec", async () => body(SPEC, "https://docs.example.test/openapi.json"));
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.source_url, "https://docs.example.test/spec");
  assert.equal(loaded.final_url, "https://docs.example.test/openapi.json");
  assert.equal(loaded.content_sha256, createHash("sha256").update(SPEC).digest("hex"));
  assert.equal(loaded.fetches.length, 1);
});

test("Swagger HTML follows a declared initialiser and resolves the spec against its redirected URL", async () => {
  const visited: string[] = [];
  const loaded = await loadSchemaDocument("https://docs.example.test/ui", async (url) => {
    visited.push(url);
    if (url.endsWith("/ui")) return body('<html><div id="swagger-ui"></div><script src="index.js"></script></html>', "https://docs.example.test/ui/");
    if (url.endsWith("/index.js")) return body('SwaggerUIBundle({url: "../spec.json"})', "https://docs.example.test/config/v2/index.js");
    return body(SPEC, url);
  });
  assert.equal(loaded.ok, true);
  assert.deepEqual(visited, ["https://docs.example.test/ui", "https://docs.example.test/ui/index.js", "https://docs.example.test/config/spec.json"]);
  assert.equal(loaded.fetches.length, 3);
});

test("upstream spec refusals are preserved instead of being misreported as unsupported format", async () => {
  const loaded = await loadSchemaDocument("https://docs.example.test/ui", async (url) => url.endsWith("/ui")
    ? body('<html><redoc spec-url="private.json"></redoc></html>', url)
    : { ok: false, refusal: "requires_credentials" });
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.reason, "requires_credentials");
  assert.equal(loaded.fetches[1]?.refusal, "requires_credentials");
});

test("unsupported Swagger 2/WSDL and ordinary pages never generate schemas", async () => {
  for (const content of ['{"swagger":"2.0","paths":{}}', '<wsdl:definitions xmlns:wsdl="x"></wsdl:definitions>', '<html>Ordinary help</html>']) {
    const loaded = await loadSchemaDocument("https://docs.example.test/spec", async (url) => body(content, url));
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.equal(loaded.reason, "unsupported_document");
  }
});

test("missing spec links bound the number of Swagger initialiser requests", async () => {
  let calls = 0;
  const scripts = Array.from({ length: 8 }, (_, i) => `<script src="/${i}/index.js"></script>`).join("");
  const loaded = await loadSchemaDocument("https://docs.example.test/ui", async (url) => {
    calls++;
    return body(url.endsWith("/ui") ? `<html><div id="swagger-ui"></div>${scripts}</html>` : "no configuration", url);
  });
  assert.equal(calls, 4);
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.reason, "spec_link_not_found");
});

test("FACe inert swagger-data JSON is extracted without a second network request", async () => {
  const html = `<html><div id="swagger-ui"></div><script type='application/json' id='swagger-data'>${JSON.stringify({ spec: JSON.parse(SPEC) })}</script></html>`;
  let calls = 0;
  const loaded = await loadSchemaDocument("https://api.face.gob.es/providers/doc", async (url) => {
    calls++;
    return body(html, url);
  });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.deepEqual(loaded.document, JSON.parse(SPEC));
  assert.equal(calls, 1);
  assert.equal(loaded.final_url, "https://api.face.gob.es/providers/doc");
  assert.equal(loaded.content_sha256, createHash("sha256").update(html).digest("hex"));
});

test("embedded discovery refuses executable scripts, malformed JSON and unrelated data blocks", async () => {
  for (const script of [
    `<script id="swagger-data" type="text/javascript">${JSON.stringify({ spec: JSON.parse(SPEC) })}</script>`,
    '<script id="swagger-data" type="application/json">globalThis.untrustedCode()</script>',
    `<script id="unrelated" type="application/json">${JSON.stringify({ spec: JSON.parse(SPEC) })}</script>`,
  ]) {
    const loaded = await loadSchemaDocument("https://docs.example.test/ui", async (url) => body(`<html><div id="swagger-ui"></div>${script}</html>`, url));
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.equal(loaded.reason, "spec_link_not_found");
  }
});

test("multiple embedded specs are ambiguous and must not be chosen by their order", async () => {
  const script = `<script id="swagger-data" type="application/json">${JSON.stringify({ spec: JSON.parse(SPEC) })}</script>`;
  const loaded = await loadSchemaDocument("https://docs.example.test/ui", async (url) => body(`<html><div id="swagger-ui"></div>${script}${script}</html>`, url));
  assert.equal(loaded.ok, false);
});

test("PDF, XML and binary files are classified before YAML parsing and produce no YAML warnings", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(process, "emitWarning", (...args: unknown[]) => { warnings.push(args); });
  const cases = [
    { text: "%PDF-1.7\n%\uFFFD\uFFFD\uFFFD\uFFFD\n1 0 obj << /Length 100 >> stream\n\x00\x1f", format: "pdf" },
    { text: '<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"></xs:schema>', format: "xml" },
    { text: "PK\x03\x04\x00\x00archived document", format: "binary" },
  ];
  for (const sample of cases) {
    const loaded = await loadSchemaDocument("https://docs.example.test/manual", async (url) => body(sample.text, url));
    assert.equal(loaded.ok, false);
    if (!loaded.ok) {
      assert.equal(loaded.reason, "unsupported_document");
      assert.equal(loaded.format, sample.format);
    }
  }
  assert.deepEqual(warnings, []);
});
