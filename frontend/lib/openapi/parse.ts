// OpenAPI 3.x -> candidates. Pure: no network, no database, no clock.
//
// Every value is what the document STATES.
// Alias normalisation happens at write time through the provider_alias and
// format_alias tables; nothing here is translated, guessed or normalised.

import {
  HTTP_METHODS,
  type Candidate,
  type HttpMethod,
  type ImportDataQuality,
  type ParseResult,
} from "../import/types.ts";
// Moved to ref.ts when the schema extractor needed the same resolver.
import { isObject, resolveRef, text, type JsonObject } from "./ref.ts";

/** RFC 2606 reserved domains can never resolve; the rule 0004 established. */
function isReservedDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(^|\.)example\.(com|net|org)$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Swagger 2.0 has no `servers`: it states the base in three separate fields.
 * An absent `schemes` means "the scheme the document was fetched over" and an
 * absent `host` means "the host it was fetched from" (OpenAPI 2.0 §4.3), which
 * is why documentUrl is the fallback for both rather than a guess.
 */
export function swaggerBase(doc: JsonObject, documentUrl: string, warnings: string[]): string {
  const host = text(doc.host);
  const basePath = text(doc.basePath);
  const schemes = Array.isArray(doc.schemes)
    ? doc.schemes.map(text).filter(Boolean) : [];
  if (schemes.length > 1) {
    warnings.push(`schemes lists ${schemes.length} entries; using the first`);
  }
  let origin = "";
  try {
    const fetched = documentUrl ? new URL(documentUrl) : undefined;
    const scheme = schemes[0] || fetched?.protocol.replace(":", "") || "";
    const onHost = host || fetched?.host || "";
    if (!scheme || !onHost) {
      warnings.push("host or scheme is absent and the document URL supplies neither; "
        + "no endpoint can be assembled");
      return "";
    }
    origin = `${scheme}://${onHost}`;
  } catch {
    warnings.push(`the document URL is not usable as a base: ${documentUrl}`);
    return "";
  }
  try {
    return new URL(basePath || "/", origin).toString().replace(/\/$/, "");
  } catch {
    warnings.push(`basePath is not usable: ${basePath}`);
    return "";
  }
}

/** servers[0].url, resolved against the document's own URL when relative. */
function baseUrl(doc: JsonObject, documentUrl: string, warnings: string[]): string {
  if (text(doc.swagger).startsWith("2")) return swaggerBase(doc, documentUrl, warnings);
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const first = servers.find(isObject);
  const url = first ? text(first.url) : "";
  if (!url) {
    warnings.push("servers is absent or empty; no endpoint can be assembled");
    return "";
  }
  if (servers.length > 1) {
    warnings.push(`servers lists ${servers.length} entries; using the first`);
  }
  try {
    return new URL(url, documentUrl || undefined).toString().replace(/\/$/, "");
  } catch {
    warnings.push(`servers[0].url is not a usable URL: ${url}`);
    return "";
  }
}

/** Media type keys under content: {}, e.g. "application/json". As stated. */
function mediaTypes(node: unknown, root: JsonObject, warnings: string[]): string[] {
  const resolved = resolveRef(node, root, warnings);
  if (!isObject(resolved) || !isObject(resolved.content)) return [];
  return Object.keys(resolved.content).map((k) => k.trim()).filter(Boolean);
}

/**
 * Swagger 2.0's equivalent: `consumes` and `produces`, on the operation or on
 * the document. Stated only -- 2.0 defines no default, so a document that says
 * nothing yields nothing rather than an invented `application/json`.
 */
function swaggerMediaTypes(op: JsonObject, doc: JsonObject, key: "consumes" | "produces"): string[] {
  const stated = Array.isArray(op[key]) ? op[key] : Array.isArray(doc[key]) ? doc[key] : [];
  return stated.map(text).map((value) => value.trim()).filter(Boolean);
}

/**
 * Output means the successful operation result. Error envelopes frequently use
 * application/json even when the 2xx response is XML/PDF, so mixing every
 * response status makes the catalogue report a false JSON output. Prefer
 * explicit 2xx responses; only fall back to all responses when a document
 * declares no success status at all.
 */
function responseMediaTypes(op: JsonObject, root: JsonObject, warnings: string[]): string[] {
  const responses = isObject(op.responses) ? op.responses : {};
  const entries = Object.entries(responses);
  const successful = entries.filter(([status]) => /^2(?:\d{2}|xx)$/i.test(status.trim()));
  const selected = successful.length > 0 ? successful : entries;
  return [
    ...new Set(selected.flatMap(([, response]) => mediaTypes(response, root, warnings))),
  ];
}

/** securityScheme types the operation uses, e.g. ["http bearer"]. As stated. */
function authenticationRaw(
  op: JsonObject,
  doc: JsonObject,
  warnings: string[],
): string[] {
  const requirements = Array.isArray(op.security)
    ? op.security
    : Array.isArray(doc.security)
      ? doc.security
      : [];
  // 3.x keeps them under components.securitySchemes; 2.0 under
  // securityDefinitions at the top level. Without this the authentication of a
  // 2.0 operation comes out empty, which is the "half-parsed" outcome the
  // version gate used to avoid by refusing 2.0 altogether.
  const components = isObject(doc.components) ? doc.components : {};
  const schemes = isObject(components.securitySchemes)
    ? components.securitySchemes
    : isObject(doc.securityDefinitions) ? doc.securityDefinitions : {};
  const out = new Set<string>();
  for (const req of requirements) {
    if (!isObject(req)) continue;
    for (const name of Object.keys(req)) {
      const scheme = resolveRef(schemes[name], doc, warnings);
      if (isObject(scheme)) {
        const type = text(scheme.type);
        const flavour = text(scheme.scheme); // http bearer / http basic
        out.add(flavour ? `${type} ${flavour}`.trim() : type || name);
      } else {
        out.add(name);
      }
    }
  }
  return [...out];
}

export function parseOpenApi3(document: unknown, documentUrl: string): ParseResult {
  const warnings: string[] = [];
  if (!isObject(document)) throw new Error("not an OpenAPI 3.x or Swagger 2.0 document");
  const isOpenApi3 = text(document.openapi).startsWith("3");
  const isSwagger2 = text(document.swagger).startsWith("2");
  if (!isOpenApi3 && !isSwagger2) {
    throw new Error("not an OpenAPI 3.x or Swagger 2.0 document");
  }
  const doc = document;
  if (isSwagger2) {
    warnings.push("Swagger 2.0 document: the endpoint comes from schemes/host/basePath and the "
      + "formats from consumes/produces");
  }
  const info = isObject(doc.info) ? doc.info : {};
  const infoTitle = text(info.title);
  const infoVersion = text(info.version) || null;
  const contact = isObject(info.contact) ? info.contact : {};
  const companyName = text(contact.name);
  if (!companyName) {
    warnings.push("the document states no provider (info.contact.name is absent)");
  }

  const base = baseUrl(doc, documentUrl, warnings);
  const docOnReserved = isReservedDomain(documentUrl);

  const candidates: Candidate[] = [];
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = resolveRef(item, doc, warnings);
    if (!isObject(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method.toLowerCase()];
      if (!isObject(op)) continue;
      const opWarnings: string[] = [];

      const endpoint = base
        ? `${base}${path.startsWith("/") ? "" : "/"}${path}`
        : "";
      const quality: ImportDataQuality = docOnReserved
        ? "unreachable_documentation"
        : endpoint
          ? "ok"
          : "suspected_placeholder";

      const operationId = text(op.operationId);
      const summary = text(op.summary);
      const operationTags = Array.isArray(op.tags)
        ? op.tags.map(text).filter(Boolean)
        : [];
      const label = operationId || summary || `${method} ${path}`;
      if (!operationId && !summary) {
        opWarnings.push("neither operationId nor summary; label derived from method and path");
      }

      candidates.push({
        api_endpoint: endpoint,
        http_method: method as HttpMethod,
        api_name: [infoTitle, label].filter(Boolean).join(" "),
        official_api_name: operationId || summary,
        description: text(op.description) || summary,
        company_name: companyName,
        operation_id: operationId,
        operation_summary: summary,
        operation_path: path,
        operation_tags: operationTags,
        has_callbacks: isObject(op.callbacks) && Object.keys(op.callbacks).length > 0,
        // The 3.x shape first; a 2.0 document states the same things in
        // consumes/produces, so those are read only where content found none.
        input_formats: (() => {
          const stated = mediaTypes(op.requestBody, doc, opWarnings);
          return stated.length > 0 ? stated : swaggerMediaTypes(op, doc, "consumes");
        })(),
        output_formats: (() => {
          const stated = responseMediaTypes(op, doc, opWarnings);
          return stated.length > 0 ? stated : swaggerMediaTypes(op, doc, "produces");
        })(),
        authentication_raw: authenticationRaw(op, doc, opWarnings),
        data_quality: quality,
        warnings: opWarnings,
      });
    }
  }

  // Within one import the derived names must be distinct: when two operations
  // share one, append the facts that tell them apart. Never a counter -- a
  // counter depends on iteration order.
  const byName = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = c.api_name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), c]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const c of group) {
      let pathPart = "";
      try {
        pathPart = c.api_endpoint ? new URL(c.api_endpoint).pathname : "";
      } catch {
        pathPart = "";
      }
      c.api_name = `${c.api_name} ${c.http_method}${pathPart ? ` ${pathPart}` : ""}`;
      c.warnings.push("name collided inside this document; method and path appended");
    }
  }

  return { candidates, info_title: infoTitle, info_version: infoVersion, warnings };
}
