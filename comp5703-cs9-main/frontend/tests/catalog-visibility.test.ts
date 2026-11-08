import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCatalogueRecordVisible,
  visibleCatalogueRecords,
} from "../lib/catalog-visibility.ts";
import { normalizeApiRecord } from "../lib/types.ts";

const awaitingVerification = normalizeApiRecord({ id: "pending", review_status: "Published" });
const verified = normalizeApiRecord({
  id: "verified", review_status: "Verified", verified_by: "Admin", verification_notes: "Official source checked.",
});

test("pending and verified records are both public without requiring a role", () => {
  assert.equal(isCatalogueRecordVisible(awaitingVerification), true);
  assert.equal(isCatalogueRecordVisible(verified), true);
  assert.deepEqual(visibleCatalogueRecords([awaitingVerification, verified]), [awaitingVerification, verified]);
});

test("public visibility preserves the verification status instead of marking pending APIs verified", () => {
  const [record] = visibleCatalogueRecords([awaitingVerification]);
  assert.equal(record.review_status, "Published");
  assert.equal(record.verified_by, "");
});

test("deleted and duplicate records stay out of the catalogue regardless of verification", () => {
  for (const record of [awaitingVerification, verified]) {
    const deleted = normalizeApiRecord({ ...record, is_active: false });
    const duplicate = normalizeApiRecord({ ...record, duplicate_of: "canonical-record" });
    assert.equal(isCatalogueRecordVisible(deleted), false);
    assert.equal(isCatalogueRecordVisible(duplicate), false);
    assert.deepEqual(visibleCatalogueRecords([deleted, duplicate, record]), [record]);
  }
});
