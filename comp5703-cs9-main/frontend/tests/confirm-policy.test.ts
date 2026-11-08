import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideAppendOnly,
  normaliseSelectedIndices,
} from "../lib/import/confirm-policy.ts";

test("append-only policy inserts only a new identity with an available name", () => {
  assert.deepEqual(decideAppendOnly(false, false), { action: "insert" });
  assert.deepEqual(decideAppendOnly(false, true), {
    action: "conflict",
    reason: "name_taken",
  });
});

test("append-only policy always skips an existing identity", () => {
  assert.deepEqual(decideAppendOnly(true, false), {
    action: "skip",
    reason: "existing_identity",
  });
  // Even contradictory or malicious client state cannot turn the match into
  // an insert/update path.
  assert.deepEqual(decideAppendOnly(true, true), {
    action: "skip",
    reason: "existing_identity",
  });
});

test("confirm selection accepts only unique in-range integer indexes", () => {
  assert.deepEqual(normaliseSelectedIndices([2, 0], 3), [2, 0]);
  assert.equal(normaliseSelectedIndices([], 3), null);
  assert.equal(normaliseSelectedIndices([0, 0], 3), null);
  assert.equal(normaliseSelectedIndices([-1], 3), null);
  assert.equal(normaliseSelectedIndices([3], 3), null);
  assert.equal(normaliseSelectedIndices([1.5], 3), null);
  assert.equal(normaliseSelectedIndices(["1"], 3), null);
  assert.equal(normaliseSelectedIndices(null, 3), null);
});
