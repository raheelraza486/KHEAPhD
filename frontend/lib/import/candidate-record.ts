// Turning a parsed Candidate into a row for public.apis, resolving the raw
// spellings through the alias tables 0004 created. Pure: the route fetches the
// alias maps and passes them in, so the one place a rule lives is still the
// database, and this function stays testable.

import {
  API_CATEGORIES,
  AUTHENTICATION_TYPES,
  type ApiCategory,
  type ApiCommunicationDirection,
  type AuthenticationType,
} from "../types.ts";
import type { Candidate } from "./types.ts";
import { classifyOpenApiCandidate } from "./category-classifier.ts";
import { effectiveCandidateFormats } from "./declared-formats.ts";

export type AliasMaps = {
  /** format_alias: raw media type or spelling -> canonical format name. */
  format: Map<string, string>;
  /** provider_alias: raw provider spelling -> canonical provider name. */
  provider: Map<string, string>;
};

/** Map a securityScheme description onto the repository's controlled list.
 *  Anything off-list is preserved verbatim in authentication_other. */
function resolveAuth(raw: string[]): { method: AuthenticationType; other: string } {
  const first = raw[0] ?? "";
  const lower = first.toLowerCase();
  const table: [RegExp, AuthenticationType][] = [
    [/oauth2|openidconnect/, "OAuth2"],
    [/http bearer|bearer/, "Token"],
    [/apikey|api key/, "API Key"],
    [/http basic|basic/, "Basic"],
    [/mutualtls|mtls|client.?cert/, "Certificate/mTLS"],
    [/wss?-?security/, "WS-Security"],
    [/hmac|signature/, "HMAC/Signature"],
  ];
  if (raw.length === 0) return { method: "None", other: "" };
  if (raw.length > 1) return { method: "Composite", other: raw.join(", ") };
  for (const [re, method] of table) if (re.test(lower)) return { method, other: "" };
  return { method: "Other", other: first };
}

/** A media type ("application/json") mapped through format_alias, falling
 *  back to the raw value when the table has no entry. */
function canonicalFormats(raw: string[], aliases: Map<string, string>): string[] {
  const out: string[] = [];
  for (const value of raw) {
    const key = value.trim();
    const mapped = aliases.get(key) ?? aliases.get(key.toLowerCase()) ?? key;
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export type ApiRow = {
  api_name: string;
  official_api_name: string;
  description: string;
  api_endpoint: string;
  company_name: string;
  company_name_original: string;
  official_company_name: string;
  documentation_url: string;
  source_url: string;
  http_method: string;
  category: ApiCategory;
  communication_direction: ApiCommunicationDirection;
  authentication_method: AuthenticationType;
  authentication_other: string;
  input_formats: string[];
  input_formats_original: string[];
  output_formats: string[];
  output_formats_original: string[];
  data_quality: Candidate["data_quality"];
  access_scope: "public";
  review_status: "Published";
};

export function toApiRow(
  candidate: Candidate,
  documentUrl: string,
  aliases: AliasMaps,
): ApiRow {
  const auth = resolveAuth(candidate.authentication_raw);
  const classification = classifyOpenApiCandidate(candidate);
  const effectiveFormats = effectiveCandidateFormats(candidate);
  const rawCompany = candidate.company_name.trim();
  const canonicalCompany =
    aliases.provider.get(rawCompany) ?? aliases.provider.get(rawCompany.toLowerCase()) ?? rawCompany;

  return {
    api_name: candidate.api_name,
    official_api_name: candidate.official_api_name,
    description: candidate.description,
    api_endpoint: candidate.api_endpoint,
    company_name: canonicalCompany,
    company_name_original: rawCompany,
    official_company_name: "",
    documentation_url: documentUrl,
    source_url: documentUrl,
    http_method: candidate.http_method,
    category: classification.category,
    communication_direction: classification.communication_direction,
    authentication_method: auth.method,
    authentication_other: auth.other,
    input_formats: canonicalFormats(effectiveFormats.input, aliases.format),
    input_formats_original: candidate.input_formats,
    output_formats: canonicalFormats(effectiveFormats.output, aliases.format),
    output_formats_original: candidate.output_formats,
    data_quality: candidate.data_quality,
    access_scope: "public",
    review_status: "Published",
  };
}

// Exported for tests; keeps the category list honest against lib/types.
export const _controlled = { API_CATEGORIES, AUTHENTICATION_TYPES };
