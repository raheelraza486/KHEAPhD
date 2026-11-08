import assert from "node:assert/strict";
import test from "node:test";

import { runCheck0 } from "../../lib/checks/check0-operation.ts";
import type { PairInput } from "../../lib/checks/types.ts";

function pair(
  sourceCategory: string | null,
  targetCategory: string | null,
): PairInput {
  const makeSide = (
    id: string,
    category: string | null,
  ) => ({
    api: {
      id,
      api_name: `${id} API`,
      company_name: "Test provider",
      category,
      api_endpoint: null,
      http_method: null,
      input_formats: ["JSON"],
      output_formats: ["JSON"],
      authentication_method: "None",
      authentication_details: null,
    },
    schemas: [],
    parameters: [],
  });

  return {
    source: makeSide("source", sourceCategory),
    target: makeSide("target", targetCategory),
    formatAliases: [],
    choices: [],
  };
}

test("forward operation sequence passes", () => {
  assert.equal(
    runCheck0(
      pair("Transformation", "Validation"),
    ).status,
    "pass",
  );

  assert.equal(
    runCheck0(
      pair("Validation", "Communication"),
    ).status,
    "pass",
  );
});

test("Transformation straight to Communication skips Validation and fails", () => {
  const result = runCheck0(
    pair("Transformation", "Communication"),
  );

  assert.equal(result.status, "fail");
  assert.equal(
    result.reason_code,
    "operation_sequence_skips_validation",
  );
});

test("Transformation to Communication passes when a Validation step stands between them", () => {
  const result = runCheck0({
    ...pair("Transformation", "Communication"),
    validatedBetween: true,
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.flags, ["validated_in_between"]);
});

test("two Transformations in a row pass with a flag", () => {
  const result = runCheck0(
    pair("Transformation", "Transformation"),
  );

  assert.equal(result.status, "pass");
  assert.deepEqual(result.flags, ["same_operation_category"]);
});

test("a Validation after a Validation, or a Communication after a Communication, fails (decided 7 October 2026)", () => {
  for (const category of ["Validation", "Communication"] as const) {
    const result = runCheck0(pair(category, category));
    assert.equal(result.status, "fail");
    assert.equal(result.reason_code, "operation_sequence_repeats_stage");
    assert.deepEqual(result.flags, []);
  }
});

test("a reversed sequence fails", () => {
  const result = runCheck0(
    pair("Communication", "Validation"),
  );

  assert.equal(result.status, "fail");
  assert.equal(
    result.reason_code,
    "operation_sequence_reversed",
  );
});

test("Other and missing categories remain unknown", () => {
  assert.equal(
    runCheck0(
      pair("Other", "Validation"),
    ).status,
    "unknown",
  );

  assert.equal(
    runCheck0(
      pair(null, "Communication"),
    ).status,
    "unknown",
  );
});