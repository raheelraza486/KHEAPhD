import assert from "node:assert/strict";
import test from "node:test";
import { auditDetailsForDisplay, publicReviewNote } from "../lib/audit-presentation.ts";

test("metadata audit JSON exposes only whitelisted field names", () => {
  const details = JSON.stringify({
    type: "admin_metadata_bulk_update",
    fields: ["network", "country_region", "network", "source_row", "note"],
    evidence: [{
      source_row: 47,
      field: "network",
      statement: "内部证据，仅供团队判断",
      url: "https://example.test/internal",
      note: "中文备注",
    }],
    source_rows: [47],
  });
  const summary = auditDetailsForDisplay({ action: "verify", details });
  assert.equal(summary, "country_region updated, network updated.");
  assert.doesNotMatch(summary, /内部|中文|evidence|statement|note|source_row|https?:/iu);
});

test("legacy free-form audit details become action-level summaries", () => {
  assert.equal(
    auditDetailsForDisplay({ action: "upload", details: "Uploaded through Excel bulk import (source row 47)." }),
    "API submitted.",
  );
  assert.equal(
    auditDetailsForDisplay({ action: "verify", details: "管理员内部备注：不要公开" }),
    "API verification completed.",
  );
  assert.equal(
    auditDetailsForDisplay({ action: "edit", details: "{not valid JSON containing 内部数据" }),
    "API details updated.",
  );
});

test("review notes hide internal JSON and CJK remarks without translating them", () => {
  assert.equal(publicReviewNote("Checked against the official provider documentation."), "Checked against the official provider documentation.");
  assert.equal(publicReviewNote("中文内部备注"), null);
  assert.equal(publicReviewNote('{"note":"internal"}'), null);
  assert.equal(publicReviewNote("statement: internal research"), null);
});

