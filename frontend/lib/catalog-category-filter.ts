import {
  API_CATEGORIES,
  type ApiCategory,
  type ApiCommunicationDirection,
} from "./types.ts";

export const ALL_CATEGORIES = "All categories" as const;
export const ALL_COMMUNICATION_DIRECTIONS = "All directions" as const;
export const CATALOG_COMMUNICATION_SUBCATEGORIES = ["Send", "Receive"] as const;

export type CatalogueCategory = ApiCategory | typeof ALL_CATEGORIES;
export type CatalogueCommunicationDirection =
  | (typeof CATALOG_COMMUNICATION_SUBCATEGORIES)[number]
  | typeof ALL_COMMUNICATION_DIRECTIONS;

type CategorySource = {
  category: ApiCategory;
  communication_direction: ApiCommunicationDirection;
};

export function normalizeCatalogueCategory(value: unknown): CatalogueCategory {
  return API_CATEGORIES.includes(value as ApiCategory)
    ? value as ApiCategory
    : ALL_CATEGORIES;
}

export function normalizeCatalogueDirection(
  category: CatalogueCategory,
  value: unknown,
): CatalogueCommunicationDirection {
  if (category !== "Communication") return ALL_COMMUNICATION_DIRECTIONS;
  return CATALOG_COMMUNICATION_SUBCATEGORIES.includes(
    value as (typeof CATALOG_COMMUNICATION_SUBCATEGORIES)[number],
  )
    ? value as CatalogueCommunicationDirection
    : ALL_COMMUNICATION_DIRECTIONS;
}

export function catalogueCategoryLabel(
  category: CatalogueCategory,
  direction: CatalogueCommunicationDirection,
) {
  return category === "Communication" && direction !== ALL_COMMUNICATION_DIRECTIONS
    ? `Communication · ${direction}`
    : category;
}

export function matchesCatalogueCategory(
  record: CategorySource,
  category: CatalogueCategory,
  direction: CatalogueCommunicationDirection,
) {
  if (category === ALL_CATEGORIES) return true;
  if (record.category !== category) return false;
  if (category !== "Communication" || direction === ALL_COMMUNICATION_DIRECTIONS) return true;
  return record.communication_direction === direction
    || record.communication_direction === "Send and receive";
}
