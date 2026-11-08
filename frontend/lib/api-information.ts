import type { ApiSchemaAvailability } from "./compatibility/ui-types.ts";
import type { ApiRecord } from "./types.ts";
import { formatFormatsForDisplay, formatInputFormatsForDisplay } from "./format-display.ts";

/** Catalogue metadata is evidence about an API, not a live availability check. */
export function publicWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function catalogueDate(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Not recorded";
  return new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export const ACCESS_LABELS = {
  public: "Publicly offered",
  restricted: "Restricted / internal",
  unknown: "Not confirmed",
} as const;

export const QUALITY_NOTES: Record<string, string> = {
  access_restricted: "Access to the provider documentation was restricted when this record was checked.",
  unreachable_documentation: "The documentation was recorded as unreachable. Check the source with the provider before integrating.",
  suspected_placeholder: "This record was flagged as a possible placeholder and needs an official-source check.",
};

export type InformationCoverageStatus = "recorded" | "missing" | "checking";
export type InformationCoverageSource = "catalogue" | "schema";

export interface InformationCoverageItem {
  key: string;
  label: string;
  value: string;
  status: InformationCoverageStatus;
  source: InformationCoverageSource;
  guidance?: string;
}

export interface InformationCoverage {
  items: InformationCoverageItem[];
  recorded: InformationCoverageItem[];
  missing: InformationCoverageItem[];
  checking: InformationCoverageItem[];
}

function clean(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean);
}

function valueItem(
  key: string,
  label: string,
  value: string,
  guidance: string,
  source: InformationCoverageSource = "catalogue",
): InformationCoverageItem {
  const normalized = value.trim();
  return normalized
    ? { key, label, value: normalized, status: "recorded", source }
    : { key, label, value: "Not recorded", status: "missing", source, guidance };
}

function valuesItem(
  key: string,
  label: string,
  values: string[],
  guidance: string,
  source: InformationCoverageSource = "catalogue",
): InformationCoverageItem {
  return valueItem(key, label, clean(values).join(" · "), guidance, source);
}

function schemaItem(
  key: string,
  label: string,
  count: number | undefined,
  missingGuidance: string,
): InformationCoverageItem {
  if (count === undefined) {
    return {
      key,
      label,
      value: "Checking saved schemas…",
      status: "checking",
      source: "schema",
      guidance: "Schema coverage is being checked separately from catalogue metadata.",
    };
  }
  return count > 0
    ? { key, label, value: `${count} saved ${count === 1 ? "schema" : "schemas"}`, status: "recorded", source: "schema" }
    : { key, label, value: "No saved schema", status: "missing", source: "schema", guidance: missingGuidance };
}

/**
 * One honest inventory of the information this catalogue tracks for an API.
 * Empty request metadata is not treated as proof that a request body exists:
 * body-less operations are possible and must be checked against the source.
 */
export function apiInformationCoverage(
  record: ApiRecord,
  schemaAvailability?: Pick<ApiSchemaAvailability, "request_count" | "response_count">,
): InformationCoverage {
  const category = record.category === "Other" && record.category_other
    ? `Other · ${record.category_other}`
    : record.category === "Other" && !record.category_other
      ? ""
      : record.category;
  const authentication = record.authentication_method === "Other"
    ? record.authentication_other
    : record.authentication_method;
  const authenticationDetails = record.authentication_method === "None"
    ? "Not required (authentication is None)"
    : record.authentication_details;
  const items: InformationCoverageItem[] = [
    valueItem("api_name", "API name", record.api_name === "Unnamed API" ? "" : record.api_name, "Add a clear operation or service name."),
    valueItem("company_name", "Provider", record.company_name === "Unknown company" ? "" : record.company_name, "Identify the organisation that provides the API."),
    valueItem("description", "Description", record.description, "Summarise what this API operation does."),
    valueItem("category", "Category", category, "Classify the API from its documented purpose."),
    ...(record.category === "Communication"
      ? [valueItem("communication_direction", "Communication direction", record.communication_direction === "Unspecified" ? "" : record.communication_direction, "Confirm whether callers send, receive, or do both.")]
      : []),
    valueItem("country_region", "Country / region", record.country_region, "Add only coverage stated by the provider; a provider address alone is not enough."),
    valueItem("api_endpoint", "Endpoint", record.api_endpoint, "Add the documented endpoint or endpoint template."),
    valueItem("http_method", "HTTP method", record.http_method, "Add the method stated by the operation documentation."),
    valueItem("documentation_url", "Official documentation", record.documentation_url, "Link the official API documentation or specification."),
    valueItem("website_url", "Provider website", record.website_url, "Add the provider's public website if available."),
    valueItem("authentication_method", "Authentication method", authentication, "Confirm the documented authentication method."),
    valueItem("authentication_details", "Authentication details", authenticationDetails, "Add credential setup, required headers, scopes, certificates, or signing steps."),
    valueItem("access_scope", "Provider access", record.access_scope === "unknown" ? "" : ACCESS_LABELS[record.access_scope], "Confirm whether the API is publicly offered or restricted/internal."),
    valuesItem("client_types", "Client / interface type", record.client_types, "Add the documented interface type, for example REST or SOAP."),
    valueItem("network", "Network", record.network, "Add the exchange network if one is required; otherwise confirm that it is not applicable."),
    valueItem("input_formats", "Input format", formatInputFormatsForDisplay(record.input_formats, ""), "Check the request definition. An empty value may be valid when this operation has no request body.", "schema"),
    valueItem("output_formats", "Output format", formatFormatsForDisplay(record.output_formats, ""), "Check response content types in the provider documentation or schema.", "schema"),
    valuesItem("invoice_standard", "Invoice standard", record.invoice_standard, "Confirm the invoice standard, or confirm that it is not applicable."),
    valueItem("instructions", "Implementation notes", record.instructions, "Add documented onboarding or implementation steps."),
    valuesItem("business_rules", "Business rules", record.business_rules, "Add documented validation or processing rules."),
    schemaItem("request_schema", "Request body fields", schemaAvailability?.request_count, "No request schema is saved. Check whether the operation has a request body before adding one."),
    schemaItem("response_schema", "Response body fields", schemaAvailability?.response_count, "No response schema is saved. Recover it from the official specification or add a reviewed schema."),
  ];

  return {
    items,
    recorded: items.filter((item) => item.status === "recorded"),
    missing: items.filter((item) => item.status === "missing"),
    checking: items.filter((item) => item.status === "checking"),
  };
}
