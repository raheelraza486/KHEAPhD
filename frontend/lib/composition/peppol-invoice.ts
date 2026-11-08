/**
 * A composed API: three catalogue APIs integrated into one operation.
 *
 *   invoice data ─▶ beliq API generateInvoice ─▶ Peppol BIS 3 UBL XML
 *                ─▶ Peppol Validator API validateInvoice ─▶ verdict
 *                ─▶ (valid only) B2Brouter import and send ─▶ delivery status
 *                   or, by email, Mailgun send message  ─▶ accepted for delivery
 *
 * The client asked on 20 September 2026 for APIs created "by integrating
 * several real APIs together", using and testing the existing APIs without
 * changing them and considering the rules the new API is subject to. Here the
 * rule set is chosen once and held on both sides: the generator is asked for
 * Peppol BIS Billing 3.0, and the validator checks against the same. (A German
 * XRechnung generator put in front of this validator fails it, as a real run
 * on 26 September showed, although the formats and fields match.)
 *
 * The validator is a gate, as in the client's own Step Functions workflow:
 * only a valid invoice is sent, and an invalid one is returned with its
 * errors and not sent. If the validator cannot be reached, the invoice has not
 * been validated, and it is neither sent nor passed off as validated.
 *
 * Sending is optional: without a sender configured the operation stops after
 * validation. A sender sends as the company registered on its account, so the
 * invoice's seller must be that company. On the B2Brouter sandbox nothing
 * leaves B2Brouter; the Peppol network and the recipient are simulated, and
 * the recipient's identifier decides the outcome (registered, refused, or no
 * receiver).
 *
 * The client's use case of 11 October 2026 ends with "send via email or
 * peppol", so the third step has two channels. By email the same validated
 * document is attached, unchanged, to a message sent through Mailgun. Mailgun
 * answers that it has queued the message; whether it reaches the mailbox is
 * settled later, so an emailed invoice is reported as accepted, not delivered.
 *
 * Over Peppol there is a second platform, Ademico, which the client named on
 * 17 October 2026. Unlike B2Brouter's sandbox it sends on the real Peppol test
 * network, and it takes a PINT A-NZ invoice as it is, so the validated
 * document goes out unchanged. It answers that it has queued the document;
 * the transmission's outcome is read from its notifications.
 *
 * `fetch` and `sleep` are injected so the tests run without calling a provider.
 */

export const GENERATOR = {
  api_name: "beliq API generateInvoice",
  url: "https://api.beliq.eu/v1/generate",
} as const;

export const VALIDATOR = {
  api_name: "Peppol Validator API validateInvoice",
  url: "https://peppolvalidator.com/api/v1/validate",
} as const;

export const SENDER = {
  api_name: "B2Brouter API import and send invoice",
  base: "https://api.b2brouter.net",
} as const;

export const EMAIL_SENDER = {
  api_name: "Mailgun Send Message API",
  base: "https://api.mailgun.net",
} as const;

/** Ademico's TEST environment, with Basic authentication (OAuth2 has another host). */
export const ADEMICO_SENDER = {
  api_name: "AdemicoPeppolREST",
  base: "https://test-peppol-api1.ademico-software.com/domibus",
} as const;

export const RULE_SET = "Peppol BIS Billing 3.0";
const PEPPOL_BIS_3 = "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";

/** B2Brouter states after which nothing more happens to a sent invoice. */
const FINAL_DELIVERY = new Set(["registered", "refused", "error", "accepted", "paid"]);

/**
 * Ademico's notification events for a sent document, as delivery states. A
 * document handed to the receiver's access point is "delivered"; a buyer's
 * invoice response, when one comes, says more and takes precedence.
 */
const ADEMICO_EVENT: Record<string, string> = {
  DOCUMENT_SENT: "delivered",
  DOCUMENT_SEND_FAILED: "error",
  MLR_RECEIVED: "rejected",
};

export interface StepOutcome {
  /** The PDF flow (pdf-invoice.ts) has a fourth step; this one has three. */
  order: 1 | 2 | 3 | 4;
  api_name: string;
  role: "extracts" | "produces" | "checks" | "delivers";
  status: "ok" | "failed";
  http_status: number | null;
  duration_ms: number;
}

export interface Finding {
  id: string;
  message: string;
}

export interface Validation {
  status: "valid" | "invalid";
  specification: string | null;
  errors: Finding[];
  warnings: Finding[];
}

export type Channel = "peppol" | "email";

export type Delivery =
  | {
    channel: "peppol";
    platform: "b2brouter";
    /** B2Brouter's invoice state: registered, refused, error — or sending/sent if still under way. */
    state: string;
    /** Whether the state is final; if not, the invoice was still travelling when we stopped asking. */
    final: boolean;
    invoice_id: number;
    /** Why it was refused or failed, in the platform's words. */
    reason: string | null;
  }
  | {
    channel: "peppol";
    platform: "ademico";
    /** delivered, rejected, error, or the buyer's response (accepted, refused…); queued while none has come. */
    state: string;
    final: boolean;
    transmission_id: string;
    /** The receiver's Peppol identifier, as Ademico read it from the invoice. */
    receiver: string | null;
    reason: string | null;
  }
  | {
    channel: "email";
    /** Mailgun has queued the message; reaching the mailbox is settled after this call returns. */
    state: "queued";
    final: false;
    message_id: string;
    recipient: string;
    reason: null;
  };

export type ComposedOutcome =
  | {
    ok: true;
    steps: StepOutcome[];
    rule_set: string;
    ruleset_versions: Record<string, string> | null;
    invoice_xml: string;
    validation: Validation;
    /** Null when there is no sender, or the invoice was invalid and so not sent. */
    delivery: Delivery | null;
  }
  | {
    ok: false;
    failed_step: 1 | 2 | 3;
    reason: FailureReason;
    message: string;
    steps: StepOutcome[];
    invoice_xml: string | null;
    validation: Validation | null;
  };

/**
 *   invoice_rejected      the generator judged the invoice data invalid (the caller's to fix)
 *   generator_refused     our credentials or quota were refused
 *   generator_unavailable the generator could not be reached or failed
 *   not_peppol            the generator returned something other than Peppol BIS 3
 *   validator_unavailable the invoice was generated but could not be validated
 *   sender_rejected       the sender would not take the invoice (e.g. the seller is not its company,
 *                         or the email domain may not write to that recipient)
 *   sender_refused        the sender refused our credentials
 *   sender_unavailable    the sender could not be reached or failed
 */
export type FailureReason =
  | "invoice_rejected"
  | "generator_refused"
  | "generator_unavailable"
  | "not_peppol"
  | "validator_unavailable"
  | "sender_rejected"
  | "sender_refused"
  | "sender_unavailable";

export interface SenderConfig {
  apiKey: string;
  /** The B2Brouter account that sends; its company must be the invoice's seller. */
  accountId: string;
}

export interface AdemicoConfig {
  username: string;
  password: string;
  /** The API access token Ademico issues per environment; sent as a query parameter. */
  accessToken: string;
  baseUrl?: string;
}

/** Ademico's TEST credentials from the server's settings; null until all three are set. */
export function ademicoConfigFromEnv(env: Record<string, string | undefined> = process.env): AdemicoConfig | null {
  const username = env.ADEMICO_USERNAME?.trim();
  const password = env.ADEMICO_PASSWORD?.trim();
  const accessToken = env.ADEMICO_ACCESS_TOKEN?.trim();
  if (!username || !password || !accessToken) return null;
  return { username, password, accessToken, baseUrl: env.ADEMICO_BASE_URL?.trim() || undefined };
}

export interface EmailConfig {
  apiKey: string;
  /** The Mailgun domain the message is sent from. */
  domain: string;
  /** The From header; a mailbox on `domain`. */
  from: string;
  /** One recipient address, already checked by the caller. */
  to: string;
  /** Mailgun's EU region has its own host; the default is the US one. */
  baseUrl?: string;
}

export interface ComposeInvoiceOptions {
  apiKey: string;
  sender?: SenderConfig | null;
  /** When set, the valid invoice is sent over Peppol through Ademico instead of B2Brouter. */
  ademico?: AdemicoConfig | null;
  /** When set, the valid invoice is emailed instead of being sent over Peppol. */
  email?: EmailConfig | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often, and how far apart, to ask for the delivery state after sending. */
  deliveryPolls?: number;
  deliveryPollMs?: number;
}

/** The provider's own explanation, trimmed: shown to the caller, never our key or headers. */
function providerMessage(text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const nested = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>).message : undefined;
    const parts = [body.title, body.detail, body.message, typeof body.error === "string" ? body.error : undefined, nested]
      .filter((v): v is string => typeof v === "string" && v.trim() !== "");
    if (parts.length > 0) return parts.join(" — ").slice(0, 500);
  } catch {
    // not JSON; fall through
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function findings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value.map((f) => {
    const r = (f ?? {}) as Record<string, unknown>;
    return { id: String(r.id ?? r.rule ?? ""), message: String(r.message ?? r.text ?? "") };
  });
}

const EMAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** One plain address: no display name, no list, nothing that could add a header. */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL_ADDRESS.test(value);
}

/**
 * Who a signed-in person may email an invoice to: their own account address,
 * or an address the server's allow-list names. Anything else would let any
 * account send mail from the group's domain to strangers.
 */
export function emailRecipientAllowed(to: string, accountEmail: string | null | undefined, allowList: readonly string[] = []): boolean {
  const wanted = to.trim().toLowerCase();
  if (!isEmailAddress(wanted)) return false;
  if (accountEmail && accountEmail.trim().toLowerCase() === wanted) return true;
  return allowList.some((entry) => entry.trim().toLowerCase() === wanted);
}

/** A file name from the invoice number, safe in a multipart header. */
function attachmentName(number: string): string {
  return `${number.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "invoice"}.xml`;
}

function deliveryReason(invoice: Record<string, unknown>): string | null {
  const errors = Array.isArray(invoice.errors)
    ? invoice.errors.map((e) => String((e as Record<string, unknown>)?.error ?? "")).filter(Boolean)
    : [];
  // B2Brouter can give the same sentence more than once.
  const parts = [...new Set([invoice.refuse_reason, ...errors].filter((v): v is string => typeof v === "string" && v.trim() !== ""))];
  return parts.length > 0 ? parts.join(" — ").slice(0, 500) : null;
}

export interface DeliveryJob {
  /** The document to send, as it is: the validated one, or the copy a caller made for the recipient's format. */
  xml: string;
  /** The invoice's own number: the email's subject and the attachment's name. */
  number: string;
  rule_set: string;
  /** B2Brouter's code for the document type the recipient is sent. */
  documentTypeCode: string;
  order: StepOutcome["order"];
}

export type DeliveryResult =
  | { ok: true; delivery: Delivery | null }
  | { ok: false; reason: "sender_rejected" | "sender_refused" | "sender_unavailable"; message: string };

type DeliveryOptions = Pick<ComposeInvoiceOptions, "sender" | "ademico" | "email" | "fetch" | "timeoutMs" | "now" | "sleep" | "deliveryPolls" | "deliveryPollMs">;

/**
 * The last step of a composed flow: send a valid invoice by email or over
 * Peppol, and record the step in `steps`. With neither channel configured
 * nothing is sent and the delivery is null.
 */
export async function deliverInvoice(job: DeliveryJob, options: DeliveryOptions, steps: StepOutcome[]): Promise<DeliveryResult> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { xml, order } = job;
  const number = job.number.trim() || "invoice";
  let started: number;

  if (options.email) {
    // By email: the validated document, unchanged, as an attachment.
    const { apiKey: mailKey, domain, from, to, baseUrl } = options.email;
    const form = new FormData();
    form.set("from", from);
    form.set("to", to);
    form.set("subject", `Invoice ${number}`);
    form.set("text", `Invoice ${number} is attached as a ${job.rule_set} UBL XML file. It passed validation against ${job.rule_set} before it was sent.`);
    form.set("attachment", new Blob([xml], { type: "application/xml" }), attachmentName(job.number));
    started = now();
    let mailed: Response;
    let mailedBody: string;
    try {
      mailed = await doFetch(`${baseUrl ?? EMAIL_SENDER.base}/v3/${encodeURIComponent(domain)}/messages`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`api:${mailKey}`).toString("base64")}`, Accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      mailedBody = await mailed.text();
    } catch {
      steps.push({ order, api_name: EMAIL_SENDER.api_name, role: "delivers", status: "failed", http_status: null, duration_ms: now() - started });
      return { ok: false, reason: "sender_unavailable", message: "The invoice is valid, but the email service could not be reached." };
    }
    let messageId: string | null = null;
    try {
      const id = (JSON.parse(mailedBody) as { id?: unknown }).id;
      messageId = typeof id === "string" && id.trim() ? id.trim() : null;
    } catch {
      messageId = null;
    }
    if (!mailed.ok || messageId === null) {
      steps.push({ order, api_name: EMAIL_SENDER.api_name, role: "delivers", status: "failed", http_status: mailed.status, duration_ms: now() - started });
      // Mailgun answers 403 for a recipient its domain may not write to, so only 401 and 429 are about us.
      const reason = mailed.status === 401 || mailed.status === 429 ? "sender_refused"
        : mailed.status >= 400 && mailed.status < 500 ? "sender_rejected"
        : "sender_unavailable";
      const message = reason === "sender_rejected"
        ? `The invoice is valid, but the email service would not send it: ${providerMessage(mailedBody)}`
        : reason === "sender_refused"
          ? "The invoice is valid, but the email service refused our credentials or quota."
          : "The invoice is valid, but the email service failed.";
      return { ok: false, reason, message };
    }
    steps.push({ order, api_name: EMAIL_SENDER.api_name, role: "delivers", status: "ok", http_status: mailed.status, duration_ms: now() - started });
    return { ok: true, delivery: { channel: "email", state: "queued", final: false, message_id: messageId, recipient: to, reason: null } };
  }

  if (options.ademico) return sendViaAdemico(job, options.ademico, options, steps);
  if (!options.sender) return { ok: true, delivery: null };

  // Over Peppol: hand the validated document, unchanged, to the sender.
  const { apiKey: senderKey, accountId } = options.sender;
  const senderHeaders = { "X-B2B-API-Key": senderKey, Accept: "application/json" };
  const query = new URLSearchParams({
    issued: "true",
    send_after_import: "true",
    transport_type_code_for_contact: "peppol",
    document_type_code_for_contact: job.documentTypeCode,
  });
  started = now();
  let sent: Response;
  let sentBody: string;
  try {
    sent = await doFetch(`${SENDER.base}/accounts/${encodeURIComponent(accountId)}/invoices/import?${query}`, {
      method: "POST",
      headers: { ...senderHeaders, "Content-Type": "application/octet-stream" },
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    });
    sentBody = await sent.text();
  } catch {
    steps.push({ order, api_name: SENDER.api_name, role: "delivers", status: "failed", http_status: null, duration_ms: now() - started });
    return { ok: false, reason: "sender_unavailable", message: "The invoice is valid, but the sending platform could not be reached." };
  }
  let imported: Record<string, unknown> | null = null;
  try {
    imported = (JSON.parse(sentBody) as { invoice?: Record<string, unknown> }).invoice ?? null;
  } catch {
    imported = null;
  }
  const invoiceId = typeof imported?.id === "number" ? imported.id : null;
  if (!sent.ok || invoiceId === null) {
    steps.push({ order, api_name: SENDER.api_name, role: "delivers", status: "failed", http_status: sent.status, duration_ms: now() - started });
    const reason = sent.status === 401 || sent.status === 403 || sent.status === 429 ? "sender_refused"
      : sent.status >= 400 && sent.status < 500 ? "sender_rejected"
      : "sender_unavailable";
    const message = reason === "sender_rejected"
      ? `The invoice is valid, but the sending platform would not take it: ${providerMessage(sentBody)}`
      : reason === "sender_refused"
        ? "The invoice is valid, but the sending platform refused our credentials."
        : "The invoice is valid, but the sending platform failed.";
    return { ok: false, reason, message };
  }

  // Sending is asynchronous: ask for the state a few times until it settles.
  let latest = imported!;
  const polls = options.deliveryPolls ?? 5;
  for (let i = 0; i < polls && !FINAL_DELIVERY.has(String(latest.state)); i++) {
    await sleep(options.deliveryPollMs ?? 2_000);
    try {
      const polled = await doFetch(`${SENDER.base}/invoices/${invoiceId}`, { headers: senderHeaders, signal: AbortSignal.timeout(timeoutMs) });
      if (!polled.ok) break;
      const next = (await polled.json() as { invoice?: Record<string, unknown> }).invoice;
      if (next) latest = next;
    } catch {
      break;
    }
  }
  steps.push({ order, api_name: SENDER.api_name, role: "delivers", status: "ok", http_status: sent.status, duration_ms: now() - started });
  const state = String(latest.state ?? "unknown");
  return { ok: true, delivery: { channel: "peppol", platform: "b2brouter", state, final: FINAL_DELIVERY.has(state), invoice_id: invoiceId, reason: deliveryReason(latest) } };
}

/** The outcome so far, from the notifications Ademico holds for one transmission. */
function ademicoState(notifications: unknown[]): { state: string; reason: string | null } | null {
  let found: { state: string; reason: string | null } | null = null;
  for (const item of notifications) {
    const n = (item ?? {}) as { eventType?: unknown; documentStatus?: unknown; details?: unknown };
    const event = String(n.eventType ?? "");
    const reason = Array.isArray(n.details)
      ? [...new Set(n.details.map((d) => String((d as { message?: unknown })?.message ?? "")).filter(Boolean))].join(" — ").slice(0, 500) || null
      : null;
    if (event === "INVOICE_RESPONSE_RECEIVED" && typeof n.documentStatus === "string") return { state: n.documentStatus.toLowerCase(), reason };
    if (ADEMICO_EVENT[event]) found = { state: ADEMICO_EVENT[event], reason };
  }
  return found;
}

/**
 * Over Peppol through Ademico: upload the document as it is, then read the
 * transmission's notifications until one arrives. The notifications are read,
 * not consumed, so the account's own queue is left as it was.
 */
async function sendViaAdemico(job: DeliveryJob, config: AdemicoConfig, options: DeliveryOptions, steps: StepOutcome[]): Promise<DeliveryResult> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = (config.baseUrl ?? ADEMICO_SENDER.base).replace(/\/+$/, "");
  const token = new URLSearchParams({ accessToken: config.accessToken });
  const headers = { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`, Accept: "application/json" };
  const form = new FormData();
  form.set("file", new Blob([job.xml], { type: "application/xml" }), attachmentName(job.number));
  const started = now();
  let sent: Response;
  let sentBody: string;
  try {
    sent = await doFetch(`${base}/api/peppol/v1/invoices/ubl-submissions?${token}`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(timeoutMs) });
    sentBody = await sent.text();
  } catch {
    steps.push({ order: job.order, api_name: ADEMICO_SENDER.api_name, role: "delivers", status: "failed", http_status: null, duration_ms: now() - started });
    return { ok: false, reason: "sender_unavailable", message: "The invoice is valid, but the sending platform could not be reached." };
  }
  let submitted: { transmissionId?: unknown; receiver?: unknown } = {};
  try {
    submitted = JSON.parse(sentBody) as typeof submitted;
  } catch {
    submitted = {};
  }
  const transmissionId = typeof submitted.transmissionId === "string" && submitted.transmissionId.trim() ? submitted.transmissionId.trim() : null;
  if (!sent.ok || transmissionId === null) {
    steps.push({ order: job.order, api_name: ADEMICO_SENDER.api_name, role: "delivers", status: "failed", http_status: sent.status, duration_ms: now() - started });
    // 400 is Ademico's answer for every document it will not send: invalid, unknown receiver, duplicate.
    const reason = sent.status === 401 || sent.status === 403 || sent.status === 429 ? "sender_refused"
      : sent.status >= 400 && sent.status < 500 ? "sender_rejected"
      : "sender_unavailable";
    const message = reason === "sender_rejected"
      ? `The invoice is valid, but the sending platform would not take it: ${providerMessage(sentBody)}`
      : reason === "sender_refused"
        ? "The invoice is valid, but the sending platform refused our credentials."
        : "The invoice is valid, but the sending platform failed.";
    return { ok: false, reason, message };
  }

  // Sending is queued: ask for this transmission's notifications a few times.
  let outcome: { state: string; reason: string | null } | null = null;
  const polls = options.deliveryPolls ?? 5;
  for (let i = 0; i < polls && outcome === null; i++) {
    await sleep(options.deliveryPollMs ?? 2_000);
    try {
      const query = new URLSearchParams({ transmissionId, accessToken: config.accessToken });
      const polled = await doFetch(`${base}/api/peppol/v1/notifications?${query}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!polled.ok) break;
      const list = (await polled.json() as { notifications?: unknown }).notifications;
      outcome = ademicoState(Array.isArray(list) ? list : []);
    } catch {
      break;
    }
  }
  steps.push({ order: job.order, api_name: ADEMICO_SENDER.api_name, role: "delivers", status: "ok", http_status: sent.status, duration_ms: now() - started });
  return {
    ok: true,
    delivery: {
      channel: "peppol",
      platform: "ademico",
      state: outcome?.state ?? "queued",
      final: outcome !== null,
      transmission_id: transmissionId,
      receiver: typeof submitted.receiver === "string" ? submitted.receiver : null,
      reason: outcome?.reason ?? null,
    },
  };
}

export async function composePeppolInvoice(invoice: Record<string, unknown>, options: ComposeInvoiceOptions): Promise<ComposedOutcome> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const steps: StepOutcome[] = [];

  // Step 1: generate.
  let started = now();
  let response: Response;
  try {
    response = await doFetch(GENERATOR.url, {
      method: "POST",
      headers: { "X-API-Key": options.apiKey, "Content-Type": "application/json", Accept: "application/xml" },
      body: JSON.stringify({ standard: "peppol-bis", output: "xml", invoice }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    steps.push({ order: 1, api_name: GENERATOR.api_name, role: "produces", status: "failed", http_status: null, duration_ms: now() - started });
    return { ok: false, failed_step: 1, reason: "generator_unavailable", message: "The invoice generator could not be reached.", steps, invoice_xml: null, validation: null };
  }
  const generated = await response.text();
  steps.push({ order: 1, api_name: GENERATOR.api_name, role: "produces", status: response.ok ? "ok" : "failed", http_status: response.status, duration_ms: now() - started });
  if (!response.ok) {
    const reason: FailureReason =
      response.status === 401 || response.status === 402 || response.status === 403 || response.status === 429 ? "generator_refused"
      : response.status >= 400 && response.status < 500 ? "invoice_rejected"
      : "generator_unavailable";
    const message = reason === "invoice_rejected"
      ? `The invoice data was rejected: ${providerMessage(generated)}`
      : reason === "generator_refused"
        ? "The invoice generator refused the request (credentials or quota)."
        : "The invoice generator failed.";
    return { ok: false, failed_step: 1, reason, message, steps, invoice_xml: null, validation: null };
  }
  if (!generated.includes(PEPPOL_BIS_3)) {
    return { ok: false, failed_step: 1, reason: "not_peppol", message: `The generator did not return a ${RULE_SET} invoice.`, steps, invoice_xml: generated, validation: null };
  }
  let versions: Record<string, string> | null = null;
  try {
    const block = response.headers.get("x-version-block");
    versions = block ? (JSON.parse(block) as Record<string, string>) : null;
  } catch {
    versions = null;
  }

  // Step 2: validate the document step 1 produced, unchanged.
  started = now();
  let checked: Response;
  let verdict: Record<string, unknown>;
  try {
    checked = await doFetch(VALIDATOR.url, {
      method: "POST",
      headers: { "Content-Type": "application/xml", Accept: "application/json" },
      body: generated,
      signal: AbortSignal.timeout(timeoutMs),
    });
    verdict = (await checked.json()) as Record<string, unknown>;
  } catch {
    steps.push({ order: 2, api_name: VALIDATOR.api_name, role: "checks", status: "failed", http_status: null, duration_ms: now() - started });
    return { ok: false, failed_step: 2, reason: "validator_unavailable", message: "The invoice was generated but could not be validated, so it was not sent.", steps, invoice_xml: generated, validation: null };
  }
  const status = verdict.status;
  const usable = checked.ok && (status === "valid" || status === "invalid");
  steps.push({ order: 2, api_name: VALIDATOR.api_name, role: "checks", status: usable ? "ok" : "failed", http_status: checked.status, duration_ms: now() - started });
  if (!usable) {
    return { ok: false, failed_step: 2, reason: "validator_unavailable", message: "The invoice was generated but could not be validated, so it was not sent.", steps, invoice_xml: generated, validation: null };
  }
  const validation: Validation = {
    status: status as "valid" | "invalid",
    specification: typeof verdict.specification === "string" ? verdict.specification : null,
    errors: findings(verdict.errors),
    warnings: findings(verdict.warnings),
  };
  const done = { ok: true as const, steps, rule_set: RULE_SET, ruleset_versions: versions, invoice_xml: generated, validation };

  // The gate: an invalid invoice, or no sender, ends the run here.
  if (validation.status !== "valid") return { ...done, delivery: null };

  // Step 3: by email or over Peppol, whichever the caller configured.
  const sent = await deliverInvoice({
    xml: generated,
    number: typeof invoice.number === "string" ? invoice.number : "",
    rule_set: RULE_SET,
    documentTypeCode: "xml.ubl.invoice.bis3",
    order: 3,
  }, options, steps);
  if (!sent.ok) return { ok: false, failed_step: 3, reason: sent.reason, message: sent.message, steps, invoice_xml: generated, validation };
  return { ...done, delivery: sent.delivery };
}
