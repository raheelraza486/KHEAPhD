/**
 * POST one chain from `/api/composition` and download its Step Functions
 * workflow (#62): an AWS SAM application (template.yaml, the definition and
 * one Lambda function per step) that `sam deploy` in CloudShell creates, as a
 * zip. `?format=json` returns the same content as JSON instead, with the
 * definition and each Lambda's details (without its files) for the workflow
 * canvas.
 *
 * Body: `{ "api_ids": [...], "status"?: "feasible" | "needs_decision", "name"?: string }`,
 * the `api_ids` and `status` of one `composition.chains[]` entry. Nothing is
 * deployed and no provider is called; the catalogue, and the chain's schemas,
 * are each read once.
 */
import { NextResponse } from "next/server";
import { getSupabaseConfig } from "@/lib/checks/store";
import { loadCompositionCatalogue, loadCompositionSides } from "@/lib/composition/catalogue";
import { generateWorkflow } from "@/lib/composition/step-functions";
import { MAX_STEPS } from "@/lib/composition/types";
import { requestFields } from "@/lib/composition/workflow-calls";
import { stackName, workflowFiles, zipFiles } from "@/lib/composition/workflow-package";

export const dynamic = "force-dynamic";
const MAX_BODY_CHARS = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(error: string, status: number, requestId: string, details?: unknown) {
  return NextResponse.json(
    { error, requestId, ...(details === undefined ? {} : { details }) },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function parseBody(value: unknown): { api_ids: string[]; status?: "feasible" | "needs_decision"; name?: string } | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "The body must be a JSON object.";
  const body = value as Record<string, unknown>;
  const ids = body.api_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_STEPS) {
    return `api_ids must list 1 to ${MAX_STEPS} API ids in process order.`;
  }
  if (!ids.every((id) => typeof id === "string" && UUID.test(id))) return "Every api_id must be a catalogue UUID.";
  if (body.status !== undefined && body.status !== "feasible" && body.status !== "needs_decision") {
    return "status must be feasible or needs_decision.";
  }
  if (body.name !== undefined && typeof body.name !== "string") return "name must be a string.";
  return { api_ids: ids as string[], status: body.status as "feasible" | "needs_decision" | undefined, name: body.name as string | undefined };
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
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
    // The wrappers build each request from the API's stored schemas: one bulk read per table.
    const { sides } = await loadCompositionSides(config, catalogue, body.api_ids);
    const schemasById = new Map(sides.map((side) => [side.api.id, side.schemas]));
    apis = catalogue.map((api) => ({ ...api, schemas: schemasById.get(api.id) ?? [] }));
  } catch {
    return errorResponse("The catalogue could not be read.", 502, requestId);
  }

  const result = generateWorkflow({ api_ids: body.api_ids, status: body.status }, apis, { name: body.name });
  if (!result.ok) return errorResponse("This chain cannot be turned into a workflow.", 422, requestId, result.issues);

  const files = workflowFiles(result.workflow);
  if (new URL(request.url).searchParams.get("format") === "json") {
    const schemasOf = new Map(apis.map((api) => [api.id, api.schemas]));
    return NextResponse.json({
      requestId,
      name: result.workflow.name,
      warnings: result.workflow.warnings,
      // The workflow canvas draws the definition, names each Lambda's API and lists
      // where each request field comes from (the call plan and the stored request's fields).
      definition: result.workflow.definition,
      lambdas: result.workflow.lambdas.map(({ files: _files, ...lambda }) => ({
        ...lambda,
        request_fields: lambda.api_id ? requestFields(lambda.category, schemasOf.get(lambda.api_id) ?? []) : null,
      })),
      // What deploying needs (#135): the template's parameters and the secrets the functions read.
      parameters: result.workflow.parameters,
      secrets: result.workflow.secrets,
      stack_name: stackName(result.workflow),
      files,
    }, { headers: { "Cache-Control": "no-store" } });
  }
  return new Response(new Uint8Array(zipFiles(files)), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.workflow.name}.zip"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}
