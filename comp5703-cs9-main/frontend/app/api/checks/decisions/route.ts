// The field decisions the signed-in person has submitted, across every API
// pair they have answered for.
//
//   GET /api/checks/decisions
//
// Answering is per pair and per field (migration 0033), and until now a person
// could only see an answer by finding the pair again. This lists their own
// answers with the state each one merged into, so they can see what is in
// force, what is waiting for an administrator and what has been settled.
//
// It returns only rows the caller wrote: `chosen_by` is compared with the
// authenticated id, never with anything the request carries. The state is read
// from the engine's report for each pair, which is what the compatibility page
// shows, so the two can never disagree.
import { NextResponse } from "next/server";
import { APP_ROLES, requireRole } from "@/lib/auth";
import { loadPairInputs, type PairKey } from "@/lib/checks/store";
import { runChecks } from "@/lib/checks/run";
import { getSupabaseConfig, publicError } from "../shared";

export const dynamic = "force-dynamic";

/** Beyond this many pairs the states are not computed; the answers are still listed. */
const MAX_PAIRS = 200;

type Row = {
  source_api_id: string;
  target_api_id: string;
  target_path: string;
  option: "candidate" | "none" | "external";
  chosen_source_path: string | null;
  chosen_at: string | null;
};

type Decision = Row & {
  source_api_name: string;
  target_api_name: string;
  /**
   * applied  — in force for this pair
   * awaiting_review — held because the answers disagree; an administrator decides
   * settled  — an administrator has answered; final
   * superseded — the answer is no longer applied (a newer one, or a schema or
   *              format change, took its place)
   */
  state: "applied" | "awaiting_review" | "settled" | "superseded";
  applied_answer: { option: string; chosen_source_path: string | null } | null;
};

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  const gate = await requireRole(request, APP_ROLES, requestId);
  if ("response" in gate) return gate.response;
  const config = getSupabaseConfig();
  if (!config) return publicError("The database is not configured.", 503, requestId);

  try {
    const mine = await ownAnswers(config, gate.user.id);
    const pairs: PairKey[] = [];
    const seen = new Set<string>();
    for (const row of mine) {
      const key = `${row.source_api_id}|${row.target_api_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ source_api_id: row.source_api_id, target_api_id: row.target_api_id });
    }
    const complete = pairs.length <= MAX_PAIRS;
    const inputs = await loadPairInputs(config, complete ? pairs : pairs.slice(0, MAX_PAIRS));

    const decisions: Decision[] = [];
    for (const row of mine) {
      const input = inputs.get(`${row.source_api_id}|${row.target_api_id}`);
      // A pair whose records were deactivated since the answer was given.
      if (!input) continue;
      const report = runChecks(input);
      const semantics = report.check2.semantics;
      const conflict = semantics?.conflicts.find((item) => item.target_path === row.target_path);
      const applied = semantics?.applied.find((item) => item.target_path === row.target_path);
      const state: Decision["state"] = conflict
        ? "awaiting_review"
        : applied?.state === "resolved"
          ? "settled"
          : applied
            ? "applied"
            : "superseded";
      decisions.push({
        ...row,
        source_api_name: input.source.api.api_name,
        target_api_name: input.target.api.api_name,
        state,
        applied_answer: applied ? { option: applied.option, chosen_source_path: applied.chosen_source_path } : null,
      });
    }

    decisions.sort((a, b) => (b.chosen_at ?? "").localeCompare(a.chosen_at ?? ""));
    return NextResponse.json({ decisions, complete, requestId }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return publicError("Your decisions could not be read.", 502, requestId);
  }
}

/** The caller's own answers, newest first. `kind = user`: a settlement is an administrator's act. */
async function ownAnswers(config: { url: string; key: string; opaqueSecret: boolean }, userId: string): Promise<Row[]> {
  const query = new URLSearchParams({
    select: "source_api_id,target_api_id,target_path,option,chosen_source_path,chosen_at",
    chosen_by: `eq.${userId}`,
    kind: "eq.user",
    order: "chosen_at.desc",
    limit: "500",
  });
  const headers: Record<string, string> = { apikey: config.key, Accept: "application/json" };
  if (!config.opaqueSecret) headers.Authorization = `Bearer ${config.key}`;
  const response = await fetch(`${config.url}/rest/v1/check_choice?${query}`, { headers });
  if (!response.ok) throw new Error(`check_choice read failed ${response.status}`);
  const rows = (await response.json()) as Row[];
  // One row per (pair, field): the newest answer is the person's current one.
  const newest = new Map<string, Row>();
  for (const row of rows) {
    const key = `${row.source_api_id}|${row.target_api_id}|${row.target_path}`;
    if (!newest.has(key)) newest.set(key, row);
  }
  return [...newest.values()];
}
