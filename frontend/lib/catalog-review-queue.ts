import type { AppRole } from "./auth-policy";
import type { ApiRecord } from "./types";

export type CatalogueSort = "name" | "company" | "updated" | "verified" | "awaiting";
type SortableRecord = Pick<ApiRecord, "api_name" | "company_name" | "updated_at" | "review_status">;
type ReviewRecord = Pick<ApiRecord, "id" | "review_status">;

export function verificationProgressMessage(count: number | null | undefined): string {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return " The remaining verification count could not be refreshed. Please refresh status.";
  if (count === 0) return " All APIs have been verified.";
  return ` ${count} ${count === 1 ? "API" : "APIs"} remaining for verification.`;
}

export function defaultCatalogueSort(role: AppRole | null): CatalogueSort {
  return role === "admin" ? "awaiting" : "name";
}

export function sortCatalogueRecords<T extends SortableRecord>(records: readonly T[], sort: CatalogueSort): T[] {
  return [...records].sort((a, b) => {
    if (sort === "company") return a.company_name.localeCompare(b.company_name) || a.api_name.localeCompare(b.api_name);
    if (sort === "updated") return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
    if (sort === "awaiting" || sort === "verified") {
      const firstStatus = sort === "awaiting" ? "Published" : "Verified";
      return Number(b.review_status === firstStatus) - Number(a.review_status === firstStatus)
        || a.api_name.localeCompare(b.api_name);
    }
    return a.api_name.localeCompare(b.api_name);
  });
}

/** Advance within the displayed filters and order, wrapping to earlier pending records. */
export function nextAwaitingVerification<T extends ReviewRecord>(records: readonly T[], currentId: string): T | undefined {
  const isPending = (record: T) => record.id !== currentId && record.review_status === "Published";
  const currentIndex = records.findIndex((record) => record.id === currentId);
  return records.slice(currentIndex + 1).find(isPending) ?? records.find(isPending);
}
