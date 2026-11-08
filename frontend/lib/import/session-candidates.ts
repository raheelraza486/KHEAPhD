// Helpers for the server-owned candidate data kept between Preview and Confirm.

import type { StoredSchema } from "../schema/rows.ts";
import type { PredictedOutcome } from "./merge.ts";
import type { Candidate, ImportScopeExclusion } from "./types.ts";

export type StoredCandidateItem = {
  candidate: Candidate;
  row: Record<string, unknown>;
  predicted_outcome?: PredictedOutcome;
  /**
   * The operation's request and success-response schemas, extracted at preview from
   * the document the server fetched. Stored here for the same reason the
   * candidates are: the confirm phase must write what the document said, not
   * what a browser sends back. Optional so previews created before schema
   * extraction was deployed remain confirmable -- they write no schemas.
   */
  schemas?: StoredSchema[];
};

export type StoredCandidates = {
  items?: StoredCandidateItem[];
  excluded_operations?: ImportScopeExclusion[];
  selected_indices?: number[];
  applied_indices?: number[];
  [key: string]: unknown;
};

export function operationKey(value: { api_endpoint: string; http_method: string }): string {
  // JSON array encoding is collision-safe and can also be persisted in jsonb.
  // PostgreSQL text/jsonb cannot store a NUL separator.
  return JSON.stringify([value.api_endpoint, value.http_method]);
}

export function parseStoredCandidates(value: unknown): StoredCandidates {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as StoredCandidates
      : {};
  } catch {
    return {};
  }
}
