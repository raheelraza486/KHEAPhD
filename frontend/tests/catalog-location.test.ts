import assert from "node:assert/strict";
import test from "node:test";
import { catalogueLocationUrl, readCatalogueLocation } from "../lib/catalog-location.ts";
import { verificationProgressMessage } from "../lib/catalog-review-queue.ts";

test("every result-affecting condition and the selected API round-trip through a shareable URL", () => {
  const state = {
    query: "invoice & 日本", category: "Communication" as const, communicationDirection: "Send" as const,
    countryRegion: "Australia", inputFormat: "XML", outputFormat: "JSON", company: "A&B",
    status: "Published", scope: "mine" as const, sort: "company" as const, page: 3, api: "api/1",
  };
  const url = catalogueLocationUrl("/apis?campaign=shared", state, "publisher");
  assert.deepEqual(readCatalogueLocation(new URL(url, "https://example.test").searchParams, "publisher"), state);
  assert.equal(new URL(url, "https://example.test").searchParams.get("campaign"), "shared");
});

test("detail navigation and return to results preserve the entire filtered list context", () => {
  const original = "/apis?q=invoice&category=Validation&status=Published&sort=updated&page=2&input=XML&company=Acme";
  const first = catalogueLocationUrl(original, { api: "one" }, "admin");
  const second = catalogueLocationUrl(first, { api: "two" }, "admin");
  const back = catalogueLocationUrl(second, { api: "" }, "admin");
  const parse = (url: string) => readCatalogueLocation(new URL(url, "https://example.test").searchParams, "admin");
  assert.deepEqual(parse(back), parse(original));
  assert.deepEqual(parse(second), { ...parse(original), api: "two" });
});

test("shared sort survives role changes and malformed enum/page parameters have safe defaults", () => {
  const url = catalogueLocationUrl("/apis", {}, "admin");
  assert.equal(readCatalogueLocation(new URL(url, "https://example.test").searchParams, null).sort, "awaiting");
  const state = readCatalogueLocation(new URLSearchParams("category=no&direction=Send&status=no&sort=no&page=-3&scope=mine"), "admin");
  assert.equal(state.category, "All categories");
  assert.equal(state.communicationDirection, "All directions");
  assert.equal(state.status, "All records");
  assert.equal(state.sort, "awaiting");
  assert.equal(state.page, 1);
  assert.equal(state.scope, "all", "admins retain the existing all-submissions rule");
});

test("verification progress handles plural, singular, completed, and unavailable server counts", () => {
  assert.equal(verificationProgressMessage(25), " 25 APIs remaining for verification.");
  assert.equal(verificationProgressMessage(1), " 1 API remaining for verification.");
  assert.equal(verificationProgressMessage(0), " All APIs have been verified.");
  for (const value of [null, undefined, -1, NaN]) {
    assert.match(verificationProgressMessage(value), /could not be refreshed/);
    assert.doesNotMatch(verificationProgressMessage(value), /All APIs have been verified/);
  }
});
