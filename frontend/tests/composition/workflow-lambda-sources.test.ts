import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GENERATED, renderGenerated } from "../../scripts/build-workflow-lambdas.mjs";

test("the mapping Lambdas' JavaScript is the current #96 code (run scripts/build-workflow-lambdas.mjs after changing it)", () => {
  // A Windows checkout may turn the file's line endings into CRLF; only the content counts.
  const committed = readFileSync(new URL(`../../${GENERATED}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(committed, renderGenerated());
});
