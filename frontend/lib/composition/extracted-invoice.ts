import { InvoiceMappingError, mapExtractionToAmit, type MappingOptions } from "./invoice-mapping.ts";
import { enrichAmitXml } from "./invoice-xml.ts";

export const AMIT_CONVERT_URL = "https://invoice-conversion-api.onrender.com/api/convert";

/** Accept an already extracted invoice; PDF extraction and validation are separate operations. */
export async function convertExtractedInvoice(extraction: unknown, options: MappingOptions = {}, runtime: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const mapped = mapExtractionToAmit(extraction, options);
  let response: Response;
  let body: unknown;
  try {
    response = await (runtime.fetch ?? fetch)(AMIT_CONVERT_URL, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ invoiceType: "JSON", outputFormat: "UBL XML", invoiceData: mapped.invoiceData, useFlexibleMapping: true }),
      signal: AbortSignal.timeout(runtime.timeoutMs ?? 60_000),
    });
    if (!response.ok) throw new Error("Converter refused the request");
    const raw = await response.text();
    if (raw.length > 1_100_000) throw new Error("Converter response too large");
    body = JSON.parse(raw);
  } catch {
    throw new InvoiceMappingError("converter_unavailable", "AmitTransform did not return a usable response. Try again later.");
  }
  const xml = (body as { xml?: unknown } | null)?.xml;
  if (typeof xml !== "string") throw new InvoiceMappingError("invalid_xml", "AmitTransform did not return an XML string.");
  return { invoice_xml: enrichAmitXml(xml, mapped), profile: mapped.profile, currency: mapped.currency, validation: { status: "not_run" as const } };
}
