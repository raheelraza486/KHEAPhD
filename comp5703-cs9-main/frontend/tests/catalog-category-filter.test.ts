import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_CATEGORIES,
  ALL_COMMUNICATION_DIRECTIONS,
  catalogueCategoryLabel,
  matchesCatalogueCategory,
  normalizeCatalogueCategory,
  normalizeCatalogueDirection,
} from "../lib/catalog-category-filter.ts";

const communication = (direction: "Send" | "Receive" | "Send and receive" | "Unspecified") => ({
  category: "Communication" as const,
  communication_direction: direction,
});

test("Communication parent includes every stored communication direction", () => {
  for (const direction of ["Send", "Receive", "Send and receive", "Unspecified"] as const) {
    assert.equal(
      matchesCatalogueCategory(communication(direction), "Communication", ALL_COMMUNICATION_DIRECTIONS),
      true,
    );
  }
});

test("Communication subcategories filter Send and Receive precisely", () => {
  assert.equal(matchesCatalogueCategory(communication("Send"), "Communication", "Send"), true);
  assert.equal(matchesCatalogueCategory(communication("Receive"), "Communication", "Send"), false);
  assert.equal(matchesCatalogueCategory(communication("Receive"), "Communication", "Receive"), true);
  assert.equal(matchesCatalogueCategory(communication("Send and receive"), "Communication", "Send"), true);
  assert.equal(matchesCatalogueCategory(communication("Send and receive"), "Communication", "Receive"), true);
});

test("top-level category selection does not depend on a communication direction", () => {
  assert.equal(matchesCatalogueCategory({
    category: "Validation",
    communication_direction: "",
  }, "Validation", ALL_COMMUNICATION_DIRECTIONS), true);
  assert.equal(matchesCatalogueCategory({
    category: "Transformation",
    communication_direction: "",
  }, "Validation", ALL_COMMUNICATION_DIRECTIONS), false);
  assert.equal(matchesCatalogueCategory(communication("Send"), ALL_CATEGORIES, ALL_COMMUNICATION_DIRECTIONS), true);
});

test("filter labels combine Communication with a selected subcategory", () => {
  assert.equal(catalogueCategoryLabel("Communication", "Send"), "Communication · Send");
  assert.equal(
    catalogueCategoryLabel("Communication", ALL_COMMUNICATION_DIRECTIONS),
    "Communication",
  );
  assert.equal(catalogueCategoryLabel("Validation", ALL_COMMUNICATION_DIRECTIONS), "Validation");
});

test("invalid URL filter values fall back to the complete catalogue", () => {
  assert.equal(normalizeCatalogueCategory("Unknown"), ALL_CATEGORIES);
  assert.equal(normalizeCatalogueCategory("Communication"), "Communication");
  assert.equal(normalizeCatalogueDirection("Validation", "Send"), ALL_COMMUNICATION_DIRECTIONS);
  assert.equal(normalizeCatalogueDirection("Communication", "Send and receive"), ALL_COMMUNICATION_DIRECTIONS);
  assert.equal(normalizeCatalogueDirection("Communication", "Receive"), "Receive");
});
