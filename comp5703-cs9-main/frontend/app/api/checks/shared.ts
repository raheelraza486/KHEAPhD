// Shared pieces of the /api/checks routes: request validation, the report for
// one pair, and the answer write used by both the user and the admin route.
import { NextResponse } from "next/server";
import { runChecks } from "@/lib/checks/run";
import { answerersOf, getSupabaseConfig, insertChoice, insertSettlementNotices, loadPairInput, PairNotFound, PairSchemaNotFound, type PairSchemaSelection, type SupabaseConfig, } from "@/lib/checks/store";
import { invalidateConflictCache } from "@/lib/checks/conflicts";
import type { CheckReport } from "@/lib/checks/types";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_CHARS = 10_000;
const OPTIONS = new Set(["candidate", "none", "external"]);

export function publicError(message: string, status: number, requestId: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, requestId, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : "").trim() || "local";
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) throw new Error("payload too large");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be an object");
  return parsed as Record<string, unknown>;
}

export interface AnswerBody {
  source_id: string;
  target_id: string;
  source_schema_id: string | null;
  target_schema_id: string | null;
  target_path: string;
  option: "candidate" | "none" | "external";
  chosen_source_path: string | null;
  note: string;
  /**
   * The format the page was comparing in when the answer was given. It decides
   * which stored schema the answer is recorded against, so a page that omits it
   * would silently record the answer against the default format's schema.
   */
  format: string | null;
}

/** Validate the body of an answer; returns a message on the first problem. */
export function answerBody(body: Record<string, unknown>): AnswerBody | string {
  const source_id = typeof body.source_id === "string" ? body.source_id.trim() : "";
  const target_id = typeof body.target_id === "string" ? body.target_id.trim() : "";
  const sourceSchemaId = typeof body.source_schema_id === "string" ? body.source_schema_id.trim() : "";
  const targetSchemaId = typeof body.target_schema_id === "string" ? body.target_schema_id.trim() : "";
  if (sourceSchemaId && !UUID.test(sourceSchemaId)) {return "source_schema_id must be a UUID.";}
  if (targetSchemaId && !UUID.test(targetSchemaId)) {return "target_schema_id must be a UUID.";}
  if (!UUID.test(source_id) || !UUID.test(target_id)) return "source_id and target_id must be UUIDs.";
  if (source_id === target_id) return "source_id and target_id must differ.";
  const target_path = typeof body.target_path === "string" ? body.target_path.trim() : "";
  if (target_path === "" || target_path.length > 500) return "target_path is required.";
  const option = typeof body.option === "string" ? body.option : "";
  if (!OPTIONS.has(option)) return "option must be candidate, none or external.";
  const chosen = typeof body.chosen_source_path === "string" ? body.chosen_source_path.trim() : "";
  if (option === "candidate" && chosen === "") return "chosen_source_path is required for option candidate.";
  if (option !== "candidate" && chosen !== "") return "chosen_source_path is only allowed with option candidate.";
  const note = typeof body.note === "string" ? body.note.slice(0, 1000) : "";
  const format = typeof body.format === "string" && body.format.trim() !== "" ? body.format.trim().slice(0, 100) : null;
  return { source_id, target_id, source_schema_id: sourceSchemaId || null, target_schema_id: targetSchemaId || null, target_path, option: option as AnswerBody["option"], chosen_source_path: option === "candidate" ? chosen : null, note, format, };
}

/**
 * Process-local quota for answers: a person answering a long drop-down list
 * answers many fields in a minute, so the catalogue's submission quota
 * (10 per hour) does not fit; 120 answers per minute per user does.
 */
export function createAnswerLimiter(windowMs = 60_000, maxRequests = 120) {
  const byUser = new Map<string, number[]>();
  return (userId: string, now = Date.now()): number => {
    const recent = (byUser.get(userId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= maxRequests) {
      byUser.set(userId, recent);
      return Math.ceil((recent[0] + windowMs - now) / 1_000);
    }
    recent.push(now);
    byUser.set(userId, recent);
    return 0;
  };
}
export const checkAnswerRateLimit = createAnswerLimiter();

export type ReportOutcome = { ok: true; report: CheckReport } | { ok: false; response: NextResponse };

/**
 * Load the pair and run the checks; translates the loader's failures into
 * responses. `format` is the canonical format the page is comparing in; an
 * unknown one is refused rather than quietly replaced by the default, because
 * the verdict depends on which schema was compared.
 */
export async function reportFor(
  config: SupabaseConfig,
  sourceId: string,
  targetId: string,
  requestId: string,
  format: string | null = null,
  applySavedAnswers = true,
  selection: PairSchemaSelection = {},
): Promise<ReportOutcome> {
  try {
    const input = await loadPairInput(config, sourceId, targetId, selection);
    // A signed-out visitor is shown the check's own conclusion about the two
    // APIs and nothing about other people's decisions: no applied answers, no
    // fields held for review, no names. Saved answers are simply not part of
    // their comparison, so a field others disagree about is, for them, an
    // ordinary undecided field they can try in a preview.
    const report = runChecks({ ...input, selectedFormat: format, choices: applySavedAnswers ? input.choices : [] });
    if (format && !report.check1.format_options.some((option) => option.selectable && option.format === format)) {
      const offered = report.check1.format_options.filter((o) => o.selectable).map((o) => o.format);
      return {
        ok: false,
        response: publicError(
          offered.length > 0
            ? `format must be one of: ${offered.join(", ")}.`
            : "Neither API declares a format that can be compared.",
          400,
          requestId,
        ),
      };
    }
    return { ok: true, report };
  } catch (error) {
    if (error instanceof PairNotFound) return { ok: false, response: publicError("API record not found.", 404, requestId, { missing: error.missing }) };
    if (error instanceof PairSchemaNotFound) {
      return { ok: false, response: publicError(`${error.side}_schema_id does not identify a valid ${error.side === "source" ? "response" : "request"} schema for the ${error.side} API.`, 400, requestId) };
    }
    return { ok: false, response: publicError("The check could not be run.", 502, requestId) };
  }
}

/**
 * Append one answer and return the report recomputed with it. The answer is
 * only accepted for a field the check actually asked about (or, for an
 * administrator, a field in conflict), and it records the content hashes of
 * the schemas compared right now.
 */
export async function recordAnswer(
  config: SupabaseConfig,
  answer: AnswerBody,
  kind: "user" | "admin",
  userId: string,
  requestId: string,
): Promise<NextResponse> {
  const selection = { sourceSchemaId: answer.source_schema_id, targetSchemaId: answer.target_schema_id };
  const before = await reportFor(config, answer.source_id, answer.target_id, requestId, answer.format, true, selection,);
  if (!before.ok) return before.response;
  const sem = before.report.check2.semantics;
  if (!sem) return publicError("This pair has no fields to answer for: it is blocked before the field-semantics check.", 409, requestId);
  const asked = sem.ambiguous.some((a) => a.target_path === answer.target_path)
    || sem.not_found.some((n) => n.target_path === answer.target_path)
    || sem.applied.some((a) => a.target_path === answer.target_path && a.state === "agreed");
  const inConflict = sem.conflicts.some((c) => c.target_path === answer.target_path);
  if (kind === "user" && !asked) {
    return publicError(inConflict ? "This field is awaiting an administrator; users can no longer answer it." : "This field is not open for an answer.", 409, requestId);
  }
  if (kind === "admin" && !inConflict && !asked) return publicError("This field is not open for an answer.", 409, requestId);
  if (answer.option === "candidate") {
    const known = sem.ambiguous.find((a) => a.target_path === answer.target_path)?.candidates.some((c) => c.source_path === answer.chosen_source_path)
      || sem.not_found.find((n) => n.target_path === answer.target_path)?.suggestions.some((c) => c.source_path === answer.chosen_source_path)
      || sem.conflicts.find((c) => c.target_path === answer.target_path)?.answers.some((a) => a.chosen_source_path === answer.chosen_source_path)
      || sem.applied.some((a) => a.target_path === answer.target_path);
    if (!known && !sourceHasPath(before.report, answer.chosen_source_path!)) return publicError("chosen_source_path is not a field of the source.", 400, requestId);
  }
  // The hashes are of the schemas this comparison actually used, so an answer
  // given in one format is not applied to another format's schema later.
  const schema = before.report.check2.schema;
  const sourceHash = schema.source_schema_used ? await hashOf(config, schema.source_schema_used.schema_id) : "";
  const targetHash = schema.target_schema_used
    ? await hashOf(config, schema.target_schema_used.schema_id)
    : await requestHashOf(config, answer.target_id);
  await insertChoice(config, {
    source_api_id: answer.source_id,
    target_api_id: answer.target_id,
    target_path: answer.target_path,
    kind,
    option: answer.option,
    chosen_source_path: answer.chosen_source_path,
    source_content_hash: sourceHash,
    target_content_hash: targetHash,
    chosen_by: userId,
    note: answer.note,
  });
  // The administrator's work list is memoised; this answer changes it either
  // way — a settlement removes a field, a user's answer can add one.
  invalidateConflictCache();

  // A settlement is final and changes the verdict of the pair, so the people
  // who answered are told the outcome. A failure here must not lose the
  // settlement itself, which is already saved.
  if (kind === "admin") {
    try {
      const recipients = (await answerersOf(config, answer.source_id, answer.target_id, answer.target_path))
        .filter((id) => id !== userId);
      await insertSettlementNotices(config, recipients.map((recipient) => ({
        recipient_user_id: recipient,
        source_api_id: answer.source_id,
        target_api_id: answer.target_id,
        target_path: answer.target_path,
        source_api_name: before.report.source.name,
        target_api_name: before.report.target.name,
        option: answer.option,
        chosen_source_path: answer.chosen_source_path,
        settled_by: userId,
      })));
    } catch {
      // Reported nowhere on purpose: the settlement stands, and the answerers
      // see it the next time they open the pair.
    }
  }

  const after = await reportFor(config, answer.source_id, answer.target_id, requestId, answer.format, true, selection,);
  if (!after.ok) return after.response;
  return NextResponse.json({ report: after.report, requestId }, { headers: { "Cache-Control": "no-store" } });
}

function sourceHasPath(report: CheckReport, path: string): boolean {
  return report.check2.types?.conversions.some((c) => c.source_path === path)
    || report.check2.semantics?.mappings.some((m) => m.source_path === path)
    || false;
}

async function hashOf(config: SupabaseConfig, schemaId: string): Promise<string> {
  const res = await fetch(`${config.url}/rest/v1/api_schema?select=content_hash&id=eq.${schemaId}`, { headers: restHeaders(config) });
  if (!res.ok) return "";
  const rows = (await res.json()) as { content_hash: string | null }[];
  return rows[0]?.content_hash ?? "";
}

async function requestHashOf(config: SupabaseConfig, apiId: string): Promise<string> {
  const res = await fetch(`${config.url}/rest/v1/api_schema?select=content_hash&api_id=eq.${apiId}&direction=eq.request`, { headers: restHeaders(config) });
  if (!res.ok) return "";
  const rows = (await res.json()) as { content_hash: string | null }[];
  return rows[0]?.content_hash ?? "";
}

function restHeaders(config: SupabaseConfig): Record<string, string> {
  const h: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) h.Authorization = `Bearer ${config.key}`;
  return h;
}

export { getSupabaseConfig };
