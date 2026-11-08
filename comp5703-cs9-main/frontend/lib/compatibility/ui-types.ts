export type SchemaInputMode = "url" | "published" | "upload";

export interface ApiSchemaField {
  path: string;
  leaf_name: string;
  leaf_name_norm: string;
  json_type: string;
  format: string | null;
  is_required: boolean;
  is_array_item: boolean;
  depth: number;
  enum_values: unknown[] | null;
  description: string | null;
}

export interface ApiSchemaRecord {
  id: string;
  direction: "request" | "response";
  media_type: string;
  status_code: string | null;
  origin: "extracted" | "uploaded";
  source_url: string;
  created_by: string;
  created_at: string;
  warnings: string[];
  raw: unknown;
  fields: ApiSchemaField[];
}

export interface ApiSchemasEntry {
  api_id: string;
  api_name: string;
  company_name: string;
  can_upload: boolean;
  can_fetch: boolean;
  schemas: ApiSchemaRecord[];
}

export interface ApiSchemasResponse {
  apis: ApiSchemasEntry[];
  missing: string[];
  requestId: string;
}

export interface ApiSchemaAvailability {
  api_id: string;
  request_count: number;
  response_count: number;
}

export interface SchemaAvailabilityResponse {
  apis: ApiSchemaAvailability[];
  requestId: string;
}
