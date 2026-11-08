// Identify what a fetched body is, from its content -- never from its URL.
// Two counterexamples already in the data:
// Peru's WSDL address is a query parameter, Serbia's Swagger UI page ends in
// .html. Detection names every format it recognises, including the ones this
// release refuses, because a refusal that names the format is the data that
// decides what the next release implements.

import { parse as parseYaml } from "yaml";
import type { DetectedFormat } from "./types.ts";

export type Detection =
  | { format: "openapi_3" | "swagger_2"; document: unknown }
  | { format: "wsdl" }
  | {
      format: "html_page";
      /** The document address stated inline on the page, when there is one. */
      specUrl?: string;
      /** Initialiser scripts the page loads; Swagger UI keeps its `url:`
       *  there (Serbia's page does). Same-origin, for the fetch layer to try
       *  through every safety gate. */
      configScriptUrls: string[];
    }
  | { format: "unknown" };

// yaml's maxAliasCount bounds anchor/alias expansion ("billion laughs"): the
// input is small, the expansion is not, and it happens inside the YAML
// parser before any of our logic runs.
const MAX_YAML_ALIASES = 100;

function classifyObject(doc: unknown): Detection | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (typeof d.openapi === "string" && d.openapi.trim().startsWith("3")) {
    return { format: "openapi_3", document: doc };
  }
  if (typeof d.swagger === "string") return { format: "swagger_2", document: doc };
  return null;
}

/** Pull a document address out of Swagger UI / Redoc markup or initialiser
 *  JS. Handles: url: "..." (initialiser), spec-url="..." (Redoc). */
export function extractSpecUrl(textContent: string, baseUrl: string): string | undefined {
  const patterns = [
    // SwaggerUIBundle({ url: "..." }) and the JSON "url":"..." form, including
    // the first entry of a "urls":[{url,name}] array (Serbia uses that).
    /["']?url["']?\s*:\s*["']([^"']+)["']/,
    /["']?spec-url["']?\s*[:=]\s*["']([^"']+)["']/i, // <redoc spec-url="...">
    /["']?data-url["']?\s*[:=]\s*["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = textContent.match(p);
    if (m) {
      try {
        return new URL(m[1], baseUrl).toString();
      } catch {
        /* fall through to the next pattern */
      }
    }
  }
  return undefined;
}

/**
 * Documentation sites built on ReadMe (B2Brouter) or Mintlify (EzzyBills)
 * publish one page per operation and serve a Markdown copy of it, at the
 * page address plus ".md", with the operation's OpenAPI definition in a
 * fenced block. The page is the provider's own source for that operation, so
 * it is read rather than refused. Fences may use three or more backticks
 * (Mintlify uses four); only json, yaml and yml blocks are tried.
 */
function embeddedDefinition(body: string): Detection | null {
  const fence = /^(`{3,})[ \t]*(json|ya?ml)\b[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gim;
  for (const m of body.matchAll(fence)) {
    try {
      const doc = m[2].toLowerCase() === "json" ? JSON.parse(m[3]) : parseYaml(m[3], { maxAliasCount: MAX_YAML_ALIASES });
      const found = classifyObject(doc);
      if (found) return found;
    } catch {
      /* not this block; try the next */
    }
  }
  return null;
}

export function detect(body: string, sourceUrl: string): Detection {
  const trimmed = body.replace(/^﻿/, "").trimStart();

  // JSON first: cheapest, and most machine documents are JSON.
  if (trimmed.startsWith("{")) {
    try {
      const found = classifyObject(JSON.parse(trimmed));
      if (found) return found;
    } catch {
      /* not JSON; keep going */
    }
  }

  // Markup: WSDL or an HTML documentation page.
  if (trimmed.startsWith("<")) {
    const head = trimmed.slice(0, 4000);
    if (/<(wsdl:)?definitions[\s>]/i.test(head)) return { format: "wsdl" };
    if (/<(!doctype\s+)?html[\s>]/i.test(head) || /<html[\s>]/i.test(head)) {
      const isApiDocPage = /swagger-ui|redoc|openapi/i.test(body);
      if (!isApiDocPage) return { format: "unknown" };
      const specUrl = extractSpecUrl(body, sourceUrl);
      const configScriptUrls: string[] = [];
      if (!specUrl) {
        // Swagger UI's stock page keeps its config in a sibling script
        // (index.js / swagger-initializer.js); Serbia's page is exactly this.
        for (const m of body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
          const src = m[1];
          if (/(swagger-initializer|index)\.js(\?|$)/i.test(src) && !/bundle|preset/i.test(src)) {
            try {
              configScriptUrls.push(new URL(src, sourceUrl).toString());
            } catch {
              /* unusable src; skip it */
            }
          }
        }
      }
      return { format: "html_page", specUrl, configScriptUrls };
    }
    return { format: "unknown" };
  }

  // A Markdown page with the definition in a fenced block.
  if (body.includes("```")) {
    const found = embeddedDefinition(body);
    if (found) return found;
  }

  // YAML last: it accepts almost anything, so it goes after the cheap tests.
  try {
    const found = classifyObject(parseYaml(body, { maxAliasCount: MAX_YAML_ALIASES }));
    if (found) return found;
  } catch {
    /* not YAML either */
  }

  return { format: "unknown" };
}

export function formatName(format: DetectedFormat): string {
  switch (format) {
    case "openapi_3": return "OpenAPI 3.x";
    case "swagger_2": return "Swagger 2.0";
    case "wsdl": return "WSDL (SOAP)";
    case "html_page": return "an API documentation page";
    default: return "an unrecognised format";
  }
}
