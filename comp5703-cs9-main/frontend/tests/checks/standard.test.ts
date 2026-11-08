import { test } from "node:test";
import assert from "node:assert/strict";
import { relationOf, resolveStandard, runStandard } from "../../lib/checks/check2-standard.ts";
import { runChecks } from "../../lib/checks/run.ts";
import { api, pair, schema, side } from "./helpers.ts";
import type { StandardClaim } from "../../lib/checks/types.ts";

// Issue #42, check 2.0b. Examples are the catalogue's own values (snapshot of 12 Oct 2026).

const r = (raw: string) => resolveStandard(raw)!;
const out = (standard: string, version = ""): StandardClaim => ({ direction: "output", standard, version, status: "reported" });
const inp = (standard: string, version = ""): StandardClaim => ({ direction: "input", standard, version, status: "reported" });

test("2.0b resolves stored values; syntaxes, file types and N/A are not standards", () => {
  assert.equal(r("Peppol BIS Billing 3.0").standard, "Peppol BIS Billing 3.0");
  assert.equal(r("Peppol BIS Billing 3.0").parent, "EN 16931");
  assert.deepEqual([r("Peppol PINT A-NZ 1.1.3").standard, r("Peppol PINT A-NZ 1.1.3").version], ["Peppol PINT A-NZ", "1.1.3"]);
  assert.deepEqual([r("XRechnung 3.0.2").standard, r("XRechnung 3.0.2").version], ["XRechnung", "3.0.2"]);
  assert.equal(r("EN 16931").version, null);
  assert.equal(r("ZUGFeRD").standard, "Factur-X");
  for (const v of ["UBL 2.1", "UBL", "UBL Invoice", "UN/CEFACT CII", "PDF", "N/A — no invoice payload"]) assert.equal(resolveStandard(v), null, v);
  // A national standard not in the table keeps its own name, without the version.
  assert.deepEqual([r("GST e-Invoice schema v1.1").standard, r("GST e-Invoice schema v1.1").version], ["GST e-Invoice schema", "1.1"]);
});

test("2.0b relations: CIUS to parent either way passes; two CIUS of one parent are disjoint; BIS 3.0 to PINT A-NZ is fillable", () => {
  assert.equal(relationOf(r("XRechnung 3.0.2"), r("EN 16931")).relation, "subset");
  assert.equal(relationOf(r("EN 16931"), r("Peppol BIS Billing 3.0")).relation, "superset");
  assert.equal(relationOf(r("XRechnung 3.0.2"), r("Peppol BIS Billing 3.0")).relation, "disjoint");
  assert.equal(relationOf(r("Peppol BIS Billing 3.0"), r("Peppol PINT A-NZ 1.1.3")).relation, "fillable");
  assert.equal(relationOf(r("Peppol PINT A-NZ 1.1.3"), r("Peppol BIS Billing 3.0")).relation, "disjoint");
  assert.equal(relationOf(r("XRechnung 3.0"), r("XRechnung 3.0.2")).relation, "version_differs");
  assert.equal(relationOf(r("Factur-X 1.09.2"), r("ZUGFeRD")).relation, "same");
});

// NormAPI Generate writes XRechnung (claim); Peppol Validator reads Peppol BIS 3.0
// (claim) although its catalogue label says only EN 16931.
const normapi = () => side(api({ category: "Transformation", invoice_standard: ["EN 16931", "XRechnung 3.0.2", "ZUGFeRD", "Factur-X"] }), [], []);
const beliq = () => side(api({ category: "Transformation", invoice_standard: ["EN 16931", "Peppol BIS Billing 3.0"] }));
const validator = () => side(api({ category: "Validation", invoice_standard: ["EN 16931"] }));
const withClaims = <T extends { standard_claims?: readonly StandardClaim[] }>(s: T, claims: StandardClaim[]) => ({ ...s, standard_claims: claims });

test("2.0b NormAPI Generate -> Peppol Validator fails on the claims; beliq -> Peppol Validator passes", () => {
  const bad = runStandard(withClaims(normapi(), [out("XRechnung", "3.0.2")]), withClaims(validator(), [inp("Peppol BIS Billing", "3.0")]));
  assert.equal(bad.status, "fail");
  assert.equal(bad.reason_code, "invoice_standard_mismatch");
  assert.equal(bad.source_basis, "claims");
  assert.ok(bad.flags.includes("claims_unreviewed"));
  const ok = runStandard(withClaims(beliq(), [out("Peppol BIS Billing", "3.0"), out("XRechnung", "3.0.2")]), withClaims(validator(), [inp("Peppol BIS Billing", "3.0")]));
  assert.equal(ok.status, "pass");
  assert.equal(ok.matches[0].relation, "same");
});

test("2.0b falls back to the catalogue label; a side with nothing recorded does not vote", () => {
  const viaLabel = runStandard(normapi(), side(api({ invoice_standard: ["Peppol PINT A-NZ 1.1.3", "UBL 2.1"] })));
  assert.equal(viaLabel.target_basis, "catalogue");
  const none = runStandard(side(api({ invoice_standard: [] })), validator());
  assert.equal(none.status, "not_voting");
  assert.ok(none.flags.includes("standard_not_recorded"));
  const syntaxOnly = runStandard(side(api({ invoice_standard: ["UBL 2.1"] })), validator());
  assert.equal(syntaxOnly.status, "not_voting");
});

test("2.0b BIS 3.0 into PINT A-NZ passes with fill_required; only a version difference does not vote", () => {
  const fill = runStandard(side(api({ invoice_standard: ["Peppol BIS Billing 3.0"] })), side(api({ invoice_standard: ["Peppol PINT A-NZ 1.1.3"] })));
  assert.equal(fill.status, "pass");
  assert.ok(fill.flags.includes("fill_required"));
  const version = runStandard(side(api({ invoice_standard: ["XRechnung 3.0"] })), side(api({ invoice_standard: ["XRechnung 3.0.2"] })));
  assert.equal(version.status, "not_voting");
  assert.ok(version.flags.includes("version_differs"));
});

test("2.0b a validator passing on its document is read on its input side", () => {
  const ess = withClaims(validator(), [inp("Peppol BIS Billing", "3.0")]);
  const target = side(api({ invoice_standard: ["XRechnung 3.0.2"] }));
  // Passing on: its input claim (Peppol BIS 3.0) meets XRechnung -> disjoint.
  assert.equal(runStandard(ess, target, true).status, "fail");
  // Read as an ordinary source it has no output claim, so its label (EN 16931) applies:
  // the target needs a CIUS of it -> which identifier the source writes is unknown.
  assert.equal(runStandard(ess, target, false).status, "unknown");
});

test("review describes the claims actually used, without changing the standard verdict", () => {
  const source = withClaims(beliq(), [out("Peppol BIS Billing", "3.0"),
    { ...inp("XRechnung"), status: "reported" },
    { ...out("XRechnung"), status: "rejected" }]);
  const target = withClaims(validator(), [{ ...inp("Peppol BIS Billing", "3.0"), status: "confirmed" }]);
  const before = runStandard(source, target);
  assert.equal(before.review?.source.status, "unreviewed");
  source.standard_claims[0].status = "confirmed";
  const after = runStandard(source, target);
  assert.equal(after.review?.source.status, "confirmed");
  assert.equal(after.review?.target.status, "confirmed");
  assert.equal(after.status, before.status);
  assert.deepEqual(after.matches, before.matches);
  const catalogue = runStandard(beliq(), validator());
  assert.equal(catalogue.review?.source.status, "not_assessed");
  const syntax = runStandard(withClaims(beliq(), [{ ...out("UBL"), status: "confirmed" }]), target);
  assert.equal(syntax.review?.source.status, "not_recorded");
});

test("runChecks reports the input claim review for a pass-through validator", () => {
  const source = withClaims(side(api({ category: "Validation", input_formats: ["XML"] }), [
    schema({ direction: "request", media_type: "application/xml", raw: { type: "string" } }),
  ]), [{ ...inp("Peppol BIS Billing", "3.0"), status: "confirmed" }, out("XRechnung", "3.0.2")]);
  const target = side(api({ category: "Communication", invoice_standard: ["Peppol BIS Billing 3.0"] }));
  const standard = runChecks(pair(source, target)).check2.standard!;
  assert.equal(standard.status, "pass");
  assert.deepEqual(standard.review?.source, { direction: "input", status: "confirmed" });
});

test("2.0b failing blocks before field mapping: no drop-downs are asked for", () => {
  const source = side(api({ category: "Transformation", invoice_standard: ["XRechnung 3.0.2"] }), [schema({ direction: "response" }, ["invoiceNumber:string:req"])]);
  const target = side(api({ category: "Validation", invoice_standard: ["Peppol BIS Billing 3.0"] }), [schema({ direction: "request" }, ["docRef:string:req"])]);
  const report = runChecks(pair(source, target));
  assert.equal(report.check2.standard?.status, "fail");
  assert.equal(report.overall.overall, "fail");
  assert.ok(report.overall.blocking_checks.includes("check2.0b"));
  assert.ok(report.overall.reason_codes.includes("invoice_standard_mismatch"));
});

test("2.0b a source known only to follow EN 16931 into a CIUS validator is unconfirmed, and blocks", () => {
  const generic = side(api({ category: "Validation", invoice_standard: ["EN 16931", "UBL 2.1"] }), [schema({ direction: "response" }, ["id:string:req"])]);
  const bis = side(api({ category: "Communication", invoice_standard: ["Peppol BIS Billing 3.0"] }), [schema({ direction: "request" }, ["docRef:string:req"])]);
  const st = runStandard(generic, bis);
  assert.equal(st.status, "unknown");
  assert.equal(st.reason_code, "invoice_standard_unconfirmed");
  assert.ok(st.flags.includes("customization_unconfirmed"));
  const report = runChecks(pair(generic, bis));
  assert.equal(report.overall.overall, "fail");
  assert.equal(report.overall.blocking_reason, "insufficient_info");
  // The other way round, a CIUS into an EN 16931 validator passes (subset).
  assert.equal(runStandard(bis, side(api({ invoice_standard: ["EN 16931"] }))).status, "pass");
});

test("2.0b a parent listed next to its CIUS is dropped: NormAPI's label alone still fails into Peppol BIS", () => {
  const st = runStandard(normapi(), side(api({ invoice_standard: ["Peppol BIS Billing 3.0"] })));
  assert.deepEqual(st.source_standards.map((v) => v.standard).sort(), ["Factur-X", "XRechnung"]);
  assert.equal(st.status, "fail");
  assert.equal(r("Peppol BIS Billing 3.0").customization_id, "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0");
});

// 14 October 2026: a claim's request option is reported with the pass, as the
// real beliq calls of 26 and 28 September had to set standard=peppol-bis.
test("2.0b a matched standard that needs a request option passes with configuration_required and names the option", () => {
  const claims: StandardClaim[] = [
    { ...out("Peppol BIS Billing", "3.0"), condition: "standard=peppol-bis; output=xml; profile=peppol (default)" },
    { ...out("XRechnung", "3.0.2"), condition: "standard=xrechnung; output=xml" },
  ];
  const r = runStandard(withClaims(beliq(), claims), withClaims(validator(), [inp("Peppol BIS Billing", "3.0")]));
  assert.equal(r.status, "pass");
  assert.ok(r.flags.includes("configuration_required"));
  // Only the matched standard's option is reported, not XRechnung's.
  assert.deepEqual(r.conditions, [{ side: "source", standard: "Peppol BIS Billing 3.0", condition: "standard=peppol-bis; output=xml; profile=peppol (default)" }]);
  // Without a condition, nothing is reported; a failing pair reports none either.
  const plain = runStandard(withClaims(beliq(), [out("Peppol BIS Billing", "3.0")]), withClaims(validator(), [inp("Peppol BIS Billing", "3.0")]));
  assert.deepEqual(plain.conditions, []);
  assert.ok(!plain.flags.includes("configuration_required"));
  const bad = runStandard(withClaims(normapi(), [{ ...out("XRechnung", "3.0.2"), condition: "syntax=cii" }]), withClaims(validator(), [inp("Peppol BIS Billing", "3.0")]));
  assert.equal(bad.status, "fail");
  assert.deepEqual(bad.conditions, []);
});
