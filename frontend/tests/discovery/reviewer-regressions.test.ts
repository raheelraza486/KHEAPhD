import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DISCOVERY_MODEL,
  DiscoveryProviderError,
  discoverProcess,
} from "../../lib/discovery/provider.ts";
import {
  DiscoveryInputError,
  MAX_BPMN_XML_BYTES,
  readDiscoveryInput,
} from "../../lib/discovery/input.ts";

const OPEN = String.fromCharCode(60);
const processJson = {
  version: "1.0",
  input_text: "send an invoice",
  steps: [],
  unmatched: [],
};

test("uses the Gemini 3.5 Flash-Lite structured JSON contract", async () => {
  let calledUrl = "";
  let requestBody: Record<string, any> = {};

  await discoverProcess(
    { mode: "text", text: "send an invoice" },
    {
      apiKey: "test-key",
      fetchImpl: async (input, init) => {
        calledUrl = String(input);
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(processJson) }] } }],
        });
      },
    },
  );

  assert.match(calledUrl, new RegExp(`${DEFAULT_DISCOVERY_MODEL}:generateContent$`));
  assert.equal(requestBody.generationConfig.responseFormat.text.mimeType, "APPLICATION_JSON");
});

test("maps Gemini 402 quota responses to temporary unavailability", async () => {
  await assert.rejects(
    () => discoverProcess(
      { mode: "text", text: "send an invoice" },
      {
        apiKey: "test-key",
        fetchImpl: async () => new Response("provider detail", {
          status: 402,
          headers: { "Retry-After": "12" },
        }),
      },
    ),
    (error) => error instanceof DiscoveryProviderError
      && error.code === "temporarily_unavailable"
      && error.retryAfter === "12"
      && !error.message.includes("provider detail"),
  );
});

const BPMN_XML = `${OPEN}bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI">
  ${OPEN}bpmn:process id="invoice">
    ${OPEN}bpmn:task id="create" name="Create invoice" />
    ${OPEN}bpmn:task id="send" name="Send invoice" />
    ${OPEN}bpmn:sequenceFlow id="flow" sourceRef="create" targetRef="send" />
  ${OPEN}/bpmn:process>
  ${OPEN}bpmndi:BPMNDiagram id="drawing">${OPEN}bpmndi:BPMNPlane id="plane" />${OPEN}/bpmndi:BPMNDiagram>
${OPEN}/bpmn:definitions>`;

function upload(contents: BlobPart[], name: string, type = "") {
  const form = new FormData();
  form.set("mode", "bpmn");
  form.set("file", new File(contents, name, { type }));
  return readDiscoveryInput(new Request("https://example.test/api/discovery", {
    method: "POST",
    body: form,
  }));
}

test("accepts BPMN XML by extension and removes diagram layout", async () => {
  const input = await upload([BPMN_XML], "invoice-flow.bpmn");
  assert.equal(input.mode, "bpmn");
  if (input.mode !== "bpmn") return;
  assert.match(input.bpmn_xml ?? "", /bpmn:sequenceFlow/);
  assert.doesNotMatch(input.bpmn_xml ?? "", /bpmndi:BPMNDiagram/);
});

test("rejects XML without a BPMN definitions root", async () => {
  await assert.rejects(
    () => upload([`${OPEN}invoice />`], "invoice.xml", "application/xml"),
    (error) => error instanceof DiscoveryInputError && error.status === 415,
  );
});

test("rejects BPMN XML containing a DOCTYPE", async () => {
  await assert.rejects(
    () => upload([`${OPEN}!DOCTYPE definitions>${BPMN_XML}`], "invoice.bpmn"),
    (error) => error instanceof DiscoveryInputError && error.status === 415,
  );
});

test("rejects BPMN XML larger than one megabyte", async () => {
  await assert.rejects(
    () => upload([new Uint8Array(MAX_BPMN_XML_BYTES + 1)], "large.bpmn", "application/octet-stream"),
    (error) => error instanceof DiscoveryInputError && error.status === 413,
  );
});
