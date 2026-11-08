/** Checks user-entered replacements before a paid extraction starts. Originals stay unchanged by default. */
export function invoiceOverrideError(
  options: { invoiceId?: unknown; issueDate?: unknown; dueDate?: unknown },
  today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
): string | null {
  if (options.invoiceId !== undefined && (typeof options.invoiceId !== "string" || !options.invoiceId.trim() || options.invoiceId.length > 60 || /[\u0000-\u001f<>]/.test(options.invoiceId))) {
    return "Invoice number must contain 1 to 60 plain characters.";
  }
  for (const key of ["issueDate", "dueDate"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      return `${key} must be a real date in YYYY-MM-DD format.`;
    }
  }
  if (typeof options.issueDate === "string" && options.issueDate > today) return "Issue date must not be after today (Australia/Sydney).";
  if (typeof options.issueDate === "string" && typeof options.dueDate === "string" && options.dueDate < options.issueDate) return "Due date must not precede the replacement issue date.";
  return null;
}

/** Provider failures need different remedies; none of these messages implies exhausted credits. */
export function invoiceFailureHint(message: string): string | null {
  if (/number has already been taken|invoice number.*(?:already|exist)/i.test(message)) return "This invoice number is already stored by B2Brouter, even if its earlier send failed. For an agreed sandbox replay, enter a new invoice number for this send; the PDF need not be edited.";
  if (/closed (?:fiscal|financial) year/i.test(message)) return "B2Brouter refused the invoice date. For an agreed sandbox replay, enter an issue date in the account's open financial year and update an older due date as well.";
  if (/configure this connection|peppol.*not configured/i.test(message)) return "The B2Brouter account's Peppol connection needs configuration. Check the account connection in B2Brouter; this response does not report exhausted test credits.";
  if (/TaxRate.*required/i.test(message)) return "The extractor did not return a usable tax rate for this billed line. A tax rate visible in the PDF can still be missed; review the extraction rather than guessing GST.";
  return null;
}
