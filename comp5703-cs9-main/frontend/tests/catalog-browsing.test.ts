import assert from "node:assert/strict";
import { test } from "node:test";
import { cataloguePage } from "../lib/catalog-pagination.ts";
import { countryRegionEvidence } from "../lib/country-region.ts";
import { coverageFilterValues } from "../lib/coverage.ts";

test("every record remains reachable across pages without duplicates", () => {
  const records = Array.from({ length: 218 }, (_, i) => `api-${i}`);
  const first = cataloguePage(records, 1);
  const all = Array.from({ length: first.pages }, (_, i) => cataloguePage(records, i + 1).items).flat();
  assert.deepEqual(all, records);
  assert.equal(first.items.length, 12);
  assert.equal(cataloguePage(records, first.pages).to, 218);
});

test("a shrinking or empty result set cannot strand the reader on a blank page", () => {
  assert.deepEqual(cataloguePage(["matching API"], 12), { page: 1, pages: 1, items: ["matching API"], from: 1, to: 1 });
  assert.deepEqual(cataloguePage([], 12), { page: 1, pages: 1, items: [], from: 0, to: 0 });
  assert.equal(cataloguePage([1, 2], -1).page, 1);
});

test("provider location inference is not presented as recorded API coverage", () => {
  const region = countryRegionEvidence({ api_name: "Argentina ARCA invoice service" });
  assert.equal(region.label, "Argentina");
  assert.equal(region.source, "inferred");
  assert.match(region.note, /not been confirmed/);
  assert.equal(countryRegionEvidence({ country_region: "Global", documentation_url: "https://provider.com.au/docs" }).source, "recorded");
  assert.equal(countryRegionEvidence({ documentation_url: "https://unknown.io/docs" }).source, "unknown");
});

test("unspecified location remains one filter, not two fictitious countries", () => {
  assert.deepEqual(coverageFilterValues("Other / unspecified"), ["Other / unspecified"]);
  assert.ok(coverageFilterValues("New Zealand / Global").includes("New Zealand"));
  assert.ok(coverageFilterValues("New Zealand / Global").includes("Global"));
});
