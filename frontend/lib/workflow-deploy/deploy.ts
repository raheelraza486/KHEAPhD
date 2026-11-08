/**
 * One-click deployment of a generated workflow (#135), the work behind
 * `/api/workflows/deployments`. It deploys exactly what the download holds:
 * the same `generateWorkflow` bundle, packaged the way `sam deploy` packages it.
 *
 *   1. parameters  the page sends the template parameters a person chooses
 *                  (a recipient, a subject); the server fills the rest from its
 *                  own settings (Mailgun's domain, B2Brouter's account) and the
 *                  hidden ones (Upbrains' flow id) from its own webhook address.
 *   2. checks      the stack is not busy, and each `bp-builder/*` secret the
 *                  functions read exists (its value is never read).
 *   3. package     each function folder as a zip, the definition and the template
 *                  to S3, with `CodeUri` and `DefinitionUri` pointing at them,
 *                  like `aws cloudformation package`.
 *   4. change set  CREATE or UPDATE with CAPABILITY_IAM and CAPABILITY_AUTO_EXPAND,
 *                  executed once CloudFormation has prepared it.
 *
 * The stack takes one to three minutes; its progress is read back from
 * CloudFormation (`deploymentStatus`), so nothing is kept on the server.
 * Parameter values are never logged or returned.
 */
import { createHash } from "node:crypto";

import { emailRecipientAllowed } from "../composition/peppol-invoice.ts";
import type { WorkflowBundle } from "../composition/step-functions.ts";
import { stackName, zipFiles } from "../composition/workflow-package.ts";
import { AwsError, isAwsError, type ChangeSetView, type DeployAws, type StackEventView, type StackView } from "./types.ts";

export interface DeployEnv {
  /** The S3 bucket for packaged functions and templates (WORKFLOW_ARTIFACT_BUCKET). */
  bucket: string;
  mailgunDomain?: string;
  mailgunFrom?: string;
  b2brouterAccount?: string;
  upbrainsWebhookUrl?: string;
  /** MAILGUN_ALLOWED_RECIPIENTS: addresses besides the admin's own that a workflow may email. */
  allowedRecipients?: string[];
}

export function deployEnvFromProcess(env: NodeJS.ProcessEnv = process.env): DeployEnv | null {
  const bucket = env.WORKFLOW_ARTIFACT_BUCKET?.trim();
  if (!bucket) return null;
  return {
    bucket,
    mailgunDomain: env.MAILGUN_DOMAIN?.trim() || undefined,
    mailgunFrom: env.MAILGUN_FROM?.trim() || undefined,
    b2brouterAccount: env.B2BROUTER_ACCOUNT_ID?.trim() || undefined,
    upbrainsWebhookUrl: env.UPBRAINS_WEBHOOK_URL?.trim() || undefined,
    allowedRecipients: (env.MAILGUN_ALLOWED_RECIPIENTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
  };
}

export type ParameterIssue =
  | { code: "missing_parameter"; parameter: string }
  | { code: "unknown_parameter"; parameter: string }
  | { code: "invalid_parameter"; parameter: string; message: string }
  | { code: "server_parameter"; parameter: string };

/**
 * Values the server supplies from its own settings. The hidden ones are never
 * taken from a request; the others are defaults a request may override.
 */
const SERVER_VALUES: Record<string, (env: DeployEnv) => string | undefined> = {
  // UPBRAINS_WEBHOOK_URL is https://agents.upbrains.ai/v1/webhooks/<flowId>, with or
  // without /sync, read as lib/composition/pdf-invoice.ts reads it.
  UpbrainsFlowId: (env) => {
    const address = (env.upbrainsWebhookUrl ?? "").trim().replace(/\/+$/, "").replace(/\/sync$/, "");
    return /\/webhooks\/([A-Za-z0-9_-]+)$/.exec(address)?.[1];
  },
  WorkflowInputBucket: (env) => env.bucket,
  MailgunDomainName: (env) => env.mailgunDomain,
  MailgunFrom: (env) => env.mailgunFrom ?? (env.mailgunDomain ? `postmaster@${env.mailgunDomain}` : undefined),
  B2BrouterAccount: (env) => env.b2brouterAccount,
};

const MAX_VALUE = 1_000;

/** Why a value cannot go into the template: it is placed in a JSON string by Fn::Sub. */
function invalidValue(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return "must be a non-empty string";
  if (value.length > MAX_VALUE) return `must be at most ${MAX_VALUE} characters`;
  if (/[\u0000-\u001f"\\]/.test(value)) return "must not contain quotes, backslashes or control characters";
  return null;
}

/**
 * The template parameters for a deployment: the request's values for the
 * parameters a person chooses, then the server's, then the template's defaults.
 * `server_missing` lists hidden parameters the server cannot supply.
 */
export function resolveParameters(
  bundle: Pick<WorkflowBundle, "parameters">,
  requested: Record<string, unknown>,
  env: DeployEnv,
): { values: Record<string, string>; issues: ParameterIssue[]; server_missing: string[] } {
  const known = new Map(bundle.parameters.map((parameter) => [parameter.name, parameter]));
  const issues: ParameterIssue[] = [];
  for (const [name, value] of Object.entries(requested)) {
    const parameter = known.get(name);
    if (!parameter) {
      issues.push({ code: "unknown_parameter", parameter: name });
    } else if (parameter.no_echo || name === "WorkflowInputBucket") {
      // Credentials and the storage destination are supplied only by the server.
      issues.push({ code: "server_parameter", parameter: name });
    } else {
      const problem = invalidValue(value);
      if (problem) issues.push({ code: "invalid_parameter", parameter: name, message: `${name} ${problem}.` });
    }
  }
  const values: Record<string, string> = {};
  const serverMissing: string[] = [];
  for (const parameter of bundle.parameters) {
    const server = SERVER_VALUES[parameter.name]?.(env);
    if (parameter.no_echo || parameter.name === "WorkflowInputBucket") {
      if (server) values[parameter.name] = server;
      else serverMissing.push(parameter.name);
      continue;
    }
    const chosen = requested[parameter.name];
    const value = typeof chosen === "string" && chosen.trim() ? chosen.trim() : server ?? parameter.default;
    if (value) values[parameter.name] = value;
    else if (!issues.some((issue) => issue.parameter === parameter.name)) issues.push({ code: "missing_parameter", parameter: parameter.name });
  }
  return { values, issues, server_missing: serverMissing };
}

/** A request's `to` field (Mailgun's `MailgunTo`): the address every run emails. */
const RECIPIENT = /To$/;

/**
 * The recipient parameters set to an address the admin may not choose. As on
 * /api/composed/peppol-invoice, a workflow may email the admin's own account
 * address or one in MAILGUN_ALLOWED_RECIPIENTS: each trial run sends from the
 * group's Mailgun domain.
 */
export function refusedRecipients(values: Record<string, string>, accountEmail: string | null | undefined, env: DeployEnv): string[] {
  return Object.entries(values)
    .filter(([name, value]) => RECIPIENT.test(name) && !emailRecipientAllowed(value, accountEmail, env.allowedRecipients))
    .map(([name]) => name);
}

export interface Artifact {
  key: string;
  body: Buffer;
  content_type: string;
}

/** Zips are written with a fixed date, so unchanged code keeps its key and is not redeployed. */
const ZIP_DATE = new Date(2026, 0, 1);

function digest(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * The S3 objects for a deployment and the template that points at them:
 * each key carries a digest of its content, so CloudFormation sees a change
 * exactly when the code or the definition changed.
 */
export function packageDeployment(bundle: WorkflowBundle, bucket: string, region: string): {
  stack: string;
  artifacts: Artifact[];
  template_url: string;
} {
  const stack = stackName(bundle);
  const template = structuredClone(bundle.template) as { Resources: Record<string, { Properties: Record<string, unknown> }> };
  const artifacts: Artifact[] = [];
  for (const lambda of bundle.lambdas) {
    const body = zipFiles(lambda.files, ZIP_DATE);
    const key = `${stack}/functions/${lambda.function_name}-${digest(body)}.zip`;
    artifacts.push({ key, body, content_type: "application/zip" });
    template.Resources[lambda.logical_id].Properties.CodeUri = { Bucket: bucket, Key: key };
  }
  const definition = Buffer.from(`${bundle.json}\n`, "utf8");
  const definitionKey = `${stack}/statemachine-${digest(definition)}.asl.json`;
  artifacts.push({ key: definitionKey, body: definition, content_type: "application/json" });
  template.Resources.Workflow.Properties.DefinitionUri = { Bucket: bucket, Key: definitionKey };
  const body = Buffer.from(JSON.stringify(template, null, 2), "utf8");
  const templateKey = `${stack}/template-${digest(body)}.json`;
  artifacts.push({ key: templateKey, body, content_type: "application/json" });
  return { stack, artifacts, template_url: `https://${bucket}.s3.${region}.amazonaws.com/${templateKey}` };
}

const CHANGE_SET_PREFIX = "bp-deploy-";
/** States a stack can be deployed from: none, a first change set not yet run, or a finished one. */
const UPDATABLE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_COMPLETE"]);
/** A failed first creation leaves a stack that can only be deleted. */
const DELETE_FIRST = new Set(["ROLLBACK_COMPLETE", "ROLLBACK_FAILED", "DELETE_FAILED", "UPDATE_ROLLBACK_FAILED"]);
const NO_CHANGES = /didn't contain changes|No updates are to be performed/i;

function busy(changeSets: readonly ChangeSetView[]): ChangeSetView | undefined {
  return changeSets.find((set) => set.name.startsWith(CHANGE_SET_PREFIX)
    && (["CREATE_PENDING", "CREATE_IN_PROGRESS"].includes(set.status) || (set.status === "CREATE_COMPLETE" && set.execution_status === "AVAILABLE")));
}

export interface DeploymentStarted {
  deployment_id: string;
  stack_name: string;
  state_machine_name: string;
  status: "in_progress" | "succeeded";
  started_at: string;
}

export type StartOutcome =
  | { ok: true; deployment: DeploymentStarted }
  | { ok: false; status: 409; error: string; details: { deployment_id: string; stack_status: string; code: "in_progress" | "delete_first" } }
  | { ok: false; status: 412; error: string; details: Array<{ code: "missing_secret"; secret: string; how: string }> };

export interface StartOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for CloudFormation to prepare the change set before answering. */
  wait_ms?: number;
}

function secretCommand(name: string): string {
  return `read -rs VALUE && aws secretsmanager create-secret --name ${name} --secret-string "$VALUE"; unset VALUE`;
}

function changeSetName(now: Date): string {
  return `${CHANGE_SET_PREFIX}${now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

/** Executes a prepared change set, which a status poll from another page may have executed a moment earlier. */
async function executePrepared(aws: DeployAws, stack: string, name: string) {
  try {
    await aws.executeChangeSet(stack, name);
  } catch (error) {
    if (!(isAwsError(error) && /InvalidChangeSetStatus/.test(error.code))) throw error;
  }
}

/** Steps 2 to 4. AWS failures are thrown as `AwsError`. */
export async function startDeployment(
  aws: DeployAws,
  bundle: WorkflowBundle,
  parameters: Record<string, string>,
  env: DeployEnv,
  options: StartOptions = {},
): Promise<StartOutcome> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = options.wait_ms ?? 45_000;
  const stack = stackName(bundle);

  const current = await aws.describeStack(stack);
  if (current && DELETE_FIRST.has(current.status)) {
    return {
      ok: false, status: 409,
      error: "The last deployment of this workflow failed and left a stack that must be deleted before it is deployed again.",
      details: { deployment_id: stack, stack_status: current.status, code: "delete_first" },
    };
  }
  const pending = current ? busy(await aws.listChangeSets(stack)) : undefined;
  if (current && ((!UPDATABLE.has(current.status) && current.status !== "REVIEW_IN_PROGRESS") || pending)) {
    return {
      ok: false, status: 409,
      error: "This workflow is being deployed or deleted; wait for that to finish.",
      details: { deployment_id: stack, stack_status: current.status, code: "in_progress" },
    };
  }

  const missing: string[] = [];
  for (const secret of bundle.secrets) if (!(await aws.secretExists(secret.name))) missing.push(secret.name);
  if (missing.length) {
    return {
      ok: false, status: 412,
      error: "Create the workflow's secrets in AWS Secrets Manager before deploying it.",
      details: missing.map((secret) => ({ code: "missing_secret" as const, secret, how: secretCommand(secret) })),
    };
  }

  const started = now();
  const packaged = packageDeployment(bundle, env.bucket, aws.region);
  for (const artifact of packaged.artifacts) await aws.putObject(env.bucket, artifact.key, artifact.body, artifact.content_type);

  const name = changeSetName(started);
  const type = current && current.status !== "REVIEW_IN_PROGRESS" ? "UPDATE" : "CREATE";
  await aws.createChangeSet({ stack, name, type, templateUrl: packaged.template_url, parameters });

  let status: DeploymentStarted["status"] = "in_progress";
  for (let waited = 0; waited <= waitMs; waited += 2_000) {
    const set = await aws.describeChangeSet(stack, name);
    if (set.status === "CREATE_COMPLETE" && set.execution_status === "AVAILABLE") {
      await executePrepared(aws, stack, name);
      break;
    }
    if (set.status === "FAILED") {
      if (NO_CHANGES.test(set.reason ?? "")) {
        // The same code and parameters are already deployed.
        await aws.deleteChangeSet(stack, name);
        status = "succeeded";
        break;
      }
      throw new AwsError("cloudformation", "ChangeSetFailed", set.reason ?? "CloudFormation could not prepare the deployment.");
    }
    // Still being prepared: past the wait, the status route executes it when it is ready.
    if (waited + 2_000 > waitMs) break;
    await sleep(2_000);
  }

  return {
    ok: true,
    deployment: { deployment_id: stack, stack_name: stack, state_machine_name: bundle.name, status, started_at: started.toISOString() },
  };
}

export interface DeploymentView {
  deployment_id: string;
  status: "in_progress" | "succeeded" | "failed";
  phase: "creating_stack" | "deleting" | "done";
  stack_status: string;
  events: Array<{ time: string; resource: string; status: string; reason: string | null }>;
  state_machine_arn: string | null;
  console_url: string | null;
  functions: Array<{ state_name: string; function_name: string; arn: string }>;
  error: { message: string; resource: string | null } | null;
}

const SUCCEEDED = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);
const FAILED = new Set([
  "CREATE_FAILED", "ROLLBACK_COMPLETE", "ROLLBACK_FAILED", "DELETE_FAILED",
  "UPDATE_ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_FAILED", "UPDATE_FAILED", "IMPORT_ROLLBACK_COMPLETE", "IMPORT_ROLLBACK_FAILED",
]);

export function stateMachineConsoleUrl(region: string, arn: string): string {
  return `https://${region}.console.aws.amazon.com/states/home?region=${region}#/statemachines/view/${arn}`;
}

/** The root cause of a failed deployment: the oldest failed resource among the latest events. */
function failure(events: readonly StackEventView[], stack: string, view: StackView): DeploymentView["error"] {
  const failed = events.filter((event) => /FAILED$/.test(event.status) && event.reason && !/cancelled/i.test(event.reason));
  const resource = failed.filter((event) => event.resource !== stack).at(-1);
  if (resource) return { message: resource.reason!, resource: resource.resource };
  const own = failed.at(-1);
  return { message: own?.reason ?? view.reason ?? `The stack ended in ${view.status}.`, resource: null };
}

/** The deployment as the page shows it, from the stack, its latest events and its change sets. */
export function deploymentView(view: StackView, events: readonly StackEventView[], region: string, changeSets: readonly ChangeSetView[]): DeploymentView {
  const pending = !!busy(changeSets);
  const base: DeploymentView = {
    deployment_id: view.name,
    status: "in_progress",
    phase: "creating_stack",
    stack_status: view.status,
    events: events.slice(0, 20).map(({ time, resource, status, reason }) => ({ time, resource, status, reason })),
    state_machine_arn: null,
    console_url: null,
    functions: [],
    error: null,
  };
  if (view.status === "DELETE_IN_PROGRESS") return { ...base, phase: "deleting" };
  if (view.status === "REVIEW_IN_PROGRESS" && !pending) {
    // A first deployment whose change set CloudFormation could not prepare: nothing was created.
    const failedSet = changeSets.filter((set) => set.name.startsWith(CHANGE_SET_PREFIX) && set.status === "FAILED").at(0);
    return { ...base, status: "failed", phase: "done", error: { message: failedSet?.reason ?? "The deployment was prepared but never started.", resource: null } };
  }
  if (pending || !(SUCCEEDED.has(view.status) || FAILED.has(view.status))) return base;
  if (FAILED.has(view.status)) return { ...base, status: "failed", phase: "done", error: failure(events, view.name, view) };

  const arn = view.outputs.StateMachineArn?.value ?? null;
  // arn:aws:states:<region>:<account>:stateMachine:<name>
  const account = arn?.split(":")[4] ?? "";
  const functions = Object.entries(view.outputs)
    .filter(([key]) => /^Step\d+FunctionName$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, output]) => ({
      state_name: output.description ?? "",
      function_name: output.value,
      arn: `arn:aws:lambda:${region}:${account}:function:${output.value}`,
    }));
  return {
    ...base,
    status: "succeeded",
    phase: "done",
    state_machine_arn: arn,
    console_url: arn ? stateMachineConsoleUrl(region, arn) : null,
    functions,
  };
}

/**
 * The deployment's progress, or null when there is no such stack. A change set
 * that was still being prepared when the start route answered is executed here
 * once it is ready, so a slow preparation still deploys.
 */
export async function deploymentStatus(aws: DeployAws, stack: string): Promise<DeploymentView | null> {
  const view = await aws.describeStack(stack);
  if (!view) return null;
  const changeSets = (await aws.listChangeSets(stack)).sort((a, b) => b.created.localeCompare(a.created));
  const pending = busy(changeSets);
  // Executed now, the stack moves to *_IN_PROGRESS by the next poll; until then it is still pending.
  if (pending?.status === "CREATE_COMPLETE") await executePrepared(aws, stack, pending.name);
  const events = await aws.stackEvents(stack, 20);
  return deploymentView(view, events, aws.region, changeSets);
}

export type DeleteOutcome =
  | { ok: true; deployment_id: string }
  | { ok: false; status: 404 | 409; error: string };

/** Deletes the stack: its functions, roles and state machine. The packaged files stay in S3. */
export async function deleteDeployment(aws: DeployAws, stack: string): Promise<DeleteOutcome> {
  const view = await aws.describeStack(stack);
  if (!view) return { ok: false, status: 404, error: "There is no such deployment." };
  if (/_IN_PROGRESS$/.test(view.status) && view.status !== "REVIEW_IN_PROGRESS") {
    return { ok: false, status: 409, error: "This workflow is being deployed or deleted; wait for that to finish." };
  }
  await aws.deleteStack(stack);
  return { ok: true, deployment_id: stack };
}
