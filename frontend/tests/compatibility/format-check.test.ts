import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFormats, checkFormatCompatibility, buildFormatAliasMap } from "../../lib/compatibility/format-check.ts";

// Repository values are free text. These are the shapes actually present in
// the export of 2026-08-26 (199 rows).

test("normalizeFormats: UBL variants collapse to UBL + XML", () => {
  for (const raw of [["UBL XML"], ["UBL | XML"], ["UBL XML format"], ["UBL"]]) {
    const { formats } = normalizeFormats(raw);
    assert.deepEqual([...formats].sort(), ["UBL", "XML"], raw.join());
  }
});

test("normalizeFormats: content descriptions are not formats and are reported as ignored", () => {
  const { formats, ignored } = normalizeFormats(["Validation Report"]);
  assert.equal(formats.size, 0);
  assert.deepEqual(ignored, ["Validation Report"]);
  const sc = normalizeFormats(["Status Codes"]);
  assert.equal(sc.formats.size, 0);
});

test("normalizeFormats: pipe-joined strings and mixed lists", () => {
  const { formats } = normalizeFormats("JSON | PDF | UBL");
  assert.deepEqual([...formats].sort(), ["JSON", "PDF", "UBL", "XML"]);
  const mixed = normalizeFormats(["JSON payload", "UBL XML"]);
  assert.deepEqual([...mixed.formats].sort(), ["JSON", "UBL", "XML"]);
});

test("format check: JSON -> JSON is compatible", () => {
  const r = checkFormatCompatibility("EcosioInvoiceAPI", ["JSON"], "Zoho Invoice", ["JSON"]);
  assert.equal(r.status, "compatible");
  assert.deepEqual(r.common_formats, ["JSON"]);
  assert.equal(
    r.reason,
    "Both sides support [JSON] ('EcosioInvoiceAPI' outputs [JSON], 'Zoho Invoice' accepts [JSON]).",
  );
});

test("format check: JSON -> UBL only is incompatible", () => {
  const r = checkFormatCompatibility("A", ["JSON"], "B", ["UBL XML"]);
  assert.equal(r.status, "incompatible");
  assert.equal(r.reason, "'A' outputs [JSON] but 'B' only accepts [UBL, XML].");
});

test("format check: a side with nothing recognisable is unknown", () => {
  const r = checkFormatCompatibility("A", ["Status Codes"], "B", ["JSON"]);
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "'A' declares no recognised output format.");
  assert.deepEqual(r.ignored_values, ["Status Codes"]);
});

test("format_alias rows rewrite a spelling before classification, case-insensitively", () => {
  // The repository's public.format_alias table; a spelling it does not list falls back to the token rules.
  const aliases = buildFormatAliasMap([
    { alias: "Peppol BIS document", canonical: "UBL" },
    { alias: "Validation Report", canonical: "Validation Report" },
  ]);
  const { formats, ignored } = normalizeFormats(["peppol bis document", "Validation Report", "json"], aliases);
  assert.deepEqual([...formats].sort(), ["JSON", "UBL", "XML"]);
  assert.deepEqual(ignored, ["Validation Report"]);
  const r = checkFormatCompatibility("A", ["Peppol BIS document"], "B", ["UBL XML"], aliases);
  assert.equal(r.status, "compatible");
});
