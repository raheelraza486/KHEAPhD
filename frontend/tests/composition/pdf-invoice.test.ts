import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AU_VALIDATOR, composePdfInvoice, CONVERTER, EXTRACTOR, type PdfInvoiceOptions } from "../../lib/composition/pdf-invoice.ts";
import { ADEMICO_SENDER, EMAIL_SENDER, SENDER } from "../../lib/composition/peppol-invoice.ts";
import { textPdf } from "../helpers/text-pdf.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const EXTRACTION = fixture("upbrains-result-2026-10-12.json");
const CONVERTED = fixture("amittransform-output-2026-10-14.xml");

// Stand-ins: no real address and no real key appears in a test.
const FLOW = "https://extractor.example.test/v1/webhooks/flow-not-real";
const KEY = "validator-key-not-real";
const PDF = { name: "invoice.pdf", pdf: new TextEncoder().encode("%PDF-1.4 test") };
const CONTEXT = { buyerReference: "PO-7", buyer: { endpointScheme: "0088", endpointId: "9508397101047", legalId: "99000000000", legalIdScheme: "0151" } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const PASSED = () => json({ status: "success", summary: "3 of 3 checks passed.", details: { pack_version: "1.1.3", steps: [{ check: "xsd", status: "success" }] } });
const FAILED = () => json({
  status: "error", summary: "1 of 3 checks failed (pint-aligned).",
  details: {
    pack_version: "1.1.3",
    steps: [
      { check: "xsd", status: "success", details: null },
      { check: "pint-aligned", status: "error", details: { failures: [
        { rule: "aligned-ibrp-003", severity: "fatal", message: "A buyer reference MUST be provided." },
        { rule: "aligned-ibr-099", severity: "warning", message: "Advisory." },
      ] } },
    ],
  },
}, 400);

type Reply = Response | Error;
interface Replies { extractor?: Reply; converter?: Reply; validator?: Reply; sender?: Reply; mail?: Reply; ademico?: Reply | Reply[] }

/** Replies by provider, recording what each was sent. The converter's wake-up GET is answered and set aside. */
function providers(replies: Replies) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u === CONVERTER.url && method === "GET") return new Response("Cannot GET /api/convert", { status: 404 });
    calls.push({ url: u, method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    const reply = u.startsWith(FLOW) ? replies.extractor
      : u === CONVERTER.url ? replies.converter
      : u === AU_VALIDATOR.url ? replies.validator
      : u.startsWith(SENDER.base) ? replies.sender
      : u.startsWith(EMAIL_SENDER.base) ? replies.mail
      : u.startsWith(ADEMICO_SENDER.base) ? (Array.isArray(replies.ademico) ? replies.ademico.shift() : replies.ademico)
      : undefined;
    if (!reply) throw new Error(`unexpected call to ${u}`);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return { stub, calls };
}

const options = (stub: typeof fetch, extra: Partial<PdfInvoiceOptions> = {}): PdfInvoiceOptions =>
  ({ extractorUrl: FLOW, validatorKey: KEY, fetch: stub, sleep: async () => undefined, ...extra });
const GOOD = (): Replies => ({ extractor: new Response(EXTRACTION), converter: json({ xml: CONVERTED, missingFields: {} }), validator: PASSED() });

for (const variant of ["labelled", "unlabelled", "conflicting", "missing"] as const) {
  test(`seller ABN preflight: ${variant} PDF evidence with no Upbrains tax field`, async () => {
    const extraction = JSON.parse(EXTRACTION);
    const fields = extraction.extractor_result.documents[0].fields;
    delete fields.VendorTaxId;
    const pdf = textPdf([
      { text: fields.VendorName.content, x: 40, y: 700 },
      ...(variant === "missing" ? [] : [{ text: variant === "unlabelled" ? "47555222000" : "ABN 47555222000", x: 40, y: 650 }]),
    ]);
    const { stub, calls } = providers({ ...GOOD(), extractor: json(extraction) });
    const context = variant === "conflicting" ? { ...CONTEXT, seller: { legalId: "80647710156" } } : CONTEXT;
    const out = await composePdfInvoice({ name: "synthetic.pdf", pdf }, context, options(stub));
    assert.equal(out.ok, variant === "labelled");
    assert.deepEqual(JSON.parse(String(calls[0].body)), { fileName: "synthetic.pdf", fileBase64: Buffer.from(pdf).toString("base64") });
    if (out.ok) {
      assert.equal(out.validation.status, "valid");
      assert.equal(out.delivery, null);
      assert.match(out.invoice_xml, /schemeID="0151">47555222000/);
      assert.match(out.extracted.notes.join(" "), /labelled seller block on PDF page 1/);
      assert.equal(calls.length, 3);
    } else {
      assert.equal(out.reason, "extraction_unusable");
      assert.equal(calls.length, 1, "Never convert, validate or send unresolved seller details");
      assert.equal(out.seller_abn_suggestion?.value, variant === "unlabelled" ? "47555222000" : undefined);
    }
  });
}

test("a valid PDF goes through the four APIs in order and is emailed", async () => {
  const { stub, calls } = providers({ ...GOOD(), mail: json({ id: "<m1@example.test>", message: "Queued. Thank you." }) });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub, { email: { apiKey: "mail-key-not-real", domain: "mg.example.test", from: "a@mg.example.test", to: "me@example.test" } }));
  assert.equal(out.ok, true);
  if (!out.ok) return;

  assert.deepEqual(out.steps.map((s) => [s.order, s.api_name, s.role, s.status]), [
    [1, EXTRACTOR.api_name, "extracts", "ok"],
    [2, CONVERTER.api_name, "produces", "ok"],
    [3, AU_VALIDATOR.api_name, "checks", "ok"],
    [4, EMAIL_SENDER.api_name, "delivers", "ok"],
  ]);
  assert.equal(out.rule_set, "Peppol PINT A-NZ Billing");
  assert.deepEqual(out.validation, { status: "valid", specification: "Peppol PINT A-NZ Billing 1.1.3", errors: [], warnings: [] });
  assert.deepEqual(out.delivery, { channel: "email", state: "queued", final: false, message_id: "<m1@example.test>", recipient: "me@example.test", reason: null });
  // By email the validated document itself goes out; there is no copy.
  assert.equal(out.sent_copy, null);
  assert.equal(out.extracted.number, "CS95-PDF-0001");
  assert.equal(out.extracted.total, "550.00");
  assert.equal(out.extracted.lines, 2);

  // 1: the PDF goes to the flow's waiting address, as base64 in JSON.
  assert.equal(calls[0].url, `${FLOW}/sync`);
  assert.deepEqual(JSON.parse(String(calls[0].body)), { fileName: "invoice.pdf", fileBase64: Buffer.from(PDF.pdf).toString("base64") });
  // 2: the converter gets the mapped invoice.
  const converted = JSON.parse(String(calls[1].body));
  assert.equal(converted.invoiceType, "JSON");
  assert.equal(converted.invoiceData.invoiceId, "CS95-PDF-0001");
  // 3: the validator gets the completed document, the one that is returned and sent.
  assert.equal(calls[2].headers["x-api-key"], KEY);
  const checked = JSON.parse(String(calls[2].body));
  assert.equal(checked.pack, "billing");
  assert.equal(Buffer.from(checked.content, "base64").toString("utf8"), out.invoice_xml);
  // 4: and the same document is the attachment.
  const attachment = (calls[3].body as FormData).get("attachment") as File;
  assert.equal(attachment.name, "CS95-PDF-0001.xml");
  assert.equal(await attachment.text(), out.invoice_xml);
  assert.match(String((calls[3].body as FormData).get("text")), /passed validation against Peppol PINT A-NZ Billing/);
});

test("a run cancelled before it starts calls no provider", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(composePdfInvoice(PDF, CONTEXT, options(async () => {
    assert.fail("A cancelled run must not call a provider");
  }, { signal: controller.signal })), (error: any) => error.status === 499);
});

for (const stage of ["extractor", "converter", "validator", "mail"] as const) {
  test(`cancelling during ${stage} aborts its request and never starts a later step`, async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<AbortSignal>();
    const held = Promise.withResolvers<Response>();
    const { stub, calls } = providers({ ...GOOD(), mail: json({ id: "<m1@example.test>" }) });
    const fetchImpl: typeof fetch = async (url, init) => {
      const destination = String(url);
      const current = destination.startsWith(FLOW) ? "extractor" : destination === CONVERTER.url ? "converter"
        : destination === AU_VALIDATOR.url ? "validator" : "mail";
      if (init?.method === "POST" && current === stage) {
        entered.resolve(init.signal!);
        return held.promise; // Simulate a provider that ignores cancellation.
      }
      return stub(url, init);
    };
    const pending = composePdfInvoice(PDF, CONTEXT, options(fetchImpl, {
      signal: controller.signal,
      email: { apiKey: "not-real", domain: "example.test", from: "a@example.test", to: "b@example.test" },
    }));
    const signal = await entered.promise;
    assert.equal(signal.aborted, false);
    controller.abort();
    assert.equal(signal.aborted, true);
    await assert.rejects(pending, (error: any) => error.status === 499);
    const count = calls.length;
    held.resolve(stage === "extractor" ? new Response(EXTRACTION) : stage === "converter" ? json({ xml: CONVERTED }) : stage === "validator" ? PASSED() : json({ id: "late" }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, count, "A late provider response cannot restart the run");
  });
}

test("cancellation during a response body read returns promptly and prevents conversion", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { body = value; } }));
  const { stub, calls } = providers({ extractor: response });
  const pending = composePdfInvoice(PDF, CONTEXT, options(async (url, init) => {
    const result = await stub(url, init);
    if (String(url).startsWith(FLOW)) entered.resolve();
    return result;
  }, { signal: controller.signal }));
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, (error: any) => error.status === 499);
  body.enqueue(new TextEncoder().encode(EXTRACTION));
  body.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
});

test("cancellation interrupts the delivery polling wait without starting another poll", async () => {
  const controller = new AbortController();
  const sleeping = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { stub, calls } = providers({ ...GOOD(), sender: json({ invoice: { id: 17, state: "sending" } }) });
  const pending = composePdfInvoice(PDF, CONTEXT, options(stub, {
    signal: controller.signal, sender: { apiKey: "not-real", accountId: "acct-1" },
    sleep: () => { sleeping.resolve(); return release.promise; },
  }));
  await sleeping.promise;
  controller.abort();
  await assert.rejects(pending, (error: any) => error.status === 499);
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 4, "Only extraction, conversion, validation and the initial send ran");
});

test("an Australian seller's ABN is read from the tax number printed on the invoice", async () => {
  const { stub } = providers(GOOD());
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(out.invoice_xml.includes('<cbc:EndpointID schemeID="0151">47555222000</cbc:EndpointID>'));
  assert.ok(out.invoice_xml.includes('<cbc:CompanyID schemeID="0151">47555222000</cbc:CompanyID>'));
  assert.match(out.extracted.notes.join(" "), /seller's ABN \(47555222000\) is the tax number printed on the invoice/);
  assert.match(out.added.join("; "), /buyer's legal registration \(99000000000\)/);
  // No sender configured: validated, and not sent.
  assert.equal(out.delivery, null);
  assert.equal(out.steps.length, 3);
});

test("over Peppol the sender is given a BIS 3.0 copy, and the result says so", async () => {
  const { stub, calls } = providers({ ...GOOD(), sender: json({ invoice: { id: 77, state: "registered" } }, 201) });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub, { sender: { apiKey: "sender-key-not-real", accountId: "acct-1" } }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.delivery, { channel: "peppol", platform: "b2brouter", state: "registered", final: true, invoice_id: 77, reason: null });
  const sent = new URL(calls[3].url);
  assert.equal(sent.pathname, "/accounts/acct-1/invoices/import");
  assert.equal(sent.searchParams.get("document_type_code_for_contact"), "xml.ubl.invoice.bis3");
  // The validated document stays a PINT A-NZ invoice; the sandbox recipient is sent the copy.
  assert.ok(out.invoice_xml.includes("urn:peppol:pint:billing-1@aunz-1"));
  assert.ok(out.sent_copy);
  assert.equal(calls[3].body, out.sent_copy.invoice_xml);
  assert.equal(out.sent_copy.format, "Peppol BIS Billing 3.0");
  assert.match(out.sent_copy.changes.join("; "), /from GST to VAT, in 4 places/);
  assert.ok(String(calls[3].body).includes("poacc:billing:3.0"));
  assert.ok(!String(calls[3].body).includes("<cbc:ID>GST</cbc:ID>"));
  assert.equal(out.steps[3].order, 4);
});

test("an invoice that fails the Australian rules is returned with the findings and not sent", async () => {
  const { stub, calls } = providers({ ...GOOD(), validator: FAILED() });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub, { sender: { apiKey: "sender-key-not-real", accountId: "acct-1" } }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.validation.status, "invalid");
  assert.deepEqual(out.validation.errors, [{ id: "aligned-ibrp-003", message: "A buyer reference MUST be provided." }]);
  assert.deepEqual(out.validation.warnings, [{ id: "aligned-ibr-099", message: "Advisory." }]);
  assert.equal(out.delivery, null);
  assert.equal(calls.length, 3);
  assert.ok(!calls.some((call) => call.url.startsWith(SENDER.base)));
});

test("a failed check that lists no rules still makes the invoice invalid", async () => {
  const xsd = json({ status: "error", summary: "failed", details: { steps: [{ check: "xsd", status: "error", summary: "XML is not valid against UBL schema.", details: { errors: ["Element 'X': not expected."] } }] } }, 400);
  const { stub } = providers({ ...GOOD(), validator: xsd });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.validation.status, "invalid");
  assert.deepEqual(out.validation.errors, [{ id: "xsd", message: "Element 'X': not expected." }]);
});

test("an invoice that could not be validated is not sent and not called valid", async () => {
  const sender = { apiKey: "sender-key-not-real", accountId: "acct-1" };
  for (const [reply, reason] of [
    [json({ message: "Forbidden" }, 403), "validator_refused"],
    [json({ status: "error", summary: "content is not base64" }, 400), "validator_unavailable"],
    [new Response("<html>bad gateway</html>", { status: 502 }), "validator_unavailable"],
    [new Error("socket hang up"), "validator_unavailable"],
  ] as const) {
    const { stub, calls } = providers({ ...GOOD(), validator: reply });
    const out = await composePdfInvoice(PDF, CONTEXT, options(stub, { sender }));
    assert.equal(out.ok, false);
    if (out.ok) continue;
    assert.equal(out.failed_step, 3);
    assert.equal(out.reason, reason);
    assert.equal(out.validation, null);
    assert.ok(out.invoice_xml?.includes("CS95-PDF-0001"));
    assert.ok(!calls.some((call) => call.url.startsWith(SENDER.base)));
  }
});

test("the run stops at extraction when the result is not one usable invoice", async () => {
  const note = JSON.parse(EXTRACTION);
  note.extractor_result.documents[0].document_type = "credit_note";
  const { stub, calls } = providers({ extractor: json(note) });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.failed_step, 1);
  assert.equal(out.reason, "extraction_unusable");
  assert.match(out.message, /Only invoices are supported/);
  assert.equal(calls.length, 1);
});

test("the extraction flow's address never reaches the caller", async () => {
  for (const extractor of [
    new Error(`connect ECONNREFUSED ${FLOW}/sync`),
    new Response(`no such flow at ${FLOW}`, { status: 404 }),
    new Response(`upstream ${FLOW} failed`, { status: 500 }),
    json({ message: "out of credits" }, 402),
    new Response(`<html>${FLOW}</html>`),
  ]) {
    const { stub } = providers({ extractor });
    const out = await composePdfInvoice(PDF, CONTEXT, options(stub));
    assert.equal(out.ok, false);
    if (out.ok) continue;
    assert.equal(out.failed_step, 1);
    assert.ok(!JSON.stringify(out).includes("flow-not-real"));
    assert.ok(!JSON.stringify(out).includes("extractor.example.test"));
  }
  const refused = await composePdfInvoice(PDF, CONTEXT, options(providers({ extractor: json({}, 402) }).stub));
  assert.equal(!refused.ok && refused.reason, "extractor_refused");
  const gone = await composePdfInvoice(PDF, CONTEXT, options(providers({ extractor: new Error("timeout") }).stub));
  assert.equal(!gone.ok && gone.reason, "extractor_unavailable");
});

test("an address that already waits for the result is used as it is", async () => {
  const { stub, calls } = providers(GOOD());
  await composePdfInvoice(PDF, CONTEXT, options(stub, { extractorUrl: `${FLOW}/sync/` }));
  assert.equal(calls[0].url, `${FLOW}/sync`);
});

test("the run stops at conversion when the converter fails or returns something else", async () => {
  for (const [converter, reason] of [
    [json({ status: "error", message: "Internal error" }, 500), "converter_unavailable"],
    [new Error("timeout"), "converter_unavailable"],
    [json({ status: "error", message: "invoiceData is required" }, 400), "conversion_unusable"],
    [json({ xml: null }), "conversion_unusable"],
    [json({ xml: "<Invoice>" }), "conversion_unusable"],
  ] as const) {
    const { stub, calls } = providers({ ...GOOD(), converter });
    const out = await composePdfInvoice(PDF, CONTEXT, options(stub));
    assert.equal(out.ok, false);
    if (out.ok) continue;
    assert.equal(out.failed_step, 2);
    assert.equal(out.reason, reason);
    assert.equal(out.steps.filter((step) => step.order === 2).length, 1);
    // What was extracted is still shown.
    assert.equal(out.extracted?.number, "CS95-PDF-0001");
    assert.ok(!calls.some((call) => call.url === AU_VALIDATOR.url));
  }
});

test("a sender that will not take a valid invoice is reported as step 4, with the verdict kept", async () => {
  const { stub } = providers({ ...GOOD(), sender: json({ message: "The number has already been taken" }, 422) });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub, { sender: { apiKey: "sender-key-not-real", accountId: "acct-1" } }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.failed_step, 4);
  assert.equal(out.reason, "sender_rejected");
  assert.match(out.message, /already been taken/);
  assert.equal(out.validation?.status, "valid");
  assert.deepEqual(out.steps.map((s) => [s.order, s.status]), [[1, "ok"], [2, "ok"], [3, "ok"], [4, "failed"]]);
});

const ADEMICO = { username: "ademico-user-not-real", password: "ademico-password-not-real", accessToken: "ademico-token-not-real" };
const SUBMITTED = () => json({ transmissionId: "tx-1", documentId: "CS95-PDF-0001", sender: "0151:47555222000", receiver: "0151:99000000000" });

test("over Peppol through Ademico the validated PINT A-NZ document goes out unchanged", async () => {
  const notification = { eventType: "DOCUMENT_SENT", notificationId: 3, transmissionId: "tx-1", notificationDate: "2026-10-20T01:00:00.000", details: [] };
  const { stub, calls } = providers({ ...GOOD(), ademico: [SUBMITTED(), json({ notifications: [] }), json({ notifications: [notification] })] });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub, { ademico: ADEMICO }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.delivery, { channel: "peppol", platform: "ademico", state: "delivered", final: true, transmission_id: "tx-1", receiver: "0151:99000000000", reason: null });
  assert.equal(out.sent_copy, null);
  assert.deepEqual(out.steps.map((s) => [s.order, s.api_name, s.status]).at(-1), [4, ADEMICO_SENDER.api_name, "ok"]);

  // The upload: a multipart file, Basic authentication, the access token as a query parameter.
  const upload = calls[3];
  const url = new URL(upload.url);
  assert.equal(url.pathname, "/domibus/api/peppol/v1/invoices/ubl-submissions");
  assert.equal(url.searchParams.get("accessToken"), ADEMICO.accessToken);
  assert.equal(upload.headers.Authorization, `Basic ${Buffer.from(`${ADEMICO.username}:${ADEMICO.password}`).toString("base64")}`);
  const file = (upload.body as FormData).get("file") as File;
  assert.equal(file.name, "CS95-PDF-0001.xml");
  assert.equal(await file.text(), out.invoice_xml);
  assert.ok(out.invoice_xml.includes("urn:peppol:pint:billing-1@aunz-1"));

  // The outcome is read from this transmission's notifications, which are not consumed.
  const polls = calls.slice(4);
  assert.equal(polls.length, 2);
  for (const poll of polls) {
    assert.equal(poll.method, "GET");
    assert.equal(new URL(poll.url).pathname, "/domibus/api/peppol/v1/notifications");
    assert.equal(new URL(poll.url).searchParams.get("transmissionId"), "tx-1");
  }
});

test("an Ademico transmission is reported as queued when no notification has come yet", async () => {
  const { stub } = providers({ ...GOOD(), ademico: [SUBMITTED(), ...Array.from({ length: 5 }, () => json({ notifications: [] }))] });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub, { ademico: ADEMICO }));
  assert.equal(out.ok && out.delivery?.state, "queued");
  assert.equal(out.ok && out.delivery?.final, false);
});

test("a failed Ademico transmission and a buyer's response are read from the notifications", async () => {
  const failed = { eventType: "DOCUMENT_SEND_FAILED", notificationId: 4, notificationDate: "2026-10-20T01:00:00.000", details: [{ code: "DOCUMENT_TRANSMISSION_ERROR", message: "Receiver access point unreachable" }] };
  let { stub } = providers({ ...GOOD(), ademico: [SUBMITTED(), json({ notifications: [failed] })] });
  let out = await composePdfInvoice(PDF, CONTEXT, options(stub, { ademico: ADEMICO }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.ok && [out.delivery?.state, out.delivery?.final, out.delivery?.reason], ["error", true, "Receiver access point unreachable"]);

  const sent = { eventType: "DOCUMENT_SENT", notificationId: 5, notificationDate: "2026-10-20T01:00:00.000", details: [] };
  const answered = { eventType: "INVOICE_RESPONSE_RECEIVED", notificationId: 6, notificationDate: "2026-10-20T01:01:00.000", documentStatus: "ACCEPTED", details: [] };
  ({ stub } = providers({ ...GOOD(), ademico: [SUBMITTED(), json({ notifications: [sent, answered] })] }));
  out = await composePdfInvoice(PDF, CONTEXT, options(stub, { ademico: ADEMICO }));
  assert.equal(out.ok && out.delivery?.state, "accepted");
});

test("a document Ademico will not send is step 4, with its reason and the verdict kept; our credentials never appear", async () => {
  const { stub } = providers({ ...GOOD(), ademico: json({ code: "PARTICIPANT_LOOKUP_ERROR", message: "The receiver 0151:99000000000 is not registered in the Peppol network" }, 400) });
  const out = await composePdfInvoice(PDF, CONTEXT, options(stub, { ademico: ADEMICO }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.failed_step, 4);
  assert.equal(out.reason, "sender_rejected");
  assert.match(out.message, /not registered in the Peppol network/);
  assert.equal(out.validation?.status, "valid");
  for (const secret of Object.values(ADEMICO)) assert.ok(!JSON.stringify(out).includes(secret));

  const refused = providers({ ...GOOD(), ademico: json({ code: "SECURITY_ERROR", message: "Invalid authentication credentials" }, 401) });
  const again = await composePdfInvoice(PDF, CONTEXT, options(refused.stub, { ademico: ADEMICO }));
  assert.equal(!again.ok && again.reason, "sender_refused");
});

test("an invoice without a buyer reference or the buyer's ABN stops after extraction, before conversion and validation", async () => {
  const { stub, calls } = providers(GOOD());
  const out = await composePdfInvoice(PDF, {}, options(stub, { sender: { apiKey: "sender-key-not-real", accountId: "acct-1" } }));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.failed_step, 1);
  assert.match(out.message, /^Stopped before conversion and validation/);
  assert.match(out.message, /buyer reference/);
  assert.match(out.message, /buyer's ABN/);
  assert.ok(out.extracted, "what was extracted is still shown");
  assert.equal(calls.length, 1, "only the extraction was called");
});
