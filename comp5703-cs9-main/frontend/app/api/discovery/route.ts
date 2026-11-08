import { NextResponse } from "next/server";
import { getCurrentAppUser } from "@/lib/auth";
import { DiscoveryInputError, readDiscoveryInput } from "@/lib/discovery/input";
import {
  DiscoveryConfigurationError,
  DiscoveryProviderError,
  discoverProcess,
} from "@/lib/discovery/provider";
import { checkDiscoveryRateLimit } from "@/lib/discovery/rate-limit";
import type { DiscoveryInput, DiscoveryProcessJson, DiscoverySource } from "@/lib/discovery/types";
import { collapseBpmnDeliveryBranches } from "@/lib/discovery/gateway-branches";
import type { DiscoveryReview } from "@/lib/discovery/grounding";
import { PROCESS_FORMAT_VERSION, parseProcessJson } from "@/lib/composition/process-format";
import { bounded, operationSignal } from '@/lib/workspace/execution';

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: string, status: number, requestId: string, details?: unknown, retryAfter?: string | number) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfter !== undefined) headers["Retry-After"] = String(retryAfter);
  return NextResponse.json(
    { error, requestId, ...(details === undefined ? {} : { details }) },
    { status, headers },
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enforce the model trust boundary before the shared Process JSON parser runs. */
function modelBoundary(value: unknown, input: DiscoveryInput): unknown {
  if (!isObject(value)) return value;
  const steps = Array.isArray(value.steps)
    ? value.steps.map((step) => isObject(step) ? { ...step, candidate_ids: null } : step)
    : value.steps;
  return {
    ...value,
    ...(input.mode === "text" ? { input_text: input.text } : {}),
    steps,
  };
}

function source(input: DiscoveryInput): DiscoverySource {
  return input.mode === "text"
    ? { mode: input.mode }
    : { mode: input.mode, file_name: input.file.name, mime_type: input.file.type };
}

function processJson(parsed: Extract<ReturnType<typeof parseProcessJson>, { ok: true }>): DiscoveryProcessJson {
  return {
    version: PROCESS_FORMAT_VERSION,
    input_text: parsed.input_text,
    steps: parsed.process.steps.map((step) => ({
      order: step.order,
      category: step.category,
      task: step.task,
      input_format: step.input_format ?? null,
      output_format: step.output_format ?? null,
      rule_set: step.rule_set ?? null,
      candidate_ids: null,
    })),
    unmatched: parsed.unmatched,
  };
}

export async function POST(request: Request) {
  const signal = operationSignal(request.signal, 'WORKSPACE_OVERALL_TIMEOUT_MS', 90_000);
  try { return await bounded(handlePost(request, signal), signal); }
  catch { return errorResponse('API Discovery timed out or was cancelled. Please retry.', 504, crypto.randomUUID()); }
}
async function handlePost(request: Request, signal: AbortSignal) {
  const requestId = crypto.randomUUID();
  let user: Awaited<ReturnType<typeof getCurrentAppUser>>;
  try {
    user = await getCurrentAppUser(request);
  } catch {
    return errorResponse("Sign-in is temporarily unavailable. Please try again.", 503, requestId);
  }
  if (!user) return errorResponse("Sign in to use API Discovery.", 401, requestId);

  const retryAfter = checkDiscoveryRateLimit(user.id);
  if (retryAfter > 0) return errorResponse("Too many Discovery requests. Please wait and try again.", 429, requestId, undefined, retryAfter);

  let input: DiscoveryInput;
  try {
    input = await readDiscoveryInput(request);
  } catch (error) {
    if (error instanceof DiscoveryInputError) return errorResponse(error.message, error.status, requestId);
    return errorResponse("The Discovery request could not be read.", 400, requestId);
  }

  try {
    let review: DiscoveryReview[] = [];
    const generated = await discoverProcess(input, { signal, onReview: notes => { review = notes; } });
    const parsed = parseProcessJson(modelBoundary(generated, input));
    if (!parsed.ok) {
      return errorResponse("The model result did not match process JSON 1.0.", 502, requestId, parsed.errors);
    }
    const strictProcess = processJson(parsed);
    const process = input.mode === "bpmn"
      ? collapseBpmnDeliveryBranches(strictProcess)
      : strictProcess;
    // Once the gateway's branches are one "email or Peppol" step, the note
    // about a missing send step no longer applies.
    if (process !== strictProcess && process.steps.some(step => step.task === "send via email or Peppol")) {
      review = review.filter(({ message }) => !message.startsWith("The source names multiple delivery actions"));
    }
    return NextResponse.json(
      { requestId, source: source(input), process, ...(review.length ? { review: process === strictProcess ? review : review.map(({ message }) => ({ message })) } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof DiscoveryConfigurationError) {
      return errorResponse("API Discovery is not configured.", 503, requestId);
    }
    if (error instanceof DiscoveryProviderError) {
      console.error("Discovery provider request failed", { requestId, mode: input.mode, code: error.code });
      const status = error.code === "temporarily_unavailable" ? 503 : 502;
      return errorResponse("API Discovery could not process this input.", status, requestId, undefined, error.retryAfter);
    }
    console.error("Discovery request failed", { requestId, mode: input.mode });
    return errorResponse("API Discovery could not process this input.", 502, requestId);
  }
}

