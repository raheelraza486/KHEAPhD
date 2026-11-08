import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, tokenizeName } from "../../lib/compatibility/name.ts";
import { sequenceRatio } from "../../lib/compatibility/sequence-ratio.ts";
import { primitiveRelation } from "../../lib/compatibility/relation.ts";
import { normalizeSchema, buildIndex } from "../../lib/compatibility/normalize.ts";
import { findMappingCandidateWithTier } from "../../lib/compatibility/candidates.ts";

// These cases mirror the upstream CompatibilityEngineTest so a regression in
// the tier ranking fails here rather than somewhere downstream.

const type = (t: string) => ({ type: t });

function sourceIndexOf(props: Record<string, unknown>) {
  return buildIndex(normalizeSchema({ type: "object", properties: props }), "$");
}

test("normalizeName lowercases, strips punctuation and singularises", () => {
  assert.equal(normalizeName("Line_Items"), "lineitem");
  assert.equal(normalizeName("bus"), "bus");
  assert.equal(normalizeName("ids"), "ids");
  assert.equal(normalizeName("customerId"), "customerid");
});

test("tokenizeName splits camelCase and underscores, singularising each token", () => {
  assert.deepEqual([...tokenizeName("LineItems")], ["line", "item"]);
  assert.deepEqual([...tokenizeName("invoice_date")], ["invoice", "date"]);
  assert.deepEqual([...tokenizeName("IRN")], ["irn"]);
});

test("sequenceRatio behaves like difflib for known pairs", () => {
  assert.equal(sequenceRatio("", ""), 1);
  assert.equal(sequenceRatio("abc", "abc"), 1);
  assert.equal(sequenceRatio("abc", "xyz"), 0);
  // difflib: SequenceMatcher(None, "rate", "price").ratio() == 0.4444...
  assert.ok(Math.abs(sequenceRatio("rate", "price") - 4 / 9) < 1e-9);
  // difflib: "descriptoin" vs "description" -> 0.9090...
  assert.ok(Math.abs(sequenceRatio("descriptoin", "description") - 20 / 22) < 1e-9);
});

test("primitiveRelation: integer -> number is direct, casts are mapping, the rest incompatible", () => {
  assert.equal(primitiveRelation(type("integer"), type("number")), "direct");
  assert.equal(primitiveRelation(type("number"), type("integer")), "mapping");
  assert.equal(primitiveRelation(type("string"), type("integer")), "mapping");
  assert.equal(primitiveRelation(type("boolean"), type("string")), "mapping");
  assert.equal(primitiveRelation(type("null"), type("string")), "mapping");
  assert.equal(primitiveRelation(type("string"), type("object")), "incompatible");
  assert.equal(primitiveRelation(type("unknown"), type("string")), "incompatible");
});

test("tier 0: same normalised name with a directly compatible type", () => {
  const match = findMappingCandidateWithTier("invoiceDate", type("string"), sourceIndexOf({ invoice_date: type("string") }), new Set());
  assert.equal(match?.tier, 0);
  assert.equal(match?.entry.path, "invoice_date");
});

test("tier 1: same normalised name but the type needs converting", () => {
  const match = findMappingCandidateWithTier("total_amt", type("string"), sourceIndexOf({ totalAmt: type("integer") }), new Set());
  assert.equal(match?.tier, 1);
});

test("tier 2: token subset with a directly compatible type", () => {
  const match = findMappingCandidateWithTier("name", type("string"), sourceIndexOf({ customerName: type("string") }), new Set());
  assert.equal(match?.tier, 2);
});

test("tier 3: token subset that also needs type conversion", () => {
  const match = findMappingCandidateWithTier("amount", type("string"), sourceIndexOf({ orderAmount: type("integer") }), new Set());
  assert.equal(match?.tier, 3);
});

test("tier 4: partial token overlap above the 0.55 similarity floor", () => {
  const match = findMappingCandidateWithTier("referenceNumber", type("string"), sourceIndexOf({ referenceCode: type("string") }), new Set());
  assert.equal(match?.tier, 4);
});

test("tier 5: pure string similarity with no shared tokens", () => {
  const match = findMappingCandidateWithTier("description", type("string"), sourceIndexOf({ descriptoin: type("string") }), new Set());
  assert.equal(match?.tier, 5);
});

test("no candidate at all returns null rather than a weak guess", () => {
  const match = findMappingCandidateWithTier("unrelatedZzz", type("string"), sourceIndexOf({ customerName: type("string") }), new Set());
  assert.equal(match, null);
});

test("a source path already used by another mapping is excluded", () => {
  const match = findMappingCandidateWithTier("invoiceDate", type("string"), sourceIndexOf({ invoice_date: type("string") }), new Set(["invoice_date"]));
  assert.equal(match, null);
});

test("a lower tier always beats a higher tier", () => {
  const match = findMappingCandidateWithTier(
    "invoiceDate",
    type("string"),
    sourceIndexOf({ invoice_date: type("string"), invoiceDateNote: type("string") }),
    new Set(),
  );
  assert.equal(match?.tier, 0);
  assert.equal(match?.entry.path, "invoice_date");
});

test("a type-incompatible entry never becomes a candidate, even with the same name", () => {
  const match = findMappingCandidateWithTier("items", type("array"), sourceIndexOf({ items: type("object") }), new Set());
  assert.equal(match, null);
});
