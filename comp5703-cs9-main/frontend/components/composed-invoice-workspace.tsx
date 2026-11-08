"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * The composed API, run from the browser: invoice data goes to beliq, which
 * writes a Peppol BIS Billing 3.0 invoice; the Peppol Validator checks that
 * same document; and only a valid invoice goes on to B2Brouter, which sends it
 * over Peppol, or to Mailgun, which emails it. The page shows what each API
 * did, the verdict, the delivery state and the invoice.
 *
 * The seller is the demo company registered on the group's B2Brouter sandbox
 * account — a sending platform sends only as its own company — and the buyers
 * are B2Brouter's sandbox test recipients, whose identifiers decide the
 * simulated outcome. The invoice number, dates and lines are the caller's.
 * Totals and the GST breakdown are computed here, as EN 16931 requires them to
 * agree with the lines.
 */

type Line = { description: string; quantity: string; unitPrice: string; vatRate: string };

type StepOutcome = {
  order: 1 | 2 | 3;
  api_name: string;
  role: "produces" | "checks" | "delivers";
  status: "ok" | "failed";
  http_status: number | null;
  duration_ms: number;
};

export type Finding = { id: string; message: string };
export type Validation = { status: "valid" | "invalid"; specification: string | null; errors: Finding[]; warnings: Finding[] };
export type Channel = "peppol" | "email";
export type Delivery =
  | { channel: "peppol"; platform: "b2brouter"; state: string; final: boolean; invoice_id: number; reason: string | null }
  | { channel: "peppol"; platform: "ademico"; state: string; final: boolean; transmission_id: string; receiver: string | null; reason: string | null }
  | { channel: "email"; state: "queued"; final: false; message_id: string; recipient: string; reason: null };

type Success = {
  ok: true;
  steps: StepOutcome[];
  rule_set: string;
  ruleset_versions: Record<string, string> | null;
  invoice_xml: string;
  validation: Validation;
  delivery: Delivery | null;
};

type Failure = {
  ok: false;
  error: string;
  reason?: string;
  failed_step?: 1 | 2 | 3;
  steps?: StepOutcome[];
  invoice_xml?: string | null;
  validation?: Validation | null;
  retryAfterSeconds?: number;
};

/** The company on the group's B2Brouter sandbox account (fictional). */
const SELLER = {
  name: "CS9 Demo Supplies Pty Ltd",
  vatId: "AU47555222000",
  registrationId: "47555222000",
  email: "billing@cs9-demo.example",
  address: { street: "University of Sydney", city: "Camperdown", postalCode: "2050", countryCode: "AU", countrySubentity: "NSW" },
  peppol: { schemeId: "0151", id: "47555222000" },
};

/** B2Brouter's sandbox test recipients: the identifier decides the simulated outcome. */
export const RECIPIENTS = [
  { gln: "9508397101047", name: "Test PEPPOL Registered", outcome: "delivered and registered" },
  { gln: "9506215594996", name: "Test PEPPOL Refused", outcome: "delivered, then refused by the recipient" },
  { gln: "9500047420799", name: "Test PEPPOL No receiver", outcome: "not delivered: no such Peppol participant" },
] as const;

const ROLE_LABEL: Record<StepOutcome["role"], string> = {
  produces: "Transformation — produces the invoice",
  checks: "Validation — checks it; only a valid invoice goes on",
  delivers: "Communication — sends it",
};

export const SENDERS: Record<Channel, { api_name: string; short: string; label: string }> = {
  peppol: { api_name: "B2Brouter API import and send invoice", short: "B2Brouter send", label: "Communication — sends it over Peppol" },
  email: { api_name: "Mailgun Send Message API", short: "Mailgun send", label: "Communication — sends it by email" },
};

/** The second Peppol platform, used by the PDF flow. */
export const ADEMICO_SENDER = { api_name: "AdemicoPeppolREST", short: "Ademico send", label: "Communication — sends it over the Peppol test network" };

const planned = (channel: Channel): { order: 1 | 2 | 3; api_name: string; role: StepOutcome["role"] }[] => [
  { order: 1, api_name: "beliq API generateInvoice", role: "produces" },
  { order: 2, api_name: "Peppol Validator API validateInvoice", role: "checks" },
  { order: 3, api_name: SENDERS[channel].api_name, role: "delivers" },
];

const REASON_LABEL: Record<string, string> = {
  invoice_rejected: "The generator rejected the invoice data",
  generator_refused: "The generator refused our credentials or quota",
  generator_unavailable: "The generator could not be reached",
  not_peppol: "The generator returned another rule set",
  validator_unavailable: "Generated, but not validated",
  sender_rejected: "Valid, but the sender would not take it",
  sender_refused: "The sender refused our credentials",
  sender_unavailable: "Valid, but the sender could not be reached",
};

const DELIVERY_LABEL: Record<string, { tone: "pass" | "fail" | "unknown"; label: string; detail: string }> = {
  registered: { tone: "pass", label: "Delivered", detail: "The recipient's Peppol access point received and registered the invoice." },
  delivered: { tone: "pass", label: "Delivered", detail: "The invoice reached the recipient's Peppol access point." },
  rejected: { tone: "fail", label: "Rejected", detail: "The recipient's access point rejected the invoice." },
  accepted: { tone: "pass", label: "Accepted", detail: "The recipient accepted the invoice." },
  paid: { tone: "pass", label: "Paid", detail: "The recipient marked the invoice as paid." },
  refused: { tone: "fail", label: "Refused", detail: "The invoice was delivered, but the recipient refused it." },
  error: { tone: "fail", label: "Not delivered", detail: "The sending platform could not deliver the invoice." },
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A fresh number for each run: the sending platform will not take the same number twice. */
function invoiceNumber(): string {
  const d = new Date();
  return `CS95-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Build beliq's invoice object; null with a reason when a line cannot be read. */
function buildInvoice(fields: { number: string; issueDate: string; dueDate: string; buyerReference: string; recipient: string }, lines: Line[]) {
  const parsed = [];
  for (const [index, line] of lines.entries()) {
    const quantity = Number(line.quantity);
    const unitPrice = Number(line.unitPrice);
    const vatRate = Number(line.vatRate);
    if (!line.description.trim()) return { error: `Line ${index + 1} needs a description.` };
    if (!(quantity > 0) || !(unitPrice >= 0) || !(vatRate >= 0)) return { error: `Line ${index + 1} needs a positive quantity, a price and a GST rate.` };
    parsed.push({
      description: line.description.trim(),
      quantity,
      unitCode: "HUR",
      unitPrice,
      lineTotal: round2(quantity * unitPrice),
      vatRate,
      vatCategoryCode: vatRate === 0 ? "Z" : "S",
    });
  }
  if (parsed.length === 0) return { error: "Add at least one line." };
  if (!fields.number.trim() || !fields.issueDate || !fields.dueDate) return { error: "Set the invoice number and the dates." };
  const recipient = RECIPIENTS.find((r) => r.gln === fields.recipient) ?? RECIPIENTS[0];

  const byRate = new Map<string, { vatCategoryCode: string; vatRate: number; taxableAmount: number }>();
  for (const line of parsed) {
    const key = `${line.vatCategoryCode}:${line.vatRate}`;
    const group = byRate.get(key) ?? { vatCategoryCode: line.vatCategoryCode, vatRate: line.vatRate, taxableAmount: 0 };
    group.taxableAmount = round2(group.taxableAmount + line.lineTotal);
    byRate.set(key, group);
  }
  const taxSummary = [...byRate.values()].map((g) => ({ ...g, taxAmount: round2((g.taxableAmount * g.vatRate) / 100) }));
  const totalNetAmount = round2(parsed.reduce((sum, l) => sum + l.lineTotal, 0));
  const totalTaxAmount = round2(taxSummary.reduce((sum, g) => sum + g.taxAmount, 0));

  return {
    invoice: {
      number: fields.number.trim(),
      issueDate: fields.issueDate,
      dueDate: fields.dueDate,
      currencyCode: "AUD",
      buyerReference: fields.buyerReference.trim(),
      seller: SELLER,
      buyer: {
        name: recipient.name,
        address: { street: "1 Test Street", city: "Sydney", postalCode: "2000", countryCode: "AU" },
        peppol: { schemeId: "0088", id: recipient.gln },
      },
      lines: parsed,
      taxSummary,
      paymentTerms: "Payable within 30 days",
      totalNetAmount,
      totalTaxAmount,
      totalGrossAmount: round2(totalNetAmount + totalTaxAmount),
    },
  };
}

function money(n: number): string {
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

function StepList({ steps, channel, notSent }: { steps: StepOutcome[]; channel: Channel; notSent?: string }) {
  return (
    <ol className="composed-steps">
      {planned(channel).map((plan) => {
        const ran = steps.find((s) => s.order === plan.order);
        const state = ran ? ran.status : "skipped";
        return (
          <li key={plan.order} className={`composed-step composed-step-${state}`}>
            <span className="composed-step-order">{plan.order}</span>
            <div>
              <strong>{ran?.api_name ?? plan.api_name}</strong>
              <small>{!ran && plan.order === 3 && notSent ? notSent : plan.order === 3 ? SENDERS[channel].label : ROLE_LABEL[plan.role]}</small>
            </div>
            <span className={`compat-status ${state === "ok" ? "status-pass" : state === "failed" ? "status-fail" : "status-unknown"}`}>
              {state === "ok" ? "Done" : state === "failed" ? "Failed" : "Not run"}
              {ran && ` · ${ran.http_status ?? "no reply"} · ${(ran.duration_ms / 1000).toFixed(1)} s`}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function DeliveryPanel({ delivery }: { delivery: Delivery }) {
  if (delivery.channel === "email") {
    return (
      <div className="composed-verdict composed-verdict-pending">
        <span className="compat-status status-unknown">Accepted for delivery</span>
        <div>
          <strong>Mailgun queued the message to {delivery.recipient}, with the invoice attached.</strong>
          <small>Whether it reaches the inbox or the spam folder is settled after this call returns · Mailgun message {delivery.message_id}</small>
        </div>
      </div>
    );
  }
  const known = DELIVERY_LABEL[delivery.state];
  const tone = known?.tone ?? "unknown";
  return (
    <div className={`composed-verdict composed-verdict-${tone === "pass" ? "valid" : tone === "fail" ? "invalid" : "pending"}`}>
      <span className={`compat-status status-${tone}`}>{known?.label ?? (delivery.final ? delivery.state : "In transit")}</span>
      <div>
        <strong>
          {known?.detail ?? (delivery.final
            ? `The sending platform reports "${delivery.state}".`
            : `Still ${delivery.state} when we stopped checking; delivery is asynchronous.`)}
        </strong>
        <small>
          {delivery.platform === "ademico"
            ? <>Ademico transmission {delivery.transmission_id}{delivery.receiver && <> · to {delivery.receiver}</>}</>
            : <>B2Brouter invoice {delivery.invoice_id}</>}
          {delivery.reason && <> · {delivery.reason}</>}
        </small>
      </div>
    </div>
  );
}

export function XmlPanel({ xml, name, title = "The generated invoice" }: { xml: string; name: string; title?: string }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name || "invoice"}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <details className="composed-xml">
      <summary>
        <span>{title} (UBL XML, {Math.round(xml.length / 1024)} KB)</span>
        <button type="button" className="button secondary" onClick={(e) => { e.preventDefault(); download(); }}>Download</button>
      </summary>
      <pre>{xml}</pre>
    </details>
  );
}

export function FindingList({ title, items, tone }: { title: string; items: Finding[]; tone: "error" | "warning" }) {
  if (items.length === 0) return null;
  return (
    <div className={`composed-findings composed-findings-${tone}`}>
      <strong>{title} ({items.length})</strong>
      <ul>
        {items.map((f, i) => (
          <li key={`${f.id}-${i}`}><code>{f.id}</code> {f.message}</li>
        ))}
      </ul>
    </div>
  );
}

export function VerdictPanel({ validation, ruleSet, versions }: { validation: Validation; ruleSet: string; versions?: Record<string, string> | null }) {
  return (
    <div className={`composed-verdict composed-verdict-${validation.status}`}>
      <span className={`compat-status ${validation.status === "valid" ? "status-pass" : "status-fail"}`}>
        {validation.status === "valid" ? "Valid" : "Invalid"}
      </span>
      <div>
        <strong>
          {validation.status === "valid"
            ? `The invoice passes ${validation.specification ?? ruleSet}.`
            : `The invoice was generated, but fails ${validation.specification ?? ruleSet}, so it was not sent.`}
        </strong>
        <small>
          {validation.errors.length} errors · {validation.warnings.length} warnings
          {versions?.ciusVersion && <> · generated under {versions.ciusVersion}</>}
        </small>
      </div>
    </div>
  );
}

export default function ComposedInvoiceWorkspace({ accountEmail = "" }: { accountEmail?: string }) {
  const [fields, setFields] = useState({
    number: "",
    issueDate: "",
    dueDate: "",
    buyerReference: "CS95-DEMO-REF",
    recipient: RECIPIENTS[0].gln as string,
  });
  const [channel, setChannel] = useState<Channel>("peppol");
  const [emailTo, setEmailTo] = useState(accountEmail);
  const [ranChannel, setRanChannel] = useState<Channel>("peppol");
  const [lines, setLines] = useState<Line[]>([
    { description: "API integration consulting", quantity: "2", unitPrice: "150", vatRate: "10" },
  ]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Success | Failure | null>(null);
  const [ranNumber, setRanNumber] = useState("invoice");

  // The number and dates come from the viewer's clock, set after hydration:
  // the server's clock may be on another day.
  useEffect(() => {
    setFields((f) => (f.issueDate ? f : { ...f, number: invoiceNumber(), issueDate: isoDate(0), dueDate: isoDate(30) }));
  }, []);

  const built = useMemo(() => buildInvoice(fields, lines), [fields, lines]);
  const invoice = "invoice" in built ? built.invoice : null;
  const recipient = RECIPIENTS.find((r) => r.gln === fields.recipient) ?? RECIPIENTS[0];

  const setField = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));
  const setLine = (index: number, key: keyof Line) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, [key]: e.target.value } : l)));

  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (!invoice) return;
    setRunning(true);
    setResult(null);
    setRanNumber(invoice.number);
    setRanChannel(channel);
    try {
      const response = await fetch("/api/composed/peppol-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(channel === "email" ? { invoice, send_via: "email", email_to: emailTo.trim() } : { invoice, send_via: "peppol" }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      setResult(response.ok ? ({ ...payload, ok: true } as Success) : ({ ...payload, ok: false, error: String(payload.error ?? `The request failed (${response.status}).`) } as Failure));
    } catch {
      setResult({ ok: false, error: "The request could not be sent. Check the connection and try again." });
    } finally {
      setRunning(false);
      // The platform may now hold this number; the next run needs its own.
      setFields((f) => ({ ...f, number: invoiceNumber() }));
    }
  }

  const notSentReason = (r: Success) =>
    r.validation.status !== "valid" ? "Not sent: the invoice failed validation."
      : ranChannel === "email" ? "Not sent: no email service is configured on this server."
      : "Not sent: no sending platform is configured on this server.";

  return (
    <main className="app-shell" id="main-content">
      <section className="workspace">
        <header className="compatibility-page-header">
          <div>
            <p className="eyebrow">Composed API · Peppol invoice</p>
            <h1>Three real APIs,<br />run as one.</h1>
            <p className="intro-copy">
              beliq writes a Peppol BIS Billing 3.0 invoice from the data below; the Peppol Validator checks that same
              document against the same rule set; and only if it is valid, B2Brouter sends it over Peppol or Mailgun
              sends it by email. All three calls are real. The rule set is fixed on both sides: a generator for
              another standard (German XRechnung) failed this validator on 26 September, although the formats and
              fields matched.
            </p>
          </div>
          <a className="button secondary" href="/compose/pdf-invoice">Start from a PDF instead</a>
        </header>

        <ol className="compat-flow composed-flow" aria-label="The composed process">
          <li><span>Invoice data (JSON)</span><i>→</i></li>
          <li><span>1 · beliq generateInvoice</span><i>→</i></li>
          <li><span>Peppol BIS 3.0 UBL XML</span><i>→</i></li>
          <li><span>2 · Peppol Validator</span><i>→</i></li>
          <li><span>valid only</span><i>→</i></li>
          <li><span>3 · {SENDERS[channel].short}</span><i>→</i></li>
          <li><span>Delivery status</span></li>
        </ol>

        <form className="composed-form" onSubmit={run}>
          <fieldset>
            <legend>Invoice</legend>
            <div className="composed-grid">
              <label><span>Invoice number</span><input value={fields.number} onChange={setField("number")} required maxLength={40} /></label>
              <label><span>Issue date</span><input type="date" value={fields.issueDate} onChange={setField("issueDate")} required /></label>
              <label><span>Due date</span><input type="date" value={fields.dueDate} onChange={setField("dueDate")} required /></label>
              <label><span>Buyer reference</span><input value={fields.buyerReference} onChange={setField("buyerReference")} maxLength={60} /></label>
            </div>
            <div className="composed-grid composed-grid-recipient">
              <label>
                <span>Send via</span>
                <select value={channel} onChange={(e) => setChannel(e.target.value === "email" ? "email" : "peppol")}>
                  <option value="peppol">Peppol · B2Brouter sandbox</option>
                  <option value="email">Email · Mailgun</option>
                </select>
              </label>
              <label>
                <span>{channel === "email" ? "Buyer on the invoice (B2Brouter sandbox test recipient)" : "Send to (B2Brouter sandbox test recipient)"}</span>
                <select value={fields.recipient} onChange={setField("recipient")}>
                  {RECIPIENTS.map((r) => <option key={r.gln} value={r.gln}>{r.name} · GLN {r.gln}</option>)}
                </select>
              </label>
              {channel === "email" && (
                <label>
                  <span>Email the invoice to (your account address, or an allowed address)</span>
                  <input type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} required maxLength={254} placeholder="name@example.com" />
                </label>
              )}
            </div>
            <p className="composed-parties">
              <span><strong>Seller</strong> {SELLER.name} · ABN {SELLER.registrationId} · Camperdown NSW</span>
              <span><strong>Expected</strong> {channel === "email" ? "accepted by Mailgun and emailed with the invoice attached" : recipient.outcome}</span>
              <span><strong>Currency</strong> AUD</span>
            </p>
          </fieldset>

          <fieldset>
            <legend>Lines</legend>
            <div className="composed-lines">
              <div className="composed-line composed-line-head" aria-hidden="true">
                <span>Description</span><span>Hours</span><span>Unit price</span><span>GST %</span><span />
              </div>
              {lines.map((line, i) => (
                <div className="composed-line" key={i}>
                  <input aria-label={`Line ${i + 1} description`} placeholder="Description" value={line.description} onChange={setLine(i, "description")} maxLength={120} />
                  <input aria-label={`Line ${i + 1} hours`} inputMode="decimal" placeholder="Hours" value={line.quantity} onChange={setLine(i, "quantity")} />
                  <input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" placeholder="Unit price" value={line.unitPrice} onChange={setLine(i, "unitPrice")} />
                  <input aria-label={`Line ${i + 1} GST rate`} inputMode="decimal" placeholder="GST %" value={line.vatRate} onChange={setLine(i, "vatRate")} />
                  <button type="button" className="button secondary" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>Remove</button>
                </div>
              ))}
              <button type="button" className="button secondary composed-add" disabled={lines.length >= 10}
                onClick={() => setLines((ls) => [...ls, { description: "", quantity: "1", unitPrice: "0", vatRate: "10" }])}>
                Add a line
              </button>
            </div>
            {invoice ? (
              <p className="composed-totals">
                Net <strong>{money(invoice.totalNetAmount)}</strong> · GST <strong>{money(invoice.totalTaxAmount)}</strong> · Total <strong>{money(invoice.totalGrossAmount)}</strong>
              </p>
            ) : (
              <p className="composed-totals composed-totals-error" role="alert">{"error" in built ? built.error : ""}</p>
            )}
          </fieldset>

          <div className="composed-actions">
            <button type="submit" className="button primary" disabled={!invoice || running || (channel === "email" && !emailTo.trim())}>
              {running ? `Calling beliq, the validator, then ${channel === "email" ? "Mailgun" : "B2Brouter"}…` : "Generate, validate and send"}
            </button>
            {invoice && (
              <details className="composed-request">
                <summary>What is sent to beliq</summary>
                <pre>{JSON.stringify({ standard: "peppol-bis", output: "xml", invoice }, null, 2)}</pre>
              </details>
            )}
          </div>
        </form>

        {result && (
          <section className="composed-result" aria-live="polite">
            {result.ok ? (
              <>
                <VerdictPanel validation={result.validation} ruleSet={result.rule_set} versions={result.ruleset_versions} />
                {result.delivery && <DeliveryPanel delivery={result.delivery} />}
                <StepList steps={result.steps} channel={ranChannel} notSent={result.delivery ? undefined : notSentReason(result)} />
                <FindingList title="Errors" items={result.validation.errors} tone="error" />
                <FindingList title="Warnings" items={result.validation.warnings} tone="warning" />
                <XmlPanel xml={result.invoice_xml} name={ranNumber} />
              </>
            ) : (
              <>
                <div className="composed-verdict composed-verdict-failed">
                  <span className="compat-status status-fail">{result.reason ? REASON_LABEL[result.reason] ?? "Failed" : "Failed"}</span>
                  <div>
                    <strong>{result.error}</strong>
                    {result.retryAfterSeconds && <small>Try again in {result.retryAfterSeconds} s.</small>}
                  </div>
                </div>
                {result.validation && <VerdictPanel validation={result.validation} ruleSet="Peppol BIS Billing 3.0" />}
                {result.steps && <StepList steps={result.steps} channel={ranChannel} />}
                {result.invoice_xml && <XmlPanel xml={result.invoice_xml} name={ranNumber} />}
              </>
            )}
          </section>
        )}

        <p className="composed-note">
          Sending over Peppol runs on B2Brouter&apos;s sandbox: the Peppol network and the recipient are simulated
          inside B2Brouter, nothing reaches a real business, and the recipient chosen above decides the outcome. The
          seller is a fictional company registered on the group&apos;s sandbox account, because a sending platform
          sends only as its own registered company. By email the same validated invoice is attached to a real
          message; it can go to your own account address, or to an address the administrators have allowed.
        </p>
      </section>
    </main>
  );
}
