// An administrator settles a field in conflict (Semantic Check Manual v1.0
// §7.6: the settlement is final).
//
//   POST /api/checks/settle      same body as /api/checks/answers
//
// Appends one row with kind = admin and returns the recomputed report.
// Administrators only. The administrator's page for this is not part of the
// UI hand-over (Check Manual chapter 12, L4); the route exists so that the
// settlement can be made as soon as such a page exists.
import { ADMIN_ROLES, requireRole } from "@/lib/auth";
import { answerBody, checkAnswerRateLimit, getSupabaseConfig, isSameOrigin, publicError, readJson, recordAnswer } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);
  const gate = await requireRole(request, ADMIN_ROLES, requestId);
  if ("response" in gate) return gate.response;
  const wait = checkAnswerRateLimit(gate.user.id);
  if (wait > 0) return publicError("Too many settlements in a short time. Try again shortly.", 429, requestId, { retryAfterSeconds: wait });
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
    return await recordAnswer(config, answer, "admin", gate.user.id, requestId);
  } catch {
    return publicError("The settlement could not be saved.", 502, requestId);
  }
}
