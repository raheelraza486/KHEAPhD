/**
 * One deployment (#135), by its stack name. Admin only.
 *
 * GET: its progress, read from CloudFormation each time (the page asks every
 * three seconds): `{ deployment_id, status, phase, stack_status, events,
 * state_machine_arn, console_url, functions, error }`. A change set still being
 * prepared when the deployment was started is executed here once it is ready.
 *
 * DELETE: deletes the stack, so its functions, roles and state machine; 202.
 * Same-origin requests only.
 */
import { requireRole } from "@/lib/auth";
import { deployAws } from "@/lib/workflow-deploy/aws";
import { deleteDeployment, deploymentStatus } from "@/lib/workflow-deploy/deploy";
import { DEPLOYMENT_ID, errorResponse, failureResponse, NO_STORE } from "@/lib/workflow-deploy/http";
import { NextResponse } from "next/server";
import { isSameOrigin } from "../../../checks/shared";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const requestId = crypto.randomUUID();
  const auth = await requireRole(request, ["admin"], requestId);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!DEPLOYMENT_ID.test(id)) return errorResponse("There is no such deployment.", 404, requestId);
  try {
    const view = await deploymentStatus(deployAws(), id);
    if (!view) return errorResponse("There is no such deployment.", 404, requestId);
    return NextResponse.json({ ...view, requestId }, { headers: NO_STORE });
  } catch (error) {
    return failureResponse(error, requestId);
  }
}

export async function DELETE(request: Request, context: Context) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return errorResponse("Cross-origin requests are not allowed.", 403, requestId);
  const auth = await requireRole(request, ["admin"], requestId);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!DEPLOYMENT_ID.test(id)) return errorResponse("There is no such deployment.", 404, requestId);
  try {
    const outcome = await deleteDeployment(deployAws(), id);
    if (!outcome.ok) return errorResponse(outcome.error, outcome.status, requestId);
    return NextResponse.json({ deployment_id: id, status: "in_progress", phase: "deleting", requestId }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return failureResponse(error, requestId);
  }
}
