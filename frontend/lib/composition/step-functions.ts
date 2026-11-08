/**
 * Step Functions workflow for a chosen chain (#62), ready to deploy on AWS.
 *
 *   chain (API ids, process order) + catalogue records and their schemas
 *     ─▶ state machine definition (Amazon States Language, JSON and YAML)
 *     ─▶ one Lambda function per API (Python 3.12), plus the group's adapter
 *        steps where a chain needs them (Node.js)
 *     ─▶ an AWS SAM template that creates all of them with one `sam deploy`
 *
 * Follows the client's guide of 16 October 2026 ("AWS Step Functions: A
 * Beginner's Guide to Building Your BP Workflow") and the client's review of
 * 24 October 2026:
 *
 * - Step Functions calls only Lambda functions, so every API becomes one Task
 *   that invokes its own function (`arn:aws:states:::lambda:invoke`, which the
 *   console draws as a Lambda step). Each state is named after its API and its
 *   position ("01 Upbrains Extract Invoice From PDF"), and so is its function.
 * - The adapter steps between two APIs that do not fit as they are are states
 *   of their own in the diagram, named for what they do.
 * - Each Task keeps its result under its own key (ResultPath) instead of
 *   overwriting the document, and a later Task picks the document it needs
 *   with InputPath. A function reads `event["document"]` and returns
 *   `{"document": ..., "status": "ok"}`, so the shapes chain.
 * - After a validator, a Choice reads `$.validation.isValid`: only a boolean
 *   true goes on; anything else goes to `Validation failed`. An execution
 *   input without a document goes to `Workflow input rejected`, and an error
 *   in any step to `Composition failed`, with that step's error and cause.
 * - Credentials are read from AWS Secrets Manager, never written into the
 *   template, the definition or an environment variable; values only the
 *   deploying company knows (an endpoint's path parameters, a sender address)
 *   are the template's parameters. Endpoint, method and authentication come
 *   from the catalogue record.
 *
 * Each function sends the request its API takes and reads the document out of
 * its answer, as the API's stored schemas say (`callPlan`, workflow-calls.ts).
 * Between an Upbrains extraction and AmitTransform's conversion the workflow
 * runs the same two deterministic steps as /api/composed/pdf-invoice (#96):
 * mapExtractionToAmit before the converter and enrichAmitXml after it, as
 * Node.js functions built from that code.
 *
 * Pure: no AWS or provider call is made here.
 */

import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

import type { SchemaRecord } from "../checks/types.ts";
import { planProcess, roleOf } from "./compose.ts";
import { STEP_CATEGORIES, type Chain, type ProcessIssue, type StepCategory, type StepRole } from "./types.ts";
import { callPlan, type CallPlan } from "./workflow-calls.ts";
import { INVOICE_MAPPING_JS, INVOICE_XML_JS, PEPPOL_BIS3_COPY_JS, XMLDOM_FILES, XMLDOM_VERSION } from "./workflow-lambda-sources.generated.ts";

/** The catalogue fields the generator reads; `CompositionApi` satisfies it. */
export interface WorkflowApi {
  id: string;
  api_name: string;
  company_name: string;
  category: string;
  api_endpoint: string | null;
  http_method: string | null;
  authentication_method: string | null;
  authentication_details: string | null;
  input_formats?: readonly string[] | null;
  output_formats?: readonly string[] | null;
  client_types?: readonly string[] | null;
  /** Stored request and response schemas; without them a function sends the document as a JSON body. */
  schemas?: readonly SchemaRecord[];
}

export interface WorkflowOptions {
  /** The state machine's name and the downloaded files' stem. */
  name?: string;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type StateMachineDefinition = { Comment: string; StartAt: string; States: Record<string, Record<string, Json>> };

export interface LambdaFile {
  path: string;
  content: string;
}

/** A value only the deploying company knows, asked for by `sam deploy`. */
export interface DeployParameter {
  name: string;
  description: string;
  /** Hidden in the console: an address that is itself the credential (Upbrains' flow id). */
  no_echo: boolean;
  default?: string;
}

/** A Secrets Manager secret the deploying company creates before `sam deploy`. */
export interface WorkflowSecret {
  name: string;
  /** The APIs that read it. */
  apis: string[];
  /** What the secret's text is. */
  value: string;
}

export interface LambdaTemplate {
  /** Position in the workflow, counting the adapter steps. */
  order: number;
  /** The catalogue API it wraps; null for an adapter step. */
  api_id: string | null;
  api_name: string;
  company_name: string;
  /** "Mapping" for an adapter step the generator adds between two APIs. */
  category: StepCategory | "Mapping";
  /** The state's name in the diagram. */
  state_name: string;
  /** The Lambda function's name. */
  function_name: string;
  /** The function's logical id in template.yaml. */
  logical_id: string;
  /** The definition substitution that becomes this function's ARN. */
  substitution: string;
  /** That substitution as it appears in the definition: `${Step01FunctionArn}`. */
  arn_placeholder: string;
  runtime: "python3.12" | "nodejs22.x";
  handler: string;
  timeout_seconds: number;
  /** Environment variables; a `${Parameter}` in a value is filled from the deploy parameters (`Fn::Sub`). */
  environment: Record<string, string>;
  /** The Secrets Manager secret holding its credential, if its API needs one. */
  secret: string | null;
  /** How the function calls its API; null for an adapter step. */
  call: CallPlan | null;
  /** What the deployer does for this function: its secret and parameters. */
  setup: string[];
  /** The function's files, relative to its folder. */
  files: LambdaFile[];
}

export interface WorkflowBundle {
  name: string;
  definition: StateMachineDefinition;
  json: string;
  yaml: string;
  /** The AWS SAM template that deploys the functions and the state machine. */
  template: Record<string, Json>;
  template_yaml: string;
  lambdas: LambdaTemplate[];
  parameters: DeployParameter[];
  secrets: WorkflowSecret[];
  /** True when the execution input may carry mapping options (an adapter step reads them). */
  uses_options: boolean;
  /** Facts a user should see before deploying, such as an API with no recorded endpoint. */
  warnings: string[];
}

export type WorkflowIssueCode = "empty_chain" | "unknown_api" | "unsupported_category";
export type WorkflowIssue = ProcessIssue | { code: WorkflowIssueCode; step?: number; message: string };
export type WorkflowResult = { ok: true; workflow: WorkflowBundle } | { ok: false; issues: WorkflowIssue[] };

const INPUT_CHECK = "Check workflow input";
const INPUT_REJECTED = "Workflow input rejected";
const VALIDATION_FAILED = "Validation failed";
const COMPOSITION_FAILED = "Composition failed";
const DONE_STATE = "Done";
const STATE_NAME_LIMIT = 80;
const FUNCTION_NAME_LIMIT = 64;
const TIMEOUT_SECONDS = 60;
const SECRET_PREFIX = "bp-builder";

/** Retry the Lambda service's transient errors, as AWS recommends for Lambda Tasks. */
const LAMBDA_RETRY: Json = [{
  ErrorEquals: ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"],
  IntervalSeconds: 2,
  MaxAttempts: 3,
  BackoffRate: 2,
}];
/** Any other error ends the run at Composition failed, keeping the error under $.error. */
const CATCH: Json = [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: COMPOSITION_FAILED }];

function categoryOf(value: string): StepCategory | null {
  return STEP_CATEGORIES.find((category) => category.toLowerCase() === value.trim().toLowerCase()) ?? null;
}

function words(text: string): string[] {
  return text.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function pascal(text: string): string {
  return words(text).map((word) => word[0].toUpperCase() + word.slice(1)).join("");
}

function pad(order: number): string {
  return String(order).padStart(2, "0");
}

/** "EB Software Services (ESS)" → "ESS"; "Reckon One" → "ReckonOne". */
function companyShort(company: string): string {
  return pascal(company.match(/\(([^)]+)\)/)?.[1] ?? company) || "Api";
}

/** "Upbrains Extract Invoice From PDF API" → "Upbrains Extract Invoice From PDF". */
function apiLabel(apiName: string): string {
  return apiName.replace(/\s+API$/i, "").replace(/[^A-Za-z0-9 ._()-]+/g, " ").replace(/\s+/g, " ").trim() || "API";
}

function stateName(order: number, label: string): string {
  return `${pad(order)} ${label}`.slice(0, STATE_NAME_LIMIT).trim();
}

function functionName(prefix: string, order: number, label: string): string {
  return `${prefix}-${pad(order)}-${pascal(label)}`.slice(0, FUNCTION_NAME_LIMIT);
}

/** Upbrains extraction followed by AmitTransform's JSON-to-UBL conversion: the pair #96 maps. */
function needsAmitMapping(from: WorkflowApi, to: WorkflowApi, toPlan: CallPlan): boolean {
  return /upbrains/i.test(from.company_name) && /amittransform/i.test(to.company_name) && toPlan.request.field === "invoiceData";
}

function needsCredential(method: string | null): boolean {
  return !["", "none"].includes((method ?? "").trim().toLowerCase());
}

/** API-key headers the group's own calls use (pdf-invoice.ts, peppol-invoice.ts), for records whose note does not say. */
const KNOWN_KEY_HEADERS: Array<[RegExp, string]> = [
  [/\bESS\b|smartdocflow/i, "x-api-key"],
  [/b2brouter/i, "X-B2B-API-Key"],
  [/billit/i, "apiKey"],
];

/**
 * The header an API key goes in: named in the catalogue's note ("API key in the
 * x-api-key header", "Request header apiKey with the key"), else a known provider's.
 */
function apiKeyHeader(api: WorkflowApi): string | null {
  const note = api.authentication_details ?? "";
  const named = [...note.matchAll(/\b([A-Za-z][\w-]*)\s+header\b|\bheader\s+([A-Za-z][\w-]*)/gi)]
    .map((match) => match[1] ?? match[2])
    .find((name) => /^x-[\w-]+$|key|token|auth/i.test(name));
  return named
    ?? KNOWN_KEY_HEADERS.find(([pattern]) => pattern.test(`${api.company_name} ${api.api_endpoint ?? ""}`))?.[1]
    ?? null;
}

/** Defaults for request settings the deployer may keep. */
const SETTING_DEFAULTS: Record<string, string> = {
  filename: "invoice.xml",
  subject: "Invoice from the BP-Builder workflow",
  text: "The invoice is attached as a UBL XML file. It passed validation before it was sent.",
};

/** Mailgun sends nothing without one of these (it answers 400). */
const MAILGUN_BODY_FIELDS = ["text", "html", "amp-html", "template"];

/**
 * Settings the group's own calls send (pdf-invoice.ts) that the stored schemas
 * do not mark as required: Mailgun needs a message body, which the deployer
 * can keep as the default text, and ESS is told the rule pack, "billing".
 */
function addKnownSettings(api: WorkflowApi, plan: CallPlan): void {
  const named = (field: string) => field in plan.request.fixed || plan.request.required.includes(field);
  if (/mailgun/i.test(api.company_name) && plan.request.kind === "file" && !MAILGUN_BODY_FIELDS.some(named)) {
    plan.request.required.push("text");
  }
  if (/smartdocflow/i.test(api.api_endpoint ?? "") && plan.request.kind === "base64" && !named("pack")) {
    plan.request.fixed.pack = "billing";
  }
}

/**
 * B2Brouter's import only stores a draft unless it is asked to issue the
 * invoice and send it. peppol-invoice.ts sends these, with the BIS 3.0
 * document type its sandbox recipients take.
 */
const B2BROUTER_SEND_QUERY = new URLSearchParams({
  issued: "true",
  send_after_import: "true",
  transport_type_code_for_contact: "peppol",
  document_type_code_for_contact: "xml.ubl.invoice.bis3",
}).toString();

/**
 * B2Brouter answers the import with 201 even when it could not send the invoice: the
 * invoice's state is then "error" and the reason is in its errors (peppol-invoice.ts reads
 * them the same way). The step fails, so the run does not report a send that did not happen.
 */
const B2BROUTER_SEND_CHECK = [
  '    invoice = result.get("invoice") if isinstance(result, dict) else None',
  '    if isinstance(invoice, dict) and (invoice.get("state") in ("error", "refused") or invoice.get("errors")):',
  '        reasons = [str(item.get("error") if isinstance(item, dict) else item) for item in invoice.get("errors") or []]',
  '        if invoice.get("refuse_reason"):',
  '            reasons.append(str(invoice["refuse_reason"]))',
  '        reasons = list(dict.fromkeys(reason for reason in reasons if reason))',
  '        raise ApiError(f"B2Brouter did not send invoice {invoice.get(\'number\')} (state {invoice.get(\'state\')}): {\'; \'.join(reasons) or \'no reason given\'}")',
];

function isB2BrouterImport(api: WorkflowApi): boolean {
  return /b2brouter/i.test(api.company_name) && /\/invoices\/import\/?$/.test(api.api_endpoint ?? "");
}

function py(value: unknown): string {
  // JSON literals are Python literals here: only strings, numbers, booleans, lists and dicts are written.
  return JSON.stringify(value).replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None");
}

function authenticationLines(method: string | null): string[] {
  switch ((method ?? "").trim()) {
    case "":
    case "None":
      return ["    # The catalogue records no authentication for this API."];
    case "Basic":
      return [
        "    # The secret holds user:password (Mailgun: api:<key>).",
        '    headers["Authorization"] = "Basic " + base64.b64encode(credential().encode()).decode()',
      ];
    case "Token":
    case "OAuth2":
      return ['    headers["Authorization"] = "Bearer " + credential()'];
    default:
      return [
        "    # The header name is provider-specific: see the authentication note above.",
        '    headers[os.environ.get("API_KEY_HEADER", "x-api-key")] = credential()',
      ];
  }
}

function returnLines(role: StepRole): string[] {
  if (role === "checks") {
    return [
      "    # The state machine's decision reads isValid by name: return it as a boolean.",
      "    # The catalogue's validators report their verdict differently: ESS answers",
      '    # "status": "success" (HTTP 200) or "error" (HTTP 400), Peppol Validator',
      '    # "status": "valid" or "invalid", and ECOSIO a boolean "success". Anything else is not valid.',
      "    verdict = False",
      "    if isinstance(result, dict):",
      '        flags = [result[key] for key in ("isValid", "success", "valid") if isinstance(result.get(key), bool)]',
      '        verdict = flags[0] if flags else result.get("status") in ("success", "valid")',
      '    return {"isValid": verdict, "report": result}',
    ];
  }
  if (role === "delivers") return ['    return {"receipt": result, "status": "ok"}'];
  // The mapping options travel on, so the first step can drop the (large) execution input.
  return ['    return {"document": result, "options": event.get("options"), "status": "ok"}'];
}

const PYTHON_HELPERS = `

class ApiError(Exception):
    """The API answered with an error status. Step Functions shows this name and the message."""


_secret = {}


def credential():
    """The API's credential: the Secrets Manager secret named in SECRET_NAME, else API_TOKEN (a console test)."""
    name = os.environ.get("SECRET_NAME")
    if not name:
        return os.environ.get("API_TOKEN", "")
    if name not in _secret:
        import boto3  # in the Lambda Python runtime

        _secret[name] = boto3.client("secretsmanager").get_secret_value(SecretId=name)["SecretString"].strip()
    return _secret[name]


def document_bytes(document):
    """The document as bytes, with its media type and a file name for a form."""
    if isinstance(document, dict) and "s3" in document:
        ref = document["s3"]
        bucket = os.environ.get("INPUT_BUCKET", "")
        prefix = os.environ.get("INPUT_PREFIX", "")
        if not isinstance(ref, dict) or not bucket or not prefix or ref.get("bucket") != bucket:
            raise ValueError("Stored invoice is not in this workflow's input bucket.")
        key = ref.get("key")
        if not isinstance(key, str) or not key.startswith(prefix) or not key.endswith(".pdf"):
            raise ValueError("Stored invoice is not in this workflow's input prefix.")
        import boto3

        response = boto3.client("s3").get_object(Bucket=bucket, Key=key)
        body = response["Body"]
        try:
            data = body.read(4 * 1024 * 1024 + 1)
        finally:
            body.close()
        if len(data) > 4 * 1024 * 1024 or not data.startswith(b"%PDF-"):
            raise ValueError("Stored invoice must be a PDF of at most 4 MB.")
        return data, "application/pdf", "invoice.pdf"
    if isinstance(document, (dict, list)):
        return json.dumps(document).encode(), "application/json", "invoice.json"
    if isinstance(document, str):
        if document.lstrip().startswith("<"):
            return document.encode(), "application/xml", "invoice.xml"
        try:
            # The execution input carries a PDF or image as base64.
            data = base64.b64decode(document, validate=True)
        except (ValueError, binascii.Error):
            return document.encode(), "text/plain", "invoice.txt"
        if data[:4] == b"%PDF":
            return data, "application/pdf", "invoice.pdf"
        return data, "application/octet-stream", "invoice.bin"
    raise ValueError("No document: the previous state did not return one under 'document'.")


def settings():
    """The request's other fields: the fixed ones, then REQUEST_FIELDS from the template's parameters."""
    values = dict(FIXED_FIELDS)
    values.update(json.loads(os.environ.get("REQUEST_FIELDS") or "{}"))
    missing = [name for name in REQUIRED_SETTINGS if values.get(name) in (None, "", [])]
    if missing:
        raise ValueError("Set REQUEST_FIELDS for: " + ", ".join(missing))
    return values


def multipart(fields, file_field, file_name, media, data):
    boundary = "bp-builder-" + uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        for item in value if isinstance(value, list) else [value]:
            parts.append(f'--{boundary}\\r\\nContent-Disposition: form-data; name="{key}"\\r\\n\\r\\n{item}\\r\\n'.encode())
    parts.append(
        f'--{boundary}\\r\\nContent-Disposition: form-data; name="{file_field}"; filename="{file_name}"\\r\\n'
        f"Content-Type: {media}\\r\\n\\r\\n".encode() + data + b"\\r\\n"
    )
    parts.append(f"--{boundary}--\\r\\n".encode())
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


def build_request(document):
    if REQUEST_KIND == "body":
        data, media, _ = document_bytes(document)
        return data, REQUEST_MEDIA or media
    if REQUEST_KIND == "base64":
        data, _, _ = document_bytes(document)
        body = settings()
        body[DOCUMENT_FIELD] = base64.b64encode(data).decode()
        return json.dumps(body).encode(), "application/json"
    if REQUEST_KIND == "file":
        data, media, name = document_bytes(document)
        return multipart(settings(), DOCUMENT_FIELD, name, media, data)
    body = settings()
    if DOCUMENT_FIELD:
        body[DOCUMENT_FIELD] = document
    elif isinstance(document, dict):
        body = {**document, **body}
    else:
        body = document
    return json.dumps(body).encode(), "application/json"


def read_response(raw, content_type):
    if RESPONSE_KIND == "text":
        body = json.loads(raw)
        value = body.get(RESPONSE_FIELD) if isinstance(body, dict) else None
        if not isinstance(value, str):
            raise ValueError(f"The response has no {RESPONSE_FIELD} document.")
        return value
    if RESPONSE_KIND == "body":
        if "xml" in content_type or content_type.startswith("text/"):
            return raw.decode()
        return base64.b64encode(raw).decode()
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode(errors="replace")
`;

function callComment(plan: CallPlan): string[] {
  const request = {
    body: `the document is the whole request body${plan.request.media ? ` (${plan.request.media})` : ""}`,
    file: `multipart form; the document is the file field "${plan.request.field}"`,
    base64: `JSON; the document goes base64-encoded in "${plan.request.field}"`,
    json: plan.request.field ? `JSON; the document goes in "${plan.request.field}"` : "JSON; the document is the body",
  }[plan.request.kind];
  const response = {
    text: `JSON; the document is the string field "${plan.response.field}"`,
    body: "the response body is the document",
    json: "JSON; the parsed response is the result",
  }[plan.response.kind];
  return [
    `# Request (from the stored schema${plan.from_schema.request ? "" : ": none is stored, so this is a guess"}): ${request}.`,
    `# Response (${plan.from_schema.response ? "from the stored schema" : "none stored"}): ${response}.`,
  ];
}

function pythonSource(api: WorkflowApi, category: StepCategory, role: StepRole, name: string, plan: CallPlan): string {
  const note = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim() || "not recorded";
  const formats = (values: readonly string[] | null | undefined) => values?.length ? values.join(", ") : "not recorded";
  const method = (api.http_method ?? "POST").toUpperCase();
  const responseKind = role === "checks" ? "json" : plan.response.kind;
  return [
    `# ${name}: ${note(api.api_name)} (${note(api.company_name)}), ${category} step.`,
    `# Generated by the BP-Builder from catalogue record ${api.id}.`,
    "#",
    `# Input formats: ${formats(api.input_formats)}. Output formats: ${formats(api.output_formats)}.`,
    `# Client type: ${formats(api.client_types)}.`,
    `# Authentication: ${note(api.authentication_method)}. ${note(api.authentication_details)}`,
    ...callComment(plan),
    "#",
    "# Environment, set by template.yaml: API_ENDPOINT, SECRET_NAME (the Secrets Manager secret",
    "# with the credential, when the API needs one) and REQUEST_FIELDS (the settings only the",
    "# deploying company knows). Timeout 60 s.",
    "import base64",
    "import binascii",
    "import json",
    "import os",
    "import urllib.error",
    "import urllib.request",
    "import uuid",
    "",
    `METHOD = ${py(method)}`,
    `REQUEST_KIND = ${py(plan.request.kind)}`,
    `REQUEST_MEDIA = ${py(plan.request.kind === "body" ? plan.request.media : null)}`,
    `DOCUMENT_FIELD = ${py(plan.request.field)}`,
    `FIXED_FIELDS = ${py(plan.request.fixed)}`,
    `REQUIRED_SETTINGS = ${py(plan.request.required)}`,
    `RESPONSE_KIND = ${py(responseKind)}`,
    `RESPONSE_FIELD = ${py(responseKind === "text" ? plan.response.field : null)}`,
    PYTHON_HELPERS,
    "",
    "def lambda_handler(event, context):",
    "    # The document from the previous state's output; the first state reads the execution input.",
    '    body, content_type = build_request(event.get("document"))',
    '    headers = {"Content-Type": content_type, "Accept": "application/json"}',
    ...authenticationLines(api.authentication_method),
    "    request = urllib.request.Request(",
    '        os.environ["API_ENDPOINT"],',
    '        data=None if METHOD == "GET" else body,',
    "        headers=headers,",
    "        method=METHOD,",
    "    )",
    "    try:",
    "        with urllib.request.urlopen(request, timeout=55) as response:",
    "            raw = response.read()",
    '            answered = response.headers.get("Content-Type", "")',
    "    except urllib.error.HTTPError as error:",
    ...(role === "checks"
      ? [
        "        # A validator may answer an invalid document with an error status; keep its report.",
        "        raw = error.read()",
        '        answered = error.headers.get("Content-Type", "")',
      ]
      : ['        raise ApiError(f"HTTP {error.code}: {error.read()[:300].decode(errors=\'replace\')}") from None']),
    "    result = read_response(raw, answered.lower())",
    ...(isB2BrouterImport(api) ? B2BROUTER_SEND_CHECK : []),
    ...returnLines(role),
    "",
  ].join("\n");
}

const MAP_INDEX = (name: string, extractionKey: string) => `// ${name}: adapter between Upbrains and AmitTransform. Maps the extraction to
// AmitTransform's invoiceData with the group's #96 mapping (invoice-mapping.mjs, generated
// from invoice-mapping.ts), as /api/composed/pdf-invoice does. It refuses what it cannot
// balance or does not cover (more than one document, a credit note, a discount, an unknown
// unit, totals that do not add up) rather than guessing.
//
// Input: the whole state. The extraction is $.${extractionKey}.document; mapping options
// (profile, buyerReference, seller, buyer) are $.options in the execution input, if any.
// DEFAULT_PROFILE is the profile when the options name none.
import { mapExtractionToAmit, missingDataMessage, pintAunzMissingData } from "./invoice-mapping.mjs";

export const handler = async (event) => {
  const extraction = event?.${extractionKey}?.document;
  const options = { profile: process.env.DEFAULT_PROFILE || undefined, ...(event?.options ?? {}) };
  let mapped = mapExtractionToAmit(extraction, options);
  // As /api/composed/pdf-invoice does under PINT A-NZ: an Australian seller's ABN, printed as
  // its tax number, is also its legal registration and its electronic address (scheme 0151).
  const supplier = mapped.invoiceData.supplier;
  const printed = supplier?.partyTaxScheme?.companyID ?? "";
  if (mapped.profile === "pint-aunz" && supplier?.address?.countryCode === "AU" && /^\\d{11}$/.test(printed)) {
    if (options.seller?.legalRegistrationSchemeId === "0151" && options.seller.legalRegistrationId && options.seller.legalRegistrationId.replace(/\\s+/g, "") !== printed) {
      throw new Error("The entered seller ABN conflicts with the extraction. Confirm the invoice identity; do not replace it with the sandbox account's ABN. Use email for a valid invoice from another seller.");
    }
    const seller = { endpointId: printed, endpointSchemeId: "0151", legalRegistrationId: printed, legalRegistrationSchemeId: "0151", ...options.seller };
    mapped = mapExtractionToAmit(extraction, { ...options, seller });
  }
  // Stop here, before AmitTransform and ESS, when the Australian rules would refuse the invoice
  // for an item that neither the extraction nor the run's options supplied.
  if (mapped.profile === "pint-aunz") {
    const missing = pintAunzMissingData(mapped.invoiceData);
    if (missing.length) {
      const error = new Error(missingDataMessage(missing));
      error.name = "MissingInvoiceData";
      throw error;
    }
  }
  return { document: mapped.invoiceData, mapped, status: "ok" };
};
`;

const COMPLETE_INDEX = (name: string) => `// ${name}: adapter after AmitTransform. Completes the converter's XML with what it
// never writes (the specification identifiers, the currency on each amount, the tax
// breakdown, each line's tax category) and checks it kept every value it was given:
// enrichAmitXml, generated from invoice-xml.ts. Sent to ESS as it came, the converter's
// XML failed EN 16931 with 28 fatal errors (12 October 2026).
//
// Input: { "xml": the converter's XML, "mapped": the mapping step's result }.
import { enrichAmitXml } from "./invoice-xml.mjs";

export const handler = async (event) => ({ document: enrichAmitXml(event.xml, event.mapped), status: "ok" });
`;

const BIS3_INDEX = (name: string) => `// ${name}: adapter before B2Brouter. B2Brouter's sandbox recipients receive only
// Peppol BIS Billing 3.0, and an invoice it reads as PINT A-NZ is not sent (seen on
// 13 October 2026). So the validated PINT A-NZ invoice is handed over as a BIS 3.0
// copy: asPeppolBis3, generated from peppol-bis3-copy.ts, as /api/composed/pdf-invoice
// does. The copy changes the specification identifiers, the tax scheme's name and how
// a tax number is written; every amount, party and line is the same.
//
// Input: { "xml": the validated invoice }.
import { asPeppolBis3 } from "./peppol-bis3-copy.mjs";

export const handler = async (event) => {
  const copy = asPeppolBis3(event.xml);
  return { document: copy.xml, changes: copy.changes, status: "ok" };
};
`;

function packageJson(name: string, withXmldom: boolean): string {
  return `${JSON.stringify({
    name: name.replace(/[^A-Za-z0-9-]+/g, "-").toLowerCase(),
    private: true,
    type: "module",
    ...(withXmldom ? { dependencies: { "@xmldom/xmldom": XMLDOM_VERSION } } : {}),
  }, null, 2)}\n`;
}

/** "BP-Upbrains-AmitTransform-ESS-Mailgun", within the state machine name limit. */
function defaultName(steps: ReadonlyArray<{ api: WorkflowApi }>): string {
  return `BP-${steps.map(({ api }) => companyShort(api.company_name)).join("-")}`.slice(0, 80);
}

/**
 * Builds the workflow for one chain. The chain's API ids are in process order,
 * as `composeChains` returns them in `/api/composition`'s `composition.chains`;
 * their order is checked again with the client's rules, so a chain from
 * elsewhere is refused for the same reasons.
 */
export function generateWorkflow(
  chain: Pick<Chain, "api_ids"> & Partial<Pick<Chain, "status">>,
  catalogue: readonly WorkflowApi[],
  options: WorkflowOptions = {},
): WorkflowResult {
  if (chain.api_ids.length === 0) {
    return { ok: false, issues: [{ code: "empty_chain", message: "The chain has no APIs." }] };
  }
  const byId = new Map(catalogue.map((api) => [api.id, api]));
  const steps: Array<{ order: number; api: WorkflowApi; category: StepCategory; role: StepRole; plan: CallPlan }> = [];
  const issues: WorkflowIssue[] = [];
  chain.api_ids.forEach((id, index) => {
    const api = byId.get(id);
    const order = index + 1;
    if (!api) {
      issues.push({ code: "unknown_api", step: order, message: `API ${id} is not in the catalogue that was read.` });
      return;
    }
    const category = categoryOf(api.category);
    if (!category) {
      issues.push({ code: "unsupported_category", step: order, message: `${api.api_name} is categorised ${api.category}, which has no place in a workflow.` });
      return;
    }
    steps.push({ order, api, category, role: roleOf(category), plan: callPlan(category, api.schemas ?? []) });
  });
  if (issues.length) return { ok: false, issues };

  const planned = planProcess({ steps: steps.map(({ order, category, api }) => ({ order, category, task: api.api_name })) });
  if (planned.issues.length) return { ok: false, issues: planned.issues };

  const name = (options.name ?? "").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 80) || defaultName(steps);
  // Function names must be unique in an account: a short code for this chain keeps two chains apart.
  const prefix = `bp${createHash("sha256").update(chain.api_ids.join(",")).digest("hex").slice(0, 6)}`;
  const validators = steps.filter(({ role }) => role === "checks").length;
  // A mapped invoice checked by an Australian (PINT A-NZ) validator is mapped under that profile.
  const profile = steps.some(({ role, api }) => role === "checks" && /a-?nz|aunz/i.test(`${api.api_name} ${api.api_endpoint ?? ""}`))
    ? "pint-aunz"
    : "peppol-bis3";
  const warnings: string[] = [];

  // The states in order: one per API, with the adapter steps around a mapped conversion.
  type Node =
    | { kind: "api"; step: (typeof steps)[number] }
    | { kind: "map"; from: WorkflowApi; to: WorkflowApi }
    | { kind: "complete"; to: WorkflowApi }
    | { kind: "bis3"; to: WorkflowApi };
  const nodes: Node[] = [];
  steps.forEach((step, index) => {
    addKnownSettings(step.api, step.plan);
    const previous = steps[index - 1];
    const mapped = previous && needsAmitMapping(previous.api, step.api, step.plan);
    if (mapped) {
      // pdf-invoice.ts sends useFlexibleMapping: true with the mapped invoice; the mapping expects it.
      step.plan.request.fixed.useFlexibleMapping = true;
      nodes.push({ kind: "map", from: previous.api, to: step.api });
    }
    // Under PINT A-NZ, B2Brouter is given the BIS 3.0 copy of the validated invoice.
    if (step.role === "delivers" && profile === "pint-aunz" && isB2BrouterImport(step.api)) nodes.push({ kind: "bis3", to: step.api });
    nodes.push({ kind: "api", step });
    if (mapped) nodes.push({ kind: "complete", to: step.api });
  });
  const labels = nodes.map((node) => node.kind === "api"
    ? apiLabel(node.step.api.api_name)
    : node.kind === "map"
      ? `Adapter ${companyShort(node.from.company_name)} to ${companyShort(node.to.company_name)}`
      : node.kind === "complete"
        ? `Adapter complete ${companyShort(node.to.company_name)} UBL`
        : `Adapter Peppol BIS 3 copy for ${companyShort(node.to.company_name)}`);
  const names = labels.map((label, index) => stateName(index + 1, label));

  const states: Record<string, Record<string, Json>> = {};
  const lambdas: LambdaTemplate[] = [];
  const parameters: DeployParameter[] = [];
  const secrets = new Map<string, WorkflowSecret>();
  const parameterName = (api: WorkflowApi, order: number, field: string) => {
    const base = `${companyShort(api.company_name)}${pascal(field)}`;
    return parameters.some((parameter) => parameter.name === base) ? `Step${pad(order)}${pascal(field)}` : base;
  };

  states[INPUT_CHECK] = {
    Type: "Choice",
    Comment: "The execution input must carry the document: a base64 PDF or image, the XML text, or a JSON document.",
    Choices: [{
      And: [{ Variable: "$.document", IsPresent: true }, { Not: { Variable: "$.document", IsNull: true } }],
      Next: names[0],
    }],
    Default: INPUT_REJECTED,
  };
  states[INPUT_REJECTED] = {
    Type: "Fail",
    Error: "WorkflowInputRejected",
    Cause: 'The execution input needs "document": a base64 PDF or image, the XML text, or a JSON document. make_input.py writes it.',
  };

  // Where the current document lives: the execution input until a Transformation writes one.
  let documentPath: string | null = null;
  let transformations = 0;
  let lastTransformed: string | null = null;

  nodes.forEach((node, index) => {
    const order = index + 1;
    const state = names[index];
    const fn = functionName(prefix, order, labels[index]);
    const logicalId = `Step${pad(order)}Function`;
    const substitution = `Step${pad(order)}FunctionArn`;
    const placeholder = `\${${substitution}}`;
    const next = names[index + 1] ?? null;
    const task: Record<string, Json> = {
      Type: "Task",
      Resource: "arn:aws:states:::lambda:invoke",
      Parameters: { FunctionName: placeholder, "Payload.$": "$" },
    };
    const finish = (resultKey: string, selector: Record<string, string>) => {
      task.ResultSelector = selector;
      task.ResultPath = `$.${resultKey}`;
      task.Retry = LAMBDA_RETRY;
      task.Catch = CATCH;
    };

    if (node.kind === "map") {
      // Reads the whole state: the extraction and, if given, the execution input's options.
      finish("mapped", { "document.$": "$.Payload.document", "mapped.$": "$.Payload.mapped" });
      task.Next = next;
      states[state] = task;
      lambdas.push({
        order, api_id: null, api_name: `Map the ${companyShort(node.from.company_name)} extraction to ${companyShort(node.to.company_name)}'s invoiceData (#96)`,
        company_name: "BP-Builder", category: "Mapping", state_name: state, function_name: fn, logical_id: logicalId, substitution,
        arn_placeholder: placeholder, runtime: "nodejs22.x", handler: "index.handler", timeout_seconds: 10,
        environment: { DEFAULT_PROFILE: profile }, secret: null, call: null, setup: [],
        files: [
          { path: "index.mjs", content: MAP_INDEX(state, lastTransformed!) },
          { path: "invoice-mapping.mjs", content: INVOICE_MAPPING_JS },
          { path: "package.json", content: packageJson(fn, false) },
        ],
      });
      documentPath = "$.mapped";
      return;
    }
    if (node.kind === "complete") {
      task.Parameters = { FunctionName: placeholder, Payload: { "xml.$": `$.${lastTransformed}.document`, "mapped.$": "$.mapped.mapped" } };
      finish("completed", { "document.$": "$.Payload.document" });
      if (next) task.Next = next;
      else task.End = true;
      states[state] = task;
      lambdas.push({
        order, api_id: null, api_name: `Complete ${companyShort(node.to.company_name)}'s UBL XML (#96)`,
        company_name: "BP-Builder", category: "Mapping", state_name: state, function_name: fn, logical_id: logicalId, substitution,
        arn_placeholder: placeholder, runtime: "nodejs22.x", handler: "index.handler", timeout_seconds: 10,
        environment: {}, secret: null, call: null, setup: [],
        files: [
          { path: "index.mjs", content: COMPLETE_INDEX(state) },
          { path: "invoice-xml.mjs", content: INVOICE_XML_JS },
          { path: "invoice-mapping.mjs", content: INVOICE_MAPPING_JS },
          { path: "package.json", content: packageJson(fn, true) },
          ...Object.entries(XMLDOM_FILES).map(([file, content]) => ({ path: `node_modules/@xmldom/xmldom/${file}`, content })),
        ],
      });
      documentPath = "$.completed";
      return;
    }

    if (node.kind === "bis3") {
      task.Parameters = { FunctionName: placeholder, Payload: { "xml.$": `${documentPath ?? "$"}.document` } };
      finish("bis3", { "document.$": "$.Payload.document", "changes.$": "$.Payload.changes" });
      task.Next = next;
      states[state] = task;
      lambdas.push({
        order, api_id: null, api_name: `Copy the validated PINT A-NZ invoice as Peppol BIS 3.0 for ${companyShort(node.to.company_name)}`,
        company_name: "BP-Builder", category: "Mapping", state_name: state, function_name: fn, logical_id: logicalId, substitution,
        arn_placeholder: placeholder, runtime: "nodejs22.x", handler: "index.handler", timeout_seconds: 10,
        environment: {}, secret: null, call: null, setup: [],
        files: [
          { path: "index.mjs", content: BIS3_INDEX(state) },
          { path: "peppol-bis3-copy.mjs", content: PEPPOL_BIS3_COPY_JS },
          { path: "invoice-xml.mjs", content: INVOICE_XML_JS },
          { path: "invoice-mapping.mjs", content: INVOICE_MAPPING_JS },
          { path: "package.json", content: packageJson(fn, true) },
          ...Object.entries(XMLDOM_FILES).map(([file, content]) => ({ path: `node_modules/@xmldom/xmldom/${file}`, content })),
        ],
      });
      documentPath = "$.bis3";
      return;
    }

    const { api, category, role, plan } = node.step;
    if (documentPath) task.InputPath = documentPath;
    if (role === "produces") {
      transformations += 1;
      const key = transformations === 1 ? "transformed" : `transformed${transformations}`;
      finish(key, { "document.$": "$.Payload.document" });
      if (documentPath === null) {
        // The first transformation reads the execution input, a base64 PDF of up to about
        // 180 KB. Its result replaces the state, keeping only the options the mapping step
        // reads, so no later state carries the PDF towards Step Functions' 256 KB limit.
        task.ResultSelector = { [key]: { "document.$": "$.Payload.document" }, "options.$": "$.Payload.options" };
        task.ResultPath = "$";
      }
      documentPath = `$.${key}`;
      lastTransformed = key;
    } else if (role === "checks") {
      finish(validators === 1 ? "validation" : `validation${pad(order)}`, { "isValid.$": "$.Payload.isValid", "report.$": "$.Payload.report" });
    } else {
      finish("delivery", { "receipt.$": "$.Payload.receipt" });
    }
    if (role === "checks") {
      const gate = validators === 1 ? "Check validation" : `Check validation ${pad(order)}`;
      const variable = `${String(task.ResultPath)}.isValid`;
      task.Next = gate;
      states[state] = task;
      states[gate] = {
        Type: "Choice",
        Choices: [{
          And: [{ Variable: variable, IsPresent: true }, { Variable: variable, IsBoolean: true }, { Variable: variable, BooleanEquals: true }],
          Next: next ?? DONE_STATE,
        }],
        Default: VALIDATION_FAILED,
      };
    } else {
      if (next) task.Next = next;
      else task.End = true;
      states[state] = task;
    }

    // Deploy-time values: the endpoint's path parameters and the settings only the deployer knows.
    const label = `${pad(order)} ${api.api_name}`;
    const endpoint = api.api_endpoint ?? "";
    if (!endpoint) warnings.push(`${label} has no endpoint in the catalogue; set API_ENDPOINT in template.yaml by hand.`);
    const pathParameters = [...endpoint.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    // Fn::Sub writes a literal "${" as "${!".
    let subEndpoint = endpoint.replaceAll("${", "${!");
    const own: string[] = [];
    for (const field of pathParameters) {
      const parameter = parameterName(api, order, field);
      own.push(parameter);
      parameters.push({
        name: parameter,
        description: `${api.api_name}: the {${field}} in ${endpoint}`,
        no_echo: !needsCredential(api.authentication_method),
      });
      subEndpoint = subEndpoint.replace(`{${field}}`, `\${${parameter}}`);
    }
    const environment: Record<string, string> = { API_ENDPOINT: pathParameters.length ? subEndpoint : endpoint };
    // Only the first binary-reading API resolves stored input. Later steps receive
    // the extracted document, never the original PDF or a bearer download URL.
    if (!lambdas.length && ["base64", "file", "body"].includes(plan.request.kind)) {
      parameters.push({ name: "WorkflowInputBucket", description: "Private S3 bucket for PDFs larger than the execution input limit; leave empty for inline inputs only.", no_echo: false, default: "" });
      environment.INPUT_BUCKET = "${WorkflowInputBucket}";
      environment.INPUT_PREFIX = "${AWS::StackName}/inputs/";
    }
    if (isB2BrouterImport(api)) environment.API_ENDPOINT += `?${B2BROUTER_SEND_QUERY}`;
    if (plan.request.required.length) {
      const fields = plan.request.required.map((field) => {
        const parameter = parameterName(api, order, field);
        own.push(parameter);
        parameters.push({ name: parameter, description: `${api.api_name}: the request's "${field}"`, no_echo: false, default: SETTING_DEFAULTS[field] });
        return `${JSON.stringify(field)}:"\${${parameter}}"`;
      });
      environment.REQUEST_FIELDS = `{${fields.join(",")}}`;
    }
    let secret: string | null = null;
    if (needsCredential(api.authentication_method)) {
      secret = `${SECRET_PREFIX}/${companyShort(api.company_name).toLowerCase()}`;
      environment.SECRET_NAME = secret;
      const entry = secrets.get(secret) ?? {
        name: secret,
        apis: [],
        value: api.authentication_method === "Basic"
          ? "user:password as plain text (Mailgun: api:<key>)"
          : `the ${api.authentication_method === "API Key" ? "API key" : "token"} as plain text`,
      };
      entry.apis.push(api.api_name);
      secrets.set(secret, entry);
      if (!["Basic", "Token", "OAuth2"].includes(api.authentication_method ?? "")) {
        const header = apiKeyHeader(api);
        environment.API_KEY_HEADER = header ?? "x-api-key";
        if (!header) warnings.push(`${label}: the catalogue does not say which header carries the API key; the function sends x-api-key. Check the provider's documentation and change API_KEY_HEADER in template.yaml if needed.`);
      }
    }
    const setup = [
      ...(secret ? [`Before deploying, create the Secrets Manager secret ${secret}: ${secrets.get(secret)!.value}.`] : []),
      ...(own.length ? [`sam deploy asks for ${own.join(", ")}.`] : []),
    ];
    if (!plan.from_schema.request) warnings.push(`${label} has no stored request schema; its function sends the document as a JSON body, which may not be what the API takes.`);

    lambdas.push({
      order, api_id: api.id, api_name: api.api_name, company_name: api.company_name, category,
      state_name: state, function_name: fn, logical_id: logicalId, substitution, arn_placeholder: placeholder,
      runtime: "python3.12", handler: "lambda_function.lambda_handler", timeout_seconds: TIMEOUT_SECONDS,
      environment, secret, call: plan, setup,
      files: [{ path: "lambda_function.py", content: pythonSource(api, category, role, state, plan) }],
    });
  });

  if (validators > 0) {
    states[VALIDATION_FAILED] = { Type: "Fail", Error: "ValidationFailed", Cause: "The invoice did not pass validation." };
  }
  states[COMPOSITION_FAILED] = { Type: "Fail", Comment: "A step failed; its error and cause are kept.", ErrorPath: "$.error.Error", CausePath: "$.error.Cause" };
  if (steps.at(-1)?.role === "checks") states[DONE_STATE] = { Type: "Succeed" };
  if (chain.status === "needs_decision") {
    warnings.push("This chain still needs a decision (missing technical data or a field mapping); the workflow may fail at that link.");
  }

  const definition: StateMachineDefinition = {
    Comment: `${name}: ${steps.map(({ api }) => api.api_name).join(" -> ")}. Generated by the BP-Builder.`,
    StartAt: INPUT_CHECK,
    States: states,
  };
  const template = samTemplate(name, definition.Comment, lambdas, parameters);
  return {
    ok: true,
    workflow: {
      name,
      definition,
      json: JSON.stringify(definition, null, 2),
      // CloudFormation and the console reject YAML aliases, so the shared Retry block is written out each time.
      yaml: stringifyYaml(definition, { aliasDuplicateObjects: false }),
      template,
      // The format version is a string: quoted, so no YAML reader takes it for a date.
      template_yaml: stringifyYaml(template, { aliasDuplicateObjects: false })
        .replace(/^AWSTemplateFormatVersion: 2010-09-09$/m, 'AWSTemplateFormatVersion: "2010-09-09"'),
      lambdas,
      parameters,
      secrets: [...secrets.values()],
      uses_options: lambdas.some((lambda) => lambda.category === "Mapping"),
      warnings,
    },
  };
}

/** The AWS SAM template: one function per step, its role, and the state machine with the functions' ARNs. */
function samTemplate(name: string, description: string, lambdas: readonly LambdaTemplate[], parameters: readonly DeployParameter[]): Record<string, Json> {
  const resources: Record<string, Json> = {};
  for (const lambda of lambdas) {
    const properties: Record<string, Json> = {
      FunctionName: lambda.function_name,
      Description: `${lambda.state_name}: ${lambda.api_name}`.slice(0, 256),
      CodeUri: `lambdas/${lambda.function_name}/`,
      Handler: lambda.handler,
      Runtime: lambda.runtime,
      Architectures: ["x86_64"],
      Timeout: lambda.timeout_seconds,
      MemorySize: 256,
    };
    if (Object.keys(lambda.environment).length) {
      // A value naming a deploy parameter is filled in by CloudFormation.
      const variables = Object.entries(lambda.environment).map(([key, value]) => [key, /\$\{(?:[A-Za-z0-9]+|AWS::[A-Za-z0-9]+)\}/.test(value) ? { "Fn::Sub": value } : value]);
      properties.Environment = { Variables: Object.fromEntries(variables) };
    }
    if (lambda.secret) {
      properties.Policies = [{
        AWSSecretsManagerGetSecretValuePolicy: {
          SecretArn: { "Fn::Sub": `arn:aws:secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:${lambda.secret}-*` },
        },
      }];
    }
    if (lambda.environment.INPUT_BUCKET) {
      const policies = (properties.Policies ?? []) as Json[];
      policies.push({ "Fn::If": ["HasInputBucket", {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: { "Fn::Sub": "arn:${AWS::Partition}:s3:::${WorkflowInputBucket}/${AWS::StackName}/inputs/*" } }],
      }, { Ref: "AWS::NoValue" }] });
      properties.Policies = policies;
    }
    resources[lambda.logical_id] = { Type: "AWS::Serverless::Function", Properties: properties };
  }
  resources.Workflow = {
    Type: "AWS::Serverless::StateMachine",
    Properties: {
      Name: name,
      Type: "STANDARD",
      DefinitionUri: "statemachine.asl.json",
      DefinitionSubstitutions: Object.fromEntries(lambdas.map((lambda) => [lambda.substitution, { "Fn::GetAtt": [lambda.logical_id, "Arn"] }])),
      Policies: lambdas.map((lambda) => ({ LambdaInvokePolicy: { FunctionName: { Ref: lambda.logical_id } } })),
    },
  };
  const template: Record<string, Json> = {
    AWSTemplateFormatVersion: "2010-09-09",
    Transform: "AWS::Serverless-2016-10-31",
    Metadata: { AWSToolsMetrics: { AWSAgentToolkit: "aws-cloudformation@2" } },
    Description: description.slice(0, 1024),
  };
  if (parameters.length) {
    template.Parameters = Object.fromEntries(parameters.map((parameter) => [parameter.name, {
      Type: "String",
      MinLength: parameter.name === "WorkflowInputBucket" ? 0 : 1,
      ...(parameter.name === "WorkflowInputBucket" ? { AllowedPattern: "^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$" } : {}),
      Description: parameter.description.slice(0, 4000),
      ...(parameter.default !== undefined ? { Default: parameter.default } : {}),
      ...(parameter.no_echo ? { NoEcho: true } : {}),
    }]));
  }
  if (parameters.some((parameter) => parameter.name === "WorkflowInputBucket")) {
    template.Conditions = { HasInputBucket: { "Fn::Not": [{ "Fn::Equals": [{ Ref: "WorkflowInputBucket" }, ""] }] } };
  }
  template.Resources = resources;
  template.Outputs = {
    ...(parameters.some((parameter) => parameter.name === "WorkflowInputBucket") ? {
      InputStorageBucket: { Description: "Private bucket for PDF inputs; only this stack's inputs prefix is readable.", Value: { Ref: "WorkflowInputBucket" } },
      StoredInputVersion: { Description: "Stored PDF input protocol supported by the first function.", Value: "1" },
    } : {}),
    StateMachineArn: { Description: "Start executions of the workflow here.", Value: { Ref: "Workflow" } },
    ...Object.fromEntries(lambdas.map((lambda) => [`${lambda.logical_id}Name`, { Description: lambda.state_name, Value: { Ref: lambda.logical_id } }])),
  };
  return template;
}
