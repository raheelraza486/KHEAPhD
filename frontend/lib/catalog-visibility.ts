export type CatalogueVisibilityRecord = {
  is_active: boolean;
  duplicate_of?: string | null;
};

/**
 * Active, non-duplicate records are public regardless of verification status.
 * Verification records a manual source check; it does not control visibility.
 */
export function isCatalogueRecordVisible(
  record: CatalogueVisibilityRecord,
): boolean {
  return record.is_active && record.duplicate_of == null;
}

export function visibleCatalogueRecords<T extends CatalogueVisibilityRecord>(
  records: readonly T[],
): T[] {
  return records.filter(isCatalogueRecordVisible);
}
