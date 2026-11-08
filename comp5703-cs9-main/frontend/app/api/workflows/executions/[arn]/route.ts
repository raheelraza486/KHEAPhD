/**
 * A trial run's progress, state by state (#135, part 3). Admin only. The path
 * is the URL-encoded execution ARN that starting the run returned.
 *
 * `{ status, states: [{ name, status, started_at?, ended_at?, error?, cause? }],
 * error, output_summary }`: `status` as Step Functions reports it, each state
 * of the definition by its exact name (succeeded, failed, running or not_run),
 * and one sentence about the result instead of the output, which holds the
 * whole invoice.
 */
import { requireRole } from "@/lib/auth";
import { deployAws } from "@/lib/workflow-deploy/aws";
import { executionStatus, isExecutionArn } from "@/lib/workflow-deploy/executions";
import { errorResponse, failureResponse, NO_STORE } from "@/lib/workflow-deploy/http";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ arn: string }> };

export async function GET(request: Request, context: Context) {
  const requestId = crypto.randomUUID();
  const auth = await requireRole(request, ["admin"], requestId);
  if (auth.response) return auth.response;
  const { arn: raw } = await context.params;
  let arn = raw;
  try {
    arn = decodeURIComponent(raw);
  } catch {
    return errorResponse("There is no such execution.", 404, requestId);
  }
  const aws = deployAws();
  if (!isExecutionArn(arn, aws.region)) return errorResponse("There is no such execution.", 404, requestId);
  try {
    const view = await executionStatus(aws, arn);
    if (!view) return errorResponse("There is no such execution.", 404, requestId);
    return NextResponse.json({ ...view, requestId }, { headers: NO_STORE });
  } catch (error) {
    return failureResponse(error, requestId);
  }
}
