import type { AppRole } from "./auth-policy";

export type ApiNotification = {
  id: string;
  api_id: string | null;
  api_name: string;
  kind: "api_verified" | "new_submission" | "api_updated" | "changes_requested" | "conflict_settled";
  created_at: string;
  read_at: string | null;
  /**
   * Set only on `conflict_settled` (migration 0035): a settlement is about an
   * ordered pair and one field of it, which `api_id` alone cannot name. The
   * inbox shows both kinds in one list, so the reader never sees that they
   * come from two tables.
   */
  pair?: {
    source_api_id: string;
    target_api_id: string;
    source_api_name: string;
    target_api_name: string;
    target_path: string;
    option: "candidate" | "none" | "external";
    chosen_source_path: string | null;
  };
};

/** How the settled answer reads in one phrase. */
export function settledAnswerLabel(pair: NonNullable<ApiNotification["pair"]>): string {
  if (pair.option === "candidate") return pair.chosen_source_path ?? "a source field";
  return pair.option === "external" ? "provided externally" : "no source field";
}

export function notificationDestination(
  notification: Pick<ApiNotification, "api_id" | "kind" | "pair">,
  role?: AppRole,
): string {
  // A settlement belongs to a pair, so it opens the compatibility page on it.
  if (notification.kind === "conflict_settled" && notification.pair) {
    return `/compatibility?source=${notification.pair.source_api_id}&target=${notification.pair.target_api_id}`;
  }
  const params = new URLSearchParams();
  const personal = notification.kind !== "new_submission" && notification.kind !== "api_updated" && role !== "admin";
  if (personal) params.set("view", "submissions");
  if (notification.api_id) params.set("api", notification.api_id);
  return personal ? `/profile?${params}` : params.size ? `/apis?${params}` : "/apis";
}

export function notificationTitle(notification: Pick<ApiNotification, "api_name" | "kind" | "pair">): string {
  if (notification.kind === "conflict_settled") {
    const pair = notification.pair;
    return pair
      ? `Settled by an administrator: ${pair.target_path} now uses ${settledAnswerLabel(pair)} (${pair.source_api_name} → ${pair.target_api_name})`
      : "A field you answered has been settled by an administrator";
  }
  if (notification.kind === "new_submission") return `New submission: ${notification.api_name}`;
  if (notification.kind === "api_updated") return `API updated: ${notification.api_name}`;
  if (notification.kind === "changes_requested") return `Changes requested: ${notification.api_name}`;
  return `${notification.api_name} has been verified`;
}
