/**
 * How a generated Lambda wrapper calls one API (#62, review of #110).
 *
 * The first wrappers sent the previous step's document as the request body,
 * but no API in the client's chain takes it that way: Upbrains wants the PDF
 * as base64 in `fileBase64`, AmitTransform the invoice under `invoiceData`
 * beside two fixed settings, ESS the XML as base64 in `content`, Mailgun a
 * multipart form with the invoice as an attachment, and AmitTransform answers
 * with the XML inside its `xml` field. The stored schemas already say all of
 * this, and `findCarrier` (lib/checks/documents.ts) reads it for the checks;
 * the plan below reads it the same way for the wrapper.
 *
 *   request   body    the document is the whole body (B2Brouter, beliq)
 *             file    multipart, the document in a file field (Mailgun `attachment`)
 *             base64  JSON, the document base64-encoded in one field (Upbrains, ESS)
 *             json    JSON fields; the document goes in the one required object
 *                     field (AmitTransform `invoiceData`) or, as text, in the one
 *                     required string named for XML (Billit `XML`), or is the body itself
 *   response  text    the document is one JSON string field (AmitTransform `xml`)
 *             body    the body is the document (XML as text, anything else base64)
 *             json    the parsed JSON is the result (Upbrains' extraction)
 *
 * Settings are the request's other top-level fields. A required one with a
 * single allowed value is filled in (`invoiceType: "JSON"`); every other
 * required one is listed for the deployer, who supplies it in REQUEST_FIELDS,
 * because only they know a recipient, a sender or a file name. Optional
 * settings are left out.
 */
import { BODY_FIELD } from "../checks/fields.ts";
import { findCarrier } from "../checks/documents.ts";
import type { SchemaRecord } from "../checks/types.ts";

export type RequestKind = "body" | "file" | "base64" | "json";
export type ResponseKind = "text" | "body" | "json";

export interface CallPlan {
  request: {
    kind: RequestKind;
    /** Media type of the request, from the schema; null when none is stored. */
    media: string | null;
    /** The field the document goes in; null for a body, or JSON sent as the body. */
    field: string | null;
    /** Required settings with one allowed value. */
    fixed: Record<string, string | number | boolean>;
    /** Required settings the deployer must supply. */
    required: string[];
  };
  response: { kind: ResponseKind; field: string | null };
  /** False when no request or 2xx response schema is stored, so the plan is the default guess. */
  from_schema: { request: boolean; response: boolean };
}

const SUCCESS = /^(2\d\d|default)$/i;

function topFields(schema: SchemaRecord) {
  return schema.fields.filter((field) => field.depth === 0);
}

function leaf(path: string): string {
  return path.replace(/\[\]$/, "");
}

function singleValue(field: SchemaRecord["fields"][number]): string | number | boolean | undefined {
  const values = field.enum_values ?? [];
  if (values.length !== 1) return undefined;
  const [value] = values;
  if (field.json_type === "boolean") return value === "true";
  if (field.json_type === "integer" || field.json_type === "number") return Number(value);
  return value;
}

/** The request schema the wrapper builds: one that carries the document, else the first stored. */
function requestSchema(schemas: readonly SchemaRecord[], category: string): SchemaRecord | null {
  const requests = schemas.filter((schema) => schema.direction === "request");
  return requests.find((schema) => findCarrier(schema, category)) ?? requests[0] ?? null;
}

function responseSchema(schemas: readonly SchemaRecord[]): SchemaRecord | null {
  const responses = schemas.filter((schema) => schema.direction === "response" && SUCCESS.test(schema.status_code ?? ""));
  return responses.find((schema) => /json/i.test(schema.media_type ?? "")) ?? responses[0] ?? null;
}

export function callPlan(category: string, schemas: readonly SchemaRecord[]): CallPlan {
  const request = requestSchema(schemas, category);
  const response = responseSchema(schemas);
  const plan: CallPlan = {
    request: { kind: "json", media: request?.media_type?.trim().toLowerCase() || null, field: null, fixed: {}, required: [] },
    response: { kind: "json", field: null },
    from_schema: { request: !!request, response: !!response },
  };

  if (request) {
    const carrier = findCarrier(request, category);
    const documentPath = carrier?.path ?? null;
    if (carrier?.kind === "body") plan.request.kind = "body";
    else if (carrier?.kind === "file") plan.request.kind = "file";
    else if (carrier?.kind === "base64") plan.request.kind = "base64";
    const top = topFields(request);
    if (plan.request.kind === "file" || plan.request.kind === "base64") {
      plan.request.field = leaf(documentPath!);
    } else if (carrier?.kind === "text") {
      // JSON whose one required string is the document (Billit `XML`): the text goes in that field as it is.
      plan.request.field = leaf(carrier.path);
    } else if (plan.request.kind === "json") {
      const objects = top.filter((field) => field.is_required && field.json_type === "object");
      if (objects.length === 1) plan.request.field = objects[0].path;
    }
    for (const field of top) {
      const name = leaf(field.path);
      if (!field.is_required || name === plan.request.field || field.path === BODY_FIELD || field.path.endsWith("[]")) continue;
      const value = singleValue(field);
      if (value !== undefined) plan.request.fixed[name] = value;
      else plan.request.required.push(name);
    }
  }

  if (response) {
    const carrier = findCarrier(response, category);
    if (carrier?.kind === "text") plan.response = { kind: "text", field: carrier.path };
    else if (carrier?.kind === "body") plan.response = { kind: "body", field: null };
    else if (!/json/i.test(response.media_type ?? "") && response.fields.length === 0) plan.response = { kind: "body", field: null };
  }
  return plan;
}

/** One top-level field of the request a wrapper builds, for the workflow canvas's input list. */
export interface RequestField {
  name: string;
  required: boolean;
  type: string | null;
}

/** The top-level fields of the request schema `callPlan` builds from, or null when none is stored. */
export function requestFields(category: string, schemas: readonly SchemaRecord[]): RequestField[] | null {
  const request = requestSchema(schemas, category);
  if (!request) return null;
  return topFields(request)
    .filter((field) => field.path !== BODY_FIELD)
    .map((field) => ({ name: leaf(field.path), required: field.is_required, type: field.json_type ?? null }));
}
