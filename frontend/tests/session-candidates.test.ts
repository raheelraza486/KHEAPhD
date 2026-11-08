import { test } from "node:test";
import assert from "node:assert/strict";
import {
  operationKey,
  parseStoredCandidates,
  type StoredCandidates,
} from "../lib/import/session-candidates.ts";

test("operation identity encoding cannot collide at field boundaries", () => {
  const first = operationKey({ api_endpoint: "https://api.x.dev/a\u0000POST", http_method: "GET" });
  const second = operationKey({ api_endpoint: "https://api.x.dev/a", http_method: "POST\u0000GET" });
  assert.notEqual(first, second);
  assert.deepEqual(JSON.parse(first), ["https://api.x.dev/a\u0000POST", "GET"]);
});

test("stored candidates parse from PostgREST strings and native JSONB objects", () => {
  const stored: StoredCandidates = {
    items: [],
    selected_indices: [1, 3],
    applied_indices: [1],
  };
  assert.deepEqual(parseStoredCandidates(JSON.stringify(stored)), stored);
  assert.equal(parseStoredCandidates(stored), stored);
});

test("malformed or non-object session data fails closed", () => {
  assert.deepEqual(parseStoredCandidates("not json"), {});
  assert.deepEqual(parseStoredCandidates([]), {});
  assert.deepEqual(parseStoredCandidates(null), {});
});
