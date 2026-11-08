/**
 * Answers of the deployment routes (#135), in the shape every route uses:
 * `{ error, requestId, details? }`, never cached.
 */
import { NextResponse } from "next/server";

import { isAwsError } from "./types.ts";

export const NO_STORE = { "Cache-Control": "no-store" };

export function errorResponse(error: string, status: number, requestId: string, details?: unknown) {
  return NextResponse.json(
    { error, requestId, ...(details === undefined ? {} : { details }) },
    { status, headers: NO_STORE },
  );
}

/** An AWS failure keeps AWS's own message (permissions, quotas); anything else is a plain 500. */
export function failureResponse(error: unknown, requestId: string) {
  if (isAwsError(error)) {
    return errorResponse("AWS refused the request.", 502, requestId, [{ code: "aws_error", service: error.service, message: error.message }]);
  }
  return errorResponse("The request could not be completed.", 500, requestId);
}

/** The stack names this site deploys: `bp-` and lower-case letters, digits and hyphens. */
export const DEPLOYMENT_ID = /^bp-[a-z0-9-]{1,125}$/;

export function notConfigured(requestId: string) {
  return errorResponse("Deployment to AWS is not configured on this server.", 503, requestId, [
    { code: "not_configured", setting: "WORKFLOW_ARTIFACT_BUCKET" },
  ]);
}
