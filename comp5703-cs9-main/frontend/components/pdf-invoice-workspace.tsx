"use client";

import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { invoiceFailureHint } from "@/lib/composition/invoice-run-options";
import { ADEMICO_SENDER, DeliveryPanel, FindingList, RECIPIENTS, SENDERS, VerdictPanel, XmlPanel, type Channel, type Delivery, type Validation } from "@/components/composed-invoice-workspace";

/**
 * The client's use case, run from the browser: an invoice PDF goes to
 * Upbrains, which reads its fields; AmitTransform writes them as UBL XML,
 * which is completed as a PINT A-NZ invoice; ESS checks that document under
 * the Australian rules; and only a valid invoice goes on to B2Brouter or
 * Ademico, which send it over Peppol, or to Mailgun, which emails it. The page shows what
 * was read from the PDF, what was added to it, what each API did, the verdict,
 * the delivery state and the invoice.
 *
 * A PDF does not carry a buyer reference, the buyer's ABN or an electronic
 * address, and the Australian rules ask for them. They are entered here, in
 * sight, and start as demonstration values that fit the group's sandbox.
 */

type StepOutcome = {
  order: 1 | 2 | 3 | 4;
  api_name: string;
  role: "extracts" | "produces" | "checks" | "delivers";
  status: "ok" | "failed";
  http_status: number | null;
  duration_ms: number;
};

type Extracted = {
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
};

type Success = {
  ok: true;
  steps: StepOutcome[];
  rule_set: string;
  extracted: Extracted;
  added: string[];
  invoice_xml: string;
  validation: Validation;
  delivery: Delivery | null;
  sent_copy: { format: string; reason: string; changes: string[]; invoice_xml: string } | null;
};

type Failure = {
  ok: false;
  error: string;
  reason?: string;
  failed_step?: 1 | 2 | 3 | 4;
  steps?: StepOutcome[];
  extracted?: Extracted | null;
  added?: string[];
  invoice_xml?: string | null;
  validation?: Validation | null;
  retryAfterSeconds?: number;
  seller_abn_suggestion?: { value: string; page: number };
};

const RULE_SET = "Peppol PINT A-NZ Billing";

/** Where step 4 sends: a Peppol platform, or email. */
type Route = Channel | "ademico";
const senderOf = (route: Route) => (route === "ademico" ? ADEMICO_SENDER : SENDERS[route]);
const MAX_PDF_BYTES = 4 * 1024 * 1024;

const PLANNED: { order: 1 | 2 | 3; api_name: string; label: string }[] = [
  { order: 1, api_name: "Upbrains Extract Invoice From PDF API", label: "Transformation — reads the invoice's fields from the PDF" },
  { order: 2, api_name: "AmitTransform Convert UBL JSON to UBL XML API", label: "Transformation — writes them as UBL XML" },
  { order: 3, api_name: "ESS SmartDocFlow Validate PINT A-NZ Invoice API", label: "Validation — checks it under the Australian rules; only a valid invoice goes on" },
];

const REASON_LABEL: Record<string, string> = {
  extractor_refused: "The extractor refused our request",
  extractor_unavailable: "The extractor could not be reached",
  extraction_unusable: "Extraction needs review",
  converter_unavailable: "Extracted, but the converter could not be reached",
  conversion_unusable: "Extracted, but not converted",
  validator_refused: "Converted, but the validator refused our request",
  validator_unavailable: "Converted, but not validated",
  sender_rejected: "Valid, but the sender would not take it",
  sender_refused: "The sender refused our credentials",
  sender_unavailable: "Valid, but the sender could not be reached",
};

function StepList({ steps, route, notSent }: { steps: StepOutcome[]; route: Route; notSent?: string }) {
  const planned = [...PLANNED, { order: 4 as const, api_name: senderOf(route).api_name, label: senderOf(route).label }];
  return (
    <ol className="composed-steps">
      {planned.map((plan) => {
        const ran = steps.find((s) => s.order === plan.order);
        const state = ran ? ran.status : "skipped";
        return (
          <li key={plan.order} className={`composed-step composed-step-${state}`}>
            <span className="composed-step-order">{plan.order}</span>
            <div>
              <strong>{ran?.api_name ?? plan.api_name}</strong>
              <small>{!ran && plan.order === 4 && notSent ? notSent : plan.label}</small>
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

function ExtractedPanel({ extracted, added }: { extracted: Extracted; added: string[] }) {
  return (
    <div className="composed-extracted">
      <div>
        <strong>Invoice prepared from the PDF</strong>
        <dl>
          <div><dt>Invoice</dt><dd>{extracted.number}</dd></div>
          <div><dt>Issued</dt><dd>{extracted.issue_date}{extracted.due_date && <> · due {extracted.due_date}</>}</dd></div>
          <div><dt>Seller</dt><dd>{extracted.seller}</dd></div>
          <div><dt>Buyer</dt><dd>{extracted.buyer}</dd></div>
          <div><dt>Lines</dt><dd>{extracted.lines}</dd></div>
          <div><dt>Total</dt><dd>{extracted.currency} {extracted.total} <small>(net {extracted.net}, tax {extracted.tax})</small></dd></div>
        </dl>
        {extracted.notes.length > 0 && <ul>{extracted.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      </div>
      {added.length > 0 && (
        <div>
          <strong>Added to the converter&apos;s document</strong>
          <ul>{added.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

export default function PdfInvoiceWorkspace({ accountEmail = "", ademicoAvailable = false }: { accountEmail?: string; ademicoAvailable?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [fields, setFields] = useState({
    invoiceId: "", issueDate: "", dueDate: "",
    buyerReference: "CS95-DEMO-REF",
    buyerAbn: "99000000000",
    sellerAbn: "",
    paymentTerms: "Payment within 30 days",
    recipient: RECIPIENTS[0].gln as string,
    // A participant on the Peppol test network; Ademico looks it up before sending.
    receiverScheme: "0151",
    receiverId: "",
  });
  const [channel, setChannel] = useState<Route>("peppol");
  const [emailTo, setEmailTo] = useState(accountEmail);
  const [ranChannel, setRanChannel] = useState<Route>("peppol");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Success | Failure | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
  }, []);

  const [loadingProgress, setLoadingProgress] = useState<number | null>(null);
  const showLoading = running || loadingProgress !== null;

  useEffect(() => {
    if (running) {
      const started = performance.now();
      setLoadingProgress(0);
      // This endpoint returns all steps together, so leave headroom until it finishes.
      const timer = window.setInterval(() => {
        setLoadingProgress(94 * (1 - Math.exp(-(performance.now() - started) / 12_000)));
      }, 150);
      return () => window.clearInterval(timer);
    }
    const completed = result?.ok && result.validation.status === "valid" && result.delivery
      && !["refused", "rejected", "error"].includes(result.delivery.state)
      && result.steps.some(step => step.order === 4 && step.status === "ok");
    if (!completed) {
      setLoadingProgress(null);
      return;
    }
    setLoadingProgress(100);
    const timer = window.setTimeout(() => setLoadingProgress(null), 750);
    return () => window.clearTimeout(timer);
  }, [running, result]);

  const recipient = RECIPIENTS.find((r) => r.gln === fields.recipient) ?? RECIPIENTS[0];
  const setField = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  function selectFile(chosen: File) {
    if (running) return;
    if (chosen.type !== "application/pdf" && !/\.pdf$/i.test(chosen.name)) {
      setFileError("Choose a PDF invoice.");
      return;
    }
    if (!chosen.size || chosen.size > MAX_PDF_BYTES) {
      setFileError(chosen.size ? "The file is larger than 4 MB." : "Choose a non-empty PDF invoice.");
      return;
    }
    setFileError("");
    setFile(chosen);
  }

  function dropFile(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (running) return;
    const files = event.dataTransfer.files;
    if (files.length > 1) { setFileError("Choose one PDF invoice at a time."); return; }
    if (files[0]) selectFile(files[0]);
  }

  // Inputs the Australian rules need when the invoice does not carry them (see pintAunzMissingData).
  const blankFields = [
    ["the buyer reference", fields.buyerReference], ["the buyer's ABN", fields.buyerAbn], ["the payment terms", fields.paymentTerms],
  ].filter(([, value]) => !value.trim()).map(([label]) => label);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (!file || fileError || running || activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    dragDepth.current = 0;
    setDragging(false);
    setCancelled(false);
    setRunning(true);
    setResult(null);
    setRanChannel(channel);
    const form = new FormData();
    form.set("file", file);
    form.set("send_via", channel === "email" ? "email" : "peppol");
    if (channel === "ademico") form.set("peppol_platform", "ademico");
    if (channel === "email") form.set("email_to", emailTo.trim());
    form.set("buyer_reference", fields.buyerReference.trim());
    form.set("buyer_abn", fields.buyerAbn.trim());
    form.set("seller_abn", fields.sellerAbn.trim());
    form.set("payment_terms", fields.paymentTerms.trim());
    if (channel === "peppol") {
      form.set("invoice_number", fields.invoiceId.trim());
      form.set("issue_date", fields.issueDate);
      form.set("due_date", fields.dueDate);
    }
    form.set("buyer_endpoint_scheme", channel === "ademico" ? fields.receiverScheme.trim() : "0088");
    form.set("buyer_endpoint_id", channel === "ademico" ? fields.receiverId.trim() : fields.recipient);
    try {
      const response = await fetch("/api/composed/pdf-invoice", { method: "POST", body: form, signal: controller.signal });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      setResult(response.ok ? ({ ...payload, ok: true } as Success) : ({ ...payload, ok: false, error: String(payload.error ?? `The request failed (${response.status}).`) } as Failure));
    } catch {
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      setResult({ ok: false, error: "The request could not be sent. Check the connection and try again." });
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setRunning(false);
      }
    }
  }

  function cancel() {
    const controller = activeRequest.current;
    if (!controller) return;
    activeRequest.current = null;
    controller.abort();
    setRunning(false);
    setResult(null);
    setCancelled(true);
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
            <p className="eyebrow">Invoice workflows</p>
            <h1>Process and send a PDF invoice</h1>
            <p className="intro-copy">
              Upbrains reads the invoice&apos;s fields from the PDF; AmitTransform writes them as UBL XML, which is completed
              as a PINT A-NZ invoice; ESS checks that document under the Australian rules; and only if it is valid,
              Mailgun sends it by email, Ademico sends it over the Peppol test network, or B2Brouter sends a Peppol BIS
              3.0 copy of it to its sandbox. All four calls are real, and the run stops at the first step that fails.
            </p>
          </div>
          <a className="button secondary" href="/compose/peppol-invoice">Start from invoice data instead</a>
        </header>

        <ol className="compat-flow composed-flow" aria-label="The composed process">
          <li><span>Invoice (PDF)</span><i>→</i></li>
          <li><span>1 · Upbrains extract</span><i>→</i></li>
          <li><span>2 · AmitTransform convert</span><i>→</i></li>
          <li><span>PINT A-NZ UBL XML</span><i>→</i></li>
          <li><span>3 · ESS PINT A-NZ</span><i>→</i></li>
          <li><span>valid only</span><i>→</i></li>
          <li><span>4 · {senderOf(channel).short}</span><i>→</i></li>
          <li><span>Delivery status</span></li>
        </ol>

        <form className="composed-form" onSubmit={run}>
          <fieldset>
            <legend>Invoice</legend>
            <label className={`composed-pdf-upload${dragging && !running ? " is-dragging" : ""}`} aria-disabled={running}
              onDragEnter={event => {
                event.preventDefault();
                if (running || !event.dataTransfer.types.includes("Files")) return;
                dragDepth.current++;
                setDragging(true);
              }}
              onDragOver={event => {
                event.preventDefault();
                event.dataTransfer.dropEffect = running ? "none" : "copy";
              }}
              onDragLeave={event => {
                event.preventDefault();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (!dragDepth.current) setDragging(false);
              }}
              onDrop={dropFile}>
              <span>The invoice, as one PDF of at most 4 MB</span>
              <input type="file" accept="application/pdf,.pdf" disabled={running} required={!file}
                aria-invalid={Boolean(fileError)} aria-describedby={fileError ? "pdf-invoice-file-error" : undefined}
                onChange={event => {
                  const chosen = event.target.files?.[0];
                  if (chosen) selectFile(chosen);
                  event.target.value = "";
                }} />
              {file && <strong>{file.name}</strong>}
              <span className="composed-pdf-prompt">{dragging && !running ? "Drop your PDF here" : <>Drag a PDF here or <span>browse files</span></>}</span>
            </label>
            {fileError && <p id="pdf-invoice-file-error" className="composed-totals composed-totals-error" role="alert">{fileError}</p>}
          </fieldset>

          <fieldset>
            <legend>Not on a PDF, so entered here</legend>
            <div className="composed-grid">
              <label><span>Buyer reference</span><input value={fields.buyerReference} onChange={setField("buyerReference")} maxLength={60} /></label>
              <label><span>Buyer&apos;s ABN (11 digits)</span><input value={fields.buyerAbn} onChange={setField("buyerAbn")} inputMode="numeric" maxLength={14} /></label>
              <label><span>Seller&apos;s ABN (optional confirmation)</span><input value={fields.sellerAbn} onChange={setField("sellerAbn")} inputMode="numeric" maxLength={14} placeholder="Detected from the PDF when possible" /></label>
              <label><span>Payment terms, if the invoice prints none</span><input value={fields.paymentTerms} onChange={setField("paymentTerms")} maxLength={120} /></label>
            </div>
            {blankFields.length > 0 && (
              <p role="note">
                Left blank: {blankFields.join(", ")}. The Australian rules need them; if the PDF does not print them, or the extraction misses them, the run stops before conversion and validation and says what to fill in.
              </p>
            )}
            <div className="composed-grid composed-grid-recipient">
              <label>
                <span>Send via</span>
                <select value={channel} onChange={(e) => setChannel(e.target.value === "email" ? "email" : e.target.value === "ademico" ? "ademico" : "peppol")}>
                  <option value="peppol">Peppol · B2Brouter sandbox</option>
                  {ademicoAvailable && <option value="ademico">Peppol · Ademico test network</option>}
                  <option value="email">Email · Mailgun</option>
                </select>
              </label>
              {channel === "ademico" ? (
                <div className="composed-grid">
                  <label><span>Receiver&apos;s scheme</span><input value={fields.receiverScheme} onChange={setField("receiverScheme")} inputMode="numeric" maxLength={4} required /></label>
                  <label><span>Receiver&apos;s Peppol identifier (a test-network participant)</span><input value={fields.receiverId} onChange={setField("receiverId")} maxLength={50} required /></label>
                </div>
              ) : (
                <label>
                  <span>Buyer&apos;s electronic address (B2Brouter sandbox test recipient)</span>
                  <select value={fields.recipient} onChange={setField("recipient")}>
                    {RECIPIENTS.map((r) => <option key={r.gln} value={r.gln}>{r.name} · GLN {r.gln}</option>)}
                  </select>
                </label>
              )}
              {channel === "email" && (
                <label>
                  <span>Email the invoice to (your account address, or an allowed address)</span>
                  <input type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} required maxLength={254} placeholder="name@example.com" />
                </label>
              )}
            </div>
            {channel === "peppol" && <div className="composed-grid">
              <label><span>Invoice number for this sandbox send (optional)</span><input value={fields.invoiceId} onChange={setField("invoiceId")} maxLength={60} placeholder="Keep the printed number" /></label>
              <label><span>Issue date for this sandbox send (optional)</span><input type="date" value={fields.issueDate} max={new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())} onChange={setField("issueDate")} /></label>
              <label><span>Due date for this sandbox send (optional)</span><input type="date" value={fields.dueDate} onChange={setField("dueDate")} min={fields.issueDate || undefined} /></label>
              <p>Use replacements only for a sandbox replay agreed with the invoice owner. B2Brouter takes each invoice number once and rejects dates in a closed financial year. The PDF and party identities stay unchanged.</p>
            </div>}
            <p className="composed-parties">
              <span><strong>Seller&apos;s ABN</strong> checked against the PDF and extraction; conflicting values need review</span>
              <span><strong>Expected</strong> {channel === "email" ? "accepted by Mailgun and emailed with the invoice attached"
                : channel === "ademico" ? "queued by Ademico, then delivered to the receiver's access point" : recipient.outcome}</span>
              <span><strong>These start as</strong> demonstration values for the group&apos;s sandbox</span>
            </p>
          </fieldset>

          <div className="composed-actions composed-run-actions">
            <button type="submit" className={`button primary${showLoading ? " composed-loading" : ""}`}
              style={{ "--loading-progress": `${loadingProgress ?? 0}%` } as CSSProperties}
              aria-busy={running}
              disabled={!file || Boolean(fileError) || showLoading || (channel === "email" && !emailTo.trim()) || (channel === "ademico" && !fields.receiverId.trim())}>
              <span>{showLoading ? `Calling Upbrains, AmitTransform, ESS, then ${channel === "email" ? "Mailgun" : channel === "ademico" ? "Ademico" : "B2Brouter"} — about half a minute…` : "Extract, convert, validate and send"}</span>
            </button>
            {running && <button type="button" className="button secondary" onClick={cancel} aria-label="Cancel workflow">Cancel</button>}
            {cancelled && <p className="composed-note composed-cancelled" role="status">
              Workflow cancelled. Requests already accepted by an external service may still finish. An invoice already sent cannot be recalled.
            </p>}
          </div>
        </form>

        {result && (
          <section className="composed-result" aria-live="polite">
            {result.ok ? (
              <>
                <VerdictPanel validation={result.validation} ruleSet={result.rule_set} />
                {result.delivery && <DeliveryPanel delivery={result.delivery} />}
                {result.sent_copy && (
                  <div className="composed-sent-copy">
                    <strong>Sent as {result.sent_copy.format}, not as the validated document.</strong>
                    <p>
                      {result.sent_copy.reason} The copy given to B2Brouter differs from the invoice validated above in:
                    </p>
                    <ul>{result.sent_copy.changes.map((change) => <li key={change}>{change}</li>)}</ul>
                    <p>Every amount, party and line is the same. The copy was not validated here; B2Brouter checks it before sending.</p>
                  </div>
                )}
                <StepList steps={result.steps} route={ranChannel} notSent={result.delivery ? undefined : notSentReason(result)} />
                <ExtractedPanel extracted={result.extracted} added={result.added} />
                <FindingList title="Errors" items={result.validation.errors} tone="error" />
                <FindingList title="Warnings" items={result.validation.warnings} tone="warning" />
                <XmlPanel xml={result.invoice_xml} name={result.extracted.number} title={result.sent_copy ? "The validated invoice" : undefined} />
                {result.sent_copy && <XmlPanel xml={result.sent_copy.invoice_xml} name={`${result.extracted.number}-bis3`} title={`The copy sent, as ${result.sent_copy.format}`} />}
              </>
            ) : (
              <>
                <div className="composed-verdict composed-verdict-failed">
                  <span className="compat-status status-fail">{result.reason ? REASON_LABEL[result.reason] ?? "Failed" : "Failed"}</span>
                  <div>
                    <strong>{result.error}</strong>
                    {invoiceFailureHint(result.error) && <p>{invoiceFailureHint(result.error)}</p>}
                    {result.failed_step && <small>The run stopped at step {result.failed_step}.</small>}
                    {result.retryAfterSeconds && <small>Try again in {result.retryAfterSeconds} s.</small>}
                    {result.seller_abn_suggestion && <button type="button" className="button secondary" onClick={() => {
                      setFields(current => ({ ...current, sellerAbn: result.seller_abn_suggestion!.value }));
                      setResult(null);
                    }}>Use {result.seller_abn_suggestion.value} from PDF page {result.seller_abn_suggestion.page}</button>}
                  </div>
                </div>
                {result.validation && <VerdictPanel validation={result.validation} ruleSet={RULE_SET} />}
                {result.steps && <StepList steps={result.steps} route={ranChannel} />}
                {result.extracted && <ExtractedPanel extracted={result.extracted} added={result.added ?? []} />}
                {result.invoice_xml && <XmlPanel xml={result.invoice_xml} name={result.extracted?.number ?? "invoice"} />}
              </>
            )}
          </section>
        )}

        <p className="composed-note">
          Each run spends extraction credits on the client&apos;s own Upbrains account, so runs are limited to five in ten
          minutes. B2Brouter&apos;s sandbox simulates the network and the recipient, and nothing reaches a real business;
          its test recipients receive only Peppol BIS Billing 3.0, so through B2Brouter the invoice is validated under
          the Australian rules and then sent as a copy in that format. Ademico sends on the Peppol test network, where
          nothing is legally binding, and takes the validated PINT A-NZ document as it is; the receiver must be a
          test-network participant that accepts PINT A-NZ. By email the validated document itself is attached. A sending platform sends only as its own registered company and takes an
          invoice number once, so over Peppol the PDF&apos;s seller must be the company registered on the group&apos;s
          account (on B2Brouter, CS9 Demo Supplies Pty Ltd, ABN 47 555 222 000) and its number must be new. By email any valid invoice can go to your
          own account address, or to an address the administrators have allowed.
        </p>
      </section>
    </main>
  );
}
