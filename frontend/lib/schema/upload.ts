// A person's upload -> schemas ready to store. Pure: no network, no database,
// no clock.
//
// Extraction needs a document the server can fetch. Fifty-four catalogue
// records cannot offer one -- their documentation is behind a login, a
// regional block or an anti-bot wall (data_quality = 'access_restricted') --
// and for those a person supplying the schema is the only way into the
// BP-Builder. The client allowed exactly this on 10 September: "you can also
// request user to upload schema of api / invoice at any stage".
//
// Two shapes are accepted, because both are what people actually have:
//
//   openapi  a whole OpenAPI 3 document, JSON or YAML. The client's own
//            demonstration inputs are this shape: one document, one operation.
//   schema   one JSON Schema for one side of one operation, for when a
//            provider publishes a schema but no OpenAPI document.

import { parse as parseYaml } from "yaml";

import { detect } from "../import/detect.ts";
import { isObject } from "../openapi/ref.ts";
import {
  dereferenceSchema,
  extractDocumentSchemas,
  flattenSchema,
  type ExtractedSchema,
} from "./extract.ts";
import { chainableSchemas, isChainable } from "./rows.ts";

/** Larger than any single schema in the four fixtures; small enough to hold in memory. */
export const MAX_UPLOAD_CHARS = 500_000;

const MAX_YAML_ALIASES = 100;

/** Keywords that make an object a schema rather than an example payload. */
const SCHEMA_KEYWORDS = [
  "type", "properties", "items", "allOf", "oneOf", "anyOf", "$ref", "enum", "required",
];

export type OperationRef = { path: string; method: string };

export type UploadInput =
  | { kind: "openapi"; text: string; operation?: OperationRef }
  | {
      kind: "schema";
      text: string;
      direction: "request" | "response";
      status_code?: string;
      media_type?: string;
    };

export type UploadResult =
  | { ok: true; schemas: ExtractedSchema[] }
  | { ok: false; error: string; operations?: OperationRef[] };

function parseStructured(text: string): unknown {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to YAML, which also accepts most JSON */
    }
  }
  return parseYaml(trimmed, { maxAliasCount: MAX_YAML_ALIASES });
}

function fromOpenApi(text: string, operation: OperationRef | undefined): UploadResult {
  const detection = detect(text, "");
  if (detection.format === "swagger_2") {
    return { ok: false, error: "This is a Swagger 2.0 document. Only OpenAPI 3 can be uploaded at the moment." };
  }
  if (detection.format !== "openapi_3") {
    return { ok: false, error: "This is not an OpenAPI 3 document." };
  }

  // Only operations that state something chainable count as choices: an
  // operation with nothing but error responses has nothing to compare.
  const found = extractDocumentSchemas(detection.document)
    .map((d) => ({ ...d, schemas: chainableSchemas(d.schemas) }))
    .filter((d) => d.schemas.length > 0);
  const operations = found.map((d) => ({ path: d.operation_path, method: d.http_method }));

  if (found.length === 0) {
    return { ok: false, error: "The document states no request or success-response schema." };
  }

  if (operation) {
    const method = operation.method.toUpperCase();
    const match = found.find((d) => d.operation_path === operation.path && d.http_method === method);
    if (!match) {
      return { ok: false, error: `The document has no ${method} ${operation.path} with a schema.`, operations };
    }
    return { ok: true, schemas: match.schemas };
  }

  // One catalogue record is one operation. A document with several cannot be
  // attached to it without saying which -- guessing would put the wrong
  // operation's schema on the record and nothing downstream would notice.
  if (found.length > 1) {
    return {
      ok: false,
      error: `The document has ${found.length} operations with schemas. Choose the one this API is.`,
      operations,
    };
  }
  return { ok: true, schemas: found[0]!.schemas };
}

function fromSchema(input: Extract<UploadInput, { kind: "schema" }>): UploadResult {
  let parsed: unknown;
  try {
    parsed = parseStructured(input.text);
  } catch {
    return { ok: false, error: "The schema could not be read as JSON or YAML." };
  }
  if (!isObject(parsed)) {
    return { ok: false, error: "A schema must be an object." };
  }
  if (!SCHEMA_KEYWORDS.some((k) => k in parsed)) {
    // The commonest mistake: pasting an example invoice instead of the schema
    // that describes it. Treating it as a schema would store an object with
    // no type and no fields -- accepted, and useless.
    return {
      ok: false,
      error: "This looks like an example payload, not a schema: it has none of type, properties, items or $ref.",
    };
  }

  const direction = input.direction;
  const status = direction === "response" ? (input.status_code?.trim() || "200") : null;
  if (direction === "response" && !isChainable({ direction, status_code: status })) {
    return { ok: false, error: `Status ${status} is an error response; only success responses are stored.` };
  }

  // The schema is its own root: a pasted schema that uses "#/definitions/X"
  // or "#/$defs/X" refers to itself.
  const warnings: string[] = [];
  const raw = dereferenceSchema(parsed, parsed, warnings);
  const { fields, warnings: flatWarnings } = flattenSchema(raw, {});
  if (fields.length === 0) {
    return { ok: false, error: "The schema describes no fields." };
  }
  return {
    ok: true,
    schemas: [{
      direction,
      media_type: input.media_type?.trim() || "application/json",
      status_code: status,
      raw,
      fields,
      warnings: [...new Set([...warnings, ...flatWarnings])],
    }],
  };
}

export function resolveUpload(input: UploadInput): UploadResult {
  if (typeof input.text !== "string" || input.text.trim() === "") {
    return { ok: false, error: "Nothing was uploaded." };
  }
  if (input.text.length > MAX_UPLOAD_CHARS) {
    return { ok: false, error: `The upload is larger than ${MAX_UPLOAD_CHARS.toLocaleString("en-AU")} characters.` };
  }
  return input.kind === "openapi" ? fromOpenApi(input.text, input.operation) : fromSchema(input);
}
