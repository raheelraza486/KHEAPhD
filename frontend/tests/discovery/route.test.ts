import assert from "node:assert/strict";
import test from "node:test";
import { parseProcessJson } from "../../lib/composition/process-format.ts";
import {
  DiscoveryConfigurationError,
  DiscoveryProviderError,
  type DiscoveryProviderOptions,
} from "../../lib/discovery/provider.ts";
import type { DiscoveryInput } from "../../lib/discovery/types.ts";
import { routeHarness } from "../helpers/route-harness.ts";

const modelOutput = {
  version: "1.0",
  input_text: "model changed the wording",
  steps: [{
    order: 1,
    category: "Transformation",
    task: "convert PDF to UBL XML",
    input_format: "PDF",
    output_format: "UBL XML",
    rule_set: null,
    candidate_ids: ["11111111-1111-4111-8111-111111111111"],
  }],
  unmatched: [],
};

function request(body: unknown) {
  return new Request("https://example.test/api/discovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function bpmnRequest() {
  const form = new FormData();
  form.set("mode", "bpmn");
  form.set("file", new File([new Uint8Array([1, 2, 3])], "gateway.png", { type: "image/png" }));
  return new Request("https://example.test/api/discovery", { method: "POST", body: form });
}

function route(options: {
  user?: { id: string; role: string } | null;
  retryAfter?: number;
  discover?: (input: DiscoveryInput, options?: DiscoveryProviderOptions) => Promise<unknown>;
} = {}) {
  return routeHarness({
    "@/lib/auth": {
      getCurrentAppUser: async () => options.user === undefined
        ? { id: "user-1", role: "viewer" }
        : options.user,
    },
    "@/lib/discovery/rate-limit": {
      checkDiscoveryRateLimit: () => options.retryAfter ?? 0,
    },
    "@/lib/discovery/provider": {
      DiscoveryConfigurationError,
      DiscoveryProviderError,
      discoverProcess: options.discover ?? (async () => modelOutput),
    },
  })("app/api/discovery/route.ts");
}

test("returns strict process JSON and never accepts model-invented repository IDs", async () => {
  const response = await route().POST(request({ mode: "text", text: "convert PDF to UBL XML" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body.source, { mode: "text" });
  assert.equal(body.process.input_text, "convert PDF to UBL XML");
  assert.equal(body.process.steps[0].candidate_ids, null);
  assert.equal(parseProcessJson(body.process).ok, true);
});

test("review notes accompany the response without changing Process JSON 1.0", async () => {
  const response = await route({ discover: async (_input, options) => {
    options?.onReview?.([{ order: 1, message: 'Review this suggested conversion.' }]);
    return modelOutput;
  } }).POST(request({ mode: 'text', text: 'convert PDF to UBL XML' }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.review, [{ order: 1, message: 'Review this suggested conversion.' }]);
  assert.ok(parseProcessJson(body.process).ok);
  assert.ok(!Object.hasOwn(body.process.steps[0], 'suggested'));
});

test("collapses a BPMN gateway's email and Peppol branches into one sending step", async () => {
  const gatewayOutput = {
    version: "1.0",
    input_text: "generate and validate an invoice, then send it by email or Peppol",
    steps: [
      { order: 1, category: "Transformation", task: "generate UBL invoice", input_format: "JSON", output_format: "UBL XML", rule_set: null, candidate_ids: null },
      { order: 2, category: "Validation", task: "validate invoice", input_format: "UBL XML", output_format: null, rule_set: "Peppol BIS", candidate_ids: null },
      { order: 3, category: "Communication", task: "send by email", input_format: "UBL XML", output_format: null, rule_set: null, candidate_ids: null },
      { order: 4, category: "Communication", task: "send over Peppol", input_format: "UBL XML", output_format: null, rule_set: "Peppol BIS", candidate_ids: null },
    ],
    unmatched: [],
  };
  const response = await route({ discover: async () => gatewayOutput }).POST(bpmnRequest());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.process.steps.map((step: { order: number; task: string }) => [step.order, step.task]), [
    [1, "generate UBL invoice"],
    [2, "validate invoice"],
    [3, "send via email or Peppol"],
  ]);
  assert.equal(body.process.steps[2].input_format, "UBL XML");
  assert.equal(body.process.steps[2].rule_set, null);
  assert.equal(parseProcessJson(body.process).ok, true);
});

test("a gateway image read as one email step offers both channels and drops the missing-step note", async () => {
  const output = {
    version: "1.0",
    input_text: "Invoice process (BPMN) starting with PDF invoice, converting to UBL XML, validating using Australian rules, and then sending via email or Peppol.",
    steps: [
      { order: 1, category: "Transformation", task: "Convert PDF to UBL XML", input_format: "PDF", output_format: "UBL XML", rule_set: null, candidate_ids: null },
      { order: 2, category: "Validation", task: "Validate using Australian rules", input_format: null, output_format: null, rule_set: "Australian rules", candidate_ids: null },
      { order: 3, category: "Communication", task: "Send invoice via email", input_format: null, output_format: null, rule_set: null, candidate_ids: null },
    ],
    unmatched: [],
  };
  const response = await route({ discover: async (_input, options) => {
    options?.onReview?.([
      { message: "Check the extracted steps and labels against your upload. Their source text is a model transcription." },
      { order: 3, message: "The source names multiple delivery actions but only one step was extracted. Review the missing send step." },
    ]);
    return output;
  } }).POST(bpmnRequest());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.process.steps[2].task, "send via email or Peppol");
  assert.deepEqual(body.review, [{ message: "Check the extracted steps and labels against your upload. Their source text is a model transcription." }]);
  assert.equal(parseProcessJson(body.process).ok, true);
});

test("does not collapse explicitly sequential text sending steps", async () => {
  const sequentialOutput = {
    ...modelOutput,
    steps: [
      { order: 1, category: "Communication", task: "send by email", input_format: null, output_format: null, rule_set: null, candidate_ids: null },
      { order: 2, category: "Communication", task: "send over Peppol", input_format: null, output_format: null, rule_set: null, candidate_ids: null },
    ],
  };
  const response = await route({ discover: async () => sequentialOutput }).POST(request({
    mode: "text",
    text: "send by email, then send over Peppol",
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.process.steps.length, 2);
  assert.deepEqual(body.process.steps.map((step: { task: string }) => step.task), ["send by email", "send over Peppol"]);
});

test("does not collapse two sequential sends in a BPMN image summary", async () => {
  const sequentialOutput = {
    ...modelOutput,
    input_text: "first send via Peppol, then send via email",
    steps: [
      { order: 1, category: "Communication", task: "send via Peppol", input_format: null, output_format: null, rule_set: null, candidate_ids: null },
      { order: 2, category: "Communication", task: "send via email", input_format: null, output_format: null, rule_set: null, candidate_ids: null },
    ],
  };
  const response = await route({ discover: async () => sequentialOutput }).POST(bpmnRequest());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.process.steps.map((step: { task: string }) => step.task), ["send via Peppol", "send via email"]);
});

test("requires an authenticated repository user before calling the model", async () => {
  let called = false;
  const response = await route({
    user: null,
    discover: async () => { called = true; return modelOutput; },
  }).POST(request({ mode: "text", text: "send invoice" }));
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("returns a retry delay when the per-user model quota is exhausted", async () => {
  const response = await route({ retryAfter: 9 }).POST(request({ mode: "text", text: "send invoice" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "9");
});

test("rejects a schema-invalid model result without returning the raw output", async () => {
  const invalid = { ...modelOutput, steps: [{ ...modelOutput.steps[0], category: "Other" }] };
  const response = await route({ discover: async () => invalid }).POST(request({ mode: "text", text: "do something" }));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error, "The model result did not match process JSON 1.0.");
  assert.ok(body.details.some((item: { path: string }) => item.path === "steps[0].category"));
  assert.ok(!JSON.stringify(body).includes("model changed the wording"));
});

test("reports missing model configuration as a service error", async () => {
  const response = await route({
    discover: async () => { throw new DiscoveryConfigurationError(); },
  }).POST(request({ mode: "text", text: "send invoice" }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "API Discovery is not configured.");
});

test("keeps upstream provider details private and forwards Retry-After", async () => {
  const response = await route({
    discover: async () => { throw new DiscoveryProviderError("temporarily_unavailable", "private provider detail", "15"); },
  }).POST(request({ mode: "text", text: "send invoice" }));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "15");
  assert.ok(!JSON.stringify(body).includes("private provider detail"));
});



test("text delivery alternatives keep their grounded step and review warning", async () => {
  const note = { order: 1, message: "The source names multiple delivery actions but only one step was extracted. Review the missing send step." };
  const output = {
    ...modelOutput,
    steps: [{ order: 1, category: "Communication", task: "Send via email", input_format: null, output_format: null, rule_set: null, candidate_ids: null }],
  };
  const response = await route({ discover: async (_input, options) => {
    options?.onReview?.([note]);
    return output;
  } }).POST(request({ mode: "text", text: "send via email or Peppol" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.process.steps[0].task, "Send via email");
  assert.deepEqual(body.review, [note]);
});
