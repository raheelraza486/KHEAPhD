export const NO_REQUEST_BODY_FORMAT = "null";
export const NO_REQUEST_BODY_LABEL = "No request body";

export function isNoRequestBodyFormat(value: string) {
  return value.trim().toLowerCase() === NO_REQUEST_BODY_FORMAT;
}

/** Keep catalogue formats as arrays in data and use one readable separator in UI text. */
export function formatFormatsForDisplay(values: readonly string[], fallback = "Not recorded") {
  const formatted = values.map((value) => value.trim()).filter(Boolean).join(" / ");
  return formatted || fallback;
}

/** `null` in input_formats explicitly means that the operation has no request body. */
export function formatInputFormatsForDisplay(values: readonly string[], fallback = "Not recorded") {
  const formatted = values
    .map((value) => isNoRequestBodyFormat(value) ? NO_REQUEST_BODY_LABEL : value.trim())
    .filter(Boolean)
    .join(" / ");
  return formatted || fallback;
}
