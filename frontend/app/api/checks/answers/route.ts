// A user's answer to one field the check asked about (step 2.2c).
//
//   POST /api/checks/answers
//   { source_id, target_id, target_path, option: "candidate" | "none" | "external",
//     chosen_source_path?: string, note?: string }
//
// Appends one row to check_choice (kind = user) and returns the report
// recomputed with the whole history, so the page can re-render at once.
// Any signed-in role may answer; a field already awaiting an administrator
// is refused with 409.
import { APP_ROLES, requireRole } from "@/lib/auth";
import { answerBody, checkAnswerRateLimit, getSupabaseConfig, isSameOrigin, publicError, readJson, recordAnswer } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);
  const gate = await requireRole(request, APP_ROLES, requestId);
  if ("response" in gate) return gate.response;
  const wait = checkAnswerRateLimit(gate.user.id);
  if (wait > 0) return publicError("Too many answers in a short time. Try again shortly.", 429, requestId, { retryAfterSeconds: wait });
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    return publicError("The request body must be a JSON object.", 400, requestId);
  }
  const answer = answerBody(body);
  if (typeof answer === "string") return publicError(answer, 400, requestId);
  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);
  try {
    return await recordAnswer(config, answer, "user", gate.user.id, requestId);
  } catch {
    return publicError("The answer could not be saved.", 502, requestId);
  }
}
