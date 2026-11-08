/**
 * Trial runs of a deployed workflow (#135, part 3): an invoice from the page
 * becomes the execution input, exactly as make_input.py writes it, and the
 * execution's history is read back state by state, so the canvas colours each
 * box by its name. Only a one-line summary of the result is returned, never the
 * output itself, which holds the whole invoice.
 */
import { randomUUID } from "node:crypto";
import { invoiceOverrideError } from "../composition/invoice-run-options.ts";
import type { DeployAws, ExecutionDescription, HistoryEventView } from "./types.ts";

/**
 * Step Functions takes an execution input of at most 256 KB; the first step's result
 * replaces it, so it may come close (make_input.py's limit).
 */
export const INPUT_LIMIT = 250_000;
export const MAX_PDF_BYTES = 4 * 1024 * 1024;

export type InputOutcome = { ok: true; input: string } | { ok: false; error: string };

/** A PDF or image as base64, XML as its text, JSON as its data; the options beside it. */
export function executionInput(file: Uint8Array, optionsText?: string | null): InputOutcome {
  let options: unknown;
  if (optionsText && optionsText.trim()) {
    try {
      options = JSON.parse(optionsText);
    } catch {
      return { ok: false, error: "options must be JSON, as in options.example.json." };
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) return { ok: false, error: "options must be a JSON object." };
  }
  const overrideError = invoiceOverrideError((options ?? {}) as Record<string, unknown>);
  if (overrideError) return { ok: false, error: overrideError };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(file).replace(/^﻿/, "");
  const start = text.trimStart();
  let document: unknown = Buffer.from(file).toString("base64");
  if (start.startsWith("<")) document = text;
  else if (start.startsWith("{") || start.startsWith("[")) {
    try {
      document = JSON.parse(text);
    } catch {
      return { ok: false, error: "The file looks like JSON but cannot be read as JSON." };
    }
  }
  const input = JSON.stringify(options === undefined ? { document } : { document, options });
  if (Buffer.byteLength(input) > INPUT_LIMIT) {
    return { ok: false, error: "The invoice is too large: Step Functions takes an input of at most 256 KB. Upload a PDF up to 4 MB to a workflow deployed with stored-input support, or use a smaller XML/JSON file." };
  }
  return { ok: true, input };
}

export function executionConsoleUrl(region: string, arn: string): string {
  return `https://${region}.console.aws.amazon.com/states/home?region=${region}#/v2/executions/details/${arn}`;
}

/** An execution ARN of this region: arn:aws:states:<region>:<account>:execution:<machine>:<name>. */
export function isExecutionArn(value: string, region: string): boolean {
  return new RegExp(`^arn:aws:states:${region}:\\d{12}:execution:[A-Za-z0-9_-]{1,80}:[A-Za-z0-9_-]{1,80}$`).test(value);
}

export type StartRunOutcome =
  | { ok: true; execution_arn: string; console_url: string }
  | { ok: false; status: 400 | 413 | 404 | 409; error: string };

const RUNNABLE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]);

export interface UploadedRunInput { file: Uint8Array; optionsText?: string | null; bucket?: string }

export async function startTrialRun(aws: DeployAws, stack: string, input: string | UploadedRunInput, now = new Date()): Promise<StartRunOutcome> {
  const view = await aws.describeStack(stack);
  if (!view) return { ok: false, status: 404, error: "There is no such deployment." };
  const machine = view.outputs.StateMachineArn?.value;
  if (!RUNNABLE.has(view.status) || !machine) {
    return { ok: false, status: 409, error: "The workflow is not deployed yet; wait for the deployment to succeed." };
  }
  if (typeof input !== "string") {
    const upload = input;
    if (upload.file.length === 0 || upload.file.length > MAX_PDF_BYTES) return { ok: false, status: 413, error: "The file must be at most 4 MB and cannot be empty." };
    const inline = executionInput(upload.file, upload.optionsText);
    if (inline.ok) input = inline.input;
    else {
      // Invalid options/JSON must never be hidden by a storage fallback.
      const isPdf = Buffer.from(upload.file.subarray(0, 5)).toString("latin1") === "%PDF-";
      if (!isPdf || !inline.error.startsWith("The invoice is too large:")) return { ok: false, status: 400, error: inline.error };
      const bucket = view.outputs.InputStorageBucket?.value;
      if (!upload.bucket || bucket !== upload.bucket || view.outputs.StoredInputVersion?.value !== "1") {
        return { ok: false, status: 409, error: "Deploy this workflow again to enable PDF uploads up to 4 MB. Its current AWS version accepts only inline inputs (about 185 KB)." };
      }
      const key = `${stack}/inputs/${randomUUID()}.pdf`;
      const options = upload.optionsText?.trim() ? JSON.parse(upload.optionsText) : undefined;
      input = JSON.stringify({ document: { s3: { bucket, key } }, ...(options === undefined ? {} : { options }) });
      if (Buffer.byteLength(input) > INPUT_LIMIT) return { ok: false, status: 400, error: "Mapping options exceed the AWS input limit." };
      await aws.putObject(bucket, key, upload.file, "application/pdf");
    }
  }
  const name = `trial-${now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  const arn = await aws.startExecution(machine, name, input);
  return { ok: true, execution_arn: arn, console_url: executionConsoleUrl(aws.region, arn) };
}

export type StateRunStatus = "succeeded" | "failed" | "running" | "not_run";

export interface StateRunView {
  name: string;
  status: StateRunStatus;
  started_at?: string;
  ended_at?: string;
  error?: string | null;
  cause?: string | null;
}

export interface ExecutionView {
  status: string;
  states: StateRunView[];
  error: { state: string | null; error: string | null; cause: string | null } | null;
  output_summary: string | null;
}

const CAUSE_LIMIT = 500;
const SUCCESS_EVENTS = /^(TaskSucceeded|LambdaFunctionSucceeded)$/;
const FAILURE_EVENTS = /^(Task|LambdaFunction)(Failed|TimedOut|StartFailed|SubmitFailed|ScheduleFailed)$/;
const END_EVENTS = /^Execution(Failed|TimedOut|Aborted)$/;

function short(text: string | null): string | null {
  if (text === null) return null;
  // A Lambda's own error arrives as JSON with its stack trace; the user needs only its message.
  try {
    const parsed = JSON.parse(text) as { errorMessage?: unknown };
    if (parsed && typeof parsed.errorMessage === "string" && parsed.errorMessage.trim()) text = parsed.errorMessage;
  } catch {
    // Not JSON: keep the cause as AWS gave it.
  }
  return text.length > CAUSE_LIMIT ? `${text.slice(0, CAUSE_LIMIT)}…` : text;
}

/** One sentence about the result: the sender's receipt, else the validator's verdict. Never the invoice. */
export function outputSummary(output: string | null): string | null {
  if (!output) return null;
  let result: Record<string, any>;
  try {
    result = JSON.parse(output);
  } catch {
    return null;
  }
  const receipt = result?.delivery?.receipt;
  if (receipt && typeof receipt === "object") {
    if (typeof receipt.id === "string" && typeof receipt.message === "string") return `Sent: ${receipt.message} (message ${receipt.id}).`;
    const invoice = receipt.invoice;
    if (invoice && (invoice.id !== undefined || invoice.state)) return `Sent: invoice ${invoice.id ?? "?"}${invoice.state ? `, ${invoice.state}` : ""}.`;
    if (receipt.id !== undefined) return `Sent: ${String(receipt.id)}.`;
    return "Sent.";
  }
  if (result?.validation?.isValid === true) return "The invoice passed validation.";
  return null;
}

/**
 * Each state of the definition with what happened to it, in the definition's
 * order: a Task whose last attempt failed is failed even when a Catch carried
 * the run on to `Composition failed`; a Fail state that was reached is failed;
 * a state never entered is not_run.
 */
export function executionView(definitionText: string, events: readonly HistoryEventView[], execution: ExecutionDescription): ExecutionView {
  let states: Record<string, { Type?: string }> = {};
  try {
    states = (JSON.parse(definitionText) as { States?: Record<string, { Type?: string }> }).States ?? {};
  } catch {
    states = {};
  }
  type Track = { entered?: string; exited?: string; cause?: string | null; failed?: { error: string | null; cause: string | null } | null };
  const track = new Map<string, Track>();
  let current: string | null = null;
  let ended: { error: string | null; cause: string | null } | null = null;
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (/StateEntered$/.test(event.type) && event.state) {
      current = event.state;
      track.set(current, { ...track.get(current), entered: event.timestamp, exited: undefined, cause: event.cause });
    } else if (/StateExited$/.test(event.type) && event.state) {
      track.set(event.state, { ...track.get(event.state), exited: event.timestamp });
    } else if (current && SUCCESS_EVENTS.test(event.type)) {
      track.set(current, { ...track.get(current), failed: null });
    } else if (current && FAILURE_EVENTS.test(event.type)) {
      // A retried attempt is overwritten by the next outcome.
      track.set(current, { ...track.get(current), failed: { error: event.error, cause: event.cause } });
    } else if (END_EVENTS.test(event.type)) {
      ended = { error: event.error, cause: event.cause };
    }
  }

  const running = execution.status === "RUNNING";
  // The step that failed, else the Fail state the run ended in (Validation failed).
  let firstError: ExecutionView["error"] = null;
  let failState: ExecutionView["error"] = null;
  const views = Object.entries(states).map(([name, state]): StateRunView => {
    const seen = track.get(name);
    if (!seen?.entered) return { name, status: "not_run" };
    const times = { started_at: seen.entered, ...(seen.exited ? { ended_at: seen.exited } : {}) };
    let failed = seen.failed ?? null;
    if (!failed && state.Type === "Fail") failed = { error: ended?.error ?? execution.error, cause: seen.cause ?? ended?.cause ?? execution.cause };
    if (!failed && !seen.exited && state.Type !== "Succeed" && !running) failed = { error: ended?.error ?? execution.error, cause: ended?.cause ?? execution.cause };
    if (failed) {
      const view = { name, status: "failed" as const, ...times, error: failed.error, cause: short(failed.cause) };
      if (state.Type === "Fail") failState ??= { state: name, error: view.error, cause: view.cause };
      else firstError ??= { state: name, error: view.error, cause: view.cause };
      return view;
    }
    if (seen.exited || state.Type === "Succeed") return { name, status: "succeeded", ...times };
    return { name, status: "running", ...times };
  });
  firstError ??= failState;
  if (!firstError && execution.status !== "RUNNING" && execution.status !== "SUCCEEDED") {
    firstError = { state: null, error: execution.error ?? ended?.error ?? null, cause: short(execution.cause ?? ended?.cause ?? null) };
  }
  return {
    status: execution.status,
    states: views,
    error: firstError,
    output_summary: execution.status === "SUCCEEDED" ? outputSummary(execution.output) : null,
  };
}

/** The execution as the canvas reads it, or null when there is no such execution. */
export async function executionStatus(aws: DeployAws, arn: string): Promise<ExecutionView | null> {
  const execution = await aws.describeExecution(arn);
  if (!execution) return null;
  const [definition, events] = await Promise.all([aws.executionDefinition(arn), aws.executionHistory(arn, execution.error === "ValidationFailed")]);
  return executionView(definition, events, execution);
}
