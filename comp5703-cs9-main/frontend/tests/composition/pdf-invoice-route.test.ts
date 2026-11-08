import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";

import { APP_ROLES } from "../../lib/auth-policy.ts";
import { routeHarness } from "../helpers/route-harness.ts";
import { textPdf } from "../helpers/text-pdf.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const EXTRACTION = fixture("upbrains-result-2026-10-12.json");
const CONVERTED = fixture("amittransform-output-2026-10-14.xml");

const HOST = "catalogue.example.test";
// Stand-ins: no real address and no real key appears in a test.
const FLOW = "https://extractor.example.test/v1/webhooks/flow-not-real";
const SECRETS = { UPBRAINS_WEBHOOK_URL: FLOW, SMARTDOCFLOW_API_KEY: "validator-key-not-real", MAILGUN_API_KEY: "mail-key-not-real", MAILGUN_DOMAIN: "mg.example.test" };
const CLEARED = ["B2BROUTER_API_KEY", "B2BROUTER_ACCOUNT_ID", "ADEMICO_USERNAME", "ADEMICO_PASSWORD", "ADEMICO_ACCESS_TOKEN", "ADEMICO_BASE_URL", "MAILGUN_ALLOWED_RECIPIENTS", "MAILGUN_FROM", "MAILGUN_BASE_URL"];
const PDF = new TextEncoder().encode("%PDF-1.4 test");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The route with a signed-in user, the server's settings, and providers that answer as on 12 October. */
function setup(t: TestContext, { signedIn = true, configured = true, extraction = EXTRACTION, converted = CONVERTED }: { signedIn?: boolean; configured?: boolean; extraction?: string; converted?: string } = {}) {
  const saved = Object.fromEntries([...Object.keys(SECRETS), ...CLEARED].map((name) => [name, process.env[name]]));
  for (const name of Object.keys(saved)) delete process.env[name];
  if (configured) Object.assign(process.env, SECRETS);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") === "GET") return new Response("Cannot GET", { status: 404 });
    calls.push(u);
    if (u.startsWith(FLOW)) return new Response(extraction);
    if (u.includes("invoice-conversion-api")) return json({ xml: converted });
    if (u.includes("smartdocflow")) return json({ status: "success", summary: "3 of 3 checks passed.", details: { pack_version: "1.1.3", steps: [] } });
    if (u.includes("mailgun")) return json({ id: "<m1@example.test>" });
    if (u.includes("ademico-software.com")) return json({ transmissionId: "tx-1", receiver: "0151:99000000000" });
    throw new Error(`unexpected call to ${u}`);
  });
  const route = routeHarness({
    "@/lib/auth": {
      APP_ROLES,
      requireRole: async () => signedIn
        ? { user: { id: "10000000-0000-4000-8000-000000000001", role: "user", email: "me@example.test" } }
        : { response: Response.json({ error: "Sign in first." }, { status: 401 }) },
    },
  })("app/api/composed/pdf-invoice/route.ts");
  return { route, calls };
}

function request(fields: Record<string, string | Blob> = {}, { origin = `https://${HOST}`, file = new File([PDF], "invoice 1.pdf", { type: "application/pdf" }) as Blob | null, signal = undefined as AbortSignal | undefined } = {}) {
  const form = new FormData();
  if (file) form.set("file", file);
  for (const [name, value] of Object.entries({ send_via: "email", email_to: "me@example.test", buyer_reference: "PO-7", buyer_abn: "99000000000", ...fields })) form.set(name, value);
  return new Request(`https://${HOST}/api/composed/pdf-invoice`, { method: "POST", headers: { origin, host: HOST }, body: form, signal });
}

test("the route returns a PDF seller ABN suggestion and stops before conversion", async t => {
  const extraction = JSON.parse(EXTRACTION);
  const fields = extraction.extractor_result.documents[0].fields;
  delete fields.VendorTaxId;
  const { route, calls } = setup(t, { extraction: JSON.stringify(extraction) });
  const bytes = textPdf([{ text: fields.VendorName.content, x: 40, y: 700 }, { text: "47555222000", x: 40, y: 650 }]);
  const response = await route.POST(request({}, { file: new File([bytes as Uint8Array<ArrayBuffer>], "synthetic.pdf", { type: "application/pdf" }) }));
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.reason, "extraction_unusable");
  assert.deepEqual(body.seller_abn_suggestion, { value: "47555222000", page: 1, labelled: false });
  assert.equal(calls.length, 1);
});

test("an aborted request returns cancellation without contacting a provider", async t => {
  const { route, calls } = setup(t);
  const controller = new AbortController();
  controller.abort();
  const response = await route.POST(request({}, { signal: controller.signal }));
  assert.equal(response.status, 499);
  assert.equal((await response.json()).reason, "cancelled");
  assert.deepEqual(calls, []);
});

test("disconnecting during extraction aborts the provider and returns cancellation", async t => {
  const { route, calls } = setup(t);
  const normal = globalThis.fetch;
  const entered = Promise.withResolvers<AbortSignal>();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(FLOW)) {
      entered.resolve(init!.signal!);
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    }
    return normal(url, init);
  });
  const controller = new AbortController();
  const pending = route.POST(request({}, { signal: controller.signal }));
  const providerSignal = await entered.promise;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  const body = await response.json();
  assert.equal(body.reason, "cancelled");
  assert.match(body.error, /cancelled/i);
  assert.equal(providerSignal.aborted, true);
  assert.deepEqual(calls, []);
  assert.ok(!JSON.stringify(body).includes(FLOW));
});

test("POST /api/composed/pdf-invoice runs the four APIs and emails a valid invoice to the account's own address", async (t) => {
  const { route, calls } = setup(t);
  const response = await route.POST(request({ send_via: "email", email_to: "me@example.test", buyer_reference: "PO-7", buyer_abn: "99 000 000 000", buyer_endpoint_scheme: "0088", buyer_endpoint_id: "9508397101047" }));
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.validation.status, "valid");
  assert.equal(body.delivery.channel, "email");
  assert.equal(body.extracted.number, "CS95-PDF-0001");
  assert.deepEqual(body.steps.map((s: { order: number; status: string }) => [s.order, s.status]), [[1, "ok"], [2, "ok"], [3, "ok"], [4, "ok"]]);
  assert.ok(body.invoice_xml.includes("<cbc:BuyerReference>PO-7</cbc:BuyerReference>"));
  assert.ok(body.invoice_xml.includes('<cbc:CompanyID schemeID="0151">99000000000</cbc:CompanyID>'));
  assert.equal(calls.length, 4);
  // Neither the flow's address nor a key is returned.
  for (const secret of ["flow-not-real", "extractor.example.test", ...Object.values(SECRETS).slice(1)]) assert.ok(!text.includes(secret), secret);
});

test("the PDF route converts quantities with embedded units and reaches validation", async (t) => {
  const extraction = JSON.parse(EXTRACTION);
  for (const item of extraction.extractor_result.documents[0].items) {
    item.Quantity.content += " HUR";
    delete item.Unit;
  }
  const { route, calls } = setup(t, { extraction: JSON.stringify(extraction) });
  const response = await route.POST(request());
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.validation.status, "valid");
  assert.equal(body.extracted.net, "500.00");
  assert.equal(body.delivery.channel, "email");
  assert.equal(calls.length, 4);
  assert.deepEqual(body.steps.map((step: { order: number; status: string }) => [step.order, step.status]),
    [[1, "ok"], [2, "ok"], [3, "ok"], [4, "ok"]]);
});

test("the client's example invoice: the seller's ABN and payment terms entered on the page reach the completed invoice", async (t) => {
  // AmitTransform's real answer for this invoice with these values (27 October).
  const { route } = setup(t, { extraction: fixture("upbrains-result-client-example-2026-10-27.json"), converted: fixture("amittransform-output-client-example-2026-10-27.xml") });
  const response = await route.POST(request({
    send_via: "email", email_to: "me@example.test", buyer_reference: "PO-7", buyer_abn: "99000000000", buyer_endpoint_scheme: "0088", buyer_endpoint_id: "9508397101047",
    seller_abn: "80 647 710 156", payment_terms: "Payment within 30 days",
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.extracted.lines, 1, "the GST summary row is not a line");
  assert.ok(body.added.includes("the seller's electronic address (0151:80647710156)"), body.added.join("; "));
  assert.ok(body.added.includes("the payment terms you entered"), body.added.join("; "));
});

test("missing sending settings are refused before extraction spends credits", async (t) => {
  const { route, calls } = setup(t);
  const response = await route.POST(request({ send_via: "peppol" }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /B2Brouter sending is not configured/);
  delete process.env.MAILGUN_API_KEY;
  const email = await route.POST(request());
  assert.equal(email.status, 503);
  assert.match((await email.json()).error, /Email sending is not configured/);
  assert.deepEqual(calls, []);
});

test("a request is refused before any provider is called", async (t) => {
  const { route, calls } = setup(t);
  const refused = async (req: Request, status: number, pattern: RegExp) => {
    const response = await route.POST(req);
    assert.equal(response.status, status);
    assert.match((await response.json()).error, pattern);
  };
  await refused(request({}, { origin: "https://evil.example" }), 403, /Cross-origin/);
  await refused(request({}, { file: null }), 400, /invoice PDF in "file"/);
  await refused(request({}, { file: new File(["<html>"], "invoice.pdf", { type: "application/pdf" }) }), 400, /not a PDF/);
  await refused(request({}, { file: new File([], "invoice.pdf") }), 413, /at most 4 MB/);
  await refused(request({}, { file: new File([new Uint8Array(4 * 1024 * 1024 + 1)], "invoice.pdf") }), 413, /4 MB/);
  await refused(request({ send_via: "fax" }), 400, /send_via/);
  await refused(request({ peppol_platform: "storecove" }), 400, /peppol_platform/);
  await refused(request({ buyer_abn: "12345" }), 400, /11 digits/);
  await refused(request({ seller_abn: "806477" }), 400, /seller_abn must be 11 digits/);
  await refused(request({ seller_abn: "80647710155" }), 400, /check-digit validation/);
  await refused(request({ payment_terms: "x".repeat(121) }), 400, /payment_terms/);
  await refused(request({ buyer_reference: "x".repeat(61) }), 400, /buyer_reference/);
  await refused(request({ buyer_endpoint_scheme: "88", buyer_endpoint_id: "9508397101047" }), 400, /electronic address/);
  await refused(request({ buyer_endpoint_id: "9508397101047" }), 400, /electronic address/);
  await refused(request({ send_via: "email", email_to: "not an address" }), 400, /one email address/);
  await refused(request({ send_via: "email", email_to: "stranger@example.org" }), 403, /your own account address/);
  assert.deepEqual(calls, []);
});

test("a signed-out caller gets no further", async (t) => {
  const out = setup(t, { signedIn: false });
  assert.equal((await out.route.POST(request())).status, 401);
  assert.deepEqual(out.calls, []);
});

test("an unconfigured server says so and calls nothing", async (t) => {
  const { route, calls } = setup(t, { configured: false });
  const response = await route.POST(request());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
  assert.deepEqual(calls, []);
});

test("a failed step comes back with its number, its reason and what was done before it", async (t) => {
  const note = JSON.parse(EXTRACTION);
  note.extractor_result.documents[0].document_type = "credit_note";
  const { route } = setup(t, { extraction: JSON.stringify(note) });
  const response = await route.POST(request());
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.reason, "extraction_unusable");
  assert.equal(body.failed_step, 1);
  assert.deepEqual(body.steps.map((s: { order: number; status: string }) => [s.order, s.status]), [[1, "ok"]]);
  assert.match(body.error, /Only invoices are supported/);
});

test("extraction credits are protected: five runs in ten minutes, and a refused request does not count", async (t) => {
  const { route } = setup(t);
  for (let i = 0; i < 3; i++) assert.equal((await route.POST(request({ buyer_abn: "1" }))).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await route.POST(request())).status, 200);
  const sixth = await route.POST(request());
  assert.equal(sixth.status, 429);
  assert.ok((await sixth.json()).retryAfterSeconds > 0);
});

test("peppol_platform=ademico without Ademico credentials is refused before any extraction", async (t) => {
  const { route, calls } = setup(t);
  const response = await route.POST(request({ send_via: "peppol", peppol_platform: "ademico", buyer_endpoint_scheme: "0088", buyer_endpoint_id: "9508397101047" }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Ademico is not configured/);
  assert.equal(calls.length, 0);
});

test("peppol_platform=ademico sends through Ademico when it is configured, and its credentials are never returned", async (t) => {
  const { route, calls } = setup(t);
  const ademico = { ADEMICO_USERNAME: "ademico-user-not-real", ADEMICO_PASSWORD: "ademico-password-not-real", ADEMICO_ACCESS_TOKEN: "ademico-token-not-real" };
  Object.assign(process.env, ademico);
  const response = await route.POST(request({ send_via: "peppol", peppol_platform: "ademico", buyer_endpoint_scheme: "0088", buyer_endpoint_id: "9508397101047" }));
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(response.status, 200, text.slice(0, 300));
  assert.equal(body.delivery.platform, "ademico");
  assert.equal(body.delivery.transmission_id, "tx-1");
  assert.equal(body.sent_copy, null);
  assert.ok(calls[3].includes("/api/peppol/v1/invoices/ubl-submissions"));
  for (const secret of Object.values(ademico)) assert.ok(!text.includes(secret), secret);
});

test("invalid sandbox replacement fields stop before extraction", async t => {
  const { route, calls } = setup(t);
  for (const fields of ([{ issue_date: "2026-02-30" }, { invoice_number: "x".repeat(61) }, { issue_date: "2026-10-31", due_date: "2015-05-01" }] as Array<Record<string, string>>)) {
    const response = await route.POST(request({ send_via: "peppol", ...fields }));
    assert.equal(response.status, 400);
  }
  const email = await route.POST(request({ invoice_number: "DEMO2" }));
  assert.equal(email.status, 400);
  assert.deepEqual(calls, []);
});

test("the PDF route applies explicit replay replacements and reports them", async t => {
  const converted = CONVERTED.replaceAll("CS95-PDF-0001", "DEMO-REPLAY-2").replaceAll("2026-10-12", "2026-10-31").replaceAll("2026-11-11", "2026-11-30");
  const { route, calls } = setup(t, { converted });
  process.env.B2BROUTER_API_KEY = "test-not-real";
  process.env.B2BROUTER_ACCOUNT_ID = "test-account";
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => String(url).includes("b2brouter")
    ? json({ invoice: { id: 1, number: "DEMO-REPLAY-2", state: "sent", errors: [] } }) : original(url, init));
  const response = await route.POST(request({ send_via: "peppol", invoice_number: "DEMO-REPLAY-2", issue_date: "2026-10-31", due_date: "2026-11-30", buyer_reference: "PO-7", buyer_abn: "99000000000", buyer_endpoint_scheme: "0088", buyer_endpoint_id: "9508397101047" }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.extracted.number, "DEMO-REPLAY-2");
  assert.equal(body.extracted.issue_date, "2026-10-31");
  assert.equal(body.extracted.due_date, "2026-11-30");
  assert.ok(body.added.some((line: string) => line.includes("replacement invoice number")));
  assert.equal(calls.length, 3);
});
