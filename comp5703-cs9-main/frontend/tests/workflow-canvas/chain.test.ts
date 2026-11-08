import assert from "node:assert/strict";
import test from "node:test";

import { addApi, chainProblems, connectionPairs, insertionIndex, moveApi, removeApi, replaceApi, type CanvasApi } from "../../lib/workflow-canvas/chain.ts";

const api = (id: string, category: CanvasApi["category"]): CanvasApi => ({ id, api_name: `${id} API`, company_name: id, category });
const EXTRACT = api("extract", "Transformation");
const CONVERT = api("convert", "Transformation");
const VALIDATE = api("validate", "Validation");
const EMAIL = api("email", "Communication");
const PEPPOL = api("peppol", "Communication");
const ids = (chain: readonly CanvasApi[]) => chain.map((item) => item.id);

test("a new API goes where its category belongs", () => {
  const chain = [EXTRACT, VALIDATE, EMAIL];
  assert.equal(insertionIndex(chain, "Transformation"), 1);
  assert.equal(insertionIndex(chain, "Validation"), 2);
  assert.equal(insertionIndex(chain, "Communication"), 3);
  const added = addApi(chain, CONVERT);
  assert.equal(added.ok, true);
  if (added.ok) assert.deepEqual(ids(added.chain), ["extract", "convert", "validate", "email"]);
});

test("an edit that breaks the client's rules is refused with the reason", () => {
  const full = [EXTRACT, CONVERT, VALIDATE, EMAIL];
  assert.deepEqual(addApi(full, PEPPOL), { ok: false, reason: "A workflow has at most 4 API steps." });
  const skipped = addApi([CONVERT], EMAIL);
  assert.equal(skipped.ok, false);
  if (!skipped.ok) assert.match(skipped.reason, /validation step must come between/);
  const removed = removeApi(full, 2);
  assert.equal(removed.ok, false);
  if (!removed.ok) assert.match(removed.reason, /Replace this step instead/);
  const backwards = moveApi([CONVERT, VALIDATE, EMAIL], 1, -1);
  assert.equal(backwards.ok, false);
  if (!backwards.ok) assert.match(backwards.reason, /Transformation → Validation → Communication/);
});

test("replace, remove and move keep the chain otherwise unchanged", () => {
  const chain = [EXTRACT, CONVERT, VALIDATE, EMAIL];
  const replaced = replaceApi(chain, 3, PEPPOL);
  assert.equal(replaced.ok, true);
  if (replaced.ok) assert.deepEqual(ids(replaced.chain), ["extract", "convert", "validate", "peppol"]);
  assert.equal(replaceApi(chain, 3, EMAIL).ok, false, "replacing a step with itself is no change");
  const removed = removeApi(chain, 3);
  assert.equal(removed.ok, true);
  if (removed.ok) assert.deepEqual(ids(removed.chain), ["extract", "convert", "validate"]);
  const moved = moveApi(chain, 0, 1);
  assert.equal(moved.ok, true);
  if (moved.ok) assert.deepEqual(ids(moved.chain), ["convert", "extract", "validate", "email"]);
  assert.equal(moveApi(chain, 3, 1).ok, false);
  assert.deepEqual(ids(chain), ["extract", "convert", "validate", "email"], "the original is not changed");
});

test("connections pair each step with the step whose document it receives", () => {
  // The validator passes the document on, so the sender reads the converter's output.
  assert.deepEqual(connectionPairs([EXTRACT, CONVERT, VALIDATE, EMAIL]), [
    { from: 0, to: 1 }, { from: 1, to: 2 }, { from: 1, to: 3 },
  ]);
  assert.deepEqual(connectionPairs([VALIDATE]), []);
  assert.deepEqual(connectionPairs([CONVERT, EMAIL]), [], "a chain that breaks the rules has no connections to check");
});

test("an empty chain has no problems; a valid one has none either", () => {
  assert.deepEqual(chainProblems([]), []);
  assert.deepEqual(chainProblems([EXTRACT, CONVERT, VALIDATE, PEPPOL]), []);
});
