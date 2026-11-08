import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detect, extractSpecUrl } from "../lib/import/detect.ts";
import { parseOpenApi3 } from "../lib/openapi/parse.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("Poland JSON is detected as OpenAPI 3.x", () => {
  const d = detect(fixture("poland-ksef.json"), "https://api.ksef.mf.gov.pl/docs/v2/openapi.json");
  assert.equal(d.format, "openapi_3");
});

test("India YAML is detected as OpenAPI 3.x and parses end to end", () => {
  const d = detect(fixture("india-irp.yaml"), "https://developer.irisirp.com/irp.yaml");
  assert.equal(d.format, "openapi_3");
  if (d.format !== "openapi_3") return;
  const { candidates, warnings } = parseOpenApi3(d.document, "https://developer.irisirp.com/irp.yaml");
  assert.ok(candidates.length >= 5, `got ${candidates.length}`);
  // India lists two servers; the parser uses the first and says so.
  assert.ok(warnings.some((w) => w.includes("servers lists 2")));
  for (const c of candidates) {
    assert.match(c.api_endpoint, /^https:\/\/api\.sandbox\.core\.irisirp\.com\//);
  }
  // India DOES state its provider, unlike Poland.
  assert.equal(candidates[0].company_name, "API Support");
});

test("Portugal is detected as WSDL, refused by name rather than half-parsed", () => {
  const d = detect(fixture("portugal-fatcorews.wsdl"), "https://info.portaldasfinancas.gov.pt/x/Fatcorews.wsdl");
  assert.equal(d.format, "wsdl");
});

test("Serbia's page is an html_page whose config lives in a sibling script", () => {
  const d = detect(
    fixture("serbia-swagger-ui.html"),
    "https://efaktura.mfin.gov.rs/swagger/index.html?urls.primaryName=Public+API+V1",
  );
  assert.equal(d.format, "html_page");
  if (d.format !== "html_page") return;
  assert.equal(d.specUrl, undefined);
  assert.deepEqual(d.configScriptUrls, ["https://efaktura.mfin.gov.rs/swagger/index.js"]);
});

test("a Swagger UI initialiser script yields the document address, resolved", () => {
  const js = `window.ui = SwaggerUIBundle({ url: "./v1/openapi.json", dom_id: "#swagger-ui" });`;
  assert.equal(
    extractSpecUrl(js, "https://efaktura.mfin.gov.rs/swagger/index.js"),
    "https://efaktura.mfin.gov.rs/swagger/v1/openapi.json",
  );
});

test("a Swagger UI urls array yields the first document address, resolved", () => {
  const js = 'var c = JSON.parse(\'{"urls":[{"url":"/swagger/public_v1/swagger.json","name":"Public API V1"},{"url":"/swagger/public_v2/swagger.json","name":"V2"}]}\');';
  assert.equal(
    extractSpecUrl(js, "https://efaktura.mfin.gov.rs/swagger/index.js"),
    "https://efaktura.mfin.gov.rs/swagger/public_v1/swagger.json",
  );
});

test("a Redoc page yields its spec-url inline", () => {
  const html = `<!doctype html><html><body><redoc spec-url="/api/openapi.yaml"></redoc><script src="redoc.standalone.js"></script></body></html>`;
  const d = detect(html, "https://docs.h.test.dev/reference");
  assert.equal(d.format, "html_page");
  if (d.format !== "html_page") return;
  assert.equal(d.specUrl, "https://docs.h.test.dev/api/openapi.yaml");
});

test("Swagger 2.0 JSON is named as swagger_2", () => {
  const d = detect(JSON.stringify({ swagger: "2.0", info: {}, paths: {} }), "https://x.test.dev/s.json");
  assert.equal(d.format, "swagger_2");
});

test("an HTML page with no API markers is unknown, not a documentation page", () => {
  const d = detect("<!doctype html><html><body><h1>Pricing</h1></body></html>", "https://x.test.dev/");
  assert.equal(d.format, "unknown");
});

test("plain prose is unknown", () => {
  assert.equal(detect("hello, this is not an api document", "https://x.test.dev/a.txt").format, "unknown");
});

test("a YAML alias bomb is contained by the parser's alias budget", () => {
  // Small-scale billion-laughs: without an alias budget this expands fast.
  const bomb = [
    "a: &a [x,x,x,x,x,x,x,x,x,x]",
    "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
    "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
    "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]",
    "openapi: '3.0.0'",
  ].join("\n");
  const started = Date.now();
  const d = detect(bomb, "https://x.test.dev/bomb.yaml");
  assert.equal(d.format, "unknown");
  assert.ok(Date.now() - started < 2_000, "alias expansion was not bounded");
});

test("a ReadMe Markdown page yields the OpenAPI definition in its json block", () => {
  const page = [
    "---", "updatedAt: 2026-04-21", "---", "", "# Import an invoice from a file", "",
    "# OpenAPI definition", "", "```json",
    JSON.stringify({ openapi: "3.0.1", info: { title: "B2Brouter API", version: "1" }, paths: { "/accounts/{account}/invoices/import.json": { post: {} } } }, null, 2),
    "```", "",
  ].join("\n");
  const d = detect(page, "https://developer.b2brouter.net/reference/import-invoice.md");
  assert.equal(d.format, "openapi_3");
});

test("a Mintlify Markdown page yields the definition in a four-backtick yaml block", () => {
  const page = [
    "> ## Documentation Index", "", "# getFormData", "", "## OpenAPI", "",
    "````yaml get /getFormData", "openapi: 3.0.1", "info:", "  title: EzzyRest API", "  version: 1.0.0",
    "paths:", "  /getFormData:", "    get:", "      operationId: getFormData", "````", "",
  ].join("\n");
  const d = detect(page, "https://apidocs.ezzydoc.com/mintlify/docs/ezzyrest/getformdata.md");
  assert.equal(d.format, "openapi_3");
});

test("a Markdown page whose code blocks are not definitions stays unknown", () => {
  const page = ["# Example", "", "```json", "{\"invoice\": 1}", "```", "", "```bash", "curl https://x", "```"].join("\n");
  assert.equal(detect(page, "https://example.com/doc.md").format, "unknown");
});
