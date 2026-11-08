import assert from "node:assert/strict";
import test from "node:test";

import { generateWorkflow } from "../../lib/composition/step-functions.ts";
import { requestFields } from "../../lib/composition/workflow-calls.ts";
import type { WorkflowLambdaView } from "../../lib/workflow-canvas/graph.ts";
import { producerOf, stepInputs } from "../../lib/workflow-canvas/inputs.ts";
import { AMIT, CLIENT_CHAIN, ESS, MAILGUN, UPBRAINS } from "../composition/fixtures/workflow-chain.ts";

/** The client's chain as the workflow route returns it to the canvas: each Lambda with its plan and request fields. */
function clientChain() {
  const result = generateWorkflow({ api_ids: [UPBRAINS, AMIT, ESS, MAILGUN] }, CLIENT_CHAIN);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("not generated");
  const byId = new Map(CLIENT_CHAIN.map((api) => [api.id, api]));
  const lambdas: Array<WorkflowLambdaView & { state_name: string }> = result.workflow.lambdas.map(({ files: _files, ...lambda }) => ({
    ...lambda,
    request_fields: lambda.api_id ? requestFields(lambda.category, byId.get(lambda.api_id)!.schemas ?? []) : null,
  }));
  return { definition: result.workflow.definition, lambdas };
}

const rows = (state: string) => {
  const { definition, lambdas } = clientChain();
  const lambda = lambdas.find((item) => item.state_name === state)!;
  return stepInputs(lambda, definition, state).map((row) => `${row.field} | ${row.source} | ${row.detail}`);
};

test("each step reads the document from the state that wrote it", () => {
  const { definition } = clientChain();
  assert.equal(producerOf(definition, "01 Upbrains Extract Invoice From PDF"), null, "the first step reads the execution input");
  assert.equal(producerOf(definition, "03 AmitTransform Convert UBL JSON to UBL XML"), "02 Adapter Upbrains to AmitTransform");
  assert.equal(producerOf(definition, "05 ESS SmartDocFlow Validate PINT A-NZ Invoice"), "04 Adapter complete AmitTransform UBL");
  assert.equal(producerOf(definition, "06 Mailgun Send Message"), "04 Adapter complete AmitTransform UBL", "the sender gets the completed invoice, not the report");
});

test("Upbrains: the invoice from the execution input, and the flow id as a deploy parameter", () => {
  assert.deepEqual(rows("01 Upbrains Extract Invoice From PDF").filter((row) => !row.includes("not_sent")), [
    "fileBase64 | document | the execution input (the invoice you start the run with), base64-encoded",
    "endpoint address | parameter | deploy parameter UpbrainsFlowId",
  ]);
});

test("Mailgun: the attachment from the completed invoice, the settings from the deploy, the key from Secrets Manager", () => {
  const mailgun = rows("06 Mailgun Send Message");
  assert.ok(mailgun.includes("attachment | document | the document from 04 Adapter complete AmitTransform UBL, as a file in a multipart form"), mailgun.join("\n"));
  for (const [field, parameter] of [["from", "MailgunFrom"], ["to", "MailgunTo"], ["subject", "MailgunSubject"], ["text", "MailgunText"]]) {
    assert.ok(mailgun.includes(`${field} | parameter | deploy parameter ${parameter}`), `${field}: ${mailgun.join("\n")}`);
  }
  assert.ok(mailgun.includes("endpoint address | parameter | deploy parameter MailgunDomainName"));
  assert.ok(mailgun.includes("Authorization | secret | Secrets Manager secret bp-builder/mailgun, read when the function runs"));
  // Mailgun's many optional fields are one row, each named once.
  const skipped = mailgun.filter((row) => row.includes("| not_sent |"));
  assert.equal(skipped.length, 1, mailgun.join("\n"));
  assert.match(skipped[0], /^\d+ optional fields? \| not_sent \| not sent: \S/);
});

test("ESS: fixed rule pack, the file name from the deploy, the API key header from Secrets Manager", () => {
  const ess = rows("05 ESS SmartDocFlow Validate PINT A-NZ Invoice");
  assert.ok(ess.includes('pack | fixed | always "billing"'), ess.join("\n"));
  assert.ok(ess.includes("filename | parameter | deploy parameter ESSFilename"));
  assert.ok(ess.includes("x-api-key | secret | Secrets Manager secret bp-builder/ess, read when the function runs"));
});

test("an API without a stored request schema says the request is a guess; an adapter has no inputs to list", () => {
  const { definition, lambdas } = clientChain();
  const amit = lambdas.find((item) => item.state_name.startsWith("03"))!;
  const guessed = { ...amit, call: { ...amit.call!, from_schema: { request: false, response: false } }, request_fields: null };
  assert.equal(stepInputs(guessed, definition, amit.state_name).at(-1)?.source, "no_schema");
  const adapter = lambdas.find((item) => item.category === "Mapping")!;
  assert.deepEqual(stepInputs(adapter, definition, adapter.state_name), []);
});
