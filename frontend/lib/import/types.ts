// The output contract every parser emits, fixed before any parser exists.
// Whatever format a parser reads, it returns this shape, and nothing
// downstream knows which format produced it.
//
// Values are what the document STATES, exactly as written. No alias
// normalisation (that happens at write time, through the provider_alias and
// format_alias tables), no translation, no guessed endpoints.

export const DETECTED_FORMATS = [
  "openapi_3",
  "swagger_2",
  "wsdl",
  "html_page",
  "unknown",
] as const;
export type DetectedFormat = (typeof DETECTED_FORMATS)[number];

export const HTTP_METHODS = [
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// Mirrors the data_quality vocabulary established by migrations 0004/0006.
// The importer only ever produces these three; 'access_restricted' is not
// reachable from import, because the fetch sends no credentials.
export type ImportDataQuality =
  | "ok"
  | "unreachable_documentation"
  | "suspected_placeholder";

/** One operation from one document: one future row in public.apis. */
export type Candidate = {
  // -- identity: facts the document states, used by the matching key --------
  /** servers[0].url + path, or "" when no endpoint could be assembled. */
  api_endpoint: string;
  http_method: HttpMethod;

  // -- document-stated text, exactly as written -----------------------------
  /** info.title + operation label, by a rule stable across re-imports. */
  api_name: string;
  /** operationId, or summary when absent, or "" when neither exists. */
  official_api_name: string;
  description: string;
  /** info.contact.name or the provider as the document states it; raw. */
  company_name: string;

  // -- operation-level classification signals -----------------------------
  // Optional so a preview session created immediately before a deployment
  // remains readable after the classifier is introduced.
  /** paths[path].{method}.operationId, without falling back to summary. */
  operation_id?: string;
  /** paths[path].{method}.summary, without falling back to operationId. */
  operation_summary?: string;
  /** The OpenAPI path key, before it is joined to servers[0].url. */
  operation_path?: string;
  /** Operation tags exactly as the document states them. */
  operation_tags?: string[];
  /** True only when the operation explicitly declares at least one callback. */
  has_callbacks?: boolean;

  // -- raw spellings; the write layer resolves them through the alias tables
  input_formats: string[];
  output_formats: string[];
  /** securityScheme types as stated, e.g. ["oauth2"]; unresolved. */
  authentication_raw: string[];

  // -- quality, per the rules 0004 established --------------------------------
  data_quality: ImportDataQuality;

  // -- parser bookkeeping ---------------------------------------------------
  /** Non-fatal notes: unresolved $ref, missing summary, and so on. */
  warnings: string[];
};

/** A minimal, server-owned record of why one parsed operation was not allowed
 * into a preview. It intentionally omits schemas and arbitrary payload text so
 * a refused document cannot turn the audit session into unbounded storage. */
export type ImportScopeExclusion = {
  api_endpoint: string;
  http_method: HttpMethod;
  operation_id: string;
  operation_path: string;
  reason_code: "outside_catalogue_scope" | "unsupported_catalogue_category";
  rule_id: string;
};

/** What a parser returns for one whole document. */
export type ParseResult = {
  candidates: Candidate[];
  /** info.title, used as the api_name prefix and shown in the preview. */
  info_title: string;
  /** info.version as stated, or null. Recorded, never acted on. */
  info_version: string | null;
  /** Document-level notes that are not tied to one operation. */
  warnings: string[];
};
