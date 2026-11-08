import type { ApiRecord } from "../types.ts";
import { countryRegionForRecord, UNSPECIFIED_COUNTRY_REGION } from "../country-region.ts";
import { coverageFilterValues } from "../coverage.ts";
import { checkFormatCompatibility } from "./format-check.ts";

export interface ApiFilters { search: string; country: string; category: string }
export const EMPTY_FILTERS: ApiFilters = { search: "", country: "", category: "" };

// Imported catalogue titles often start with a country label. Keep the supplier
// and operation in comparison labels; the country has its own filter and metadata.
const COUNTRY_PREFIX = /^(?:Argentina|Australia|Austria|Belgium|Brazil|Bulgaria|Canada|Chile|China|Colombia|Croatia|Czech Republic|Czechia|Denmark|Ecuador|Egypt|Estonia|Finland|France|Germany|Greece|Hong Kong|Hungary|India|Indonesia|Ireland|Israel|Italy|Japan|Jordan|Kenya|Malaysia|Mexico|Netherlands|New Zealand|Norway|Peru|Philippines|Poland|Portugal|Romania|Rwanda|Saudi Arabia|Serbia|Singapore|Slovakia|Slovenia|South Africa|South Korea|Spain|Sweden|Switzerland|Taiwan|Thailand|Turkey|Türkiye|Ukraine|United Arab Emirates|United Kingdom|United States(?: of America)?|Vietnam|Zambia)\s+/iu;

export function comparisonApiName(api: Pick<ApiRecord, "api_name">): string {
  const name = api.api_name.trim();
  return name.replace(COUNTRY_PREFIX, "").trim() || name;
}

/**
 * The endpoint as an operation: method first, where the record knows it.
 *
 * On its own an endpoint is not an operation, which is why 0007 made the
 * identity (endpoint, method) and 0018 added a selector for the services that
 * answer several operations at one address. Showing the endpoint alone lets
 * five DIAN records look like the same thing.
 */
export function operationLabel(api: Pick<ApiRecord, "api_endpoint" | "http_method">): string {
  const endpoint = api.api_endpoint.trim();
  if (!endpoint) return "Endpoint not recorded";
  return api.http_method ? `${api.http_method} ${endpoint}` : endpoint;
}

/**
 * What distinguishes this operation from the others at the same address, in
 * words, or null when nothing does -- either because the endpoint identifies
 * it, or because nobody has recorded the discriminator yet. The two cases read
 * differently to a person and are not merged here: `sharesEndpointWith` says
 * which one it is.
 */
export function operationSelectorNote(
  api: Pick<ApiRecord, "operation_selector">,
): { name: string; value: string } | null {
  const selector = api.operation_selector?.trim();
  if (!selector) return null;
  const divider = selector.indexOf("=");
  if (divider <= 0) return null;
  return { name: selector.slice(0, divider), value: selector.slice(divider + 1) };
}

/** Other records this one cannot be told apart from by endpoint and method. */
export function sharesEndpointWith(
  api: Pick<ApiRecord, "id" | "api_endpoint" | "http_method">,
  apis: readonly ApiRecord[],
): ApiRecord[] {
  const endpoint = api.api_endpoint.trim();
  if (!endpoint) return [];
  return apis.filter((other) =>
    other.id !== api.id
    && other.api_endpoint.trim() === endpoint
    && (other.http_method || "") === (api.http_method || ""));
}

function countryValues(api: ApiRecord): string[] {
  const country = countryRegionForRecord(api);
  return country === UNSPECIFIED_COUNTRY_REGION ? [country] : coverageFilterValues(country);
}

export function apiCountryOptions(apis: readonly ApiRecord[]): string[] {
  return [...new Set(apis.flatMap(countryValues))].sort((left, right) => {
    if (left === UNSPECIFIED_COUNTRY_REGION) return 1;
    if (right === UNSPECIFIED_COUNTRY_REGION) return -1;
    return left.localeCompare(right, "en");
  });
}

export function filterApis(apis: readonly ApiRecord[], filters: ApiFilters): ApiRecord[] {
  const query = filters.search.trim().toLowerCase();
  const country = filters.country === "__unknown__" ? UNSPECIFIED_COUNTRY_REGION : filters.country;
  return apis.filter((api) =>
    (!country || countryValues(api).includes(country))
    && (!filters.category || api.category === filters.category)
    && (!query || `${api.api_name} ${api.company_name} ${api.api_endpoint}`.toLowerCase().includes(query)),
  );
}

/** A catalogue hint is evidence about formats, not a verdict on schema compatibility. */
export function formatHint(sourceFormats: readonly string[], targetFormats: readonly string[]) {
  const result = checkFormatCompatibility("Source", sourceFormats, "Target", targetFormats);
  return {
    status: result.status,
    label: result.status === "compatible" ? "Format overlap" : result.status === "incompatible" ? "Format mismatch" : "Format unknown",
    reason: result.status === "compatible"
      ? `Shared format: ${result.common_formats.join(", ")}. Run the comparison to check fields.`
      : result.status === "incompatible"
        ? `Source: ${result.source_output_formats.join(", ")}. Target: ${result.target_input_formats.join(", ")}. No recorded format overlap.`
        : "Format information is incomplete. This API remains available for comparison.",
  };
}

/** Uploaded fragments do not declare the wire format just by being JSON or YAML files. */
export function selectedFormats(mode: "url" | "published" | "upload", mediaType: string | undefined, catalogueFormats: readonly string[]): string[] {
  if (mediaType?.trim()) return [mediaType.trim()];
  return mode === "published" ? [...catalogueFormats] : [];
}
