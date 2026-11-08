/**
 * The client's use case as one composed API: four catalogue APIs in a row.
 *
 *   invoice PDF ─▶ Upbrains extract invoice        ─▶ the invoice's fields (JSON)
 *               ─▶ AmitTransform convert to UBL    ─▶ UBL XML, completed as PINT A-NZ
 *               ─▶ ESS SmartDocFlow PINT A-NZ      ─▶ verdict under the Australian rules
 *               ─▶ (valid only) B2Brouter or Ademico over Peppol, or Mailgun by email
 *
 * By email, and over Peppol through Ademico, the validated document goes out
 * as it is. B2Brouter's sandbox recipients receive only Peppol BIS Billing 3.0,
 * so B2Brouter is given a copy labelled as that format (asPeppolBis3), and the
 * result says so in `sent_copy`: what went out is not the validated document.
 *
 * The client set it on 11 October 2026: "convert pdf to ubl xml, validate
 * using Australian rules and send via email or peppol", each step on its own
 * and all together. The APIs are the ones the client designated on 6 October;
 * each had been called for real on its own before they were put in a row here.
 *
 * Two things sit between the APIs, because the APIs do not fit each other as
 * they are: the extractor's field names are not the converter's, and the
 * converter's XML fails the validator until what it never writes is added.
 * Both are the group's deterministic mapping of #96 (invoice-mapping.ts and
 * invoice-xml.ts): it refuses an extraction it cannot balance or does not
 * cover, and checks that the converter kept every value it was given.
 *
 * As in the Peppol flow (peppol-invoice.ts), the validator is a gate: only a
 * valid invoice is sent, and an invoice that could not be validated is neither
 * sent nor passed off as valid. The run stops at the first step that fails and
 * says which one and why.
 *
 * A PDF does not carry everything the Australian rules ask for (a buyer
 * reference, the buyer's ABN, electronic addresses). The caller supplies those
 * in `context`; the result lists what was added, so nothing is added out of
 * sight. The seller's ABN is read from the tax number printed on the invoice.
 *
 * `fetch` and `sleep` are injected so the tests run without calling a provider.
 */
import { InvoiceMappingError, mapExtractionToAmit, missingDataMessage, pintAunzMissingData, type MappedInvoice, type MappingOptions, type PartyContext } from "./invoice-mapping.ts";
import { enrichAmitXml } from "./invoice-xml.ts";
import { asPeppolBis3, PEPPOL_BIS3, PINT_AUNZ } from "./peppol-bis3-copy.ts";
import { deliverInvoice, type ComposeInvoiceOptions, type Delivery, type Finding, type StepOutcome, type Validation } from "./peppol-invoice.ts";
import { setTimeout as delay } from "node:timers/promises";
import { bounded } from "../workspace/execution.ts";
import { readPdfText, resolveSellerAbn, sellerAbns, SellerAbnReviewError, type AbnEvidence, type PdfTextItem } from "./pdf-abn.ts";

/** Identifiers of one party that the PDF does not carry. */
export interface PartyIds {
  /** Electronic address: the scheme (0151 for an ABN, 0088 for a GLN) and the identifier. */
  endpointScheme?: string;
  endpointId?: string;
  /** Legal registration identifier (BT-30 / BT-47) and its scheme; in Australia the ABN under 0151. */
  legalId?: string;
  legalIdScheme?: string;
}

/** What the caller supplies because a PDF does not carry it. */
export interface InvoiceContext {
  buyerReference?: string;
  /** Explicit sandbox replay replacements; the original PDF is never changed. */
  invoiceId?: string;
  issueDate?: string;
  dueDate?: string;
  /** Used when the invoice prints no payment terms. */
  paymentTerms?: string;
  seller?: PartyIds;
  buyer?: PartyIds;
}

export const EXTRACTOR = {
  api_name: "Upbrains Extract Invoice From PDF API",
} as const;

export const CONVERTER = {
  api_name: "AmitTransform Convert UBL JSON to UBL XML API",
  url: "https://invoice-conversion-api.onrender.com/api/convert",
} as const;

export const AU_VALIDATOR = {
  api_name: "ESS SmartDocFlow Validate PINT A-NZ Invoice API",
  url: "https://xml.staging.smartdocflow.com/v1/peppol/aunz/validate/ubl",
} as const;

/**
 * B2Brouter's code for the format its sandbox recipients receive. Its code for
 * a PINT A-NZ invoice ("xml.ubl.invoice.pint.billing.aunz.v1") is accepted and
 * then replaced by this one, because the recipient's directory entry lists
 * only this format (two runs and a directory lookup on 13 October 2026).
 */
const BIS3_DOCUMENT = "xml.ubl.invoice.bis3";

/** What was handed to the Peppol sender when it is not the validated document itself. */
export interface SentCopy {
  format: string;
  reason: string;
  /** In plain words, how the copy differs from the validated document. */
  changes: string[];
  invoice_xml: string;
}

/** What the extractor read, in the caller's terms; shown before anything is converted. */
export interface ExtractionSummary {
  number: string;
  issue_date: string;
  due_date: string | null;
  currency: string;
  seller: string;
  buyer: string;
  net: string;
  tax: string;
  total: string;
  lines: number;
  notes: string[];
}

/**
 *   extractor_refused      the extraction service refused our request (credentials or credits)
 *   extractor_unavailable  the extraction service could not be reached or failed
 *   extraction_unusable    it answered, but not with one invoice this flow can convert
 *   converter_unavailable  the converter could not be reached or failed
 *   conversion_unusable    the converter answered, but not with a UBL invoice this flow can complete
 *   validator_refused      the validator refused our credentials or quota
 *   validator_unavailable  the invoice was converted but could not be validated
 *   sender_*               as in the Peppol flow
 */
export type PdfFailureReason =
  | "extractor_refused"
  | "extractor_unavailable"
  | "extraction_unusable"
  | "converter_unavailable"
  | "conversion_unusable"
  | "validator_refused"
  | "validator_unavailable"
  | "sender_rejected"
  | "sender_refused"
  | "sender_unavailable";

export type PdfOutcome =
  | {
    ok: true;
    steps: StepOutcome[];
    rule_set: string;
    extracted: ExtractionSummary;
    /** In plain words, what was added to the converter's document. */
    added: string[];
    invoice_xml: string;
    validation: Validation;
    /** Null when there is no sender, or the invoice was invalid and so not sent. */
    delivery: Delivery | null;
    /** Set over Peppol only: the copy the sender was given. By email the validated document is sent. */
    sent_copy: SentCopy | null;
  }
  | {
    ok: false;
    failed_step: 1 | 2 | 3 | 4;
    reason: PdfFailureReason;
    message: string;
    steps: StepOutcome[];
    extracted: ExtractionSummary | null;
    added: string[];
    invoice_xml: string | null;
    validation: Validation | null;
    seller_abn_suggestion?: AbnEvidence;
  };

export interface PdfInvoiceOptions extends Pick<ComposeInvoiceOptions, "sender" | "ademico" | "email" | "fetch" | "timeoutMs" | "now" | "sleep" | "deliveryPolls" | "deliveryPollMs"> {
  /** Stop this run's requests and polling; accepted provider work cannot be recalled. */
  signal?: AbortSignal;
  /**
   * The webhook of the extraction flow in the client's Upbrains workspace. It
   * carries no token, so the address is itself the secret: it is read on the
   * server and never returned or written to a message.
   */
  extractorUrl: string;
  validatorKey: string;
  /** Extraction took about 15 s for one page on 12 October. */
  extractorTimeoutMs?: number;
  /** The converter runs on a free tier and can take about 20 s to wake. */
  converterTimeoutMs?: number;
}

interface MappedData {
  invoiceId: string; issueDate: string; dueDate?: string;
  supplier: { name: string; partyTaxScheme?: { companyID: string }; address?: { countryCode?: string } };
  customer: { name: string };
  subtotal: string; totalTax: string; totalAmount: string; items: unknown[];
}

function partyContext(ids: PartyIds | undefined): PartyContext | undefined {
  if (!ids) return undefined;
  const party: PartyContext = {
    ...(ids.endpointId ? { endpointId: ids.endpointId, endpointSchemeId: ids.endpointScheme } : {}),
    ...(ids.legalId ? { legalRegistrationId: ids.legalId, legalRegistrationSchemeId: ids.legalIdScheme } : {}),
  };
  return Object.keys(party).length ? party : undefined;
}

/**
 * Map the extraction as a PINT A-NZ invoice. An Australian seller's ABN is its
 * tax registration, its legal registration and, under scheme 0151, its
 * electronic address, so a first pass reads the tax number printed on the
 * invoice and the second gives it to the seller as those two identifiers.
 */
function mapForAustralia(extraction: unknown, context: InvoiceContext, text: readonly PdfTextItem[]): { mapped: MappedInvoice; abn: string | null; note?: string } {
  const options: MappingOptions = { invoiceId: context.invoiceId, issueDate: context.issueDate, dueDate: context.dueDate, profile: "pint-aunz", buyerReference: context.buyerReference, paymentTerms: context.paymentTerms, buyer: partyContext(context.buyer) };
  const data = mapExtractionToAmit(extraction, options).invoiceData as unknown as MappedData;
  const supplier = data.supplier;
  const printed = supplier.partyTaxScheme?.companyID ?? "";
  const australian = supplier.address?.countryCode === "AU";
  const resolved = australian ? resolveSellerAbn(sellerAbns(text, supplier.name, data.customer.name), /^\d{11}$/.test(printed) ? printed : null, context.seller?.legalId) : { abn: null };
  const abn = resolved.abn;
  if (australian && !abn) throw new SellerAbnReviewError("The seller ABN could not be confirmed from the PDF or extraction. Enter the seller's ABN before conversion and validation.");
  const seller = abn
    ? { endpointId: abn, endpointSchemeId: "0151", legalRegistrationId: abn, legalRegistrationSchemeId: "0151", ...partyContext(context.seller) }
    : partyContext(context.seller);
  return { mapped: mapExtractionToAmit(extraction, { ...options, seller }), abn: context.seller?.legalId ? null : abn, note: resolved.note };
}

function summarise(mapped: MappedInvoice, abn: string | null): ExtractionSummary {
  const data = mapped.invoiceData as unknown as MappedData;
  return {
    number: data.invoiceId,
    issue_date: data.issueDate,
    due_date: data.dueDate ?? null,
    currency: mapped.currency,
    seller: data.supplier.name,
    buyer: data.customer.name,
    net: data.subtotal,
    tax: data.totalTax,
    total: data.totalAmount,
    lines: data.items.length,
    notes: abn ? [`The seller's ABN (${abn}) is the tax number printed on the invoice.`] : [],
  };
}

/** In plain words, what the completed document carries that the PDF did not. */
function additions(mapped: MappedInvoice, context: InvoiceContext, abn: string | null): string[] {
  const added = [`the specification identifiers of ${PINT_AUNZ.rule_set}`];
  if (context.invoiceId !== undefined) added.push(`the replacement invoice number you entered (${context.invoiceId}); the original PDF is unchanged`);
  if (context.issueDate !== undefined) added.push(`the replacement issue date you entered (${context.issueDate})`);
  if (context.dueDate !== undefined) added.push(`the replacement due date you entered (${context.dueDate})`);
  if (context.buyerReference) added.push("the buyer reference you entered");
  if (context.paymentTerms && mapped.invoiceData.paymentTerms === context.paymentTerms) added.push("the payment terms you entered");
  for (const [role, ids] of [["seller", abn ? { endpointScheme: "0151", endpointId: abn, legalId: abn, ...context.seller } : context.seller], ["buyer", context.buyer]] as const) {
    if (ids?.endpointId) added.push(`the ${role}'s electronic address (${ids.endpointScheme}:${ids.endpointId})`);
    if (ids?.legalId) added.push(`the ${role}'s legal registration (${ids.legalId})`);
  }
  const rates = mapped.taxGroups.map((group) => `${Number(group.rate)}%`).join(", ");
  added.push(`the tax breakdown with its taxable amount, and each line's tax category (${PINT_AUNZ.taxScheme} ${rates})`);
  added.push(`the currency (${mapped.currency}) on every amount`);
  return added;
}

/** The validator's findings, from each check that failed. */
function essFindings(body: Record<string, unknown>): { errors: Finding[]; warnings: Finding[] } {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const details = (body.details ?? {}) as { steps?: unknown };
  for (const step of Array.isArray(details.steps) ? details.steps : []) {
    const check = (step ?? {}) as { check?: unknown; status?: unknown; summary?: unknown; details?: unknown };
    if (check.status === "success") continue;
    const inner = (check.details ?? {}) as { failures?: unknown; errors?: unknown };
    const before = errors.length + warnings.length;
    for (const failure of Array.isArray(inner.failures) ? inner.failures : []) {
      const f = (failure ?? {}) as { rule?: unknown; severity?: unknown; message?: unknown };
      const finding = { id: String(f.rule ?? check.check ?? ""), message: String(f.message ?? "").slice(0, 500) };
      (f.severity === "warning" || f.severity === "info" ? warnings : errors).push(finding);
    }
    if (errors.length + warnings.length === before) {
      // A check that reports no rule by rule failures (the schema check, for one) still failed.
      const lines = Array.isArray(inner.errors) ? inner.errors.map((line) => String(line).slice(0, 500)) : [String(check.summary ?? "The check failed.")];
      for (const message of lines) errors.push({ id: String(check.check ?? ""), message });
    }
  }
  return { errors, warnings };
}

export async function composePdfInvoice(
  file: { name: string; pdf: Uint8Array },
  context: InvoiceContext,
  options: PdfInvoiceOptions,
): Promise<PdfOutcome> {
  const signal = options.signal;
  if (!signal) return executePdfInvoice(file, context, options);
  const fetchImpl = options.fetch ?? fetch;
  const scopedFetch: typeof fetch = async (input, init) => {
    signal.throwIfAborted();
    const response = await bounded(fetchImpl(input, {
      ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    }), signal);
    signal.throwIfAborted();
    return response;
  };
  const sleep = (ms: number) => {
    signal.throwIfAborted();
    return options.sleep ? bounded(options.sleep(ms), signal) : delay(ms, undefined, { signal });
  };
  // Bound the entire operation, including body reads and providers that ignore abort.
  // The scoped fetch also guards every later step if such a provider replies late.
  return bounded(executePdfInvoice(file, context, { ...options, fetch: scopedFetch, sleep }), signal);
}

async function executePdfInvoice(
  file: { name: string; pdf: Uint8Array },
  context: InvoiceContext,
  options: PdfInvoiceOptions,
): Promise<PdfOutcome> {
  const doFetch = options.fetch ?? fetch;
  const pdfText = await readPdfText(file.pdf, options.signal);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const steps: StepOutcome[] = [];
  const fail = (failed_step: 1 | 2 | 3 | 4, reason: PdfFailureReason, message: string, partial: { extracted?: ExtractionSummary | null; added?: string[]; invoice_xml?: string | null; validation?: Validation | null } = {}): PdfOutcome => ({
    ok: false, failed_step, reason, message, steps,
    extracted: partial.extracted ?? null, added: partial.added ?? [], invoice_xml: partial.invoice_xml ?? null, validation: partial.validation ?? null,
  });

  // The converter sleeps when idle and takes about 20 s to wake. Knocking now,
  // while the extractor works, keeps the whole run inside a proxy's time limit.
  void doFetch(CONVERTER.url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.body?.cancel(), () => undefined);

  // Step 1: extract. The flow's own address waits for the result when it ends in /sync.
  const address = options.extractorUrl.trim().replace(/\/+$/, "");
  let started = now();
  let extraction: unknown;
  try {
    const response = await doFetch(address.endsWith("/sync") ? address : `${address}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ fileName: file.name, fileBase64: Buffer.from(file.pdf).toString("base64") }),
      signal: AbortSignal.timeout(options.extractorTimeoutMs ?? 120_000),
    });
    const body = await response.text();
    steps.push({ order: 1, api_name: EXTRACTOR.api_name, role: "extracts", status: response.ok ? "ok" : "failed", http_status: response.status, duration_ms: now() - started });
    if (!response.ok) {
      return [401, 402, 403, 429].includes(response.status)
        ? fail(1, "extractor_refused", "The extraction service refused the request (credentials or credits).")
        : response.status >= 400 && response.status < 500
          ? fail(1, "extraction_unusable", "The extraction service would not read this file.")
          : fail(1, "extractor_unavailable", "The extraction service failed.");
    }
    try {
      extraction = JSON.parse(body);
    } catch {
      return fail(1, "extraction_unusable", "The extraction service did not return a result this flow can read.");
    }
  } catch {
    // Nothing of the error is passed on: it can name the flow's address.
    steps.push({ order: 1, api_name: EXTRACTOR.api_name, role: "extracts", status: "failed", http_status: null, duration_ms: now() - started });
    return fail(1, "extractor_unavailable", "The extraction service could not be reached, or took too long.");
  }

  let mapped: MappedInvoice;
  let abn: string | null;
  let abnNote: string | undefined;
  try {
    ({ mapped, abn, note: abnNote } = mapForAustralia(extraction, context, pdfText));
  } catch (error) {
    return { ...fail(1, "extraction_unusable", error instanceof InvoiceMappingError ? error.message : "The extraction result could not be read."),
      ...(error instanceof SellerAbnReviewError && error.suggestion ? { seller_abn_suggestion: error.suggestion } : {}) };
  }
  const extracted = summarise(mapped, abn);
  if (abnNote) extracted.notes = [abnNote];
  // Stop before the converter and the validator when the Australian rules would refuse the
  // invoice for an item neither the extraction nor the entered fields supplied.
  const missing = pintAunzMissingData(mapped.invoiceData);
  if (missing.length) return fail(1, "extraction_unusable", missingDataMessage(missing), { extracted });
  const number = extracted.number;

  // Step 2: convert, then complete what the converter never writes.
  started = now();
  let invoiceXml: string;
  try {
    const response = await doFetch(CONVERTER.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ invoiceType: "JSON", outputFormat: "UBL XML", invoiceData: mapped.invoiceData, useFlexibleMapping: true }),
      signal: AbortSignal.timeout(options.converterTimeoutMs ?? 90_000),
    });
    const body = await response.text();
    steps.push({ order: 2, api_name: CONVERTER.api_name, role: "produces", status: response.ok ? "ok" : "failed", http_status: response.status, duration_ms: now() - started });
    if (!response.ok) {
      return response.status >= 400 && response.status < 500
        ? fail(2, "conversion_unusable", "The converter would not take the extracted invoice.", { extracted })
        : fail(2, "converter_unavailable", "The converter failed.", { extracted });
    }
    let xml: unknown;
    try {
      xml = (JSON.parse(body) as { xml?: unknown }).xml;
    } catch {
      xml = null;
    }
    if (typeof xml !== "string") return fail(2, "conversion_unusable", "The converter did not return an XML document.", { extracted });
    invoiceXml = enrichAmitXml(xml, mapped);
  } catch (error) {
    if (error instanceof InvoiceMappingError) return fail(2, "conversion_unusable", error.message, { extracted });
    if (!steps.some((step) => step.order === 2)) {
      steps.push({ order: 2, api_name: CONVERTER.api_name, role: "produces", status: "failed", http_status: null, duration_ms: now() - started });
    }
    return fail(2, "converter_unavailable", "The converter could not be reached, or took too long.", { extracted });
  }
  const added = additions(mapped, context, abn);
  const sofar = { extracted, added, invoice_xml: invoiceXml };
  const notValidated = "The invoice was converted but could not be validated, so it was not sent.";

  // Step 3: validate the completed document under the Australian rules.
  started = now();
  let checked: Response;
  let verdict: Record<string, unknown>;
  try {
    checked = await doFetch(AU_VALIDATOR.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": options.validatorKey },
      body: JSON.stringify({ filename: "invoice.xml", content: Buffer.from(invoiceXml, "utf8").toString("base64"), pack: "billing" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    verdict = (await checked.json()) as Record<string, unknown>;
  } catch {
    steps.push({ order: 3, api_name: AU_VALIDATOR.api_name, role: "checks", status: "failed", http_status: null, duration_ms: now() - started });
    return fail(3, "validator_unavailable", notValidated, sofar);
  }
  // A verdict is a 200 that passed, or a 400 that lists the checks it ran.
  const ranChecks = Array.isArray((verdict.details as { steps?: unknown } | null | undefined)?.steps);
  const passed = checked.status === 200 && verdict.status === "success";
  const failed = checked.status === 400 && verdict.status === "error" && ranChecks;
  steps.push({ order: 3, api_name: AU_VALIDATOR.api_name, role: "checks", status: passed || failed ? "ok" : "failed", http_status: checked.status, duration_ms: now() - started });
  if (!passed && !failed) {
    return [401, 403, 429].includes(checked.status)
      ? fail(3, "validator_refused", "The validator refused our credentials or quota, so the invoice was not sent.", sofar)
      : fail(3, "validator_unavailable", notValidated, sofar);
  }
  const version = (verdict.details as { pack_version?: unknown } | null | undefined)?.pack_version;
  const validation: Validation = {
    status: passed ? "valid" : "invalid",
    specification: `${PINT_AUNZ.rule_set}${typeof version === "string" ? ` ${version}` : ""}`,
    ...(passed ? { errors: [], warnings: [] } : essFindings(verdict)),
  };
  const done = { ok: true as const, steps, rule_set: PINT_AUNZ.rule_set, extracted, added, invoice_xml: invoiceXml, validation };

  // The gate: an invalid invoice ends the run here.
  if (validation.status !== "valid") return { ...done, delivery: null, sent_copy: null };

  // Step 4: by email or over Peppol, whichever the caller configured. Only
  // B2Brouter's sandbox needs the document in another format.
  let outgoing = invoiceXml;
  let sentCopy: SentCopy | null = null;
  if (options.sender && !options.email && !options.ademico) {
    try {
      const copy = asPeppolBis3(invoiceXml);
      outgoing = copy.xml;
      sentCopy = {
        format: PEPPOL_BIS3.format,
        reason: `The sandbox recipient receives only ${PEPPOL_BIS3.format}.`,
        changes: copy.changes,
        invoice_xml: copy.xml,
      };
    } catch {
      return fail(4, "sender_rejected", `The invoice is valid, but it could not be written as ${PEPPOL_BIS3.format} for the sending platform.`, { ...sofar, validation });
    }
  }
  const sent = await deliverInvoice({ xml: outgoing, number, rule_set: PINT_AUNZ.rule_set, documentTypeCode: BIS3_DOCUMENT, order: 4 }, options, steps);
  if (!sent.ok) return fail(4, sent.reason, sent.message, { ...sofar, validation });
  return { ...done, delivery: sent.delivery, sent_copy: sent.delivery ? sentCopy : null };
}
