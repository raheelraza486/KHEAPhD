import assert from "node:assert/strict";
import test from "node:test";

import { composePeppolInvoice, EMAIL_SENDER, emailRecipientAllowed, GENERATOR, isEmailAddress, SENDER, VALIDATOR } from "../../lib/composition/peppol-invoice.ts";

const PEPPOL_XML = `<?xml version="1.0"?><Invoice><cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID></Invoice>`;
const XRECHNUNG_XML = `<?xml version="1.0"?><Invoice><cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID></Invoice>`;
const INVOICE = { number: "T-1", issueDate: "2026-09-26", currencyCode: "EUR" };
const KEY = "test-key-not-real";

type Reply = Response | Error;

/** Replies by URL, recording what each provider was sent. */
function providers(generator: Reply, validator?: Reply) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") });
    const reply = u === GENERATOR.url ? generator : validator;
    if (!reply) throw new Error(`unexpected call to ${u}`);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return { stub, calls };
}

const xml = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "application/xml", ...headers } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a valid run returns the generated invoice and the validator's verdict", async () => {
  const { stub, calls } = providers(
    xml(PEPPOL_XML, 200, { "X-Version-Block": JSON.stringify({ ciusVersion: "PeppolBIS-Billing-3.0.21" }) }),
    json({ status: "valid", specification: "Peppol BIS Billing 3.0", errors: [], warnings: [{ id: "DE-R-019", message: "IBAN" }] }),
  );
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.invoice_xml, PEPPOL_XML);
  assert.equal(out.validation.status, "valid");
  assert.deepEqual(out.validation.warnings, [{ id: "DE-R-019", message: "IBAN" }]);
  assert.deepEqual(out.ruleset_versions, { ciusVersion: "PeppolBIS-Billing-3.0.21" });
  assert.deepEqual(out.steps.map((s) => [s.order, s.api_name, s.status]), [
    [1, GENERATOR.api_name, "ok"],
    [2, VALIDATOR.api_name, "ok"],
  ]);
});

test("the generator is asked for Peppol BIS, and the validator gets that document unchanged — and never our key", async () => {
  const { stub, calls } = providers(xml(PEPPOL_XML), json({ status: "valid", errors: [], warnings: [] }));
  await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub });
  const [gen, val] = calls;
  assert.deepEqual(JSON.parse(gen.body), { standard: "peppol-bis", output: "xml", invoice: INVOICE });
  assert.equal(gen.headers["X-API-Key"], KEY);
  assert.equal(val.body, PEPPOL_XML);
  assert.ok(!JSON.stringify(val.headers).includes(KEY));
});

test("an invalid invoice is a completed run: the verdict and its errors are the result", async () => {
  const { stub } = providers(xml(PEPPOL_XML), json({ status: "invalid", errors: [{ id: "BR-CO-16", message: "Amount due" }], warnings: [] }));
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub });
  assert.equal(out.ok, true);
  if (out.ok) assert.deepEqual(out.validation.errors, [{ id: "BR-CO-16", message: "Amount due" }]);
});

test("invoice data the generator rejects is the caller's to fix, and nothing is validated", async () => {
  const { stub, calls } = providers(json({ title: "Invalid invoice", detail: "totalNetAmount does not match the lines" }, 422));
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, "invoice_rejected");
  assert.match(out.message, /totalNetAmount does not match the lines/);
  assert.equal(calls.length, 1);
});

test("refused credentials or quota are ours, not the caller's", async () => {
  for (const status of [401, 402, 403, 429]) {
    const { stub } = providers(json({ error: "no" }, status));
    const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub });
    assert.equal(!out.ok && out.reason, "generator_refused", `status ${status}`);
  }
});

test("a generator that answers with another rule set stops the run before validation", async () => {
  const { stub, calls } = providers(xml(XRECHNUNG_XML));
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub });
  assert.equal(!out.ok && out.reason, "not_peppol");
  assert.equal(calls.length, 1);
});

test("if the validator cannot be reached, the invoice is returned but not passed off as validated", async () => {
  for (const reply of [new Error("network down"), json({ error: "busy" }, 503)]) {
    const { stub } = providers(xml(PEPPOL_XML), reply);
    const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "validator_unavailable");
    assert.equal(out.failed_step, 2);
    assert.equal(out.invoice_xml, PEPPOL_XML);
  }
});

test("an unreachable generator is reported as step 1 failing", async () => {
  const { stub } = providers(new Error("timeout"));
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub });
  assert.equal(!out.ok && out.reason, "generator_unavailable");
  assert.equal(!out.ok && out.failed_step, 1);
});

// ---- Step 3: sending through B2Brouter, only when the invoice is valid ----

const SENDER_KEY = "test_sender-key-not-real";
const SENDER_CONFIG = { apiKey: SENDER_KEY, accountId: "343767" };
const IMPORT_URL = `${SENDER.base}/accounts/343767/invoices/import`;

/** Replies for all three providers; the sender's replies are taken in order (import, then polls). */
function chain(validator: Reply, senderReplies: Reply[] = []) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const queue = [...senderReplies];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") });
    const reply = u === GENERATOR.url ? xml(PEPPOL_XML) : u === VALIDATOR.url ? validator : queue.shift();
    if (!reply) throw new Error(`unexpected call to ${u}`);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return { stub, calls };
}

const VALID = () => json({ status: "valid", specification: "Peppol BIS Billing 3.0", errors: [], warnings: [] });
const INVALID = () => json({ status: "invalid", errors: [{ id: "BR-CO-15", message: "Total" }], warnings: [] });
const state = (s: string, extra: Record<string, unknown> = {}) => json({ invoice: { id: 24408249, state: s, errors: [], ...extra } });
const noWait = { sleep: async () => {}, deliveryPollMs: 0 };

test("a valid invoice is sent unchanged, as the configured account, and followed until it is registered", async () => {
  const { stub, calls } = chain(VALID(), [json({ invoice: { id: 24408249, state: "sending" } }, 201), state("sent"), state("registered")]);
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: stub, ...noWait });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.delivery, { channel: "peppol", platform: "b2brouter", state: "registered", final: true, invoice_id: 24408249, reason: null });
  assert.deepEqual(out.steps.map((s) => [s.order, s.role, s.status]), [[1, "produces", "ok"], [2, "checks", "ok"], [3, "delivers", "ok"]]);
  const send = calls[2];
  assert.ok(send.url.startsWith(`${IMPORT_URL}?`));
  const q = new URL(send.url).searchParams;
  assert.equal(q.get("send_after_import"), "true");
  assert.equal(q.get("transport_type_code_for_contact"), "peppol");
  assert.equal(send.body, PEPPOL_XML);
  assert.equal(send.headers["X-B2B-API-Key"], SENDER_KEY);
});

test("each key goes only to its own provider", async () => {
  const { stub, calls } = chain(VALID(), [state("registered")]);
  await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: stub, ...noWait });
  const [gen, val, send] = calls.map((c) => JSON.stringify(c.headers));
  assert.ok(gen.includes(KEY) && !gen.includes(SENDER_KEY));
  assert.ok(!val.includes(KEY) && !val.includes(SENDER_KEY));
  assert.ok(send.includes(SENDER_KEY) && !send.includes(`"${KEY}"`));
});

test("the validator is a gate: an invalid invoice is returned with its errors and never sent", async () => {
  const { stub, calls } = chain(INVALID());
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: stub, ...noWait });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.validation.status, "invalid");
  assert.equal(out.delivery, null);
  assert.equal(calls.length, 2);
  assert.equal(out.steps.length, 2);
});

test("without a sender the operation ends after validation", async () => {
  const { stub, calls } = chain(VALID());
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, fetch: stub, ...noWait });
  assert.equal(out.ok && out.delivery, null);
  assert.equal(calls.length, 2);
});

test("a refused or undeliverable invoice is a completed run, with the platform's reason", async () => {
  const refused = chain(VALID(), [state("refused", { refuse_reason: "Wrong order reference" })]);
  const r1 = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: refused.stub, ...noWait });
  assert.deepEqual(r1.ok && r1.delivery, { channel: "peppol", platform: "b2brouter", state: "refused", final: true, invoice_id: 24408249, reason: "Wrong order reference" });

  const noReceiver = chain(VALID(), [state("error", { errors: [{ error: "Recipient is not registered to receive this document" }] })]);
  const r2 = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: noReceiver.stub, ...noWait });
  assert.equal(r2.ok && r2.delivery?.state, "error");
  assert.match((r2.ok && r2.delivery?.reason) || "", /not registered/);

  // As returned on 13 October 2026 for an invoice dated after that day, the reason came back twice.
  const why = "Cannot send invoice CS95-PDF-0003: Validation failed: Cannot send an invoice dated after today";
  const future = chain(VALID(), [state("error", { refuse_reason: why, errors: [{ error: why }] })]);
  const r3 = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: future.stub, ...noWait });
  assert.equal(r3.ok && r3.delivery?.reason, why);
});

test("an invoice still travelling when we stop asking is reported as not final", async () => {
  const { stub } = chain(VALID(), [state("sending"), state("sent"), state("sent")]);
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: stub, ...noWait, deliveryPolls: 2 });
  assert.deepEqual(out.ok && out.delivery, { channel: "peppol", platform: "b2brouter", state: "sent", final: false, invoice_id: 24408249, reason: null });
});

test("a sender that will not take the invoice fails step 3, keeping the validated invoice and verdict", async () => {
  const body = { error: { code: "unprocessable_entity", message: "Companies DE1 - DE2 of the invoice do not belong to your companies" } };
  const { stub } = chain(VALID(), [json(body, 422)]);
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: stub, ...noWait });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, "sender_rejected");
  assert.equal(out.failed_step, 3);
  assert.match(out.message, /do not belong to your companies/);
  assert.equal(out.invoice_xml, PEPPOL_XML);
  assert.equal(out.validation?.status, "valid");
});

test("refused sender credentials, or an unreachable sender, are ours to fix", async () => {
  const refused = chain(VALID(), [json({ error: "no" }, 401)]);
  const r1 = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: refused.stub, ...noWait });
  assert.equal(!r1.ok && r1.reason, "sender_refused");
  const down = chain(VALID(), [new Error("network down")]);
  const r2 = await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, fetch: down.stub, ...noWait });
  assert.equal(!r2.ok && r2.reason, "sender_unavailable");
});

// ---- Step 3 by email: the same validated document, attached to a Mailgun message ----

const MAIL_KEY = "test-mail-key-not-real";
const MAIL_CONFIG = { apiKey: MAIL_KEY, domain: "mg.example.test", from: "Demo <postmaster@mg.example.test>", to: "buyer@example.test" };
const MAIL_URL = `${EMAIL_SENDER.base}/v3/mg.example.test/messages`;

/** Replies for the generator, the validator and Mailgun, keeping the form Mailgun was sent. */
function mailChain(validator: Reply, mail?: Reply) {
  const calls: { url: string; headers: Record<string, string>; form: FormData | null }[] = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, headers: { ...(init?.headers as Record<string, string>) }, form: init?.body instanceof FormData ? init.body : null });
    const reply = u === GENERATOR.url ? xml(PEPPOL_XML) : u === VALIDATOR.url ? validator : mail;
    if (!reply) throw new Error(`unexpected call to ${u}`);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return { stub, calls };
}

const QUEUED = () => json({ id: "<20261012.1@mg.example.test>", message: "Queued. Thank you." });

test("by email, the valid invoice is attached unchanged and reported as queued, not delivered", async () => {
  const { stub, calls } = mailChain(VALID(), QUEUED());
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, email: MAIL_CONFIG, fetch: stub });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.delivery, { channel: "email", state: "queued", final: false, message_id: "<20261012.1@mg.example.test>", recipient: "buyer@example.test", reason: null });
  assert.deepEqual(out.steps.map((s) => [s.order, s.api_name, s.role, s.status]), [
    [1, GENERATOR.api_name, "produces", "ok"],
    [2, VALIDATOR.api_name, "checks", "ok"],
    [3, EMAIL_SENDER.api_name, "delivers", "ok"],
  ]);
  const mail = calls[2];
  assert.equal(mail.url, MAIL_URL);
  assert.equal(mail.headers.Authorization, `Basic ${Buffer.from(`api:${MAIL_KEY}`).toString("base64")}`);
  assert.ok(mail.form);
  assert.equal(mail.form.get("from"), MAIL_CONFIG.from);
  assert.equal(mail.form.get("to"), "buyer@example.test");
  assert.equal(mail.form.get("subject"), "Invoice T-1");
  const attachment = mail.form.get("attachment") as File;
  assert.equal(attachment.name, "T-1.xml");
  assert.equal(await attachment.text(), PEPPOL_XML);
});

test("by email, each key still goes only to its own provider, and Peppol is not used", async () => {
  const { stub, calls } = mailChain(VALID(), QUEUED());
  await composePeppolInvoice(INVOICE, { apiKey: KEY, sender: SENDER_CONFIG, email: MAIL_CONFIG, fetch: stub });
  assert.equal(calls.length, 3);
  assert.ok(!calls.some((c) => c.url.startsWith(SENDER.base)));
  const [gen, val, mail] = calls.map((c) => JSON.stringify(c.headers));
  assert.ok(gen.includes(KEY) && !gen.includes("Basic"));
  assert.ok(!val.includes(KEY) && !val.includes("Basic"));
  assert.ok(!mail.includes(KEY) && !mail.includes(SENDER_KEY));
});

test("the gate holds by email too: an invalid invoice is never mailed", async () => {
  const { stub, calls } = mailChain(INVALID());
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, email: MAIL_CONFIG, fetch: stub });
  assert.equal(out.ok && out.validation.status, "invalid");
  assert.equal(out.ok && out.delivery, null);
  assert.equal(calls.length, 2);
});

test("a recipient the mail domain may not write to fails step 3 with the service's reason", async () => {
  const { stub } = mailChain(VALID(), json({ message: "Domain mg.example.test is not allowed to send: add the address to authorized recipients" }, 403));
  const out = await composePeppolInvoice(INVOICE, { apiKey: KEY, email: MAIL_CONFIG, fetch: stub });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, "sender_rejected");
  assert.equal(out.failed_step, 3);
  assert.match(out.message, /authorized recipients/);
  assert.equal(out.validation?.status, "valid");
  assert.equal(out.invoice_xml, PEPPOL_XML);
});

test("refused mail credentials, an unreachable mail service, or an answer without a message id are ours", async () => {
  const refused = mailChain(VALID(), json({ message: "Forbidden" }, 401));
  const r1 = await composePeppolInvoice(INVOICE, { apiKey: KEY, email: MAIL_CONFIG, fetch: refused.stub });
  assert.equal(!r1.ok && r1.reason, "sender_refused");
  const down = mailChain(VALID(), new Error("network down"));
  const r2 = await composePeppolInvoice(INVOICE, { apiKey: KEY, email: MAIL_CONFIG, fetch: down.stub });
  assert.equal(!r2.ok && r2.reason, "sender_unavailable");
  const odd = mailChain(VALID(), json({ message: "ok" }, 502));
  const r3 = await composePeppolInvoice(INVOICE, { apiKey: KEY, email: MAIL_CONFIG, fetch: odd.stub });
  assert.equal(!r3.ok && r3.reason, "sender_unavailable");
});

test("an invoice number cannot shape the attachment's file name", async () => {
  const { stub, calls } = mailChain(VALID(), QUEUED());
  await composePeppolInvoice({ ...INVOICE, number: "../a b\"c\r\n" }, { apiKey: KEY, email: MAIL_CONFIG, fetch: stub });
  assert.equal((calls[2].form?.get("attachment") as File).name, ".._a_b_c_.xml");
});

test("an email address is one plain address, and nothing that could add a header", () => {
  for (const good of ["a@b.co", "first.last+tag@sub.example.org"]) assert.equal(isEmailAddress(good), true, good);
  for (const bad of ["", "a@b", "a b@c.de", "a@b.co, c@d.co", "A <a@b.co>", "a@b.co\r\nBcc: x@y.zz", 42, null, `${"a".repeat(250)}@b.co`]) {
    assert.equal(isEmailAddress(bad), false, String(bad));
  }
});

test("an invoice may be emailed to the account's own address or an allowed one, and to nobody else", () => {
  assert.equal(emailRecipientAllowed("Me@Example.org", "me@example.org"), true);
  assert.equal(emailRecipientAllowed("client@example.org", "me@example.org", [" Client@example.org "]), true);
  assert.equal(emailRecipientAllowed("stranger@example.org", "me@example.org", ["client@example.org"]), false);
  assert.equal(emailRecipientAllowed("stranger@example.org", "", []), false);
  assert.equal(emailRecipientAllowed("not an address", "not an address"), false);
});
