/**
 * The client's chain with the request and response schemas stored for it
 * (migrations 0040, 0042, 0046): only the top-level fields the wrappers read.
 */
import type { SchemaFieldRecord, SchemaRecord } from "../../../lib/checks/types.ts";
import type { WorkflowApi } from "../../../lib/composition/step-functions.ts";

type FieldSpec = [path: string, type: string, required: boolean, format?: string | null, enumValues?: string[] | null];

function schema(id: string, api_id: string, direction: "request" | "response", media: string, status: string | null, specs: FieldSpec[], raw: unknown = { type: "object" }): SchemaRecord {
  const fields: SchemaFieldRecord[] = specs.map(([path, type, required, format = null, enumValues = null]) => ({
    path, leaf_name: path.replace(/\[\]$/, ""), leaf_name_norm: path.replace(/\[\]$/, "").toLowerCase(),
    json_type: type, format, is_required: required, is_array_item: path.endsWith("[]"),
    depth: 0, enum_values: enumValues, description: null,
  }));
  return { id, api_id, direction, media_type: media, status_code: status, raw, verified_by: null, fields };
}

export const UPBRAINS = "974405cd-82b2-4e76-a628-278a56ac4e9a";
export const AMIT = "17455a7a-f107-4180-a907-0f8879bcd746";
export const ESS = "10feb4e1-16d8-4f67-8463-99d44565580d";
export const MAILGUN = "08885479-e750-4a42-99d6-b4d32ad62983";
export const B2BROUTER = "8c305642-44f0-4400-ae99-49801ae06131";
export const BILLIT_SENDXML = "dd6f7bec-14c8-49ca-be7e-14f653225602";

function api(id: string, api_name: string, company_name: string, category: string, endpoint: string, authentication_method: string, schemas: SchemaRecord[]): WorkflowApi {
  return { id, api_name, company_name, category, api_endpoint: endpoint, http_method: "POST", authentication_method, authentication_details: "", schemas };
}

export const CLIENT_CHAIN: WorkflowApi[] = [
  api(UPBRAINS, "Upbrains Extract Invoice From PDF API", "Upbrains", "Transformation", "https://ai.upbrains.ai/api/v1/webhooks/{flowId}/sync", "None", [
    schema("u-req", UPBRAINS, "request", "application/json", null, [["fileName", "string", false], ["fileBase64", "string", true, "byte"]]),
    schema("u-res", UPBRAINS, "response", "application/json", "200", [["status", "integer", false], ["extractor_result", "object", false]]),
  ]),
  api(AMIT, "AmitTransform Convert UBL JSON to UBL XML API", "AmitTransform", "Transformation", "https://invoice-conversion-api.onrender.com/api/convert", "None", [
    schema("a-req", AMIT, "request", "application/json", null, [
      ["invoiceType", "string", true, null, ["JSON"]], ["outputFormat", "string", true, null, ["UBL XML"]],
      ["invoiceData", "object", true], ["useFlexibleMapping", "boolean", false],
    ]),
    schema("a-res", AMIT, "response", "application/json", "200", [["xml", "string", true], ["missingFields", "object", true]]),
    schema("a-400", AMIT, "response", "application/json", "400", [["status", "string", true, null, ["error"]], ["message", "string", true]]),
  ]),
  api(ESS, "ESS SmartDocFlow Validate PINT A-NZ Invoice API", "EB Software Services (ESS)", "Validation", "https://xml.staging.smartdocflow.com/v1/peppol/aunz/validate/ubl", "API Key", [
    schema("e-req", ESS, "request", "application/json", null, [
      ["filename", "string", true], ["content", "string", true, "base64"], ["pack", "string", false, null, ["billing", "selfbilling"]],
    ]),
    schema("e-res", ESS, "response", "application/json", "200", [["status", "string", true]]),
  ]),
  api(MAILGUN, "Mailgun Send Message API", "Mailgun", "Communication", "https://api.mailgun.net/v3/{domain_name}/messages", "Basic", [
    schema("m-req", MAILGUN, "request", "multipart/form-data", null, [
      ["from", "string", true], ["to", "array", true], ["to[]", "string", true], ["subject", "string", true],
      ["text", "string", false], ["attachment", "array", false], ["attachment[]", "string", false, "binary"],
      ["inline", "array", false, "binary"], ["inline[]", "string", false, "binary"],
    ]),
    schema("m-res", MAILGUN, "response", "application/json", "200", [["id", "string", true], ["message", "string", true]]),
  ]),
  api(B2BROUTER, "B2Brouter Import Invoice API", "B2Brouter", "Communication", "https://api.b2brouter.net/accounts/{account}/invoices/import", "API Key", [
    schema("b-req", B2BROUTER, "request", "application/octet-stream", null, [], { type: "string", format: "binary" }),
    schema("b-res", B2BROUTER, "response", "application/json", "201", [["invoice", "object", false]]),
  ]),
  // Billit sendxml (migration 0055): the UBL file as the one required string `XML`.
  api(BILLIT_SENDXML, "Billit Peppol Send XML API", "Billit", "Communication", "https://api.billit.be/v1/peppol/sendxml", "API Key", [
    schema("bl-req", BILLIT_SENDXML, "request", "application/json", null, [["XML", "string", true]], { type: "object", required: ["XML"], properties: { XML: { type: "string" } } }),
    schema("bl-res", BILLIT_SENDXML, "response", "application/json", "200", [], { type: "integer" }),
  ]),
];
