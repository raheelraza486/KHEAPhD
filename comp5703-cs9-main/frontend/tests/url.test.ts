import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseDocumentUrl } from "../lib/import/url.ts";

test("scheme and host lowercase; default port dropped; fragment dropped", () => {
  assert.equal(
    normaliseDocumentUrl("HTTPS://API.Example.GOV:443/V2/Spec#section"),
    "https://api.example.gov/V2/Spec",
  );
});

test("a lone trailing slash is removed but the root slash is kept", () => {
  assert.equal(normaliseDocumentUrl("https://h.test.dev/a/b/"), "https://h.test.dev/a/b");
  assert.equal(normaliseDocumentUrl("https://h.test.dev/"), "https://h.test.dev/");
});

test("two spellings of one document reduce to the same string", () => {
  assert.equal(
    normaliseDocumentUrl("https://h.test.dev/openapi.json"),
    normaliseDocumentUrl("HTTPS://h.test.dev:443/openapi.json"),
  );
});

test("the query string is preserved -- Peru's ?wsdl is load-bearing", () => {
  assert.equal(
    normaliseDocumentUrl("https://e-factura.sunat.gob.pe/x/billValidService?wsdl"),
    "https://e-factura.sunat.gob.pe/x/billValidService?wsdl",
  );
});

test("path case is preserved -- only scheme and host are case-insensitive", () => {
  assert.match(normaliseDocumentUrl("https://h.test.dev/CaseSensitive/Path"), /\/CaseSensitive\/Path$/);
});
