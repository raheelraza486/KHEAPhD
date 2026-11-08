// A composed API: generate a Peppol BIS Billing 3.0 invoice, validate it, and
// send it if it is valid.
//
//   POST /api/composed/peppol-invoice
//   { invoice: { number, issueDate, currencyCode, seller, buyer, lines,
//                totalNetAmount, totalTaxAmount, totalGrossAmount, ... },
//     send_via?: "peppol" | "email", email_to?: "name@example.com" }
//
// The invoice object is beliq's EN 16931 shape. The response carries the
// generated XML, the validator's verdict, the delivery state, and what each
// integrated API did. Signed-in users only, and rate-limited: every call
// spends the group's generator quota. The keys are read on the server and
// never returned. Without B2BROUTER_API_KEY and B2BROUTER_ACCOUNT_ID the
// operation stops after validation.
//
// By email (send_via "email") the valid invoice is attached to a message sent
// through Mailgun, which needs MAILGUN_API_KEY and MAILGUN_DOMAIN;
// MAILGUN_FROM and MAILGUN_BASE_URL (the EU host) are optional. A person may
// email an invoice to their own account address, or to an address listed in
// MAILGUN_ALLOWED_RECIPIENTS (comma-separated): otherwise any account could
// send mail from the group's domain to strangers.
import { NextResponse } from "next/server";
import { APP_ROLES, requireRole } from "@/lib/auth";
import { composePeppolInvoice, emailRecipientAllowed, isEmailAddress, type EmailConfig, type FailureReason, type SenderConfig } from "@/lib/composition/peppol-invoice";
import { createAnswerLimiter, isSameOrigin, publicError } from "../../checks/shared";

export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 50_000;
const checkComposeRateLimit = createAnswerLimiter(60_000, 10);

const STATUS: Record<FailureReason, number> = {
  invoice_rejected: 422,
  generator_refused: 503,
  generator_unavailable: 502,
  not_peppol: 502,
  validator_unavailable: 502,
  sender_rejected: 422,
  sender_refused: 503,
  sender_unavailable: 502,
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOrigin(request)) return publicError("Cross-origin requests are not allowed.", 403, requestId);
  const gate = await requireRole(request, APP_ROLES, requestId);
  if ("response" in gate) return gate.response;
  const wait = checkComposeRateLimit(gate.user.id);
  if (wait > 0) return publicError("Too many invoices in a short time. Try again shortly.", 429, requestId, { retryAfterSeconds: wait });

  const apiKey = process.env.BELIQ_API_KEY?.trim();
  if (!apiKey) return publicError("The composed API is not configured.", 503, requestId);

  let invoice: Record<string, unknown>;
  let sendVia: unknown;
  let emailTo: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return publicError("The request body is too large.", 413, requestId);
    const body = JSON.parse(raw) as unknown;
    const candidate = (body as { invoice?: unknown } | null)?.invoice;
    sendVia = (body as { send_via?: unknown } | null)?.send_via ?? "peppol";
    emailTo = (body as { email_to?: unknown } | null)?.email_to;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return publicError("The request body must be { \"invoice\": { ... } }.", 400, requestId);
    }
    invoice = candidate as Record<string, unknown>;
  } catch {
    return publicError("The request body must be a JSON object.", 400, requestId);
  }

  if (sendVia !== "peppol" && sendVia !== "email") {
    return publicError("send_via must be \"peppol\" or \"email\".", 400, requestId);
  }

  let sender: SenderConfig | null = null;
  let email: EmailConfig | null = null;
  if (sendVia === "email") {
    const to = typeof emailTo === "string" ? emailTo.trim() : "";
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
  } else {
    const senderKey = process.env.B2BROUTER_API_KEY?.trim();
    const senderAccount = process.env.B2BROUTER_ACCOUNT_ID?.trim();
    sender = senderKey && senderAccount ? { apiKey: senderKey, accountId: senderAccount } : null;
  }

  const outcome = await composePeppolInvoice(invoice, { apiKey, sender, email });
  if (!outcome.ok) {
    return publicError(outcome.message, STATUS[outcome.reason], requestId, {
      reason: outcome.reason,
      failed_step: outcome.failed_step,
      steps: outcome.steps,
      invoice_xml: outcome.invoice_xml,
      validation: outcome.validation,
    });
  }
  return NextResponse.json({ requestId, ...outcome }, { headers: { "Cache-Control": "no-store" } });
}
