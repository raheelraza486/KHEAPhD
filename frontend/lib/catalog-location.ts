import type { AppRole } from "./auth-policy";
import { ALL_CATEGORIES, ALL_COMMUNICATION_DIRECTIONS, normalizeCatalogueCategory, normalizeCatalogueDirection, type CatalogueCategory, type CatalogueCommunicationDirection } from "./catalog-category-filter.ts";
import { ALL_COUNTRY_REGIONS } from "./country-region.ts";
import { defaultCatalogueSort, type CatalogueSort } from "./catalog-review-queue.ts";

export type CatalogueLocation = {
  query: string;
  category: CatalogueCategory;
  communicationDirection: CatalogueCommunicationDirection;
  countryRegion: string;
  inputFormat: string;
  outputFormat: string;
  company: string;
  status: string;
  scope: "all" | "mine";
  sort: CatalogueSort;
  page: number;
  api: string;
};

const keys: Record<keyof CatalogueLocation, string> = {
  query: "q", category: "category", communicationDirection: "direction", countryRegion: "country",
  inputFormat: "input", outputFormat: "output", company: "company", status: "status",
  scope: "scope", sort: "sort", page: "page", api: "api",
};

export function readCatalogueLocation(params: Pick<URLSearchParams, "get">, role: AppRole | null): CatalogueLocation {
  const category = normalizeCatalogueCategory(params.get("category") ?? undefined);
  const sort = params.get("sort");
  const page = Number(params.get("page") ?? 1);
  return {
    query: params.get("q") ?? "",
    category,
    communicationDirection: normalizeCatalogueDirection(category, params.get("direction") ?? undefined),
    countryRegion: params.get("country") || ALL_COUNTRY_REGIONS,
    inputFormat: params.get("input") ?? "",
    outputFormat: params.get("output") ?? "",
    company: params.get("company") || "All companies",
    status: ["Published", "Verified"].includes(params.get("status") ?? "") ? params.get("status")! : "All records",
    scope: role !== "admin" && params.get("scope") === "mine" ? "mine" : "all",
    sort: ["name", "company", "updated", "verified", "awaiting"].includes(sort ?? "") ? sort as CatalogueSort : defaultCatalogueSort(role),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    api: params.get("api") ?? "",
  };
}

/** Keep unrelated parameters; serialize the sort explicitly so shared links retain their order across roles. */
export function catalogueLocationUrl(current: string, patch: Partial<CatalogueLocation>, role: AppRole | null) {
  const url = new URL(current, "http://catalogue.local");
  const location = { ...readCatalogueLocation(url.searchParams, role), ...patch };
  const defaults = { query: "", category: ALL_CATEGORIES, communicationDirection: ALL_COMMUNICATION_DIRECTIONS,
    countryRegion: ALL_COUNTRY_REGIONS, inputFormat: "", outputFormat: "", company: "All companies",
    status: "All records", scope: "all", page: 1, api: "" };
  for (const key of Object.keys(keys) as (keyof CatalogueLocation)[]) {
    const value = location[key];
    if (key !== "sort" && value === defaults[key as keyof typeof defaults]) url.searchParams.delete(keys[key]);
    else url.searchParams.set(keys[key], String(value));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
