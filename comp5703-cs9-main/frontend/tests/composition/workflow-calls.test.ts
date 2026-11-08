import assert from "node:assert/strict";
import test from "node:test";

import { callPlan } from "../../lib/composition/workflow-calls.ts";
import { AMIT, B2BROUTER, BILLIT_SENDXML, CLIENT_CHAIN, ESS, MAILGUN, UPBRAINS } from "./fixtures/workflow-chain.ts";

const plan = (id: string) => {
  const api = CLIENT_CHAIN.find((item) => item.id === id)!;
  return callPlan(api.category, api.schemas!);
};

test("Upbrains takes the PDF as base64 in fileBase64 and answers with its extraction as JSON", () => {
  assert.deepEqual(plan(UPBRAINS).request, { kind: "base64", media: "application/json", field: "fileBase64", fixed: {}, required: [] });
  assert.deepEqual(plan(UPBRAINS).response, { kind: "json", field: null });
});

test("AmitTransform takes the invoice in invoiceData beside its two fixed settings and answers with the XML in xml", () => {
  assert.deepEqual(plan(AMIT).request, {
    kind: "json", media: "application/json", field: "invoiceData", fixed: { invoiceType: "JSON", outputFormat: "UBL XML" }, required: [],
  });
  assert.deepEqual(plan(AMIT).response, { kind: "text", field: "xml" });
});

test("ESS takes the XML as base64 in content; filename is required and only the deployer can name it", () => {
  assert.deepEqual(plan(ESS).request, { kind: "base64", media: "application/json", field: "content", fixed: {}, required: ["filename"] });
});

test("Mailgun takes a multipart form with the invoice as attachment; from, to and subject are the deployer's", () => {
  assert.deepEqual(plan(MAILGUN).request, { kind: "file", media: "multipart/form-data", field: "attachment", fixed: {}, required: ["from", "to", "subject"] });
});

test("B2Brouter takes the document as the whole body", () => {
  assert.deepEqual(plan(B2BROUTER).request, { kind: "body", media: "application/octet-stream", field: null, fixed: {}, required: [] });
});

test("Billit sendxml takes the XML as text in the one required string XML; nothing is left for the deployer", () => {
  assert.deepEqual(plan(BILLIT_SENDXML).request, { kind: "json", media: "application/json", field: "XML", fixed: {}, required: [] });
  assert.deepEqual(plan(BILLIT_SENDXML).response, { kind: "json", field: null });
});

test("without stored schemas the plan is a JSON body and says it is a guess", () => {
  const guessed = callPlan("Transformation", []);
  assert.equal(guessed.request.kind, "json");
  assert.equal(guessed.request.field, null);
  assert.deepEqual(guessed.from_schema, { request: false, response: false });
});
