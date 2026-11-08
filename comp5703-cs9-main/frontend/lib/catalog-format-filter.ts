import { isNoRequestBodyFormat, NO_REQUEST_BODY_LABEL } from "./format-display.ts";

export const UNRECORDED_FORMAT = "__not_recorded__";

export type CatalogueFormatDirection = "input" | "output";

function formatKey(value: string) {
  return value.trim().toLowerCase();
}

function individualFormats(formats: readonly string[]) {
  return formats
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Keep the filter vocabulary aligned with the values shown in the catalogue. */
export function catalogueFormatOptions(
  rows: readonly (readonly string[])[],
  direction?: CatalogueFormatDirection,
) {
  const options = new Map<string, string>();
  let hasUnrecorded = false;
  for (const formats of rows) {
    const values = individualFormats(formats);
    if (values.length === 0) hasUnrecorded = true;
    for (const value of values) {
      if (direction === "output" && isNoRequestBodyFormat(value)) continue;
      const key = formatKey(value);
      if (!options.has(key)) {
        options.set(key, direction === "input" && isNoRequestBodyFormat(value) ? NO_REQUEST_BODY_LABEL : value);
      }
    }
  }
  const result = [...options].map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "en"));
  if (hasUnrecorded) result.push({ value: UNRECORDED_FORMAT, label: "Not recorded" });
  return result;
}

export function matchesCatalogueFormat(formats: readonly string[], selected: string) {
  if (!selected) return true;
  const values = individualFormats(formats).map(formatKey);
  return selected === UNRECORDED_FORMAT
    ? values.length === 0
    : values.includes(formatKey(selected));
}
