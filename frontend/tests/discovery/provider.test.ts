import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryConfigurationError,
  DiscoveryProviderError,
  discoverProcess,
} from "../../lib/discovery/provider.ts";

const processJson = {
  version: "1.0",
  input_text: "convert PDF to UBL XML",
  steps: [{
    order: 1,
    category: "Transformation",
    task: "convert PDF to UBL XML",
    input_format: "PDF",
    output_format: "UBL XML",
    rule_set: null,
    candidate_ids: null,
  }],
  unmatched: [],
};

test("calls the configured Gemini model with a structured response schema", async () => {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  const result = await discoverProcess(
    { mode: "text", text: "convert PDF to UBL XML" },
    {
      apiKey: "test-key",
      model: "gemini-test-model",
      fetchImpl: async (input, init) => {
        calledUrl = String(input);
        calledInit = init;
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(processJson) }] } }] });
      },
    },
  );
  assert.deepEqual(result, processJson);
  assert.match(calledUrl, /gemini-test-model:generateContent$/);
  assert.equal(new Headers(calledInit?.headers).get("x-goog-api-key"), "test-key");
  const body = JSON.parse(String(calledInit?.body));
  assert.equal(body.generationConfig.responseFormat.text.mimeType, "APPLICATION_JSON");
  assert.deepEqual(body.generationConfig.responseFormat.text.schema.properties.steps.maxItems, 4);
  assert.equal(body.contents[0].parts.length, 1);
  assert.ok(!JSON.stringify(body).includes("Repository API ids"));
});

test("sends BPMN bytes inline without sending repository records", async () => {
  let requestBody: Record<string, any> = {};
  await discoverProcess(
    {
      mode: "bpmn",
      file: new File([new Uint8Array([1, 2, 3])], "flow.png", { type: "image/png" }),
    },
    {
      apiKey: "test-key",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ candidates: [{ content: { parts: [{ text: `\`\`\`json\n${JSON.stringify(processJson)}\n\`\`\`` }] } }] });
      },
    },
  );
  assert.deepEqual(requestBody.contents[0].parts[1].inline_data, {
    mime_type: "image/png",
    data: "AQID",
  });
  assert.match(requestBody.systemInstruction.parts[0].text, /email and Peppol are alternative send branches/i);
  assert.match(requestBody.systemInstruction.parts[0].text, /First send via Peppol, then send via email.*two sequential Communication steps/i);
  assert.match(requestBody.contents[0].parts[0].text, /combine email and Peppol send branches into one Communication step/i);
});

test("requires a server-side API key", async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => discoverProcess({ mode: "text", text: "send invoice" }, { apiKey: "" }),
      DiscoveryConfigurationError,
    );
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test("maps an upstream quota response without exposing its body", async () => {
  await assert.rejects(
    () => discoverProcess(
      { mode: "text", text: "send invoice" },
      {
        apiKey: "test-key",
        fetchImpl: async () => new Response("private provider detail", {
          status: 429,
          headers: { "Retry-After": "12" },
        }),
      },
    ),
    (error) => error instanceof DiscoveryProviderError
      && error.code === "temporarily_unavailable"
      && error.retryAfter === "12"
      && !error.message.includes("private provider detail"),
  );
});

test('model deadline covers response body consumption, not just response headers', async () => {
  // Keep the test process alive while AbortSignal.timeout's unref'ed timer expires.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(discoverProcess({ mode: 'text', text: 'generate invoice' }, {
      apiKey: 'test-key', timeoutMs: 15,
      fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response,
    }), (error: unknown) => error instanceof DiscoveryProviderError && error.code === 'timeout');
  } finally { clearInterval(keepAlive); }
});

test('cancellation aborts the upstream model request and preserves error privacy', async () => {
  const controller = new AbortController();
  let upstream: AbortSignal | undefined;
  const result = discoverProcess({ mode: 'text', text: 'generate invoice' }, {
    apiKey: 'test-key', signal: controller.signal,
    fetchImpl: async (_input, init) => { upstream = init?.signal ?? undefined; return new Promise(() => {}); },
  });
  await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(result, DiscoveryProviderError);
  assert.equal(upstream?.aborted, true);
});

