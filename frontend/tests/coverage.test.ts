import assert from "node:assert/strict";
import test from "node:test";
import {
  coverageFilterValues,
  summarizeCoverage,
  type CoverageSource,
} from "../lib/coverage.ts";

function record(overrides: Partial<CoverageSource> = {}): CoverageSource {
  return {
    api_name: "Create invoice",
    company_name: "Example provider",
    documentation_url: "https://docs.example.com/openapi.json",
    is_active: true,
    ...overrides,
  };
}

test("coverage groups operations and counts distinct OpenAPI documents", () => {
  const summary = summarizeCoverage([
    record({ country_region: "France", api_name: "Create" }),
    record({ country_region: "France", api_name: "Validate" }),
    record({ country_region: "France", api_name: "Send", documentation_url: "https://other.example/openapi.yaml" }),
  ]);

  assert.equal(summary.totalOperations, 3);
  assert.equal(summary.totalSources, 2);
  assert.deepEqual(
    summary.points.map(({ name, operations, sources }) => ({ name, operations, sources })),
    [{ name: "France", operations: 3, sources: 2 }],
  );
});

test("explicit locations win over URL inference and inactive records are excluded", () => {
  const summary = summarizeCoverage([
    record({ country_region: "Germany", documentation_url: "https://example.com.au/openapi.json" }),
    record({ country_region: "France", is_active: false, documentation_url: "https://example.fr/openapi.json" }),
  ]);

  assert.equal(summary.totalOperations, 1);
  assert.equal(summary.points[0]?.name, "Germany");
});

test("coverage reuses conservative country inference for legacy records", () => {
  const summary = summarizeCoverage([
    record({ country_region: "", documentation_url: "https://service.gov.au/openapi.json" }),
  ]);

  assert.equal(summary.points[0]?.name, "Australia");
});

test("global, mapped region, unmapped and unspecified values remain distinct", () => {
  const summary = summarizeCoverage([
    record({ country_region: "New Zealand / global", api_name: "One" }),
    record({ country_region: "European Union", api_name: "Two", documentation_url: "https://eu.example/openapi.json" }),
    record({ country_region: "Atlantis", api_name: "Three", documentation_url: "https://atlantis.example/openapi.json" }),
    record({ country_region: "", api_name: "Four", company_name: "Unknown", documentation_url: "https://example.com/openapi.json" }),
  ]);

  assert.equal(summary.globalOperations, 1);
  assert.equal(summary.representedLocations, 3);
  assert.equal(summary.unspecifiedOperations, 1);
  assert.ok(summary.points.some((point) => point.name === "New Zealand"));
  assert.ok(summary.points.some((point) => point.name === "European Union"));
  assert.deepEqual(summary.otherRegions, [{ name: "Atlantis", operations: 1, sources: 1 }]);
});

test("map labels remain valid catalogue filters for aliases and composite regions", () => {
  assert.ok(coverageFilterValues("New Zealand / global").includes("New Zealand"));
  assert.ok(coverageFilterValues("New Zealand / global").includes("Global"));
  assert.ok(coverageFilterValues("Czechia").includes("Czech Republic"));
});
