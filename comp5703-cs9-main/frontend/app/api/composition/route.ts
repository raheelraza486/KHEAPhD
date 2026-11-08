/** POST the LLM stream's process JSON and list feasible catalogue API chains. */
import { NextResponse } from "next/server";
import { getCurrentAppUser } from "@/lib/auth";
import { getSupabaseConfig } from "@/lib/checks/store";
import { compositionResponse } from "@/lib/composition/api-contract";
import { evaluateComposition, loadMatchingContext } from "@/lib/composition/service";
import { matchRequirements } from '@/lib/workspace/operations';
import { emptyState } from '@/lib/workspace/types';
import { composeChains, planProcess } from "@/lib/composition/compose";
import { parseProcessJson } from "@/lib/composition/process-format";
import { type CandidateNarrowingResult } from "@/lib/composition/task-candidates";
import { bounded, operationSignal } from '@/lib/workspace/execution';

export const dynamic = "force-dynamic";
const MAX_BODY_CHARS = 20_000;

function errorResponse(error: string, status: number, requestId: string, details?: unknown) {
  return NextResponse.json(
    { error, requestId, ...(details === undefined ? {} : { details }) },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const matching = new URL(request.url).searchParams.get('mode') === 'match';
  const signal = operationSignal(request.signal, matching ? 'API_MATCH_TIMEOUT_MS' : 'WORKFLOW_EVALUATION_TIMEOUT_MS', matching ? 30_000 : 60_000);
  try { return await bounded(handlePost(request, signal), signal); }
  catch { return errorResponse('Composition timed out or was cancelled. Please retry.', 504, crypto.randomUUID()); }
}
async function handlePost(request: Request, signal: AbortSignal) {
  const matching = new URL(request.url).searchParams.get('mode') === 'match';
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
  const parsed = parseProcessJson(value);
  if (!parsed.ok) return errorResponse("The process JSON does not match version 1.0.", 400, requestId, parsed.errors);
  if (!matching && planProcess(parsed.process).issues.length > 0) {
    const narrowed: CandidateNarrowingResult = {
      process: { steps: parsed.process.steps.map((step) => ({ ...step, candidate_ids: [] })) },
      steps: parsed.process.steps.map((step) => ({
        order: step.order, source: "none", matches: [], total_matches: 0, issue: null,
      })),
    };
    const composition = composeChains(narrowed.process, [], () => "pass");
    return NextResponse.json(
      compositionResponse(requestId, parsed.input_text, parsed.unmatched, narrowed, [], composition),
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const config = getSupabaseConfig();
  if (!config) return errorResponse("The database is not configured.", 503, requestId);

  try {
    const signedIn = await getCurrentAppUser(request).then(user => user !== null).catch(() => false);
    if (matching) {
      if (!signedIn) return errorResponse('Sign in to discover APIs.', 401, requestId);
      const context = await loadMatchingContext({ ...config, signal });
      const matches = matchRequirements({ ...emptyState(), requirements: parsed.process.steps.map(({ order, ...step }) => ({ ...step, id: String(order), candidate_ids: step.candidate_ids ? [...step.candidate_ids] : null })) }, context);
      const entries = Object.values(matches);
      return NextResponse.json({ steps: entries.map(entry => entry.step), catalogue_key: entries[0]?.catalogue_key ?? '',
        rule_review: entries.map(entry => entry.rule_review ?? []) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const result = await evaluateComposition(parsed, { ...config, signal }, signedIn, requestId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Composition request failed", { requestId, message: error instanceof Error ? error.message : "Unknown error" });
    return errorResponse("The composition could not be calculated.", 502, requestId);
  }
}
