import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNSPECIFIED_COUNTRY_REGION,
  countryRegionForRecord,
  countryRegionOptions,
} from "../lib/country-region.ts";

test("an explicit country or region always wins", () => {
  assert.equal(countryRegionForRecord({
    country_region: "  Global  ",
    company_name: "Example Australia",
    documentation_url: "https://example.de/openapi.json",
  }), "Global");
});

test("legacy rows can use a complete country name", () => {
  assert.equal(countryRegionForRecord({ api_name: "Saudi Arabia invoice clearance" }), "Saudi Arabia");
  assert.equal(countryRegionForRecord({ company_name: "Czechia Invoice Service" }), "Czech Republic");
});

test("legacy rows can use a non-generic country-code domain", () => {
  assert.equal(countryRegionForRecord({ documentation_url: "https://api.service.gov.uk/openapi.json" }), "United Kingdom");
});

test("known providers on generic domains are handled conservatively", () => {
  assert.equal(countryRegionForRecord({ documentation_url: "https://docs.facturapi.io/api" }), "Mexico");
  assert.equal(countryRegionForRecord({ documentation_url: "https://unrelated.io/api" }), UNSPECIFIED_COUNTRY_REGION);
});

test("country and region options are unique, sorted, and put unspecified last", () => {
  assert.deepEqual(countryRegionOptions([
    { country_region: "Poland" },
    { documentation_url: "https://example.de/api" },
    { country_region: "Poland" },
    {},
  ]), ["Germany", "Poland", UNSPECIFIED_COUNTRY_REGION]);
});
