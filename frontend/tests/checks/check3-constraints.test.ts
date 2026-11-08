import assert from "node:assert/strict";
import test from "node:test";

import { runCheck3, waitingCheck3 } from "../../lib/checks/check3-constraints.ts";
import type { Conversion, Field, Mapping } from "../../lib/checks/types.ts";

function field(path: string, enumValues: readonly string[] | null, extra: Partial<Field> = {}): Field {
  return { path, leaf: path, name: path.toLowerCase(), parent: null, jsonType: "string", format: null, required: true, arrayItem: false, depth: 0, enumValues, description: null, isParameter: false, ...extra };
}

function mapping(notes: string[] = []): Mapping {
  return { source_path: "sourceCode", target_path: "targetCode", unit_id: "U01", origin: "auto", notes };
}

function conversion(source_type: string, target_type: string, condition: string): Conversion {
  return { source_path: "sourceCode", target_path: "targetCode", source_type, target_type, kind: "conditional", condition };
}

function run(sourceValues: readonly string[] | null, targetValues: readonly string[] | null, conversions: readonly Conversion[] = [], notes: string[] = [], sourceExtra: Partial<Field> = {}) {
  return runCheck3({
    mappings: [mapping(notes)],
    sourceFields: new Map([["sourceCode", field("sourceCode", sourceValues, sourceExtra)]]),
    targetFields: new Map([["targetCode", field("targetCode", targetValues)]]),
    conversions,
  });
}

test("a source enum contained by the target enum passes", () => {
  const result = run(["AUD", "USD"], ["AUD", "USD", "EUR"]);
  assert.equal(result.status, "pass");
  assert.equal(result.reason_code, null);
});

test("enum values are compared ignoring case", () => {
  const result = run(["cancelled", "Paid"], ["CANCELLED", "PAID"]);
  assert.equal(result.status, "pass");
});

test("a partial enum overlap fails", () => {
  const result = run(["AUD", "USD", "JPY"], ["AUD", "USD"]);
  assert.equal(result.status, "fail");
  assert.equal(result.reason_code, "value_constraint_incompatible");
  assert.equal(result.issues[0]?.kind, "enum_partial_overlap");
  assert.deepEqual(result.issues[0]?.unsupported_values, ["JPY"]);
});

test("disjoint enum values fail", () => {
  const result = run(["AU"], ["AUS"]);
  assert.equal(result.status, "fail");
  assert.equal(result.issues[0]?.kind, "enum_no_overlap");
});

test("a target enum with no declared source values is unknown when the source is a string", () => {
  const result = run(null, ["AU", "NZ"]);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason_code, "value_constraint_unknown");
  assert.equal(result.issues[0]?.kind, "source_values_unknown");
  assert.deepEqual(result.issues[0]?.target_values, ["AU", "NZ"]);
  assert.ok(!result.flags.includes("value_mapping_required"));
});

test("a target enum of words that an object or number source can never produce fails", () => {
  const object = run(null, ["VALIDATED", "PAID"], [], [], { jsonType: "object" });
  assert.equal(object.status, "fail");
  assert.equal(object.issues[0]?.kind, "source_type_mismatch");
  const integer = run(null, ["VALIDATED", "PAID"], [], [], { jsonType: "integer" });
  assert.equal(integer.status, "fail");
  // digits as enum values: an integer source may well produce them
  const digits = run(null, ["0", "1", "2"], [], [], { jsonType: "integer" });
  assert.equal(digits.status, "unknown");
  assert.equal(digits.issues[0]?.kind, "source_values_unknown");
});

test("a conditional conversion with no source evidence stays unknown", () => {
  const result = run(null, null, [conversion("string", "number", "value must be numeric text")]);
  assert.equal(result.status, "unknown");
  assert.equal(result.issues[0]?.kind, "conditional_conversion");
  assert.ok(result.flags.includes("runtime_validation_required"));
});

test("a GUID source can never become integer text: fail", () => {
  const result = run(null, null, [conversion("string", "integer", "value must be integer text")], [], { format: "guid" });
  assert.equal(result.status, "fail");
  assert.equal(result.issues[0]?.kind, "conversion_impossible");
  assert.ok(!result.flags.includes("runtime_validation_required"));
});

test("declared source values are tested against the condition", () => {
  const ok = run(["1", "2", "10"], null, [conversion("string", "integer", "value must be integer text")]);
  assert.equal(ok.status, "pass");
  const bad = run(["1", "x"], null, [conversion("string", "integer", "value must be integer text")]);
  assert.equal(bad.status, "fail");
  assert.deepEqual(bad.issues[0]?.unsupported_values, ["x"]);
  const bool = run(["true", "FALSE"], null, [conversion("string", "boolean", "value must be the text true/false")]);
  assert.equal(bool.status, "pass");
});

test("a conversion that succeeds for every value passes and asks for a transformation step", () => {
  const result = run(null, null, [conversion("date-time", "string", "time semantics lost; recorded")]);
  assert.equal(result.status, "pass");
  assert.equal(result.issues[0]?.kind, "conversion_always_succeeds");
  assert.ok(result.flags.includes("value_mapping_required"));
  assert.ok(!result.flags.includes("runtime_validation_required"));
  const date = run(null, null, [conversion("date-time", "date", "time part dropped")]);
  assert.equal(date.status, "pass");
});

test("a representation difference is information, not a vote", () => {
  const result = run(null, null, [], ["representation_differs"]);
  assert.equal(result.status, "not_voting");
  assert.deepEqual(result.representation_differs.map((r) => r.note), ["representation_differs"]);
  assert.ok(result.flags.includes("value_mapping_required"));
  assert.ok(result.flags.includes("no_declared_constraints"));
});

test("an enum failure outranks an undecidable conversion", () => {
  const result = run(["AU"], ["AUS"], [conversion("string", "number", "value must be numeric text")]);
  assert.equal(result.status, "fail");
});

test("no declared constraint does not vote", () => {
  const result = run(null, null);
  assert.equal(result.status, "not_voting");
  assert.deepEqual(result.flags, ["no_declared_constraints"]);
});

test("Check 3 waits while semantic choices remain unresolved", () => {
  const result = waitingCheck3();
  assert.equal(result.status, "not_voting");
  assert.deepEqual(result.flags, ["check3_waiting_for_semantics"]);
});
