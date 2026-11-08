/**
 * Start a trial run of a deployed workflow (#135, part 3). Admin only.
 *
 * multipart/form-data: `invoice` (PDF up to 4 MB, or an inline XML/JSON file)
 * and, optionally,
 * `options` (JSON text, as in options.example.json). The input is built as
 * make_input.py builds it and the state machine is started.
 *
 * 202 `{ execution_arn, console_url }`; follow it with
 * GET /api/workflows/executions/{execution_arn, URL-encoded}. A run really sends
 * the invoice (and an Upbrains step spends credits), so requests must be
 * same-origin and each admin may start five a minute (429 with
 * `retry_after_seconds`).
 */
import { requireRole } from "@/lib/auth";
import { deployAws } from "@/lib/workflow-deploy/aws";
import { MAX_PDF_BYTES, startTrialRun } from "@/lib/workflow-deploy/executions";
import { DEPLOYMENT_ID, errorResponse, failureResponse, NO_STORE } from "@/lib/workflow-deploy/http";
import { NextResponse } from "next/server";
import { createAnswerLimiter, isSameOrigin } from "../../../../checks/shared";

export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = MAX_PDF_BYTES + 100_000;
const checkTrialRateLimit = createAnswerLimiter(60_000, 5);

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return errorResponse("Cross-origin requests are not allowed.", 403, requestId);
  const auth = await requireRole(request, ["admin"], requestId);
  if (auth.response) return auth.response;
  const wait = checkTrialRateLimit(auth.user.id);
  if (wait > 0) return errorResponse("Too many trial runs in a short time. Try again shortly.", 429, requestId, { retry_after_seconds: wait });
  const { id } = await context.params;
  if (!DEPLOYMENT_ID.test(id)) return errorResponse("There is no such deployment.", 404, requestId);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) return errorResponse("The request is too large.", 413, requestId);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse("Send the invoice as multipart/form-data in the field invoice.", 400, requestId);
  }
  const invoice = form.get("invoice");
  if (!invoice || typeof invoice === "string") return errorResponse("Send the invoice as a file in the field invoice.", 400, requestId);
  const options = form.get("options");
  if (options !== null && typeof options !== "string") return errorResponse("options must be JSON text.", 400, requestId);
  if (!invoice.size || invoice.size > MAX_PDF_BYTES) return errorResponse("The file must be at most 4 MB and cannot be empty.", 413, requestId);
  const input = { file: new Uint8Array(await invoice.arrayBuffer()), optionsText: options, bucket: process.env.WORKFLOW_ARTIFACT_BUCKET?.trim() };

  try {
    const outcome = await startTrialRun(deployAws(), id, input);
    if (!outcome.ok) return errorResponse(outcome.error, outcome.status, requestId);
    return NextResponse.json({ execution_arn: outcome.execution_arn, console_url: outcome.console_url, requestId }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return failureResponse(error, requestId);
  }
}
