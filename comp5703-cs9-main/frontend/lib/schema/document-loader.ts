// Shared, guarded recovery of a machine-readable document from its catalogue
// link. Only document-declared spec links are followed; no guessed URLs.
import { createHash } from "node:crypto";
import { detect, extractSpecUrl, type Detection } from "../import/detect.ts";
import { refusalMessage, safeFetch, type FetchOutcome } from "../import/fetch.ts";

export type DocumentFetch = {
  url: string;
  final_url?: string;
  content_sha256?: string;
  refusal?: string;
};

export type LoadedDocument = {
  source_url: string;
  fetched_at: string;
  fetches: DocumentFetch[];
} & (
  | { ok: true; document: unknown; final_url: string; content_sha256: string; format: "openapi_3" }
  | { ok: false; reason: string; message: string; format?: string }
);

/** Nelmio Swagger UI (FACe) stores its spec as inert JSON, not a spec URL.
 * Parse only that named JSON data block; never evaluate initialiser scripts. */
function embeddedOpenApi(body: string): unknown | undefined {
  const documents: unknown[] = [];
  for (const script of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = script[1];
    if (!/(?:^|\s)id\s*=\s*(["'])swagger-data\1/i.test(attributes)
      || !/(?:^|\s)type\s*=\s*(["'])application\/json\1/i.test(attributes)) continue;
    try {
      const parsed: unknown = JSON.parse(script[2]);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const spec = (parsed as { spec?: unknown }).spec;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
      const version = (spec as { openapi?: unknown }).openapi;
      if (typeof version === "string" && version.trim().startsWith("3")) documents.push(spec);
    } catch {
      // Malformed JSON is not executable JavaScript and never becomes a schema.
    }
  }
  return documents.length === 1 ? documents[0] : undefined;
}

/** Binary manuals must never be offered to YAML's permissive text parser. */
function detectSchemaDocument(body: string, sourceUrl: string): Detection | { format: "pdf" | "xml" | "binary" } {
  const trimmed = body.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("%PDF-")) return { format: "pdf" };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(trimmed.slice(0, 4096))) return { format: "binary" };
  // detect() checks markup before YAML; retain its WSDL and Swagger/Redoc
  // recognition and label other declared XML as XML for an actionable report.
  const detection = detect(body, sourceUrl);
  if (detection.format === "html_page") {
    const embedded = embeddedOpenApi(body);
    if (embedded !== undefined) return { format: "openapi_3", document: embedded };
  }
  if (detection.format === "unknown" && (/^<\?xml\b/i.test(trimmed)
    || /^<(?:[\w.-]+:)?(?:schema|application)\b/i.test(trimmed))) return { format: "xml" };
  return detection;
}

export async function loadSchemaDocument(
  url: string,
  fetchDocument: (url: string) => Promise<FetchOutcome> = safeFetch,
): Promise<LoadedDocument> {
  const fetches: DocumentFetch[] = [];
  const provenance = { source_url: url, fetched_at: new Date().toISOString(), fetches };
  async function read(address: string): Promise<FetchOutcome> {
    const result = await fetchDocument(address);
    fetches.push(result.ok
      ? { url: address, final_url: result.finalUrl, content_sha256: createHash("sha256").update(result.body).digest("hex") }
      : { url: address, refusal: result.refusal });
    return result;
  }
  let fetched = await read(url);
  if (!fetched.ok) {
    return { ...provenance, ok: false, reason: fetched.refusal, message: refusalMessage(fetched.refusal) };
  }
  let detection = detectSchemaDocument(fetched.body, fetched.finalUrl);
  if (detection.format === "html_page") {
    let specUrl = detection.specUrl;
    // The HTML detector only returns named Swagger initialisers. The cap also
    // bounds a malformed page that lists thousands of candidate scripts.
    for (const scriptUrl of detection.configScriptUrls.slice(0, 3)) {
      if (specUrl) break;
      const script = await read(scriptUrl);
      if (script.ok) specUrl = extractSpecUrl(script.body, script.finalUrl);
    }
    if (!specUrl) {
      return { ...provenance, ok: false, reason: "spec_link_not_found", format: detection.format,
        message: "No OpenAPI document link was declared by the documentation page." };
    }
    fetched = await read(specUrl);
    if (!fetched.ok) {
      return { ...provenance, ok: false, reason: fetched.refusal, message: refusalMessage(fetched.refusal) };
    }
    detection = detectSchemaDocument(fetched.body, fetched.finalUrl);
  }
  if (detection.format !== "openapi_3") {
    return { ...provenance, ok: false, reason: "unsupported_document", format: detection.format,
      message: `The documentation is ${detection.format}; automatic schema extraction requires OpenAPI 3.` };
  }
  return { ...provenance, ok: true, document: detection.document, format: "openapi_3",
    final_url: fetched.finalUrl, content_sha256: createHash("sha256").update(fetched.body).digest("hex") };
}
