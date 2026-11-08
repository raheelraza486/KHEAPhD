// The administrator's work list: every (pair, field) the engine reports as a
// conflict (Check Manual 10.25).
//
//   GET /api/checks/conflicts
//
// Administrators only. The list is computed by running the checks over the
// pairs that have saved answers, not by reading v_check_choice_current: that
// view cannot see an answer disagreeing with the registry's current automatic
// match (migration 0033 says so itself), which is the case an administrator
// most needs. See lib/checks/conflicts.ts. The view remains the fallback when
// there are more answered pairs than one request should run.
import { NextResponse } from "next/server";
import { ADMIN_ROLES, requireRole } from "@/lib/auth";
import { listAuthoritativeConflicts } from "@/lib/checks/conflicts";
import { listConflicts } from "@/lib/checks/store";
import { getSupabaseConfig, publicError } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const gate = await requireRole(request, ADMIN_ROLES, requestId);
  if ("response" in gate) return gate.response;
  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);
  try {
    // `fresh=1`: the caller has just settled something and must not be served
    // the memo it did not invalidate.
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    const list = await listAuthoritativeConflicts(config, Date.now(), { fresh });
    if (list.complete) {
      return NextResponse.json({ ...list, requestId }, { headers: { "Cache-Control": "no-store" } });
    }
    // Too many answered pairs to check them all in one request: fall back to
    // the merge the database can do on its own, and say that it is partial.
    const rows = await listConflicts(config);
    return NextResponse.json({
      conflicts: rows.map((row) => ({
        source_api_id: row.source_api_id,
        target_api_id: row.target_api_id,
        source_api_name: "",
        target_api_name: "",
        target_path: row.target_path,
        required: false,
        answers: [],
        last_chosen_at: row.last_chosen_at,
      })),
      pairs: new Set(rows.map((row) => `${row.source_api_id}|${row.target_api_id}`)).size,
      complete: false,
      computed_at: new Date().toISOString(),
      requestId,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return publicError("Conflicts could not be read.", 502, requestId);
  }
}
