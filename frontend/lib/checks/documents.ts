/**
 * Whole-document exchange (issue #41).
 *
 * Most e-invoicing APIs do not exchange invoice fields one by one: they pass a
 * whole invoice file. The file reaches the API in one of five ways, and the
 * checks must see all five as the same thing — "a UBL XML (or PDF) document":
 *
 *   body    the request or response body is the file itself
 *           (beliq generateInvoice responds with application/xml; Peppol
 *           Validator accepts application/xml; B2Brouter Import accepts
 *           application/octet-stream)
 *   file    a multipart form with a binary file field
 *           (Peppol Validator `file`, Mailgun `attachment[]`)
 *   base64  a JSON body with one base64 field that holds the file
 *           (ESS SmartDocFlow `content`, Upbrains `fileBase64`)
 *   byte-array a JSON body with one explicitly identified array of file bytes
 *           (EzzyBills `PictureStream`, integers from 0 to 255)
 *   text    a JSON response with one required string named for XML that
 *           holds the file (AmitTransform `xml`, extracted-invoice `invoice_xml`)
 *
 * `base64`, `byte-array` and `file` are envelopes: JSON or multipart only carries
 * the document, so for format purposes the side accepts the document format,
 * not JSON or multipart. The other fields of an envelope (`filename`,
 * `profile`, `to`, `subject`, path parameters) are settings of the call, not
 * invoice data.
 *
 * Only these five count. An XML schema that lists fields is not taken for a
 * file even when the other side carries one: XML is a syntax, and a query or
 * status message written in XML is not an invoice. An encrypted base64 field
 * (Poland KSeF) is not taken for the invoice file either.
 *
 * What the document is, when the schema does not say: the document formats
 * the record declares (e-invoice conversion uploads CSV, XML or EDIFACT; the
 * wrappers JSON and multipart are not documents); when it declares none,
 * Validation and Communication APIs exchange the invoice as XML, and a
 * Transformation API that takes a file (an extraction such as Upbrains or
 * Nanonets) takes a PDF or an image. Decided 12 October 2026; declared formats
 * first since 14 October 2026.
 *
 * A record that declares "Hybrid PDF" (ZUGFeRD / Factur-X: a PDF with the
 * invoice XML embedded) reads or writes only that kind of PDF, so its PDF body
 * carries a Hybrid PDF. A Hybrid PDF is still a PDF to a side that takes any
 * PDF, as UBL is still XML to a side that takes any XML.
 */
import { BODY_FIELD, schemaFields } from "./fields.ts";
import { normaliseFormats, type NormalisedFormats } from "./check1-format.ts";
import { schemaCarriesFormat } from "./media-types.ts";
import type { ApiSideInput, FormatAliasRow, SchemaRecord } from "./types.ts";

export type CarrierKind = "body" | "file" | "base64" | "byte-array" | "text";

export interface DocumentCarrier {
  kind: CarrierKind;
  /** The field that holds the document; `(body)` for a body carrier. */
  path: string;
  /** Canonical formats of the document carried. */
  formats: string[];
  /** Canonical format of the envelope (JSON, Multipart form data), or null. */
  container: string | null;
}

const FILE_FIELD = /^(file|files|attachment|attachments|document|invoice)$/;
/** A string field named for the XML document it holds: `xml`, `invoice_xml`, `ublXml`, `xmlContent`; not `xmlns` or `xmlErrors`. */
function isXmlField(leaf: string): boolean {
  const name = leaf.toLowerCase().replace(/[_-]/g, "");
  return /^[a-z0-9]*xml$/.test(name) || /^xml(content|document|string|data|body|text)$/.test(name);
}

function mediaOf(s: SchemaRecord): string {
  return (s.media_type ?? "").trim().toLowerCase();
}

function isJsonMedia(m: string): boolean {
  return m === "application/json" || m === "text/json" || m.endsWith("+json");
}

/** Declared values that name a wrapper or no body, not the document itself. */
const CONTAINER_FORMATS = new Set(["JSON", "Multipart form data", "Form URL encoded", "Base64", "Binary", "No request body"]);

/** The document formats a side's record declares for one direction; wrappers are left out. */
export function declaredDocuments(side: ApiSideInput, direction: "output" | "input", aliases: readonly FormatAliasRow[]): string[] {
  const declared = normaliseFormats(direction === "output" ? side.api.output_formats : side.api.input_formats, aliases);
  return declared.formats.filter((f) => !CONTAINER_FORMATS.has(f));
}

/** The document a side exchanges when the schema itself does not say. */
export function documentFormatsFor(category: string | null | undefined, direction: SchemaRecord["direction"]): string[] {
  const c = (category ?? "").trim().toLowerCase();
  if (c === "transformation") return direction === "request" ? ["PDF", "Images"] : ["XML"];
  if (c === "validation" || c === "communication") return ["XML"];
  return [];
}

/** What a document's format is when only the category says: the record's declared documents, else the category's default. */
function guessed(category: string | null | undefined, direction: SchemaRecord["direction"], documents?: readonly string[]): string[] {
  return documents?.length ? [...documents] : documentFormatsFor(category, direction);
}

function bodyFormats(media: string, category: string | null | undefined, direction: SchemaRecord["direction"], documents?: readonly string[]): string[] {
  if (media.includes("xml")) return ["XML"];
  if (media === "application/pdf") return documents?.includes("Hybrid PDF") && !documents.includes("PDF") ? ["Hybrid PDF"] : ["PDF"];
  return guessed(category, direction, documents);
}

function rawObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** The document this stored schema carries, or null when it carries fields. */
export function findCarrier(schema: SchemaRecord, category: string | null | undefined, documents?: readonly string[]): DocumentCarrier | null {
  const media = mediaOf(schema);
  const fields = schemaFields(schema);

  // body: no fields, the whole body is one string, and it is not JSON.
  if (schema.fields.length === 0 && !isJsonMedia(media)) {
    const raw = rawObject(schema.raw);
    if (raw && raw.type === "string") {
      const formats = bodyFormats(media, category, schema.direction, documents);
      if (formats.length > 0) return { kind: "body", path: BODY_FIELD, formats, container: null };
    }
  }

  const top = fields.filter((f) => f.depth === 0 || (f.depth === 1 && f.path.endsWith("[]")));

  // file: a multipart form with a binary file field.
  if (media === "multipart/form-data") {
    const binary = top.filter((f) => f.format === "binary");
    const required = binary.filter((f) => f.required);
    const named = binary.filter((f) => FILE_FIELD.test(f.leaf.replace(/\[\]$/, "").toLowerCase()));
    const pick = required.length === 1 ? required[0] : named[0];
    if (pick) {
      const formats = guessed(category, schema.direction, documents);
      if (formats.length > 0) return { kind: "file", path: pick.path, formats, container: "Multipart form data" };
    }
  }

  // base64: a JSON body whose one required base64 field holds the file.
  if (isJsonMedia(media)) {
    // An encrypted payload is not the invoice file: the receiver also needs
    // values computed from the plain invoice (hash, size), as Poland KSeF
    // Send Invoice does, so it is compared field by field.
    const encoded = top.filter((f) => f.depth === 0 && f.jsonType === "string" && (f.format === "byte" || f.format === "base64") && !/encrypt/i.test(f.leaf));
    const required = encoded.filter((f) => f.required);
    if (required.length === 1 && encoded.length === 1) {
      const formats = guessed(category, schema.direction, documents);
      if (formats.length > 0) return { kind: "base64", path: required[0].path, formats, container: "JSON" };
    }

    // Bounds alone do not make a numeric array a document (it might be RGB
    // values or identifiers). Require the reviewed raw schema's explicit
    // carrier annotation as well as a required, top-level byte array.
    const raw = rawObject(schema.raw);
    const properties = rawObject(raw?.properties);
    const marked = Object.entries(properties ?? {}).filter(([, value]) => rawObject(value)?.["x-document-carrier"] === "byte-array");
    if (raw?.type === "object" && !raw.oneOf && !raw.anyOf && !raw.allOf && marked.length === 1 && encoded.length === 0) {
      const [path, value] = marked[0];
      const property = rawObject(value)!;
      const items = rawObject(property.items);
      const field = top.find((f) => f.path === path && f.depth === 0 && !f.arrayItem && f.required && f.jsonType === "array");
      if (field && !/encrypt/i.test(path) && Array.isArray(raw.required) && raw.required.includes(path)
          && property.type === "array" && !property.oneOf && !property.anyOf && !property.allOf
          && items?.type === "integer" && items.minimum === 0 && items.maximum === 255
          && !items.oneOf && !items.anyOf && !items.allOf && !items.enum && items.const === undefined) {
        const formats = guessed(category, schema.direction, documents);
        if (formats.length > 0) return { kind: "byte-array", path, formats, container: "JSON" };
      }
    }
  }

  // text: a JSON body whose one required string named for XML is the
  // document (AmitTransform `xml`; the group's extracted-invoice `invoice_xml`;
  // Billit `POST /v1/peppol/sendxml` takes `{ "XML": "<UBL>" }`).
  // Widened from the exact name `xml` on 14 October 2026, and from responses
  // to requests on 25 October 2026 (the real Billit send of 21 October).
  if (isJsonMedia(media)) {
    const named = top.filter((f) => f.depth === 0 && f.jsonType === "string" && f.required && isXmlField(f.leaf));
    if (named.length === 1) return { kind: "text", path: named[0].path, formats: ["XML"], container: null };
  }

  return null;
}

export function isEnvelope(c: DocumentCarrier | null): boolean {
  return !!c && (c.kind === "base64" || c.kind === "byte-array" || c.kind === "file");
}

/**
 * Does this schema carry the format? An envelope carries the document format
 * only; any other schema carries what its media type says, plus the document
 * it holds.
 */
export function schemaCarries(schema: SchemaRecord, format: string, category: string | null | undefined, documents?: readonly string[]): boolean {
  const c = findCarrier(schema, category, documents);
  // A carrier of any XML takes a UBL document, and one of any PDF a Hybrid PDF.
  const viaDocument = !!c && (c.formats.includes(format) || (format === "UBL" && c.formats.includes("XML")) || (format === "Hybrid PDF" && c.formats.includes("PDF")));
  if (isEnvelope(c)) return viaDocument;
  return schemaCarriesFormat(schema.media_type, format) || viaDocument;
}

export function schemasCarrying<T extends SchemaRecord>(schemas: readonly T[], format: string | null | undefined, category: string | null | undefined, documents?: readonly string[]): readonly T[] {
  if (!format) return schemas;
  return schemas.filter((s) => schemaCarries(s, format, category, documents));
}

/**
 * The formats a side really exchanges: the declared ones, plus the document
 * held by a carrier, minus an envelope's own container when every schema in
 * that container is an envelope (ESS takes JSON only as the wrapper of an XML
 * file; as a pass-through source it hands on that XML file).
 */
export function effectiveFormats(side: ApiSideInput, direction: "output" | "input", aliases: readonly FormatAliasRow[]): NormalisedFormats {
  const declared = normaliseFormats(direction === "output" ? side.api.output_formats : side.api.input_formats, aliases);
  const schemas = side.schemas.filter((s) =>
    direction === "input" ? s.direction === "request" : s.direction === "response" && /^(2\d\d|default)$/i.test(s.status_code ?? ""),
  );
  const category = side.api.category;
  const formats = new Set(declared.formats);
  const documents = declaredDocuments(side, direction, aliases);
  const containers = new Map<string, boolean>(); // container -> every schema in it is an envelope
  for (const s of schemas) {
    const c = findCarrier(s, category, documents);
    if (c) for (const f of c.formats) formats.add(f);
    const container = isJsonMedia(mediaOf(s)) ? "JSON" : mediaOf(s) === "multipart/form-data" ? "Multipart form data" : null;
    if (container) containers.set(container, (containers.get(container) ?? true) && isEnvelope(c));
  }
  for (const [container, allEnvelopes] of containers) if (allEnvelopes) formats.delete(container);
  return { formats: [...formats].sort(), unrecognised: declared.unrecognised };
}

/**
 * A Validation API passes on the document it was given: when it is the source
 * of a pair, the file it received is the file it hands on, not its report
 * (client, 1 October 2026: "you can go … validate to send"). Its request
 * schemas stand in for its responses. A validator with no stored request
 * schema, or one queried with fields rather than given a document, is left
 * as it is.
 */
export function passThrough(side: ApiSideInput): ApiSideInput {
  if ((side.api.category ?? "").trim().toLowerCase() !== "validation") return side;
  const requests = side.schemas.filter((s) => s.direction === "request");
  // Only a validator that takes a document hands one on; one that is queried
  // with fields (a status or authorisation lookup) is left as it is.
  const takesDocument = requests.some((s) => !!findCarrier(s, side.api.category));
  if (requests.length === 0 || !takesDocument) return side;
  return {
    ...side,
    api: { ...side.api, output_formats: side.api.input_formats },
    schemas: requests.map((s) => ({ ...s, direction: "response" as const, status_code: "200" })),
  };
}
