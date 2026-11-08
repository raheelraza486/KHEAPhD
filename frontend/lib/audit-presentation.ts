import type { AuditAction, AuditEvent } from "./types.ts";

const USER_VISIBLE_METADATA_FIELDS = [
  "api_name",
  "official_api_name",
  "company_name",
  "official_company_name",
  "description",
  "api_endpoint",
  "documentation_url",
  "category",
  "category_other",
  "communication_direction",
  "country_region",
  "http_method",
  "authentication_method",
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

const visibleFieldSet = new Set<string>(USER_VISIBLE_METADATA_FIELDS);

function metadataFieldSummary(fields: unknown): string | null {
  if (!Array.isArray(fields)) return null;
  const safeFields = [...new Set(fields.filter(
    (field): field is string => typeof field === "string" && visibleFieldSet.has(field),
  ))].sort();
  return safeFields.length > 0 ? `${safeFields.map((field) => `${field} updated`).join(", ")}.` : null;
}

function summaryAlreadySafe(details: string): string | null {
  const parts = details.replace(/[.]$/, "").split(/,\s*/u);
  if (parts.length === 0 || parts.some((part) => {
    const match = /^([a-z][a-z0-9_]*) updated$/u.exec(part);
    return !match || !visibleFieldSet.has(match[1]);
  })) return null;
  return `${parts.join(", ")}.`;
}

function structuredMetadataSummary(details: string): string | null {
  const trimmed = details.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const payload = JSON.parse(trimmed) as { type?: unknown; fields?: unknown };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (payload.type !== "admin_metadata_bulk_update" && payload.type !== "api_fields_updated") return null;
    return metadataFieldSummary(payload.fields) ?? "API metadata updated.";
  } catch {
    return null;
  }
}

function genericActionSummary(action: AuditAction, details: string): string {
  switch (action) {
    case "upload":
      return "API submitted.";
    case "edit":
      return /schema/i.test(details) ? "API schema updated." : "API details updated.";
    case "verify":
      return "API verification completed.";
    case "status_change":
      return "Verification status updated.";
    case "delete":
      return "API removed from the catalogue.";
    case "restore":
      return "API restored to the catalogue and returned to awaiting verification.";
  }
}

/**
 * Converts trusted and legacy audit storage into a deliberately narrow public
 * summary. Raw notes, evidence statements, source rows, URLs and JSON values
 * are never returned to a user-facing component.
 */
export function auditDetailsForDisplay(
  event: Pick<AuditEvent, "action" | "details">,
): string {
  const details = typeof event.details === "string" ? event.details.trim() : "";
  return structuredMetadataSummary(details)
    ?? summaryAlreadySafe(details)
    ?? genericActionSummary(event.action, details);
}

const CJK_TEXT = /[\u3400-\u9fff\uf900-\ufaff]/u;
const INTERNAL_NOTE_SHAPE = /["']?(?:evidence|statement|note|remark|comment|source_row|source_rows)["']?\s*:/iu;

/** User-facing review notes must be authored for the public UI, not copied
 * from spreadsheet remarks or internal JSON. Unsafe legacy notes stay stored
 * for migration/administrative work but are not rendered. */
export function publicReviewNote(value: string | null | undefined): string | null {
  const note = typeof value === "string" ? value.trim() : "";
  if (!note || CJK_TEXT.test(note) || INTERNAL_NOTE_SHAPE.test(note)) return null;
  if (note.startsWith("{") || note.startsWith("[")) return null;
  return note;
}
