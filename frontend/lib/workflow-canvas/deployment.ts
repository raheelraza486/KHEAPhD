/**
 * The canvas's side of deploying a workflow to AWS from the site (#135) and of
 * a test run on AWS. The service (back end, Xinzhan Peng, #138) answers as
 * agreed in "一键部署接口约定（草案）": POST /api/workflows/deployments starts a
 * deployment, GET …/{id} reports it, DELETE …/{id} deletes it, POST
 * …/{id}/executions starts a run and GET /api/workflows/executions/{arn}
 * reports each state. The page never sends a credential: secrets stay in AWS
 * Secrets Manager and hidden (NoEcho) parameters are filled in by the server.
 */

export interface DeployParameterView {
  name: string;
  description: string;
  no_echo: boolean;
  default?: string;
}

/**
 * Parameters the service fills in from its own settings when the page leaves
 * them empty (MAILGUN_DOMAIN, MAILGUN_FROM, B2BROUTER_ACCOUNT_ID); the page may
 * still set them.
 */
export const SERVER_FILLED = new Set(["MailgunDomainName", "MailgunFrom", "B2BrouterAccount"]);

/** A parameter naming the address every run emails (Mailgun's MailgunTo), told apart as the service does. */
export const isRecipientParameter = (name: string) => /To$/.test(name);

export interface Deployment {
  deployment_id: string;
  status: "in_progress" | "succeeded" | "failed";
  phase?: "creating_stack" | "deleting" | "done";
  stack_status?: string | null;
  events?: Array<{ time: string; resource: string; status: string; reason: string | null }>;
  state_machine_arn?: string | null;
  console_url?: string | null;
  functions?: Array<{ state_name: string; function_name: string; arn: string }>;
  error?: { message: string; resource?: string } | null;
}

export type RunState = "succeeded" | "failed" | "running" | "not_run";

export interface Execution {
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | string;
  states: Array<{ name: string; status: RunState; started_at?: string; ended_at?: string; error?: string; cause?: string }>;
  /** The step that failed (or the Fail state the run ended in), else the execution's own error. */
  error?: { state?: string | null; error?: string | null; cause?: string | null } | null;
  output_summary?: string | null;
  console_url?: string | null;
}

/** Why a request did not succeed, in the terms the page shows. */
export type Failure =
  | { kind: "unavailable" }
  | { kind: "not_found" }
  | { kind: "not_configured"; message: string }
  | { kind: "signed_out" }
  | { kind: "forbidden"; message?: string }
  | { kind: "recipient_not_allowed"; parameters: string[]; message: string }
  | { kind: "rate_limited"; retry_after_seconds: number | null; message: string }
  | { kind: "missing_parameters"; parameters: string[]; message: string }
  | { kind: "missing_secrets"; secrets: Array<{ secret: string; how?: string }>; message: string }
  | { kind: "busy"; deployment_id: string | null; code: "in_progress" | "delete_first"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "aws"; message: string }
  | { kind: "other"; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure };

type Fetch = typeof fetch;

/**
 * The parameters the page sends: every visible one, typed or its default.
 * Hidden ones are the server's; one the server fills in is left out when empty,
 * so it is not missing.
 */
export function deployParameters(parameters: readonly DeployParameterView[], values: Record<string, string>): { send: Record<string, string>; missing: string[] } {
  const send: Record<string, string> = {};
  const missing: string[] = [];
  for (const parameter of parameters) {
    if (parameter.no_echo || parameter.name === "WorkflowInputBucket") continue;
    const value = (values[parameter.name] ?? "").trim() || parameter.default || "";
    if (value) send[parameter.name] = value;
    else if (!SERVER_FILLED.has(parameter.name)) missing.push(parameter.name);
  }
  return { send, missing };
}

async function failureOf(response: Response): Promise<Failure> {
  const json = /json/i.test(response.headers.get("content-type") ?? "");
  const body = json ? await response.json().catch(() => null) as { error?: string; details?: unknown } | null : null;
  const message = body?.error ?? `The request failed (${response.status}).`;
  const details = Array.isArray(body?.details) ? body.details as Array<Record<string, unknown>> : [];
  // A route that does not exist yet answers with Next's HTML page, not the service's JSON.
  if ((response.status === 404 || response.status === 405) && !body) return { kind: "unavailable" };
  const named = (code: string) => details.flatMap((detail) => detail.code === code && typeof detail.parameter === "string" ? [detail.parameter] : []);
  switch (response.status) {
    case 401: return { kind: "signed_out" };
    case 403: {
      // The service emails only the admin's own address or one on MAILGUN_ALLOWED_RECIPIENTS.
      const recipients = named("recipient_not_allowed");
      if (recipients.length) return { kind: "recipient_not_allowed", parameters: recipients, message };
      return { kind: "forbidden", ...(body?.error ? { message: body.error } : {}) };
    }
    case 429: {
      // Five trial runs a minute per admin; details is { retry_after_seconds }.
      const info = body?.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details as { retry_after_seconds?: unknown } : {};
      const wait = typeof info.retry_after_seconds === "number" && info.retry_after_seconds > 0 ? Math.ceil(info.retry_after_seconds) : null;
      return { kind: "rate_limited", retry_after_seconds: wait, message };
    }
    case 404: return { kind: "not_found" };
    case 400: {
      const missing = named("missing_parameter");
      // Each refused value with its reason (invalid_parameter carries one); the others by name.
      const refused = [
        ...details.flatMap((detail) => detail.code === "invalid_parameter" && typeof detail.message === "string" ? [detail.message] : []),
        ...named("unknown_parameter").map((name) => `${name} is not a parameter of this workflow.`),
        ...named("server_parameter").map((name) => `${name} is set by the server, not the page.`),
      ];
      if (missing.length && !refused.length) return { kind: "missing_parameters", parameters: missing, message };
      if (missing.length) refused.unshift(`Fill in ${missing.join(", ")}.`);
      return { kind: "invalid", message: refused.length ? refused.join(" ") : message };
    }
    case 409: {
      const info = body?.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details as { deployment_id?: unknown; code?: unknown } : {};
      return {
        kind: "busy", deployment_id: typeof info.deployment_id === "string" ? info.deployment_id : null,
        code: info.code === "delete_first" ? "delete_first" : "in_progress", message,
      };
    }
    case 412:
      return { kind: "missing_secrets", secrets: details.flatMap((detail) => typeof detail.secret === "string" ? [{ secret: detail.secret, how: typeof detail.how === "string" ? detail.how : undefined }] : []), message };
    case 422: return { kind: "invalid", message: [message, ...details.flatMap((detail) => typeof detail.message === "string" ? [detail.message] : [])].join(" ") };
    case 502: return { kind: "aws", message: details.flatMap((detail) => typeof detail.message === "string" ? [detail.message] : [])[0] ?? message };
    case 503: {
      // not_configured: no WORKFLOW_ARTIFACT_BUCKET; server_setting_missing: a hidden parameter the server cannot fill.
      const settings = details.flatMap((detail) => detail.code === "server_setting_missing" && typeof detail.parameter === "string" ? [detail.parameter] : []);
      return { kind: "not_configured", message: settings.length ? `${message} It cannot fill in ${settings.join(", ")}.` : message };
    }
    default: return { kind: "other", message };
  }
}

async function call<T>(doFetch: Fetch, url: string, init?: RequestInit): Promise<Result<T>> {
  let response: Response;
  try {
    response = await doFetch(url, { cache: "no-store", ...init });
  } catch {
    return { ok: false, failure: { kind: "other", message: "The service could not be reached. Check the connection and try again." } };
  }
  if (!response.ok) return { ok: false, failure: await failureOf(response) };
  const value = await response.json().catch(() => null) as T | null;
  return value ? { ok: true, value } : { ok: false, failure: { kind: "other", message: "The service gave an answer the page cannot read." } };
}

export function startDeployment(
  body: { api_ids: string[]; status: "feasible" | "needs_decision"; name?: string; parameters: Record<string, string> },
  doFetch: Fetch = fetch,
): Promise<Result<Deployment>> {
  return call<Deployment>(doFetch, "/api/workflows/deployments", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

export function getDeployment(id: string, doFetch: Fetch = fetch): Promise<Result<Deployment>> {
  return call<Deployment>(doFetch, `/api/workflows/deployments/${encodeURIComponent(id)}`);
}

/** Deletes the stack (its functions, roles and state machine); the service answers 202 and GET then reports it until it is gone. */
export function deleteDeployment(id: string, doFetch: Fetch = fetch): Promise<Result<Deployment>> {
  return call<Deployment>(doFetch, `/api/workflows/deployments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function startExecution(id: string, invoice: Blob, options: Record<string, unknown> | null, doFetch: Fetch = fetch): Promise<Result<{ execution_arn: string; console_url?: string }>> {
  const form = new FormData();
  form.set("invoice", invoice);
  if (options) form.set("options", JSON.stringify(options));
  return call(doFetch, `/api/workflows/deployments/${encodeURIComponent(id)}/executions`, { method: "POST", body: form });
}

export function getExecution(arn: string, doFetch: Fetch = fetch): Promise<Result<Execution>> {
  return call<Execution>(doFetch, `/api/workflows/executions/${encodeURIComponent(arn)}`);
}

/** Each state of the definition with its run status; a state the run has not reached is not_run. */
export function runStates(execution: Execution | null, stateNames: readonly string[]): Record<string, RunState> {
  const result: Record<string, RunState> = {};
  if (!execution) return result;
  const reported = new Map(execution.states.map((state) => [state.name, state.status]));
  for (const name of stateNames) result[name] = reported.get(name) ?? "not_run";
  return result;
}

export const RUNNING = "RUNNING";
/** PDFs use private S3 storage when they do not fit inline. XML and JSON remain inline. */
export const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;

/** The demo company the client asked us to send from in the B2Brouter sandbox (CS9 Demo Supplies Pty Ltd). */
export const DEMO_SELLER_ABN = "47555222000";

/**
 * The run's mapping options, as options.example.json and /compose/pdf-invoice
 * ask for them: what a PDF does not carry. Empty values are left out.
 * invoiceId and issueDate replace the printed number and date, for re-sending
 * an old invoice in the B2Brouter sandbox (each number once, a date of this
 * financial year).
 */
export function runOptions(input: {
  buyerReference?: string; paymentTerms?: string; sellerAbn?: string; buyerAbn?: string; buyerEndpoint?: { scheme: string; id: string };
  invoiceId?: string; issueDate?: string; dueDate?: string;
}): Record<string, unknown> {
  const options: Record<string, unknown> = { profile: "pint-aunz" };
  const clean = (value?: string) => (value ?? "").trim();
  const digits = (value?: string) => clean(value).replace(/\s+/g, "");
  if (clean(input.buyerReference)) options.buyerReference = clean(input.buyerReference);
  if (clean(input.paymentTerms)) options.paymentTerms = clean(input.paymentTerms);
  const buyer: Record<string, string> = {};
  if (input.buyerEndpoint?.id) Object.assign(buyer, { endpointId: input.buyerEndpoint.id, endpointSchemeId: input.buyerEndpoint.scheme });
  if (digits(input.buyerAbn)) Object.assign(buyer, { legalRegistrationId: digits(input.buyerAbn), legalRegistrationSchemeId: "0151" });
  if (Object.keys(buyer).length) options.buyer = buyer;
  const seller = digits(input.sellerAbn);
  if (seller) options.seller = { endpointId: seller, endpointSchemeId: "0151", legalRegistrationId: seller, legalRegistrationSchemeId: "0151" };
  if (clean(input.invoiceId)) options.invoiceId = clean(input.invoiceId);
  if (clean(input.issueDate)) options.issueDate = clean(input.issueDate);
  if (clean(input.dueDate)) options.dueDate = clean(input.dueDate);
  return options;
}
