import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultCatalogueSort,
  nextAwaitingVerification,
  sortCatalogueRecords,
} from "../lib/catalog-review-queue.ts";

const records = [
  { id: "verified-a", api_name: "Alpha", company_name: "C", updated_at: "2026-09-09", review_status: "Verified" as const },
  { id: "pending-c", api_name: "Charlie", company_name: "B", updated_at: "2026-09-08", review_status: "Published" as const },
  { id: "pending-b", api_name: "Bravo", company_name: "A", updated_at: "2026-09-07", review_status: "Published" as const },
  { id: "verified-d", api_name: "Delta", company_name: "A", updated_at: "2026-09-06", review_status: "Verified" as const },
];

test("admin defaults put pending records first, ordered by API name", () => {
  const sorted = sortCatalogueRecords(records, defaultCatalogueSort("admin"));
  assert.deepEqual(sorted.map((record) => record.id), ["pending-b", "pending-c", "verified-a", "verified-d"]);
  assert.equal(records[0].id, "verified-a", "sorting must not mutate the source records");
});

test("non-admin defaults retain alphabetical ordering", () => {
  for (const role of [null, "publisher", "viewer"] as const) {
    assert.equal(defaultCatalogueSort(role), "name");
    assert.deepEqual(sortCatalogueRecords(records, defaultCatalogueSort(role)).map((record) => record.api_name), [
      "Alpha", "Bravo", "Charlie", "Delta",
    ]);
  }
});

test("explicit company, recency and verified-first sorts remain available", () => {
  assert.deepEqual(sortCatalogueRecords(records, "company").map((record) => record.api_name), ["Bravo", "Delta", "Charlie", "Alpha"]);
  assert.deepEqual(sortCatalogueRecords(records, "updated").map((record) => record.api_name), ["Alpha", "Charlie", "Bravo", "Delta"]);
  assert.deepEqual(sortCatalogueRecords(records, "verified").map((record) => record.api_name), ["Alpha", "Delta", "Bravo", "Charlie"]);
});

test("finishing a review selects the next pending record in displayed order", () => {
  const queue = sortCatalogueRecords(records, "awaiting");
  assert.equal(nextAwaitingVerification(queue, "pending-b")?.id, "pending-c");
  assert.equal(nextAwaitingVerification(queue, "pending-c")?.id, "pending-b", "wrap around to earlier pending work");
});

test("advancing skips verified records and respects the supplied filters", () => {
  const visible = [records[1], records[0], records[2]];
  assert.equal(nextAwaitingVerification(visible, "pending-c")?.id, "pending-b");
  const companyB = records.filter((record) => record.company_name === "B");
  assert.equal(nextAwaitingVerification(companyB, "pending-c"), undefined);
});

test("a completed or empty queue has no next pending record", () => {
  assert.equal(nextAwaitingVerification([], "missing"), undefined);
  assert.equal(nextAwaitingVerification(records.filter((record) => record.review_status === "Verified"), "verified-a"), undefined);
  assert.equal(nextAwaitingVerification([records[1]], "pending-c"), undefined);
});

test("a saved record removed by the pending filter still advances to pending work", () => {
  const remaining = [records[1]];
  assert.equal(nextAwaitingVerification(remaining, "pending-b")?.id, "pending-c");
});
