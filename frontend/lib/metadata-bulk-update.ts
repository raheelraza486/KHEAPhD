import { createHash } from "node:crypto";
import {
  API_CATEGORIES,
  COMMUNICATION_DIRECTIONS,
  HTTP_METHODS,
  type ApiRecord,
} from "./types.ts";

export const METADATA_BULK_FIELDS = [
  "official_api_name",
  "official_company_name",
  "category",
  "category_other",
  "communication_direction",
  "country_region",
  "http_method",
  "authentication_details",
  "client_types",
  "network",
  "input_formats",
  "output_formats",
  "invoice_standard",
  "website_url",
  "instructions",
  "business_rules",
] as const;

export type MetadataBulkField = (typeof METADATA_BULK_FIELDS)[number];

export type MetadataSpreadsheetRow = {
  source_row?: unknown;
  api_id?: unknown;
  api_name?: unknown;
  field?: unknown;
  proposed_value?: unknown;
  evidence?: unknown;
  evidence_url?: unknown;
  note?: unknown;
};

export type NormalizedMetadataRow = {
  sourceRow: number;
  apiId: string;
  apiName: string;
  field: MetadataBulkField;
  value: string | string[];
  evidence: string;
  evidenceUrl: string;
  note: string;
};

export type MetadataBulkInvalidRow = {
  source_row: number;
  api_id: string;
  field: string;
  error: string;
};

export type MetadataBulkPlanEntry = {
  id: string;
  api_name: string;
  company_name: string;
  expected_updated_at: string;
  changes: Partial<Record<MetadataBulkField, string | string[]>>;
  fields: MetadataBulkField[];
  evidence_urls: string[];
  evidence: Array<{
    source_row: number;
    field: MetadataBulkField;
    statement: string;
    url: string;
    note: string;
  }>;
  source_rows: number[];
};

export type MetadataBulkPlan = {
  ready: boolean;
  rows: NormalizedMetadataRow[];
  invalid: MetadataBulkInvalidRow[];
  entries: MetadataBulkPlanEntry[];
  changedRows: number;
  unchangedRows: number;
  fieldCounts: Record<string, number>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARRAY_FIELDS = new Set<MetadataBulkField>([
  "client_types", "input_formats", "output_formats", "invoice_standard", "business_rules",
]);
const STRING_LIMITS: Partial<Record<MetadataBulkField, number>> = {
  official_api_name: 240,
  official_company_name: 240,
  category: 40,
  category_other: 100,
  communication_direction: 40,
  country_region: 120,
  http_method: 12,
  authentication_details: 1_000,
  network: 200,
  website_url: 2_000,
  instructions: 4_000,
};

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim()
    : "";
}

function sourceRow(value: unknown, index: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : index + 2;
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function invalid(
  source_row: number,
  api_id: string,
  field: string,
  error: string,
): MetadataBulkInvalidRow {
  return { source_row, api_id, field, error };
}

function normalizeValue(field: MetadataBulkField, raw: string) {
  if (!ARRAY_FIELDS.has(field)) return raw;
  // An explicit marker distinguishes clearing a list from an unfilled cell.
  if (raw === "[]") return [];
  const itemLimit = field === "business_rules" ? 500 : 100;
  const items = [...new Set(raw.split(/\r\n|[\r\n]/u).map((item) => item.trim()))];
  if (items.some((item) => !item || /^null$/iu.test(item) || item === "[]" || item === "{}")) {
    throw new Error("List values must not be null, empty or list markers. Use [] alone to clear the list.");
  }
  // Business rules are prose and may legitimately contain punctuation.
  if (field !== "business_rules" && items.some((item) => item.includes(","))) {
    throw new Error("Put each list value on a separate line; comma-joined values are not allowed.");
  }
  if (items.length > 40) throw new Error("A list field may contain at most 40 values.");
  if (items.some((item) => item.length > itemLimit)) {
    throw new Error(`Each list value must be ${itemLimit} characters or fewer.`);
  }
  return items;
}

export function normalizeMetadataSpreadsheetRows(input: unknown): {
  rows: NormalizedMetadataRow[];
  invalid: MetadataBulkInvalidRow[];
} {
  if (!Array.isArray(input)) {
    return { rows: [], invalid: [invalid(0, "", "", "rows must be an array.")] };
  }
  if (input.length === 0) {
    return { rows: [], invalid: [invalid(0, "", "", "The spreadsheet contains no update rows.")] };
  }
  if (input.length > 2_000) {
    return { rows: [], invalid: [invalid(0, "", "", "A maximum of 2,000 update rows is allowed.")] };
  }

  const rows: NormalizedMetadataRow[] = [];
  const errors: MetadataBulkInvalidRow[] = [];
  const seen = new Set<string>();

  input.forEach((raw, index) => {
    const rowNumber = sourceRow(
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as MetadataSpreadsheetRow).source_row
        : undefined,
      index,
    );
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(invalid(rowNumber, "", "", "The row must be an object."));
      return;
    }
    const value = raw as MetadataSpreadsheetRow;
    const apiId = text(value.api_id);
    const fieldText = text(value.field);
    const apiName = text(value.api_name);
    const proposed = text(value.proposed_value);
    const evidence = text(value.evidence);
    const evidenceUrl = text(value.evidence_url);
    const note = text(value.note);

    if (!UUID_PATTERN.test(apiId)) {
      errors.push(invalid(rowNumber, apiId, fieldText, "API record ID is invalid."));
      return;
    }
    if (!METADATA_BULK_FIELDS.includes(fieldText as MetadataBulkField)) {
      errors.push(invalid(rowNumber, apiId, fieldText, "Supabase field is not allowed for metadata bulk update."));
      return;
    }
    const field = fieldText as MetadataBulkField;
    const key = `${apiId}\u0000${field}`;
    if (seen.has(key)) {
      errors.push(invalid(rowNumber, apiId, field, "This API and field appear more than once."));
      return;
    }
    seen.add(key);
    if (!proposed) {
      errors.push(invalid(rowNumber, apiId, field, ARRAY_FIELDS.has(field)
        ? "Proposed value is required. Use [] to explicitly clear a list."
        : "Proposed value is required."));
      return;
    }
    // A bare null would otherwise be stored as the text "null" in a text field.
    if (!ARRAY_FIELDS.has(field) && /^null$/iu.test(proposed)) {
      errors.push(invalid(rowNumber, apiId, field, "Proposed value must not be null."));
      return;
    }
    if (!evidence) {
      errors.push(invalid(rowNumber, apiId, field, "Evidence is required."));
      return;
    }
    if (!isHttpUrl(evidenceUrl)) {
      errors.push(invalid(rowNumber, apiId, field, "Official evidence URL must start with http:// or https://."));
      return;
    }
    const limit = STRING_LIMITS[field];
    if (limit && proposed.length > limit) {
      errors.push(invalid(rowNumber, apiId, field, `Proposed value must be ${limit} characters or fewer.`));
      return;
    }
    if (field === "communication_direction" && !COMMUNICATION_DIRECTIONS.includes(proposed as never)) {
      errors.push(invalid(rowNumber, apiId, field, "Communication direction is not supported."));
      return;
    }
    if (field === "category" && !API_CATEGORIES.includes(proposed as never)) {
      errors.push(invalid(rowNumber, apiId, field, "Category is not supported."));
      return;
    }
    if (field === "http_method" && !HTTP_METHODS.includes(proposed.toUpperCase() as never)) {
      errors.push(invalid(rowNumber, apiId, field, "HTTP method is not supported."));
      return;
    }
    if (field === "website_url" && !isHttpUrl(proposed)) {
      errors.push(invalid(rowNumber, apiId, field, "Provider website must start with http:// or https://."));
      return;
    }

    try {
      rows.push({
        sourceRow: rowNumber,
        apiId,
        apiName,
        field,
        value: normalizeValue(field, field === "http_method" ? proposed.toUpperCase() : proposed),
        evidence,
        evidenceUrl,
        note,
      });
    } catch (error) {
      errors.push(invalid(rowNumber, apiId, field, error instanceof Error ? error.message : "Proposed value is invalid."));
    }
  });

  return { rows, invalid: errors };
}

function currentValue(record: ApiRecord, field: MetadataBulkField): string | string[] {
  const value = record[field as keyof ApiRecord];
  if (ARRAY_FIELDS.has(field)) return Array.isArray(value) ? value.map(String) : [];
  return typeof value === "string" ? value : "";
}

function sameValue(left: string | string[], right: string | string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildMetadataBulkPlan(
  normalized: ReturnType<typeof normalizeMetadataSpreadsheetRows>,
  records: ApiRecord[],
): MetadataBulkPlan {
  const invalidRows = [...normalized.invalid];
  const byId = new Map(records.map((record) => [record.id, record]));
  const grouped = new Map<string, MetadataBulkPlanEntry>();
  const proposedCategories = new Map(
    normalized.rows
      .filter((row) => row.field === "category")
      .map((row) => [row.apiId, row.value as string]),
  );
  const proposedOtherCategories = new Map(
    normalized.rows
      .filter((row) => row.field === "category_other")
      .map((row) => [row.apiId, row.value as string]),
  );
  const fieldCounts: Record<string, number> = {};
  let changedRows = 0;
  let unchangedRows = 0;

  for (const row of normalized.rows) {
    const record = byId.get(row.apiId);
    if (!record || !record.is_active || record.duplicate_of) {
      invalidRows.push(invalid(row.sourceRow, row.apiId, row.field, "Active API record was not found."));
      continue;
    }
    if (row.apiName && row.apiName !== record.api_name) {
      invalidRows.push(invalid(row.sourceRow, row.apiId, row.field, `API name does not match the current record (${record.api_name}).`));
      continue;
    }
    const effectiveCategory = proposedCategories.get(row.apiId) ?? record.category;
    if (row.field === "category" && row.value === "Other") {
      const otherCategory = proposedOtherCategories.get(row.apiId)
        ?? (record.category === "Other" ? record.category_other : "");
      if (!otherCategory) {
        invalidRows.push(invalid(row.sourceRow, row.apiId, row.field, "Changing category to Other also requires category_other."));
        continue;
      }
    }
    if (row.field === "category_other" && effectiveCategory !== "Other") {
      invalidRows.push(invalid(row.sourceRow, row.apiId, row.field, "category_other only applies to records whose category is Other."));
      continue;
    }
    if (row.field === "communication_direction" && effectiveCategory !== "Communication") {
      invalidRows.push(invalid(row.sourceRow, row.apiId, row.field, "communication_direction only applies to Communication records."));
      continue;
    }

    const unchanged = sameValue(currentValue(record, row.field), row.value)
      && !(row.field === "invoice_standard" && record.invoice_standard_source !== "confirmed");
    if (unchanged) unchangedRows += 1;
    else changedRows += 1;
    fieldCounts[row.field] = (fieldCounts[row.field] ?? 0) + 1;

    const entry = grouped.get(record.id) ?? {
      id: record.id,
      api_name: record.api_name,
      company_name: record.company_name,
      expected_updated_at: record.updated_at,
      changes: {},
      fields: [],
      evidence_urls: [],
      evidence: [],
      source_rows: [],
    };
    entry.changes[row.field] = row.value;
    entry.fields.push(row.field);
    entry.evidence_urls.push(row.evidenceUrl);
    entry.evidence.push({
      source_row: row.sourceRow,
      field: row.field,
      statement: row.evidence,
      url: row.evidenceUrl,
      note: row.note,
    });
    entry.source_rows.push(row.sourceRow);
    grouped.set(record.id, entry);
  }

  const entries = [...grouped.values()]
    .map((entry) => ({
      ...entry,
      fields: [...entry.fields].sort(),
      evidence_urls: [...new Set(entry.evidence_urls)].sort(),
      evidence: [...entry.evidence].sort((a, b) => a.source_row - b.source_row),
      source_rows: [...entry.source_rows].sort((a, b) => a - b),
      changes: Object.fromEntries(Object.entries(entry.changes).sort(([a], [b]) => a.localeCompare(b))),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    ready: invalidRows.length === 0 && entries.length > 0,
    rows: normalized.rows,
    invalid: invalidRows,
    entries,
    changedRows,
    unchangedRows,
    fieldCounts,
  };
}

export function metadataBulkPlanToken(entries: MetadataBulkPlanEntry[]) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
