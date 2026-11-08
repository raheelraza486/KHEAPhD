import assert from "node:assert/strict";
import test from "node:test";

import { generateWorkflow } from "../../lib/composition/step-functions.ts";
import {
  executionInput,
  executionStatus,
  executionView,
  isExecutionArn,
  outputSummary,
  startTrialRun,
} from "../../lib/workflow-deploy/executions.ts";
import type { ExecutionDescription, HistoryEventView } from "../../lib/workflow-deploy/types.ts";
import { AMIT, CLIENT_CHAIN, ESS, MAILGUN, UPBRAINS } from "../composition/fixtures/workflow-chain.ts";
import { FakeAws } from "./fake-aws.ts";

const STACK = "bp-upbrains-amittransform-ess-mailgun";
const MACHINE = "arn:aws:states:ap-southeast-2:803964123922:stateMachine:BP-Upbrains-AmitTransform-ESS-Mailgun";
const EXECUTION = "arn:aws:states:ap-southeast-2:803964123922:execution:BP-Upbrains-AmitTransform-ESS-Mailgun:trial-1";

function definition(): string {
  const result = generateWorkflow({ api_ids: [UPBRAINS, AMIT, ESS, MAILGUN] }, CLIENT_CHAIN);
  if (!result.ok) throw new Error("not generated");
  return result.workflow.json;
}

const S1 = "01 Upbrains Extract Invoice From PDF";
const S2 = "02 Adapter Upbrains to AmitTransform";
const S3 = "03 AmitTransform Convert UBL JSON to UBL XML";
const S4 = "04 Adapter complete AmitTransform UBL";
const S5 = "05 ESS SmartDocFlow Validate PINT A-NZ Invoice";
const S6 = "06 Mailgun Send Message";

/** A history as Step Functions writes it: each state entered, its task, then exited. */
function history(steps: Array<[string, string, ...Array<{ type: string; error?: string; cause?: string }>]>): HistoryEventView[] {
  const events: HistoryEventView[] = [];
  const add = (type: string, state: string | null = null, error: string | null = null, cause: string | null = null) =>
    events.push({ id: events.length + 1, type, timestamp: `2026-10-27T03:00:${String(events.length).padStart(2, "0")}.000Z`, state, error, cause });
  add("ExecutionStarted");
  for (const [state, kind, ...extra] of steps) {
    add(`${kind}StateEntered`, state);
    for (const event of extra) add(event.type, null, event.error ?? null, event.cause ?? null);
    if (!extra.some((event) => event.type === "Exit:none")) add(`${kind}StateExited`, state);
  }
  return events.filter((event) => event.type !== "Exit:none");
}

const ok = { type: "TaskSucceeded" };
function execution(status: string, extra: Partial<ExecutionDescription> = {}): ExecutionDescription {
  return { status, state_machine_arn: MACHINE, output: null, error: null, cause: null, started_at: "2026-10-27T03:00:00.000Z", stopped_at: null, ...extra };
}

test("the execution input is make_input.py's: a PDF as base64, XML as text, JSON as data, with the options", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 test");
  assert.deepEqual(executionInput(pdf), { ok: true, input: JSON.stringify({ document: Buffer.from(pdf).toString("base64") }) });
  assert.deepEqual(executionInput(new TextEncoder().encode("﻿<Invoice/>"), '{"buyerReference":"PO-7"}'),
    { ok: true, input: JSON.stringify({ document: "<Invoice/>", options: { buyerReference: "PO-7" } }) });
  assert.deepEqual(executionInput(new TextEncoder().encode('{"invoiceId":"1"}')), { ok: true, input: JSON.stringify({ document: { invoiceId: "1" } }) });
  assert.equal(executionInput(pdf, "not json").ok, false);
  assert.equal(executionInput(pdf, "[1]").ok, false);
  const big = executionInput(new Uint8Array(190_000));
  assert.equal(big.ok, false);
  assert.match(!big.ok ? big.error : "", /256 KB/);
});

test("execution ARNs are checked against the region before anything is asked of AWS", () => {
  assert.equal(isExecutionArn(EXECUTION, "ap-southeast-2"), true);
  assert.equal(isExecutionArn(EXECUTION, "us-east-1"), false);
  assert.equal(isExecutionArn("arn:aws:states:ap-southeast-2:803964123922:stateMachine:X", "ap-southeast-2"), false);
  assert.equal(isExecutionArn(`${EXECUTION}/../x`, "ap-southeast-2"), false);
});

test("a trial run starts the deployed state machine; not deployed is 404 or 409", async () => {
  assert.equal((await startTrialRun(new FakeAws(), STACK, "{}") as { status: number }).status, 404);
  assert.equal((await startTrialRun(new FakeAws().stack(STACK, "CREATE_IN_PROGRESS"), STACK, "{}") as { status: number }).status, 409);
  const aws = new FakeAws().stack(STACK, "CREATE_COMPLETE", { StateMachineArn: { value: MACHINE, description: null } });
  const outcome = await startTrialRun(aws, STACK, '{"document":"x"}', new Date("2026-10-27T03:00:00Z"));
  assert.equal(outcome.ok, true);
  assert.equal(aws.started[0].machine, MACHINE);
  assert.match(aws.started[0].name, /^trial-20261027030000-[a-z0-9]{1,6}$/);
  assert.equal(aws.started[0].input, '{"document":"x"}');
  if (!outcome.ok) return;
  assert.equal(outcome.console_url, `https://ap-southeast-2.console.aws.amazon.com/states/home?region=ap-southeast-2#/v2/executions/details/${outcome.execution_arn}`);
});

test("a successful run: every state on the path succeeded by its exact name, the exits not run, one sentence of result", () => {
  const events = history([
    ["Check workflow input", "Choice"], [S1, "Task", ok], [S2, "Task", ok], [S3, "Task", ok], [S4, "Task", ok], [S5, "Task", ok],
    ["Check validation", "Choice"], [S6, "Task", ok],
  ]);
  const output = JSON.stringify({ document: "JVBERi0=", delivery: { receipt: { id: "<m@mg.example.test>", message: "Queued. Thank you." } } });
  const view = executionView(definition(), events, execution("SUCCEEDED", { output }));
  assert.equal(view.status, "SUCCEEDED");
  assert.deepEqual(view.states.map((state) => [state.name, state.status]), [
    ["Check workflow input", "succeeded"], ["Workflow input rejected", "not_run"],
    [S1, "succeeded"], [S2, "succeeded"], [S3, "succeeded"], [S4, "succeeded"], [S5, "succeeded"],
    ["Check validation", "succeeded"], [S6, "succeeded"],
    ["Validation failed", "not_run"], ["Composition failed", "not_run"],
  ]);
  assert.ok(view.states[2].started_at && view.states[2].ended_at);
  assert.equal(view.error, null);
  assert.equal(view.output_summary, "Sent: Queued. Thank you. (message <m@mg.example.test>).");
  assert.doesNotMatch(JSON.stringify(view), /JVBERi0/, "the output itself is never returned");
});

test("a failed step is red with its error even though Catch carried the run to Composition failed; a retried one is green", () => {
  const events = history([
    ["Check workflow input", "Choice"],
    [S1, "Task", { type: "TaskFailed", error: "Lambda.ServiceException", cause: "retry" }, ok],
    [S2, "Task", ok],
    [S3, "Task", { type: "TaskFailed", error: "ApiError", cause: `HTTP 500: ${"x".repeat(600)}` }],
    ["Composition failed", "Fail", { type: "ExecutionFailed", error: "ApiError", cause: "HTTP 500" }, { type: "Exit:none" }],
  ]);
  const view = executionView(definition(), events, execution("FAILED", { error: "ApiError", cause: "HTTP 500" }));
  const status = Object.fromEntries(view.states.map((state) => [state.name, state.status]));
  assert.equal(status[S1], "succeeded");
  assert.equal(status[S3], "failed");
  assert.equal(status[S4], "not_run");
  assert.equal(status["Composition failed"], "failed");
  const failed = view.states.find((state) => state.name === S3)!;
  assert.equal(failed.error, "ApiError");
  assert.equal(failed.cause!.length, 501, "the cause is cut at 500 characters");
  assert.deepEqual(view.error, { state: S3, error: "ApiError", cause: failed.cause });
  assert.equal(view.output_summary, null);
});

test("an invalid invoice ends in Validation failed; a run in progress shows its current state as running", () => {
  const invalid = executionView(definition(), history([
    ["Check workflow input", "Choice"], [S1, "Task", ok], [S2, "Task", ok], [S3, "Task", ok], [S4, "Task", ok], [S5, "Task", ok],
    ["Check validation", "Choice"],
    ["Validation failed", "Fail", { type: "ExecutionFailed", error: "ValidationFailed", cause: "The invoice did not pass validation." }, { type: "Exit:none" }],
  ]), execution("FAILED", { error: "ValidationFailed", cause: "The invoice did not pass validation." }));
  assert.equal(invalid.states.find((state) => state.name === S6)!.status, "not_run");
  assert.deepEqual(invalid.error, { state: "Validation failed", error: "ValidationFailed", cause: "The invoice did not pass validation." });

  const running = executionView(definition(), history([["Check workflow input", "Choice"], [S1, "Task", ok], [S2, "Task", { type: "Exit:none" }]]), execution("RUNNING"));
  assert.equal(running.states.find((state) => state.name === S2)!.status, "running");
  assert.equal(running.states.find((state) => state.name === S3)!.status, "not_run");
  assert.equal(running.error, null);
});

test("the result sentence: a B2Brouter invoice, a validator's verdict, or nothing", () => {
  assert.equal(outputSummary(JSON.stringify({ delivery: { receipt: { invoice: { id: 4242, state: "sent" } } } })), "Sent: invoice 4242, sent.");
  assert.equal(outputSummary(JSON.stringify({ validation: { isValid: true, report: {} } })), "The invoice passed validation.");
  assert.equal(outputSummary("not json"), null);
});

test("the status read from AWS: definition, history and description of one execution; an unknown one is null", async () => {
  const aws = new FakeAws();
  aws.executions.set(EXECUTION, { description: execution("RUNNING"), history: history([["Check workflow input", "Choice"]]), definition: definition() });
  const view = await executionStatus(aws, EXECUTION);
  assert.equal(view?.status, "RUNNING");
  assert.equal(view?.states[0].status, "succeeded");
  assert.equal(await executionStatus(aws, `${EXECUTION}-other`), null);
});


test("validation rule messages replace the generic Fail-state cause in the canvas result", () => {
  const events = history([
    ["Check workflow input", "Choice"], [S1, "Task", ok], [S2, "Task", ok], [S3, "Task", ok], [S4, "Task", ok], [S5, "Task", ok],
    ["Check validation", "Choice"],
    ["Validation failed", "Fail", { type: "ExecutionFailed", error: "ValidationFailed", cause: "The invoice did not pass validation." }, { type: "Exit:none" }],
  ]);
  const entered = events.find(event => event.type === "FailStateEntered")!;
  entered.cause = "[ibr-081] Seller electronic address is required.";
  const view = executionView(definition(), events, execution("FAILED", { error: "ValidationFailed", cause: "The invoice did not pass validation." }));
  assert.equal(view.error?.cause, entered.cause);
  assert.equal(view.states.find(state => state.name === "Validation failed")?.cause, entered.cause);
});

test("large PDFs use private storage with a small reference; stale workflows and invalid options start nothing", async () => {
  const file = Buffer.alloc(400_000, 32); file.write("%PDF-1.4");
  const outputs = { StateMachineArn: { value: MACHINE, description: null }, InputStorageBucket: { value: "private-inputs", description: null }, StoredInputVersion: { value: "1", description: null } };
  const aws = new FakeAws().stack(STACK, "UPDATE_COMPLETE", outputs);
  const outcome = await startTrialRun(aws, STACK, { file, optionsText: '{"buyerReference":"PO-7"}', bucket: "private-inputs" });
  assert.equal(outcome.ok, true);
  assert.equal(aws.objects.size, 1);
  const input = JSON.parse(aws.started[0].input);
  assert.equal(input.document.s3.bucket, "private-inputs");
  assert.match(input.document.s3.key, new RegExp(`^${STACK}/inputs/[a-f0-9-]+\\.pdf$`));
  assert.equal(aws.objects.get(`private-inputs/${input.document.s3.key}`)!.body, file);
  assert.deepEqual(input.options, { buyerReference: "PO-7" });
  assert.ok(Buffer.byteLength(aws.started[0].input) < 1000);
  assert.ok(!aws.started[0].input.includes(file.toString("base64")));
  for (const bucket of [undefined, "another-bucket"]) {
    const refused = new FakeAws().stack(STACK, "UPDATE_COMPLETE", outputs);
    const result = await startTrialRun(refused, STACK, { file, bucket });
    assert.equal(result.ok ? null : result.status, 409);
    assert.equal(refused.objects.size + refused.started.length, 0);
  }
  const old = new FakeAws().stack(STACK, "UPDATE_COMPLETE", { StateMachineArn: outputs.StateMachineArn });
  const stale = await startTrialRun(old, STACK, { file, bucket: "private-inputs" });
  assert.match(stale.ok ? "" : stale.error, /Deploy this workflow again/);
  for (const optionsText of ["no-json", "[]", '{"issueDate":"2026-02-30"}']) {
    const bad = new FakeAws().stack(STACK, "UPDATE_COMPLETE", outputs);
    const result = await startTrialRun(bad, STACK, { file, optionsText, bucket: "private-inputs" });
    assert.equal(result.ok ? null : result.status, 400);
    assert.equal(bad.objects.size + bad.started.length, 0);
  }
  const huge = await startTrialRun(aws, STACK, { file: Buffer.alloc(4 * 1024 * 1024 + 1), bucket: "private-inputs" });
  assert.equal(huge.ok ? null : huge.status, 413);
});

test("a Lambda's own error shows its message, not the JSON with the stack trace", () => {
  const message = "Stopped before conversion and validation: the Australian rules (PINT A-NZ) need the buyer's ABN (enter the buyer's ABN).";
  const cause = JSON.stringify({ errorType: "MissingInvoiceData", errorMessage: message, trace: ["MissingInvoiceData: ...", "    at Module.handler (file:///var/task/index.mjs:32:21)"] });
  const events = history([
    ["Check workflow input", "Choice"],
    [S1, "Task", { type: "TaskFailed", error: "MissingInvoiceData", cause }],
    ["Composition failed", "Fail", { type: "ExecutionFailed", error: "MissingInvoiceData", cause }, { type: "Exit:none" }],
  ]);
  const view = executionView(definition(), events, execution("FAILED", { error: "MissingInvoiceData", cause }));
  const failed = view.states.find((state) => state.name === S1)!;
  assert.equal(failed.error, "MissingInvoiceData");
  assert.equal(failed.cause, message);
  assert.doesNotMatch(JSON.stringify(view), /index\.mjs/, "no stack trace reaches the page");
});
