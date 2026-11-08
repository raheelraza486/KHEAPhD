export class InvoiceMappingError extends Error {
  readonly code: "invalid_extraction" | "unsupported_invoice" | "invalid_xml" | "converter_unavailable";
  constructor(code: InvoiceMappingError["code"], message: string) {
    super(message);
    this.name = "InvoiceMappingError";
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;
const SCALE = BigInt(10_000), CENT = BigInt(100), ZERO = BigInt(0);
function roundDivision(value: bigint, divisor: bigint): bigint { return (value + divisor / BigInt(2)) / divisor; }
export interface MappingOptions {
  currency?: string;
  taxRate?: string | number;
  dateOrder?: "DMY" | "MDY";
  profile?: "peppol-bis3" | "pint-aunz";
  buyerReference?: string;
  /** Payment terms (BT-20) for an invoice that prints none; PINT A-NZ needs them or a due date. */
  paymentTerms?: string;
  /**
   * Replace the printed invoice number and date (BT-1, BT-2). Only for re-sending an old invoice
   * to a sandbox that refuses it: B2Brouter will not send a date in a closed fiscal year, and takes
   * each number once. The invoice sent then differs from the PDF in these two fields.
   */
  invoiceId?: string;
  issueDate?: string;
  /** Explicit replacement for a due date when replaying an old invoice in a sandbox. */
  dueDate?: string;
  seller?: PartyContext;
  buyer?: PartyContext;
}
export interface PartyContext {
  countryCode?: string;
  endpointId?: string;
  endpointSchemeId?: string;
  legalRegistrationId?: string;
  legalRegistrationSchemeId?: string;
}
export interface MappedLine {
  id: string;
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  amount: string;
  taxRate: string;
}
export interface MappedInvoice {
  invoiceData: RecordValue;
  currency: string;
  profile: NonNullable<MappingOptions["profile"]>;
  lines: MappedLine[];
  taxGroups: { rate: string; taxable: string; tax: string }[];
}

function mappingFailure(message: string): never {
  throw new InvoiceMappingError("invalid_extraction", message);
}
function record(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) mappingFailure(`${path} must be an object.`);
  return value as RecordValue;
}
function field(data: RecordValue, name: string): unknown {
  const matches = Object.keys(data).filter((key) => key.toLowerCase() === name.toLowerCase());
  if (matches.length > 1) mappingFailure(`Duplicate field: ${name}.`);
  return data[matches[0]];
}
function scalar(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as RecordValue;
    return item.content ?? item.value ?? item._;
  }
  return value;
}
function parsedDetails(value: unknown): RecordValue | null {
  const details = value && typeof value === "object" ? (value as RecordValue).details : null;
  return details && typeof details === "object" && !Array.isArray(details) ? details as RecordValue : null;
}
function text(value: unknown, path: string): string {
  const result = scalar(value);
  if ((typeof result !== "string" && typeof result !== "number") || !String(result).trim()) mappingFailure(`${path} is required.`);
  return String(result).trim();
}

// Four decimal places, using integers so money checks do not depend on floating point.
export function decimal(value: unknown, path: string, places = 4): bigint {
  const number = text(value, path);
  if (!new RegExp(`^\\d{1,12}(?:\\.\\d{1,${places}})?$`).test(number)) mappingFailure(`${path} must be a non-negative decimal with at most ${places} decimal places.`);
  const [whole, fraction = ""] = number.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, "0"));
}
function decimalText(value: bigint, places = 2): string {
  return `${value / SCALE}.${String(value % SCALE).padStart(4, "0").slice(0, places)}`;
}
function money(value: unknown, path: string): string {
  return decimalText(decimal(parsedDetails(value)?.amount ?? value, path, 2));
}
function isoDate(value: unknown, path: string, order?: MappingOptions["dateOrder"]): string {
  const details = parsedDetails(value);
  let year: number, month: number, day: number;
  if (details?.year != null && details.month != null && details.day != null) {
    [year, month, day] = [Number(details.year), Number(details.month), Number(details.day)];
  } else {
    const input = text(value, path);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(input);
    if (iso) [year, month, day] = iso.slice(1).map(Number);
    else if (local && order) [year, month, day] = [Number(local[3]), Number(local[order === "DMY" ? 2 : 1]), Number(local[order === "DMY" ? 1 : 2])];
    else mappingFailure(`${path} needs ISO YYYY-MM-DD, date details, or an explicit dateOrder.`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) mappingFailure(`${path} is not a valid date.`);
  return date.toISOString().slice(0, 10);
}
const UNIT_WORDS: Record<string, string> = {
  hour: "HUR", hours: "HUR", hr: "HUR", hrs: "HUR",
  day: "DAY", days: "DAY", minute: "MIN", minutes: "MIN",
  month: "MON", months: "MON", year: "ANN", years: "ANN",
  each: "C62", unit: "C62", units: "C62", piece: "H87", pieces: "H87", pce: "H87",
  kilogram: "KGM", kilograms: "KGM", kg: "KGM", gram: "GRM", grams: "GRM",
  metre: "MTR", metres: "MTR", meter: "MTR", meters: "MTR", litre: "LTR", litres: "LTR",
};
const UNIT_CODES = new Set([...Object.values(UNIT_WORDS), "MTK", "MTQ", "MLT", "TNE", "XBX", "XPK"]);
function unitCode(value: unknown): string {
  if (value == null) return "C62";
  const unit = text(value, "Unit");
  const code = UNIT_WORDS[unit.toLowerCase()] ?? unit.toUpperCase();
  if (!UNIT_CODES.has(code)) mappingFailure(`Unknown unit "${unit}". Supply a supported UN/ECE code, for example HUR, C62 or KGM.`);
  return code;
}
/** The extractor can keep a printed quantity and its unit together, e.g. "72.00 PCE". */
function measuredQuantity(value: unknown, unit: unknown, path: string): { quantity: bigint; code: string } {
  const written = text(value, path);
  const measured = /^(\d{1,12}(?:\.\d{1,4})?)\s+([A-Za-z][A-Za-z0-9]*)$/.exec(written);
  if (!measured) return { quantity: decimal(value, path), code: unitCode(unit) };
  const code = unitCode(measured[2]);
  if (unit != null && unitCode(unit) !== code) mappingFailure(`${path} unit conflicts with Unit; review the extraction.`);
  return { quantity: decimal(measured[1], path), code };
}
/** Rejoin an extractor-split amount only when its adjacent line is unambiguous and balances. */
function joinSplitAmounts(items: unknown[]): unknown[] {
  const row = (value: unknown): RecordValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
  const present = (value: unknown) => scalar(value) != null && String(scalar(value)).trim() !== "";
  const amountOnly = (value: RecordValue) => present(field(value, "Amount"))
    && Object.keys(value).every(key => ["amount", "_index", "page_number"].includes(key.toLowerCase()));
  const matches = (amount: RecordValue, detail: RecordValue): boolean => {
    if (present(field(detail, "Amount")) || !["Description", "Quantity", "UnitPrice", "TaxRate"].every(key => present(field(detail, key)))) return false;
    const page = scalar(field(amount, "page_number"));
    if (page == null || String(page) !== String(scalar(field(detail, "page_number")))) return false;
    try {
      const { quantity } = measuredQuantity(field(detail, "Quantity"), field(detail, "Unit"), "Quantity");
      const price = field(detail, "UnitPrice");
      return quantity > ZERO && roundDivision(quantity * decimal(parsedDetails(price)?.amount ?? price, "UnitPrice"), SCALE * CENT) * CENT
        === decimal(money(field(amount, "Amount"), "Amount"), "Amount");
    } catch (error) {
      if (error instanceof InvoiceMappingError) return false;
      throw error;
    }
  };
  const proposals = new Map<number, number[]>();
  for (let index = 0; index < items.length; index++) {
    const amount = row(items[index]);
    if (!amount || !amountOnly(amount)) continue;
    const candidates = [index - 1, index + 1].filter(target => {
      const detail = row(items[target]);
      return detail !== null && matches(amount, detail);
    });
    if (candidates.length === 1) proposals.set(candidates[0], [...(proposals.get(candidates[0]) ?? []), index]);
  }
  const merged = new Map<number, RecordValue>();
  const consumed = new Set<number>();
  for (const [target, sources] of proposals) {
    if (sources.length !== 1) continue;
    merged.set(target, { ...row(items[target]), Amount: field(row(items[sources[0]])!, "Amount") });
    consumed.add(sources[0]);
  }
  return items.flatMap((item, index) => consumed.has(index) ? [] : [merged.get(index) ?? item]);
}

function schemeId(value: unknown, path: string): string {
  const scheme = text(value, path);
  if (!/^\d{4}$/.test(scheme)) mappingFailure(`${path} must contain four digits.`);
  return scheme;
}
function taxIdentifier(value: unknown, profile: MappedInvoice["profile"], country?: unknown): string {
  const id = text(value, "VendorTaxId").replace(/\s+/g, "").toUpperCase();
  if (profile === "pint-aunz") return country && id.startsWith(String(country)) && /^\d+$/.test(id.slice(2)) ? id.slice(2) : id;
  if (/^[A-Z]{2}/.test(id)) return id;
  if (!country) mappingFailure("seller.countryCode is required to add the BIS country prefix to VendorTaxId.");
  return `${country === "GR" ? "EL" : country}${id}`;
}
function party(fields: RecordValue, name: string, address: string | string[], profile: MappedInvoice["profile"], context: PartyContext = {}, taxId?: string): RecordValue {
  record(context, "party context");
  const result: RecordValue = { name: text(field(fields, name), name) };
  // The first address field the extraction has (Upbrains names the buyer's BillingAddress or CustomerAddress).
  const source = (Array.isArray(address) ? address : [address]).map((key) => field(fields, key)).find((value) => value != null);
  if (source != null) {
    const details = parsedDetails(source);
    result.address = { street: details?.street_address || scalar(source), city: details?.city ?? details?.suburb, postalCode: details?.postal_code, state: details?.state };
    const country = String(details?.country_region ?? "").trim().toUpperCase();
    const code = country === "AUSTRALIA" ? "AU" : country === "NEW ZEALAND" ? "NZ" : country;
    if (/^[A-Z]{2}$/.test(code)) (result.address as RecordValue).countryCode = code;
  }
  if (context.countryCode != null) {
    if (!/^[A-Z]{2}$/.test(context.countryCode)) mappingFailure("countryCode must be a two-letter ISO country code.");
    const postal = (result.address ?? {}) as RecordValue;
    if (postal.countryCode && postal.countryCode !== context.countryCode) mappingFailure("The party country conflicts with the extracted address.");
    result.address = { ...postal, countryCode: context.countryCode };
  }
  if (context.endpointId != null || context.endpointSchemeId != null) {
    result.endpointID = text(context.endpointId, "endpointId");
    result.endpointSchemeId = schemeId(context.endpointSchemeId, "endpointSchemeId");
  }
  if (context.legalRegistrationId != null || context.legalRegistrationSchemeId != null) {
    const scheme = schemeId(context.legalRegistrationSchemeId, "legalRegistrationSchemeId");
    const id = text(context.legalRegistrationId, "legalRegistrationId");
    result.partyLegalEntity = { registrationName: result.name, companyID: scheme === "0151" ? id.replace(/\s+/g, "") : id };
    result.legalRegistrationSchemeId = scheme;
  }
  if (taxId && field(fields, taxId) != null) {
    const country = (result.address as RecordValue | undefined)?.countryCode;
    result.partyTaxScheme = { companyID: taxIdentifier(field(fields, taxId), profile, country), taxScheme: { id: "VAT" } };
  }
  return result;
}

/** Map one saved Upbrains result. Unknown currency or tax is never inferred from '$' or a country. */
export function mapExtractionToAmit(extraction: unknown, options: MappingOptions = {}): MappedInvoice {
  record(options, "options");
  if (options.profile !== undefined && !["peppol-bis3", "pint-aunz"].includes(options.profile)) mappingFailure("Unsupported profile.");
  if (options.dateOrder !== undefined && !["DMY", "MDY"].includes(options.dateOrder)) mappingFailure("Unsupported dateOrder.");
  const profile = options.profile ?? "peppol-bis3";
  const root = record(extraction, "extraction");
  if (root.status != null && root.status !== 200) mappingFailure("The extraction did not complete successfully.");
  const result = record(root.extractor_result, "extractor_result");
  const documents = result.documents;
  if (!Array.isArray(documents) || documents.length !== 1) mappingFailure("Exactly one extracted invoice is required; split multi-document results first.");
  const document = record(documents[0], "documents[0]");
  if (document.document_type != null && String(document.document_type).toLowerCase() !== "invoice") throw new InvoiceMappingError("unsupported_invoice", "Only invoices are supported; credit notes require a separate mapping.");
  const review = document.needs_review as RecordValue | undefined;
  if (review?.low_confidence || review?.has_validation_error || [review?.uncertain_fields, review?.violations].some((value) => Array.isArray(value) && value.length)) mappingFailure("The extraction requires review before conversion.");
  const fields = record(document.fields, "fields");
  if (field(fields, "InvoiceTypeCode") != null && text(field(fields, "InvoiceTypeCode"), "InvoiceTypeCode") !== "380") throw new InvoiceMappingError("unsupported_invoice", "Only invoice type 380 is supported.");
  // A row with nothing to bill (no amount, quantity or price) is not a line: Upbrains reads the
  // "Standard Rate" row of a GST summary table as an item with only a description. Dropping it is
  // safe, because the line amounts must still add up to SubTotal below.
  const items = Array.isArray(document.items)
    ? joinSplitAmounts(document.items).filter((item) => !item || typeof item !== "object" || Array.isArray(item)
      || ["Amount", "Quantity", "UnitPrice"].some((key) => field(item as RecordValue, key) != null))
    : document.items;
  if (!Array.isArray(items) || !items.length || items.length > 500) mappingFailure("The invoice must contain 1 to 500 line items.");
  for (const key of ["Discount", "TotalDiscount", "ShippingCost", "AllowanceTotalAmount", "ChargeTotalAmount", "PrepaidAmount", "PayableRoundingAmount"]) {
    if (field(fields, key) != null && decimal(field(fields, key), key) !== ZERO) throw new InvoiceMappingError("unsupported_invoice", `${key} needs a separate allowance, charge or payment mapping.`);
  }
  const currencyCodes = new Set<string>();
  if (options.currency != null) currencyCodes.add(text(options.currency, "currency").toUpperCase());
  if (field(fields, "Currency") != null) currencyCodes.add(text(field(fields, "Currency"), "Currency").toUpperCase());
  for (const value of [...Object.values(fields), ...items.flatMap((item) => Object.values(record(item, "item")))]) {
    const details = parsedDetails(value);
    if (details?.code != null) currencyCodes.add(text(details.code, "currency code").toUpperCase());
  }
  if (currencyCodes.size !== 1 || !/^[A-Z]{3}$/.test([...currencyCodes][0] ?? "")) mappingFailure("One explicit three-letter currency is required; conflicting currencies are not supported.");
  const currency = [...currencyCodes][0];
  const subtotal = money(field(fields, "SubTotal"), "SubTotal");
  const totalTax = money(field(fields, "TotalTax"), "TotalTax");
  const total = money(field(fields, "InvoiceTotal"), "InvoiceTotal");
  const payable = field(fields, "AmountDue") == null ? total : money(field(fields, "AmountDue"), "AmountDue");
  if (payable !== total) throw new InvoiceMappingError("unsupported_invoice", "AmountDue differs from InvoiceTotal; prepaid amounts need a separate payment mapping.");
  const lines = items.map((item, index): MappedLine => {
    const row = record(item, `items[${index}]`);
    if (field(row, "TaxCategory") != null && text(field(row, "TaxCategory"), "TaxCategory") !== "S") throw new InvoiceMappingError("unsupported_invoice", "Only standard tax category S is supported.");
    for (const key of ["Discount", "DiscountAmount", "AllowanceCharge", "Charges"]) {
      if (field(row, key) != null) throw new InvoiceMappingError("unsupported_invoice", `items[${index}].${key} needs a separate allowance or charge mapping.`);
    }
    const ratePath = `items[${index}].TaxRate`;
    const rate = decimal(text(field(row, "TaxRate") ?? options.taxRate, ratePath).replace(/\s*%$/, ""), ratePath);
    if (rate <= ZERO || rate > CENT * SCALE) throw new InvoiceMappingError("unsupported_invoice", "This mapping supports positive standard tax rates only; zero or exempt tax needs an explicit category mapping.");
    const { quantity, code } = measuredQuantity(field(row, "Quantity"), field(row, "Unit"), `items[${index}].Quantity`);
    const priceField = field(row, "UnitPrice");
    const price = decimal(parsedDetails(priceField)?.amount ?? priceField, "UnitPrice");
    const amount = money(field(row, "Amount"), "Amount");
    if (quantity <= ZERO || roundDivision(quantity * price, SCALE * CENT) * CENT !== decimal(amount, "Amount")) mappingFailure(`items[${index}]: Quantity times UnitPrice must equal Amount; discounts need a separate mapping.`);
    return {
      id: String(index + 1), description: text(field(row, "Description"), "Description"),
      quantity: decimalText(quantity, 4), unitCode: code, unitPrice: decimalText(price, 4), amount, taxRate: decimalText(rate, 4),
    };
  });
  const groups = new Map<string, bigint>();
  for (const line of lines) groups.set(line.taxRate, (groups.get(line.taxRate) ?? ZERO) + decimal(line.amount, "Amount"));
  const taxGroups = [...groups].map(([rate, taxable]) => ({ rate, taxable: decimalText(taxable), tax: decimalText(roundDivision(taxable * decimal(rate, "TaxRate"), SCALE * CENT * CENT) * CENT) }));
  const lineTotal = lines.reduce((sum, line) => sum + decimal(line.amount, "Amount"), ZERO);
  const calculatedTax = taxGroups.reduce((sum, group) => sum + decimal(group.tax, "TaxAmount"), ZERO);
  if (lineTotal !== decimal(subtotal, "SubTotal") || calculatedTax !== decimal(totalTax, "TotalTax") || lineTotal + calculatedTax !== decimal(total, "InvoiceTotal")) mappingFailure("Line amounts, SubTotal, TotalTax and InvoiceTotal do not balance.");
  const invoiceData: RecordValue = {
    invoiceId: options.invoiceId !== undefined ? text(options.invoiceId, "invoiceId") : text(field(fields, "InvoiceId"), "InvoiceId"),
    issueDate: options.issueDate !== undefined ? isoDate(options.issueDate, "issueDate") : isoDate(field(fields, "InvoiceDate"), "InvoiceDate", options.dateOrder),
    invoiceTypeCode: "380", currencyCode: currency,
    supplier: party(fields, "VendorName", "VendorAddress", profile, options.seller, "VendorTaxId"),
    customer: party(fields, "CustomerName", ["BillingAddress", "CustomerAddress"], profile, options.buyer),
    subtotal, taxExclusiveAmount: subtotal, totalTax, totalAmount: total, payableAmount: payable,
    totals: { lineExtensionAmount: subtotal, taxExclusiveAmount: subtotal, taxInclusiveAmount: total, payableAmount: payable },
    items: lines,
  };
  if (options.dueDate !== undefined) invoiceData.dueDate = isoDate(options.dueDate, "dueDate");
  else if (field(fields, "DueDate") != null) invoiceData.dueDate = isoDate(field(fields, "DueDate"), "DueDate", options.dateOrder);
  if ((options.issueDate !== undefined || options.dueDate !== undefined) && typeof invoiceData.dueDate === "string" && invoiceData.dueDate < String(invoiceData.issueDate)) {
    mappingFailure("DueDate precedes the replacement issueDate. Enter a dueDate for this sandbox send as well; the printed due date is not changed automatically.");
  }
  if (field(fields, "PaymentTerm") != null) invoiceData.paymentTerms = text(field(fields, "PaymentTerm"), "PaymentTerm");
  else if (options.paymentTerms !== undefined) invoiceData.paymentTerms = text(options.paymentTerms, "paymentTerms");
  const orderReference = field(fields, "PurchaseOrderReference"), purchaseOrder = field(fields, "PurchaseOrder");
  if (orderReference != null || purchaseOrder != null) {
    const reference = text(orderReference ?? purchaseOrder, orderReference != null ? "PurchaseOrderReference" : "PurchaseOrder");
    if (orderReference != null && purchaseOrder != null && reference !== text(purchaseOrder, "PurchaseOrder")) {
      mappingFailure("PurchaseOrderReference conflicts with PurchaseOrder; review the extraction.");
    }
    invoiceData.purchaseOrderReference = reference;
  }
  const extractedReference = field(fields, "BuyerReference");
  if (extractedReference != null) invoiceData.buyerReference = text(extractedReference, "BuyerReference");
  if (options.buyerReference !== undefined) {
    const reference = text(options.buyerReference, "buyerReference");
    if (invoiceData.buyerReference && invoiceData.buyerReference !== reference) mappingFailure("buyerReference conflicts with the extracted BuyerReference.");
    invoiceData.buyerReference = reference;
  }
  return { invoiceData, currency, profile, lines, taxGroups };
}

/**
 * What a mapped invoice still lacks for the Australian rules (PINT A-NZ), checked before the
 * converter and the validator run. These are the items ESS reported missing on 31 October 2026
 * when neither the extraction nor the entered run options supplied them; with them supplied, the
 * same invoice passed. Each item names the input that fills it. Nothing is guessed here.
 */
export function pintAunzMissingData(invoiceData: RecordValue): string[] {
  const missing: string[] = [];
  const supplier = (invoiceData.supplier ?? {}) as RecordValue;
  const customer = (invoiceData.customer ?? {}) as RecordValue;
  const country = (party: RecordValue) => String(((party.address ?? {}) as RecordValue).countryCode ?? "");
  const legalId = (party: RecordValue) => String(((party.partyLegalEntity ?? {}) as RecordValue).companyID ?? "").trim();
  if (!String(invoiceData.buyerReference ?? "").trim() && !String(invoiceData.purchaseOrderReference ?? "").trim()) {
    missing.push("a buyer reference or purchase order number (enter the buyer reference)");
  }
  if (!String(supplier.endpointID ?? "").trim() || (country(supplier) === "AU" && !legalId(supplier))) {
    missing.push("the seller's ABN, which is also its electronic address (enter the seller's ABN)");
  }
  // An Australian buyer, or one whose country the extraction did not read, needs its ABN.
  if (["AU", ""].includes(country(customer)) && !legalId(customer)) {
    missing.push("the buyer's ABN (enter the buyer's ABN)");
  }
  if (!String(invoiceData.dueDate ?? "").trim() && !String(invoiceData.paymentTerms ?? "").trim()) {
    missing.push("a due date or payment terms (enter the payment terms)");
  }
  return missing;
}

/** One sentence for the user, stopping the run before the converter and the validator. */
export function missingDataMessage(missing: readonly string[]): string {
  return `Stopped before conversion and validation: the Australian rules (PINT A-NZ) need ${missing.join("; ")}. `
    + "The PDF may print them even when the extraction did not read them. Fill them in and run again.";
}
