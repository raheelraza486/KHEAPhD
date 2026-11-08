import type { ApiRecord, ApiSideInput, FormatAliasRow, PairInput, ParameterRecord, SchemaFieldRecord, SchemaRecord, UserChoice } from "../../lib/checks/types.ts";

export const ALIASES: FormatAliasRow[] = [
  { alias: "JSON", canonical: "JSON" },
  { alias: "application/json", canonical: "JSON" },
  { alias: "XML", canonical: "XML" },
  { alias: "UBL", canonical: "UBL" },
  { alias: "UBL XML", canonical: "UBL" },
  { alias: "PDF", canonical: "PDF" },
  { alias: "ZIP", canonical: "ZIP" },
  { alias: "Form URL encoded", canonical: "Form URL encoded" },
  { alias: "Status Codes", canonical: "Status Codes" },
];

let seq = 0;

export function api(over: Partial<ApiRecord> = {}): ApiRecord {
  seq++;
  return {
    id: `api-${seq}`,
    api_name: `API ${seq}`,
    company_name: "Vendor A",
    // Two Transformations may follow each other (Check 0); two Communications may not since 14 October 2026.
    category: "Transformation",
    input_formats: ["JSON"],
    output_formats: ["JSON"],
    authentication_method: "API Key",
    authentication_details: "Send X-API-Key header",
    ...over,
  };
}

/**
 * Field spec: "path:type[:req][:fmt]" e.g. "invoice.invoiceNumber:string:req".
 * Array items use "[]" in the path ("lines[].quantity:number:req").
 */
export function fields(specs: readonly string[], descriptions: Record<string, string> = {}): SchemaFieldRecord[] {
  return specs.map((spec) => {
    const [path, type, ...rest] = spec.split(":");
    const leaf = path.split(".").at(-1)!.replace(/\[\]$/, "");
    const fmt = rest.find((r) => r !== "req" && r !== "");
    return {
      path,
      leaf_name: leaf,
      leaf_name_norm: leaf.toLowerCase().replace(/[^a-z0-9]/g, ""),
      json_type: type,
      format: fmt ?? null,
      is_required: rest.includes("req"),
      is_array_item: path.includes("[]"),
      depth: path.split(".").length - 1,
      enum_values: null,
      description: descriptions[path] ?? null,
    };
  });
}

export function schema(over: Partial<SchemaRecord> & { direction: "request" | "response" }, specs: readonly string[] = [], descriptions: Record<string, string> = {}): SchemaRecord {
  seq++;
  return {
    id: `schema-${seq}`,
    api_id: "",
    status_code: over.direction === "response" ? "200" : null,
    raw: { type: "object" },
    verified_by: null,
    fields: fields(specs, descriptions),
    ...over,
  };
}

export function param(name: string, over: Partial<ParameterRecord> = {}): ParameterRecord {
  return { name, location: "path", json_type: "string", is_required: true, description: null, ...over };
}

export function side(a: ApiRecord, schemas: SchemaRecord[] = [], parameters: ParameterRecord[] = []): ApiSideInput {
  return { api: a, schemas: schemas.map((s) => ({ ...s, api_id: a.id })), parameters };
}

export function pair(source: ApiSideInput, target: ApiSideInput, choices?: UserChoice[]): PairInput {
  return { source, target, formatAliases: ALIASES, choices };
}
