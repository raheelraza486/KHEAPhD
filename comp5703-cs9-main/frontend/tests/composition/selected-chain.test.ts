import assert from "node:assert/strict";
import test from "node:test";
import { parseSelectedCompositionChain } from "../../lib/composition/selected-chain.ts";

const valid = {
  version: "1.0",
  process: { version: "1.0", name: "Invoice delivery", steps: [] },
  chain: {
    api_ids: ["api-1"],
    links: [],
    status: "feasible",
  },
  apis: [
    {
      step_order: 1,
      category: "Extraction",
      api_id: "api-1",
      api_name: "Example API",
      company_name: "Example",
      score: 1,
      matched_terms: [],
      candidate_source: "discovery",
    },
  ],
};

test("parses a complete saved feasible chain", () => {
  assert.deepEqual(parseSelectedCompositionChain(JSON.stringify(valid)), valid);
  const fromWorkflow = { ...valid, workflow_draft_id: '11111111-1111-4111-8111-111111111111' };
  assert.deepEqual(parseSelectedCompositionChain(JSON.stringify(fromWorkflow)), fromWorkflow);
  assert.equal(parseSelectedCompositionChain(JSON.stringify({ ...valid, workflow_draft_id: '../other-page' })), null);
});

test("rejects invalid JSON and a mismatched API sequence", () => {
  assert.equal(parseSelectedCompositionChain("{"), null);
  assert.equal(
    parseSelectedCompositionChain(
      JSON.stringify({
        ...valid,
        apis: [{ ...valid.apis[0], api_id: "different-api" }],
      }),
    ),
    null,
  );
});

test("rejects a non-feasible saved chain", () => {
  assert.equal(
    parseSelectedCompositionChain(
      JSON.stringify({
        ...valid,
        chain: { ...valid.chain, status: "needs_decision" },
      }),
    ),
    null,
  );
});
