/** Confirm accepts a non-empty set of unique indexes into the server-owned
 * preview. Reject malformed input before any catalogue read or write. */
export function normaliseSelectedIndices(value: unknown, itemCount: number): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || !Number.isInteger(itemCount) || itemCount < 0) {
    return null;
  }
  const selected: number[] = [];
  const seen = new Set<number>();
  for (const index of value) {
    if (!Number.isInteger(index) || index < 0 || index >= itemCount || seen.has(index)) return null;
    seen.add(index);
    selected.push(index);
  }
  return selected;
}

export type AppendOnlyDecision =
  | { action: "insert" }
  | { action: "skip"; reason: "existing_identity" }
  | { action: "conflict"; reason: "name_taken" };

/** Identity wins over every client claim: once an operation exists, confirm
 * can only skip it. This keeps a forged/stale selected index from turning an
 * append-only import into an update. */
export function decideAppendOnly(
  hasIdentityMatch: boolean,
  nameTaken: boolean,
): AppendOnlyDecision {
  if (hasIdentityMatch) return { action: "skip", reason: "existing_identity" };
  return nameTaken
    ? { action: "conflict", reason: "name_taken" }
    : { action: "insert" };
}
