/**
 * The administrator's work list: every (pair, field) the engine currently
 * reports as a conflict (Check Manual 10.25, Semantic Manual 7.6).
 *
 * Why this is not a read of `v_check_choice_current`. That view merges the
 * rows of `check_choice` alone, so it sees users disagreeing with each other
 * and nothing else. The second kind of conflict — a saved answer that
 * disagrees with the automatic match the registry now produces — cannot be
 * seen from the table: it depends on the schemas and the registry as they are
 * today, which is what the engine computes. Migration 0033 says as much in its
 * own comment: a field the view shows as `agreed` can still be a conflict, and
 * the check's report is what counts. Reading only the view would therefore
 * hide exactly the case an administrator most needs — a registration that
 * turned out to be wrong.
 *
 * Why running the engine is affordable. A conflict needs at least one saved
 * answer, and every saved answer is a row of `check_choice`; a pair nobody has
 * answered for has nothing to disagree with. So the candidates are the
 * distinct pairs in that table, not the whole catalogue. Those pairs are read
 * in one batch — a handful of queries for all of them together, not five per
 * pair — and the checks then run in memory.
 */
import { runChecks } from "./run.ts";
import { displayNamesOf, listAnsweredPairs, loadPairInputs, type PairKey, type SupabaseConfig } from "./store.ts";
import type { ConflictField } from "./types.ts";

/** Beyond this many answered pairs the list falls back to the view. */
export const MAX_AUTHORITATIVE_PAIRS = 500;
const CACHE_MS = 30_000;

export interface ConflictListItem extends PairKey {
  source_api_name: string;
  target_api_name: string;
  target_path: string;
  required: boolean;
  answers: Array<ConflictField["answers"][number] & { chosen_by_name: string | null }>;
  /**
   * Everything the check would have offered for this field had nobody answered
   * yet. A field in conflict is taken out of the waiting list, so without this
   * an administrator could only pick between the answers already given — not
   * the right source field if it happens to be a third one.
   */
  candidates: string[];
  last_chosen_at: string | null;
}

export interface ConflictList {
  conflicts: ConflictListItem[];
  /** Pairs with at least one field awaiting an administrator. */
  pairs: number;
  /**
   * False when there were more answered pairs than the engine will run in one
   * request; the page says the list may be incomplete rather than implying it
   * is the whole picture.
   */
  complete: boolean;
  computed_at: string;
}

let cache: { at: number; value: ConflictList } | null = null;

/** Drops the memo. Only reaches the copy of this module the caller was bundled with. */
export function invalidateConflictCache(): void {
  cache = null;
}

/**
 * `fresh` skips the memo. The caller that has just changed the answers asks
 * for it, because dropping the memo from another route cannot be relied on:
 * route handlers are bundled separately, so each may hold its own copy of this
 * module — and with it its own cache. The memo still spares the repeated polls
 * of the corner notice.
 */
export async function listAuthoritativeConflicts(
  config: SupabaseConfig,
  now = Date.now(),
  options: { fresh?: boolean } = {},
): Promise<ConflictList> {
  if (!options.fresh && cache && now - cache.at < CACHE_MS) return cache.value;
  const value = await compute(config);
  cache = { at: now, value };
  return value;
}

async function compute(config: SupabaseConfig): Promise<ConflictList> {
  const answered = await listAnsweredPairs(config);
  const complete = answered.length <= MAX_AUTHORITATIVE_PAIRS;
  const pairs = complete ? answered : answered.slice(0, MAX_AUTHORITATIVE_PAIRS);
  const inputs = await loadPairInputs(config, pairs);

  const conflicts: ConflictListItem[] = [];
  const pairsInConflict = new Set<string>();
  const answeredBy = new Set<string>();
  for (const pair of pairs) {
    const input = inputs.get(`${pair.source_api_id}|${pair.target_api_id}`);
    // A pair whose records were deactivated or removed since the answer was
    // given simply has nothing to adjudicate any more.
    if (!input) continue;
    const report = runChecks(input);
    if (report.overall.overall !== "pending_admin") continue;
    pairsInConflict.add(`${pair.source_api_id}|${pair.target_api_id}`);
    // The same pair as the check sees it with no answers saved: a field held
    // for an administrator is no longer in the waiting list, and this is where
    // its original candidates still are.
    const untouched = runChecks({ ...input, choices: [] }).check2.semantics;
    for (const field of report.check2.semantics?.conflicts ?? []) {
      const offered = untouched?.ambiguous.find((item) => item.target_path === field.target_path)?.candidates
        ?? untouched?.not_found.find((item) => item.target_path === field.target_path)?.suggestions
        ?? [];
      const chosen = field.answers.map((a) => a.chosen_source_path).filter((path): path is string => Boolean(path));
      for (const answer of field.answers) if (answer.chosen_by) answeredBy.add(answer.chosen_by);
      conflicts.push({
        source_api_id: pair.source_api_id,
        target_api_id: pair.target_api_id,
        source_api_name: input.source.api.api_name,
        target_api_name: input.target.api.api_name,
        target_path: field.target_path,
        required: field.required,
        answers: field.answers.map((answer) => ({ ...answer, chosen_by_name: null })),
        candidates: [...new Set([...offered.map((c) => c.source_path), ...chosen])].sort((a, b) => a.localeCompare(b)),
        last_chosen_at: field.answers.map((a) => a.chosen_at ?? "").sort().at(-1) || null,
      });
    }
  }

  // Name the people who answered: an administrator is deciding between them.
  const names = await displayNamesOf(config, [...answeredBy]);
  for (const item of conflicts) {
    item.answers = item.answers.map((answer) => ({
      ...answer,
      chosen_by_name: answer.chosen_by ? names.get(answer.chosen_by) ?? null : null,
    }));
  }

  // Newest first: an administrator works through what just happened.
  conflicts.sort((a, b) => (b.last_chosen_at ?? "").localeCompare(a.last_chosen_at ?? "")
    || a.target_api_name.localeCompare(b.target_api_name)
    || a.target_path.localeCompare(b.target_path));

  return { conflicts, pairs: pairsInConflict.size, complete, computed_at: new Date().toISOString() };
}
