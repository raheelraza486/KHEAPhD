// A composed API: extract an invoice from a PDF, convert it to UBL XML,
// validate it under the Australian rules, and send it if it is valid.
//
//   POST /api/composed/pdf-invoice      multipart/form-data
//     file                 the invoice, one PDF of at most 4 MB
//     send_via             "peppol" (default) or "email"
//     peppol_platform      "b2brouter" (default) or "ademico", when send_via is "peppol"
//     email_to             the recipient, when send_via is "email"
//     buyer_reference      optional; a PDF does not carry one
//     buyer_abn            optional; 11 digits
//     buyer_endpoint_scheme, buyer_endpoint_id
//                          optional; the buyer's electronic address
//
// The response carries what was extracted, what was added to the converter's
// document, the XML, the validator's verdict, the delivery state, the copy
// given to the Peppol sender (sent_copy; by email the validated document is
// sent), and what each of the four integrated APIs did. Signed-in users only, and tightly
// rate-limited: every call spends extraction credits on the client's own
// account. UPBRAINS_WEBHOOK_URL and SMARTDOCFLOW_API_KEY are read on the
// server and never returned; the first is an address with no token, so the
// address is the secret. Sending is configured as in /api/composed/peppol-invoice;
// Ademico reads ADEMICO_USERNAME, ADEMICO_PASSWORD and ADEMICO_ACCESS_TOKEN.
import { NextResponse } from "next/server";
import { APP_ROLES, requireRole } from "@/lib/auth";
import { composePdfInvoice, type InvoiceContext, type PdfFailureReason } from "@/lib/composition/pdf-invoice";
import { invoiceOverrideError } from "@/lib/composition/invoice-run-options";
import { validAbn } from "@/lib/composition/pdf-abn";
import { emailRecipientAllowed, isEmailAddress, ademicoConfigFromEnv, type AdemicoConfig, type EmailConfig, type SenderConfig } from "@/lib/composition/peppol-invoice";
import { createAnswerLimiter, isSameOrigin, publicError } from "../../checks/shared";

export const dynamic = "force-dynamic";

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const checkPdfRateLimit = createAnswerLimiter(600_000, 5);

const STATUS: Record<PdfFailureReason, number> = {
  extractor_refused: 503,
  extractor_unavailable: 502,
  extraction_unusable: 422,
  converter_unavailable: 502,
  conversion_unusable: 502,
  validator_refused: 503,
  validator_unavailable: 502,
  sender_rejected: 422,
  sender_refused: 503,
  sender_unavailable: 502,
};

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const cancelled = () => publicError("Workflow cancelled. An invoice already sent cannot be recalled.", 499, requestId, { reason: "cancelled" });
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);
  const gate = await requireRole(request, APP_ROLES, requestId);
  if ("response" in gate) return gate.response;
  if (request.signal.aborted) return cancelled();

  const extractorUrl = process.env.UPBRAINS_WEBHOOK_URL?.trim();
  const validatorKey = process.env.SMARTDOCFLOW_API_KEY?.trim();
  if (!extractorUrl || !validatorKey) return publicError("The composed API is not configured.", 503, requestId);

  if (Number(request.headers.get("content-length") ?? 0) > MAX_PDF_BYTES + 100_000) {
    return publicError("The file is too large; the limit is 4 MB.", 413, requestId);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    if (request.signal.aborted) return cancelled();
    return publicError("The request must be a form with the invoice PDF in \"file\".", 400, requestId);
  }
  const upload = form.get("file");
  if (!(upload instanceof File)) return publicError("The request must be a form with the invoice PDF in \"file\".", 400, requestId);
  if (upload.size === 0 || upload.size > MAX_PDF_BYTES) return publicError("The file must be a PDF of at most 4 MB.", 413, requestId);
  const pdf = new Uint8Array(await upload.arrayBuffer());
  if (Buffer.from(pdf.subarray(0, 5)).toString("latin1") !== "%PDF-") return publicError("The file is not a PDF.", 400, requestId);

  const sendVia = field(form, "send_via") || "peppol";
  if (sendVia !== "peppol" && sendVia !== "email") return publicError("send_via must be \"peppol\" or \"email\".", 400, requestId);
  const platform = field(form, "peppol_platform") || "b2brouter";
  if (platform !== "b2brouter" && platform !== "ademico") return publicError("peppol_platform must be \"b2brouter\" or \"ademico\".", 400, requestId);

  const buyerReference = field(form, "buyer_reference");
  const buyerAbn = field(form, "buyer_abn").replace(/\s+/g, "");
  // For an invoice whose printed ABN the extraction does not read, and one that prints no payment terms.
  const sellerAbn = field(form, "seller_abn").replace(/\s+/g, "");
  const paymentTerms = field(form, "payment_terms");
  const endpointScheme = field(form, "buyer_endpoint_scheme");
  const endpointId = field(form, "buyer_endpoint_id");
  if (buyerReference.length > 60 || /[\u0000-\u001f<>]/.test(buyerReference)) return publicError("buyer_reference must be at most 60 plain characters.", 400, requestId);
  if (buyerAbn && !/^\d{11}$/.test(buyerAbn)) return publicError("buyer_abn must be 11 digits.", 400, requestId);
  if (sellerAbn && !/^\d{11}$/.test(sellerAbn)) return publicError("seller_abn must be 11 digits.", 400, requestId);
  if (sellerAbn && !validAbn(sellerAbn)) return publicError("The seller ABN fails its check-digit validation. Check the number on the invoice.", 400, requestId);
  if (paymentTerms.length > 120 || /[\u0000-\u001f<>]/.test(paymentTerms)) return publicError("payment_terms must be at most 120 plain characters.", 400, requestId);
  if ((endpointScheme || endpointId) && !(/^\d{4}$/.test(endpointScheme) && /^[A-Za-z0-9:._-]{1,50}$/.test(endpointId))) {
    return publicError("The buyer's electronic address needs a four-digit scheme and an identifier.", 400, requestId);
  }
  const replacements = {
    ...(field(form, "invoice_number") ? { invoiceId: field(form, "invoice_number") } : {}),
    ...(field(form, "issue_date") ? { issueDate: field(form, "issue_date") } : {}),
    ...(field(form, "due_date") ? { dueDate: field(form, "due_date") } : {}),
  };
  if (Object.keys(replacements).length && (sendVia !== "peppol" || platform !== "b2brouter")) return publicError("Sandbox replay replacements are supported only for B2Brouter.", 400, requestId);
  const overrideError = invoiceOverrideError(replacements);
  if (overrideError) return publicError(overrideError, 400, requestId);
  const context: InvoiceContext = {
    ...replacements,
    buyerReference: buyerReference || undefined,
    paymentTerms: paymentTerms || undefined,
    ...(sellerAbn ? { seller: { endpointScheme: "0151", endpointId: sellerAbn, legalId: sellerAbn, legalIdScheme: "0151" } } : {}),
    buyer: {
      ...(endpointId ? { endpointScheme, endpointId } : {}),
      ...(buyerAbn ? { legalId: buyerAbn, legalIdScheme: "0151" } : {}),
    },
  };

  let sender: SenderConfig | null = null;
  let ademico: AdemicoConfig | null = null;
  let email: EmailConfig | null = null;
  if (sendVia === "email") {
    const to = field(form, "email_to");
    if (!isEmailAddress(to)) return publicError("email_to must be one email address.", 400, requestId);
    const allowed = (process.env.MAILGUN_ALLOWED_RECIPIENTS ?? "").split(",").filter((entry) => entry.trim() !== "");
    if (!emailRecipientAllowed(to, gate.user.email, allowed)) {
      return publicError("An invoice can be emailed to your own account address, or to an address the administrators have allowed.", 403, requestId);
    }
    const mailKey = process.env.MAILGUN_API_KEY?.trim();
    const domain = process.env.MAILGUN_DOMAIN?.trim();
    if (mailKey && domain) {
      email = {
        apiKey: mailKey,
        domain,
        from: process.env.MAILGUN_FROM?.trim() || `CS9-5 Business API Ecosystem <postmaster@${domain}>`,
        to,
        baseUrl: process.env.MAILGUN_BASE_URL?.trim() || undefined,
      };
    }
    if (!email) return publicError("Email sending is not configured on this server. No extraction was started.", 503, requestId);
  } else if (platform === "ademico") {
    ademico = ademicoConfigFromEnv();
    // Refused before extraction: an Ademico run would otherwise spend the
    // client's extraction credits and then stop with nothing sent.
    if (!ademico) return publicError("Sending through Ademico is not configured on this server.", 503, requestId);
  } else {
    const senderKey = process.env.B2BROUTER_API_KEY?.trim();
    const senderAccount = process.env.B2BROUTER_ACCOUNT_ID?.trim();
    sender = senderKey && senderAccount ? { apiKey: senderKey, accountId: senderAccount } : null;
    if (!sender) return publicError("B2Brouter sending is not configured on this server. No extraction was started.", 503, requestId);
  }

  // Counted last: a request refused above has spent no extraction credit.
  if (request.signal.aborted) return cancelled();
  const wait = checkPdfRateLimit(gate.user.id);
  if (wait > 0) return publicError("Too many invoices in a short time. Try again shortly.", 429, requestId, { retryAfterSeconds: wait });

  const name = upload.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "invoice.pdf";
  let outcome: Awaited<ReturnType<typeof composePdfInvoice>>;
  try {
    outcome = await composePdfInvoice({ name, pdf }, context, { extractorUrl, validatorKey, sender, ademico, email, signal: request.signal });
  } catch (error) {
    if (request.signal.aborted) return cancelled();
    throw error;
  }
  if (request.signal.aborted) return cancelled();
  if (!outcome.ok) {
    return publicError(outcome.message, STATUS[outcome.reason], requestId, {
      reason: outcome.reason,
      failed_step: outcome.failed_step,
      steps: outcome.steps,
      extracted: outcome.extracted,
      added: outcome.added,
      invoice_xml: outcome.invoice_xml,
      validation: outcome.validation,
      seller_abn_suggestion: outcome.seller_abn_suggestion,
    });
  }
  return NextResponse.json({ requestId, ...outcome }, { headers: { "Cache-Control": "no-store" } });
}
