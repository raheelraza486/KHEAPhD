/**
 * POST a chain to deploy its Step Functions workflow on AWS (#135): the same
 * functions, state machine and template as the download of
 * `/api/composition/workflow`, deployed as the CloudFormation stack
 * `bp-<workflow name>`. Admin only.
 *
 * Body: `{ "api_ids": [...], "status"?: "feasible" | "needs_decision", "name"?: string,
 * "parameters"?: { "<template parameter>": "<value>" } }`. The page sends only the
 * parameters a person chooses; the server fills Mailgun's domain and sender,
 * B2Brouter's account and Upbrains' flow id from its own settings, and never
 * accepts the hidden ones from a request.
 *
 * 202 `{ deployment_id, stack_name, state_machine_name, status, started_at }` once
 * the change set is executing; follow it with GET /api/workflows/deployments/{id}.
 * 400 bad body or parameters, 401/403, 403 `recipient_not_allowed` (a recipient
 * other than the admin's own address or MAILGUN_ALLOWED_RECIPIENTS), 409 busy,
 * 412 a secret is missing, 422 the chain cannot be a workflow, 502 AWS refused,
 * 503 not configured. Same-origin requests only.
 */
import { requireRole } from "@/lib/auth";
import { getSupabaseConfig } from "@/lib/checks/store";
import { loadCompositionCatalogue, loadCompositionSides } from "@/lib/composition/catalogue";
import { generateWorkflow } from "@/lib/composition/step-functions";
import { MAX_STEPS } from "@/lib/composition/types";
import { deployAws } from "@/lib/workflow-deploy/aws";
import { deployEnvFromProcess, refusedRecipients, resolveParameters, startDeployment } from "@/lib/workflow-deploy/deploy";
import { errorResponse, failureResponse, NO_STORE, notConfigured } from "@/lib/workflow-deploy/http";
import { NextResponse } from "next/server";
import { isSameOrigin } from "../../checks/shared";

export const dynamic = "force-dynamic";
const MAX_BODY_CHARS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { api_ids: string[]; status?: "feasible" | "needs_decision"; name?: string; parameters: Record<string, unknown> };

function parseBody(value: unknown): Body | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "The body must be a JSON object.";
  const body = value as Record<string, unknown>;
  const ids = body.api_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_STEPS) return `api_ids must list 1 to ${MAX_STEPS} API ids in process order.`;
  if (!ids.every((id) => typeof id === "string" && UUID.test(id))) return "Every api_id must be a catalogue UUID.";
  if (body.status !== undefined && body.status !== "feasible" && body.status !== "needs_decision") return "status must be feasible or needs_decision.";
  if (body.name !== undefined && typeof body.name !== "string") return "name must be a string.";
  const parameters = body.parameters ?? {};
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return "parameters must be an object of strings.";
  return {
    api_ids: ids as string[],
    status: body.status as Body["status"],
    name: body.name as string | undefined,
    parameters: parameters as Record<string, unknown>,
  };
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return errorResponse("Cross-origin requests are not allowed.", 403, requestId);
  const auth = await requireRole(request, ["admin"], requestId);
  if (auth.response) return auth.response;
  const env = deployEnvFromProcess();
  if (!env) return notConfigured(requestId);

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorResponse("The request body could not be read.", 400, requestId);
  }
  if (raw.length > MAX_BODY_CHARS) return errorResponse("The request body is too large.", 413, requestId);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return errorResponse("The request body must be valid JSON.", 400, requestId);
  }
  const body = parseBody(value);
  if (typeof body === "string") return errorResponse(body, 400, requestId);

  const config = getSupabaseConfig();
  if (!config) return errorResponse("The database is not configured.", 503, requestId);
  let apis;
  try {
    const catalogue = await loadCompositionCatalogue(config);
    const { sides } = await loadCompositionSides(config, catalogue, body.api_ids);
    const schemasById = new Map(sides.map((side) => [side.api.id, side.schemas]));
    apis = catalogue.map((api) => ({ ...api, schemas: schemasById.get(api.id) ?? [] }));
  } catch {
    return errorResponse("The catalogue could not be read.", 502, requestId);
  }

  const result = generateWorkflow({ api_ids: body.api_ids, status: body.status }, apis, { name: body.name });
  if (!result.ok) return errorResponse("This chain cannot be turned into a workflow.", 422, requestId, result.issues);

  const parameters = resolveParameters(result.workflow, body.parameters, env);
  if (parameters.issues.length) return errorResponse("Some parameters are missing or not accepted.", 400, requestId, parameters.issues);
  if (parameters.server_missing.length) {
    return errorResponse("The server lacks a setting this workflow needs.", 503, requestId,
      parameters.server_missing.map((parameter) => ({ code: "server_setting_missing", parameter })));
  }
  const refused = refusedRecipients(parameters.values, auth.user.email, env);
  if (refused.length) {
    return errorResponse("A workflow can email your own account address, or an address the administrators have allowed.", 403, requestId,
      refused.map((parameter) => ({ code: "recipient_not_allowed", parameter })));
  }

  try {
    const outcome = await startDeployment(deployAws(), result.workflow, parameters.values, env);
    if (!outcome.ok) return errorResponse(outcome.error, outcome.status, requestId, outcome.details);
    return NextResponse.json({ ...outcome.deployment, requestId }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return failureResponse(error, requestId);
  }
}
