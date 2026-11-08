// Compare a parsed operation with the matching catalogue row. The importer is
// append-only: this module can classify an existing row, but it never produces
// an update action.

/** Fields used to tell an exact duplicate from an existing identity whose
 * document metadata differs. Identity fields (endpoint and method) are the
 * lookup key. Authentication is excluded because the parser and stored row use
 * different representations for it. */
export const MERGEABLE_FIELDS = [
  "api_name",
  "official_api_name",
  "description",
  "company_name",
  "category",
  "communication_direction",
  "input_formats",
  "output_formats",
] as const;
export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

/** The fields that participate in exact-duplicate comparison. */
export type StoredRecord = Record<MergeableField, string | string[]>;

/** A normalised row-shaped value. ApiRow has additional columns but is
 * structurally compatible with this type. */
export type MergeableRecord = StoredRecord;

export type PredictedOutcome = "insert" | "duplicate" | "existing";

function eq(a: string | string[], b: string | string[]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function field(c: MergeableRecord, f: MergeableField): string | string[] {
  return (c as Record<string, string | string[]>)[f];
}

/** Callers must pass the normalised ApiRow rather than the raw parser Candidate;
 * otherwise provider and media-type aliases create false differences. */
export function sameMergeableValues(a: MergeableRecord, b: MergeableRecord): boolean {
  return MERGEABLE_FIELDS.every((f) => eq(field(a, f), field(b, f)));
}

/** Classify one preview row against its endpoint+method match. The importer is
 *  append-only: an exact match is a `duplicate`, while a non-identical identity
 *  match is `existing`. Both are skipped at confirm time and never updated. */
export function predictOutcome(
  existing: MergeableRecord | null,
  incoming: MergeableRecord,
): PredictedOutcome {
  if (existing === null) return "insert";
  return sameMergeableValues(existing, incoming) ? "duplicate" : "existing";
}
