import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryInputError,
  MAX_AUDIO_BYTES,
  readDiscoveryInput,
} from "../../lib/discovery/input.ts";

function json(body: unknown) {
  return new Request("https://example.test/api/discovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("reads a trimmed text discovery request", async () => {
  const input = await readDiscoveryInput(json({ mode: "text", text: "  convert PDF to UBL XML  " }));
  assert.deepEqual(input, { mode: "text", text: "convert PDF to UBL XML" });
});

test("JSON requests cannot claim to contain uploaded media", async () => {
  await assert.rejects(
    () => readDiscoveryInput(json({ mode: "audio" })),
    (error) => error instanceof DiscoveryInputError && error.status === 415,
  );
});

test("reads a supported BPMN image and removes path fragments from its name", async () => {
  const form = new FormData();
  form.set("mode", "bpmn");
  form.set("file", new File([new Uint8Array([1, 2, 3])], "folder\\invoice-flow.png", { type: "image/png" }));
  const input = await readDiscoveryInput(new Request("https://example.test/api/discovery", { method: "POST", body: form }));
  assert.equal(input.mode, "bpmn");
  if (input.mode !== "bpmn") return;
  assert.equal(input.file.name, "invoice-flow.png");
  assert.equal(input.file.type, "image/png");
  assert.equal(input.file.size, 3);
});

test("rejects unsupported media before a provider call", async () => {
  const form = new FormData();
  form.set("mode", "bpmn");
  form.set("file", new File(["not an image"], "flow.txt", { type: "text/plain" }));
  await assert.rejects(
    () => readDiscoveryInput(new Request("https://example.test/api/discovery", { method: "POST", body: form })),
    (error) => error instanceof DiscoveryInputError && error.status === 415,
  );
});

test("rejects an oversized request using Content-Length before parsing multipart data", async () => {
  const request = new Request("https://example.test/api/discovery", {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=example",
      "Content-Length": String(MAX_AUDIO_BYTES + 2 * 1024 * 1024),
    },
    body: "--example--",
  });
  await assert.rejects(
    () => readDiscoveryInput(request),
    (error) => error instanceof DiscoveryInputError && error.status === 413,
  );
});

