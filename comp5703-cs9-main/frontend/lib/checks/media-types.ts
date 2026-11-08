/**
 * Canonical format name → the media types that carry it.
 *
 * Two different columns describe the same exchange from two sides:
 *
 *   apis.output_formats / input_formats  what a person declared the operation
 *                                        speaks, in canonical names (JSON, XML)
 *   api_schema.media_type                what the extractor actually stored a
 *                                        schema for (application/json, text/xml)
 *
 * Check 1 decides on the declared names; check item 2.1 has to pick one stored
 * schema. This table is the bridge: the format the user selects on the page is
 * a canonical name, and 2.1 keeps only the schema rows whose media type it
 * covers.
 *
 * The table lives in code rather than in `format_alias` on purpose: that table
 * maps *spellings of one format* to the canonical name (`JSON payload` → `JSON`)
 * and is validated as such by the catalogue. This is a different relation, and
 * mixing the two would break that validation. Moving it into the database is a
 * later question (Backlog).
 *
 * The lists below cover every media type present in the catalogue snapshot of
 * 2026-09-19 (167 active records, 337 schemas).
 */

/** Media types that mean "anything": they satisfy every canonical format. */
export const WILDCARD_MEDIA_TYPES = new Set(["*/*"]);

export const FORMAT_MEDIA_TYPES: Readonly<Record<string, readonly string[]>> = {
  JSON: ["application/json"],
  // UBL is an XML document standard, so the syntax carriers are the same ones
  // (Check Manual §6.2: a target that accepts XML can parse UBL).
  XML: ["application/xml", "text/xml", "application/*+xml", "application/soap+xml"],
  UBL: ["application/xml", "text/xml"],
  PDF: ["application/pdf"],
  // ZUGFeRD / Factur-X: a PDF with the invoice XML embedded, sent as a PDF.
  "Hybrid PDF": ["application/pdf"],
  ZIP: ["application/zip"],
  "Form URL encoded": ["application/x-www-form-urlencoded"],
  // A successful response carried by the status code alone has no body and so
  // no schema; 2.1 handles it through `source_no_output_body`, never here.
  "Status Codes": [],
};

/**
 * Media types stored in the catalogue that no canonical format covers
 * (`text/plain`, `multipart/form-data`, `application/octet-stream`). They are
 * not guessed into a format: a schema stored only under one of them is
 * unreachable by format selection, which is reported as `no_schema_for_format`
 * rather than silently compared.
 */
export function mediaTypesFor(format: string | null | undefined): readonly string[] {
  if (!format) return [];
  return FORMAT_MEDIA_TYPES[format] ?? [];
}

/**
 * Does this stored schema's media type carry the given canonical format?
 *
 * A row with no media type recorded says nothing about its content type, so it
 * cannot rule itself out: it is kept for every format. Excluding it instead
 * would let one empty column silently remove the only schema a pair has.
 */
export function schemaCarriesFormat(mediaType: string | null | undefined, format: string | null | undefined): boolean {
  const value = (mediaType ?? "").trim().toLowerCase();
  if (value === "") return true;
  if (WILDCARD_MEDIA_TYPES.has(value)) return true;
  const accepted = mediaTypesFor(format);
  if (accepted.length === 0) return false;
  return accepted.some((candidate) => candidate === value);
}

/**
 * Keep the schemas that can carry the selected format. With no format selected
 * (the engine called directly, or a pair the page has not chosen a format for)
 * every schema stays, which is the behaviour of V1.0.
 */
export function schemasForFormat<T extends { media_type?: string | null }>(
  schemas: readonly T[],
  format: string | null | undefined,
): readonly T[] {
  if (!format) return schemas;
  return schemas.filter((schema) => schemaCarriesFormat(schema.media_type, format));
}

/**
 * Order between several stored schemas that all carry the selected format.
 * The lists above are written most specific first, so a provider that publishes
 * the same XML body as `application/xml`, `text/xml` and `application/*+xml` is
 * compared against the plainly named one rather than the wildcard. Anything not
 * in the list, and ties, fall back to the name and then the id, so the choice
 * never depends on the order rows came back in.
 */
export function mediaTypeOrder<T extends { media_type?: string | null; id?: string }>(
  format: string | null | undefined,
): (a: T, b: T) => number {
  const preference = mediaTypesFor(format);
  const rank = (value: string | null | undefined) => {
    const index = preference.indexOf((value ?? "").trim().toLowerCase());
    return index === -1 ? preference.length : index;
  };
  return (a, b) =>
    rank(a.media_type) - rank(b.media_type)
    || (a.media_type ?? "").localeCompare(b.media_type ?? "")
    || (a.id ?? "").localeCompare(b.id ?? "");
}
