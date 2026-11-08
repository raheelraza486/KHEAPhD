import assert from "node:assert/strict";
import test from "node:test";

import { stackName } from "../../lib/composition/workflow-package.ts";
import {
  deleteDeployment, deployParameters, getDeployment, getExecution, isRecipientParameter, runOptions, runStates, startDeployment, startExecution,
  type DeployParameterView,
} from "../../lib/workflow-canvas/deployment.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const answering = (response: Response) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const doFetch = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return response; }) as typeof fetch;
  return { doFetch, calls };
};
const BODY = { api_ids: ["a"], status: "feasible" as const, parameters: {} };

test("the deployment id the page uses is the stack name the workflow route returns: bp- and the name", () => {
  // The page takes stack_name from /api/composition/workflow; the service names the stack the same way.
  assert.equal(stackName({ name: "BP-Upbrains-AmitTransform-ESS-Mailgun" }), "bp-upbrains-amittransform-ess-mailgun");
  assert.equal(stackName({ name: "Demo" }), "bp-demo");
});

test("the page sends visible parameters, typed or by default, and never a hidden one", () => {
  const parameters: DeployParameterView[] = [
    { name: "UpbrainsFlowId", description: "", no_echo: true },
    { name: "MailgunTo", description: "", no_echo: false },
    { name: "MailgunSubject", description: "", no_echo: false, default: "Invoice" },
    { name: "MailgunText", description: "", no_echo: false },
    { name: "MailgunFrom", description: "", no_echo: false },
    { name: "MailgunDomainName", description: "", no_echo: false },
  ];
  // MailgunFrom and MailgunDomainName left empty are the server's to fill, so they are not missing.
  assert.deepEqual(deployParameters(parameters, { MailgunTo: " a@example.test ", UpbrainsFlowId: "never-sent" }), {
    send: { MailgunTo: "a@example.test", MailgunSubject: "Invoice" },
    missing: ["MailgunText"],
  });
  assert.deepEqual(deployParameters(parameters, { MailgunText: "Hi", MailgunFrom: "Me <me@example.test>" }).send,
    { MailgunSubject: "Invoice", MailgunText: "Hi", MailgunFrom: "Me <me@example.test>" });
});

test("starting a deployment posts the chain and its parameters, and reads the 202", async () => {
  const { doFetch, calls } = answering(json(202, { deployment_id: "demo", status: "in_progress" }));
  const result = await startDeployment({ ...BODY, parameters: { MailgunTo: "a@example.test" } }, doFetch);
  assert.deepEqual(result, { ok: true, value: { deployment_id: "demo", status: "in_progress" } });
  assert.equal(calls[0].url, "/api/workflows/deployments");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { ...BODY, parameters: { MailgunTo: "a@example.test" } });
});

test("each refusal of the agreed interface becomes one the page can explain", async () => {
  const failure = async (response: Response) => {
    const result = await startDeployment(BODY, answering(response).doFetch);
    assert.equal(result.ok, false);
    return result.ok ? null : result.failure;
  };
  assert.deepEqual(await failure(new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } })), { kind: "unavailable" }, "no service yet");
  assert.deepEqual(await failure(json(401, { error: "Sign in first." })), { kind: "signed_out" });
  assert.deepEqual(await failure(json(403, { error: "Administrators only." })), { kind: "forbidden", message: "Administrators only." });
  assert.deepEqual(await failure(json(403, { error: "Cross-origin requests are not allowed." })), { kind: "forbidden", message: "Cross-origin requests are not allowed." });
  assert.deepEqual(await failure(json(403, { error: "Your own address only.", details: [{ code: "recipient_not_allowed", parameter: "MailgunTo" }] })),
    { kind: "recipient_not_allowed", parameters: ["MailgunTo"], message: "Your own address only." });
  assert.deepEqual(await failure(json(400, { error: "Missing.", details: [{ code: "missing_parameter", parameter: "MailgunTo" }] })), { kind: "missing_parameters", parameters: ["MailgunTo"], message: "Missing." });
  assert.deepEqual(await failure(json(400, { error: "Some parameters are missing or not accepted.", details: [
    { code: "missing_parameter", parameter: "MailgunText" },
    { code: "invalid_parameter", parameter: "MailgunTo", message: "MailgunTo must not contain quotes, backslashes or control characters." },
    { code: "unknown_parameter", parameter: "Colour" },
    { code: "server_parameter", parameter: "UpbrainsFlowId" },
  ] })), {
    kind: "invalid",
    message: "Fill in MailgunText. MailgunTo must not contain quotes, backslashes or control characters. Colour is not a parameter of this workflow. UpbrainsFlowId is set by the server, not the page.",
  });
  assert.deepEqual(await failure(json(409, { error: "Busy.", details: { deployment_id: "bp-demo", stack_status: "UPDATE_IN_PROGRESS", code: "in_progress" } })), { kind: "busy", deployment_id: "bp-demo", code: "in_progress", message: "Busy." });
  assert.deepEqual(await failure(json(409, { error: "Delete it first.", details: { deployment_id: "bp-demo", stack_status: "ROLLBACK_COMPLETE", code: "delete_first" } })), { kind: "busy", deployment_id: "bp-demo", code: "delete_first", message: "Delete it first." });
  assert.deepEqual(await failure(json(503, { error: "Deployment to AWS is not configured on this server.", details: [{ code: "not_configured", setting: "WORKFLOW_ARTIFACT_BUCKET" }] })), { kind: "not_configured", message: "Deployment to AWS is not configured on this server." });
  assert.deepEqual(await failure(json(503, { error: "The server lacks a setting this workflow needs.", details: [{ code: "server_setting_missing", parameter: "UpbrainsFlowId" }] })), { kind: "not_configured", message: "The server lacks a setting this workflow needs. It cannot fill in UpbrainsFlowId." });
  assert.deepEqual(await failure(json(412, { error: "No secret.", details: [{ code: "missing_secret", secret: "bp-builder/ess", how: "README step 3" }] })), { kind: "missing_secrets", secrets: [{ secret: "bp-builder/ess", how: "README step 3" }], message: "No secret." });
  assert.deepEqual(await failure(json(502, { error: "AWS.", details: [{ code: "aws_error", service: "cloudformation", message: "AccessDenied" }] })), { kind: "aws", message: "AccessDenied" });
  const unreachable = await startDeployment(BODY, (async () => { throw new TypeError("offline"); }) as typeof fetch);
  assert.equal(unreachable.ok ? null : unreachable.failure.kind, "other");
});

test("a deployment that does not exist is not_found, not unavailable", async () => {
  const { doFetch, calls } = answering(json(404, { error: "No such deployment." }));
  const result = await getDeployment("bp upbrains", doFetch);
  assert.deepEqual(result, { ok: false, failure: { kind: "not_found" } });
  assert.equal(calls[0].url, "/api/workflows/deployments/bp%20upbrains");
});

test("deleting sends DELETE for the stack and reads the 202", async () => {
  const { doFetch, calls } = answering(json(202, { deployment_id: "bp-demo", status: "in_progress", phase: "deleting" }));
  const result = await deleteDeployment("bp-demo", doFetch);
  assert.deepEqual(result, { ok: true, value: { deployment_id: "bp-demo", status: "in_progress", phase: "deleting" } });
  assert.equal(calls[0].url, "/api/workflows/deployments/bp-demo");
  assert.equal(calls[0].init?.method, "DELETE");
  const busy = await deleteDeployment("bp-demo", answering(json(409, { error: "Wait." })).doFetch);
  assert.equal(busy.ok ? null : busy.failure.kind, "busy");
});

test("a run posts the invoice and its options as a form; an execution is read by its encoded ARN", async () => {
  const started = answering(json(202, { execution_arn: "arn:aws:states:x:execution:a:b" }));
  const options = runOptions({ buyerReference: "PO-7" });
  await startExecution("demo", new Blob(["%PDF-"], { type: "application/pdf" }), options, started.doFetch);
  assert.equal(started.calls[0].url, "/api/workflows/deployments/demo/executions");
  const form = started.calls[0].init?.body as FormData;
  assert.ok(form.get("invoice") instanceof Blob);
  assert.deepEqual(JSON.parse(String(form.get("options"))), { profile: "pint-aunz", buyerReference: "PO-7" });
  const read = answering(json(200, { status: "RUNNING", states: [] }));
  await getExecution("arn:aws:states:x:execution:a:b", read.doFetch);
  assert.equal(read.calls[0].url, "/api/workflows/executions/arn%3Aaws%3Astates%3Ax%3Aexecution%3Aa%3Ab");
});

test("a trial run refused for the rate limit says how long to wait", async () => {
  const limited = await startExecution("demo", new Blob(["%PDF-"]), runOptions({}),
    answering(json(429, { error: "Too many trial runs in a short time. Try again shortly.", details: { retry_after_seconds: 41 } })).doFetch);
  assert.deepEqual(limited.ok ? null : limited.failure, { kind: "rate_limited", retry_after_seconds: 41, message: "Too many trial runs in a short time. Try again shortly." });
  const vague = await startExecution("demo", new Blob(["%PDF-"]), runOptions({}), answering(json(429, { error: "Wait." })).doFetch);
  assert.equal(vague.ok ? null : vague.failure.kind === "rate_limited" && vague.failure.retry_after_seconds, null);
});

test("the recipient parameters are the ones the service checks against the allow-list", () => {
  assert.deepEqual(["MailgunTo", "MailgunFrom", "MailgunSubject", "ESSFilename"].filter(isRecipientParameter), ["MailgunTo"]);
});

test("run states colour every state of the definition; one the run has not reached is not_run", () => {
  const states = runStates({ status: "FAILED", states: [{ name: "01 A", status: "succeeded" }, { name: "02 B", status: "failed" }] }, ["01 A", "02 B", "03 C"]);
  assert.deepEqual(states, { "01 A": "succeeded", "02 B": "failed", "03 C": "not_run" });
  assert.deepEqual(runStates(null, ["01 A"]), {});
});

test("run options are what options.example.json carries, without empty values", () => {
  assert.deepEqual(runOptions({
    buyerReference: " PO-7 ", paymentTerms: "Payment within 30 days", sellerAbn: "80 647 710 156", buyerAbn: "",
    buyerEndpoint: { scheme: "0088", id: "9508397101047" },
  }), {
    profile: "pint-aunz", buyerReference: "PO-7", paymentTerms: "Payment within 30 days",
    buyer: { endpointId: "9508397101047", endpointSchemeId: "0088" },
    seller: { endpointId: "80647710156", endpointSchemeId: "0151", legalRegistrationId: "80647710156", legalRegistrationSchemeId: "0151" },
  });
});

test("a sandbox re-send carries a new invoice number and date only when they are given", () => {
  assert.deepEqual(runOptions({ sellerAbn: "47555222000", invoiceId: " EBWASP1002-DEMO3 ", issueDate: "2026-10-31" }), {
    profile: "pint-aunz",
    seller: { endpointId: "47555222000", endpointSchemeId: "0151", legalRegistrationId: "47555222000", legalRegistrationSchemeId: "0151" },
    invoiceId: "EBWASP1002-DEMO3", issueDate: "2026-10-31",
  });
  assert.deepEqual(runOptions({ invoiceId: "", issueDate: "" }), { profile: "pint-aunz" });
});
