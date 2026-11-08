import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapExtractionToAmit, InvoiceMappingError } from "../../lib/composition/invoice-mapping.ts";
import { enrichAmitXml, INVOICE_PROFILES } from "../../lib/composition/invoice-xml.ts";
import { convertExtractedInvoice, AMIT_CONVERT_URL } from "../../lib/composition/extracted-invoice.ts";
import { DOMParser } from "@xmldom/xmldom";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/upbrains-invoice.mock.json", import.meta.url), "utf8"));
const realFixture = () => JSON.parse(readFileSync(new URL("./fixtures/upbrains-invoice.real.json", import.meta.url), "utf8"));
const rawXml = `<?xml version="1.0"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:b="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:a="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
<b:ID>MOCK-96-001</b:ID><b:IssueDate>2026-10-12</b:IssueDate><b:DueDate>2026-10-26</b:DueDate><b:InvoiceTypeCode>380</b:InvoiceTypeCode><b:DocumentCurrencyCode>AUD</b:DocumentCurrencyCode>
<b:BuyerReference>MOCK-ORDER-96</b:BuyerReference>
<b:RegistrationName>Synthetic Supplier</b:RegistrationName><b:LineExtensionAmount>100.00</b:LineExtensionAmount><b:TaxAmount>10.00</b:TaxAmount><b:PriceAmount>50.00</b:PriceAmount>
<a:AccountingSupplierParty><a:Party><a:PartyTaxScheme><b:CompanyID>AU12345678901</b:CompanyID><a:TaxScheme><b:ID>VAT</b:ID></a:TaxScheme></a:PartyTaxScheme><a:PartyLegalEntity><b:RegistrationName>Synthetic Supplier</b:RegistrationName></a:PartyLegalEntity></a:Party></a:AccountingSupplierParty>
<a:AccountingCustomerParty><a:Party><a:PartyLegalEntity><b:RegistrationName>Synthetic Buyer</b:RegistrationName></a:PartyLegalEntity></a:Party></a:AccountingCustomerParty>
<a:TaxTotal><b:TaxAmount>10.00</b:TaxAmount><a:TaxSubtotal><b:TaxAmount>10.00</b:TaxAmount><a:TaxCategory><b:ID>S</b:ID><b:Percent>10</b:Percent><a:TaxScheme><b:ID>VAT</b:ID></a:TaxScheme></a:TaxCategory></a:TaxSubtotal></a:TaxTotal>
<a:InvoiceLine><b:ID>1</b:ID><b:InvoicedQuantity unitCode="HUR">2</b:InvoicedQuantity><b:LineExtensionAmount>100.00</b:LineExtensionAmount><a:Item><b:Name>Synthetic consulting service</b:Name></a:Item><a:Price><b:PriceAmount>50.00</b:PriceAmount></a:Price></a:InvoiceLine>
<a:LegalMonetaryTotal><b:LineExtensionAmount>100.00</b:LineExtensionAmount><b:TaxExclusiveAmount>100.00</b:TaxExclusiveAmount><b:TaxInclusiveAmount>110.00</b:TaxInclusiveAmount><b:PayableAmount>110.00</b:PayableAmount></a:LegalMonetaryTotal></Invoice>`;

test("maps the observed Upbrains wrappers without mutating input or confusing gross and payable totals", () => {
  const input = fixture(), saved = structuredClone(input);
  const mapped = mapExtractionToAmit(input);
  assert.deepEqual(input, saved);
  assert.equal(mapped.invoiceData.issueDate, "2026-10-12");
  assert.equal(mapped.invoiceData.dueDate, "2026-10-26");
  assert.equal(mapped.invoiceData.totalAmount, "110.00");
  assert.equal(mapped.invoiceData.payableAmount, "110.00");
  assert.equal(mapped.invoiceData.invoiceTypeCode, "380");
  assert.equal(mapped.currency, "AUD");
  assert.deepEqual(mapped.taxGroups, [{ rate: "10.0000", taxable: "100.00", tax: "10.00" }]);
  const fields = input.extractor_result.documents[0].fields;
  fields.invoiceid = fields.InvoiceId; delete fields.InvoiceId;
  assert.equal(mapExtractionToAmit(input).invoiceData.invoiceId, "MOCK-96-001");
});

for (const [name, mutate, error] of [
  ["multiple documents", (x: any) => x.extractor_result.documents.push(structuredClone(x.extractor_result.documents[0])), /Exactly one/],
  ["invalid date", (x: any) => x.extractor_result.documents[0].fields.InvoiceDate.details.day = 32, /valid date/],
  ["ambiguous date", (x: any) => x.extractor_result.documents[0].fields.InvoiceDate.details = null, /dateOrder/],
  ["missing currency", (x: any) => { for (const v of Object.values(x.extractor_result.documents[0].fields) as any[]) if (v.details?.code) delete v.details.code; for (const v of Object.values(x.extractor_result.documents[0].items[0]) as any[]) if (v.details?.code) delete v.details.code; }, /currency/],
  ["conflicting currency", (x: any) => x.extractor_result.documents[0].items[0].Amount.details.code = "USD", /currenc/],
  ["missing tax rate", (x: any) => delete x.extractor_result.documents[0].items[0].TaxRate, /TaxRate/],
  ["unbalanced tax", (x: any) => x.extractor_result.documents[0].fields.TotalTax.details.amount = 9, /balance/],
  ["unbalanced line", (x: any) => x.extractor_result.documents[0].items[0].Quantity.content = "3", /Quantity times/],
  ["prepaid invoice", (x: any) => x.extractor_result.documents[0].fields.AmountDue.details.amount = 100, /prepaid/],
  ["zero rate without category", (x: any) => x.extractor_result.documents[0].items[0].TaxRate.content = "0", /category/],
  ["review flag", (x: any) => x.extractor_result.documents[0].needs_review.low_confidence = true, /review/],
  ["credit note", (x: any) => x.extractor_result.documents[0].document_type = "credit note", /credit notes/],
  ["unsupported document type", (x: any) => x.extractor_result.documents[0].fields.InvoiceTypeCode = "381", /type 380/],
  ["unsupported tax category", (x: any) => x.extractor_result.documents[0].items[0].TaxCategory = "E", /category S/],
  ["line allowance", (x: any) => x.extractor_result.documents[0].items[0].DiscountAmount = "1", /separate allowance/],
  ["percentage as money", (x: any) => { x.extractor_result.documents[0].fields.SubTotal = "100%"; }, /SubTotal must/],
] as const) test(`rejects ${name} before contacting a converter`, async () => {
  const input = fixture(); mutate(input);
  await assert.rejects(convertExtractedInvoice(input, {}, { fetch: async () => { assert.fail("Provider must not be called"); } }), error);
});

test("the client's example invoice (27 October): the GST summary row Upbrains reads as an item is skipped, the buyer's CustomerAddress is used, and payment terms come from the options", () => {
  const extraction = JSON.parse(readFileSync(new URL("./fixtures/upbrains-result-client-example-2026-10-27.json", import.meta.url), "utf8"));
  const items = extraction.extractor_result.documents[0].items;
  assert.deepEqual(items.map((item: { Description: { content: string } }) => item.Description.content), ["pencils", "Standard"], "Upbrains read the summary row as a second item");
  const mapped = mapExtractionToAmit(extraction, { profile: "pint-aunz", paymentTerms: "Payment within 30 days" });
  assert.deepEqual(mapped.lines.map((line) => [line.description, line.quantity, line.unitPrice, line.amount, line.taxRate]), [["pencils", "500.0000", "0.2000", "100.00", "10.0000"]]);
  assert.equal((mapped.invoiceData.customer as { address?: { countryCode?: string; postalCode?: string } }).address?.countryCode, "AU");
  assert.equal((mapped.invoiceData.customer as { address?: { postalCode?: string } }).address?.postalCode, "2140");
  assert.equal(mapped.invoiceData.paymentTerms, "Payment within 30 days");
  // A row that bills something is never skipped: one without a tax rate is still refused.
  const billed = structuredClone(extraction);
  billed.extractor_result.documents[0].items[1].Amount = { content: "$5.00", details: { amount: 5, code: "AUD" } };
  assert.throws(() => mapExtractionToAmit(billed, { profile: "pint-aunz" }), /items\[1\]\.TaxRate is required/);
});

test("invoiceId and issueDate replace the printed number and date, to re-send an old invoice to a sandbox", () => {
  const extraction = JSON.parse(readFileSync(new URL("./fixtures/upbrains-result-client-example-2026-10-27.json", import.meta.url), "utf8"));
  const printed = mapExtractionToAmit(extraction, { profile: "pint-aunz", paymentTerms: "Payment within 30 days" });
  assert.deepEqual([printed.invoiceData.invoiceId, printed.invoiceData.issueDate], ["EBWASP1002", "2022-02-07"]);
  const resent = mapExtractionToAmit(extraction, { profile: "pint-aunz", paymentTerms: "Payment within 30 days", invoiceId: " EBWASP1002-DEMO ", issueDate: "2026-10-27" });
  assert.deepEqual([resent.invoiceData.invoiceId, resent.invoiceData.issueDate], ["EBWASP1002-DEMO", "2026-10-27"]);
  assert.deepEqual(resent.lines, printed.lines, "nothing else changes");
  for (const issueDate of ["27/10/2026", "2026-02-30", ""]) {
    assert.throws(() => mapExtractionToAmit(extraction, { profile: "pint-aunz", paymentTerms: "x", issueDate }), /issueDate/);
  }
});

test("rejects malformed options as input errors", () => {
  for (const options of [null, [], { profile: "" }, { profile: "other" }, { dateOrder: "" }, { seller: { endpointId: "123" } }]) {
    assert.throws(() => mapExtractionToAmit(fixture(), options as any), (error) => error instanceof InvoiceMappingError && error.code === "invalid_extraction");
  }
});

test("explicit options resolve absent tax and local dates, without overriding extracted currencies or rates", () => {
  const input = fixture();
  const document = input.extractor_result.documents[0];
  document.fields.InvoiceDate.details = null;
  delete document.items[0].TaxRate;
  const mapped = mapExtractionToAmit(input, { dateOrder: "DMY", taxRate: 10 });
  assert.equal(mapped.invoiceData.issueDate, "2026-10-12");
  assert.equal(mapped.lines[0].taxRate, "10.0000");
  assert.throws(() => mapExtractionToAmit(input, { currency: "USD", taxRate: 10 }), /currenc/);
});

test("computes distinct tax subtotals and exact decimal rounding", () => {
  const input = fixture(), document = input.extractor_result.documents[0];
  const second = structuredClone(document.items[0]); second.TaxRate.content = "15";
  document.items.push(second);
  document.fields.SubTotal.details.amount = 200;
  document.fields.TotalTax.details.amount = 25;
  document.fields.InvoiceTotal.details.amount = document.fields.AmountDue.details.amount = 225;
  assert.deepEqual(mapExtractionToAmit(input).taxGroups.map((group) => group.tax), ["10.00", "15.00"]);
  document.items = [second];
  second.Quantity.content = "3"; second.UnitPrice.details.amount = 0.3333; second.Amount.details.amount = 1;
  document.fields.SubTotal.details.amount = 1; document.fields.TotalTax.details.amount = 0.15;
  document.fields.InvoiceTotal.details.amount = document.fields.AmountDue.details.amount = 1.15;
  assert.equal(mapExtractionToAmit(input).lines[0].amount, "1.00");
});

test("completes namespaced XML, removes misplaced root fields and orders totals before lines", () => {
  const mapped = mapExtractionToAmit(fixture());
  const xml = enrichAmitXml(rawXml, mapped);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  assert.ok(xml.includes(INVOICE_PROFILES["peppol-bis3"].customization));
  assert.ok(xml.indexOf("CustomizationID") < xml.indexOf("<b:ID>"));
  assert.ok(xml.indexOf("<a:LegalMonetaryTotal>") < xml.indexOf("<a:InvoiceLine>"));
  assert.equal(doc.getElementsByTagNameNS("*", "TaxableAmount")[0].textContent, "100.00");
  assert.equal(doc.getElementsByTagNameNS("*", "ClassifiedTaxCategory").length, 1);
  const rootBasics = Array.from(doc.documentElement!.childNodes).filter((node) => node.nodeType === 1).map((node) => node.nodeName);
  assert.ok(!rootBasics.includes("b:RegistrationName"));
  for (const amount of Array.from(doc.getElementsByTagNameNS("*", "*")).filter((node) => node.localName?.endsWith("Amount"))) assert.equal(amount.getAttribute("currencyID"), "AUD");
  assert.equal(enrichAmitXml(xml, mapped), xml);
});

test("selects PINT A-NZ identifiers and GST together", () => {
  const xml = enrichAmitXml(rawXml.replace("AU12345678901", "12345678901"), mapExtractionToAmit(fixture(), { profile: "pint-aunz" }));
  assert.ok(xml.includes(INVOICE_PROFILES["pint-aunz"].customization));
  assert.ok(xml.includes(">GST<")); assert.ok(!xml.includes(">VAT<"));
});

test("handles the saved live Amit response to synthetic data, including its spurious party ID", () => {
  const xml = readFileSync(new URL("./fixtures/amit-invoice.mock.xml", import.meta.url), "utf8");
  const mapped = mapExtractionToAmit(fixture(), { seller: { endpointId: "1234567890128", endpointSchemeId: "0088" }, buyer: { endpointId: "9876543210982", endpointSchemeId: "0088" } });
  const completed = enrichAmitXml(xml, mapped);
  assert.ok(completed.includes('schemeID="0088"'));
  assert.ok(!completed.includes("PartyIdentification"));
  assert.ok(completed.includes("AU12345678901"));
  assert.throws(() => enrichAmitXml(xml.replace("<cbc:EndpointID>9876543210982", "<cbc:EndpointID>1234567890128"), mapped), /EndpointID/);
  assert.equal(enrichAmitXml(completed, mapped), completed);
});

for (const [name, xml] of [
  ["malformed XML", rawXml.replace("</Invoice>", "")],
  ["DTD", rawXml.replace("<Invoice", '<!DOCTYPE Invoice [<!ENTITY attack "bad">]><Invoice')],
  ["wrong namespace", rawXml.replace("schema:xsd:Invoice-2", "schema:xsd:CreditNote-2")],
  ["changed amount", rawXml.replace("<b:TaxInclusiveAmount>110.00", "<b:TaxInclusiveAmount>111.00")],
  ["lost line", rawXml.replace(/<a:InvoiceLine>[\s\S]*?<\/a:InvoiceLine>/, "")],
] as const) test(`rejects converter output with ${name}`, () => {
  assert.throws(() => enrichAmitXml(xml, mapExtractionToAmit(fixture())), (error) => error instanceof InvoiceMappingError && error.code === "invalid_xml");
});

test("calls the fixed Amit endpoint and returns enriched XML without a validation claim", async () => {
  const outcome = await convertExtractedInvoice(fixture(), {}, { fetch: async (url, init) => {
    assert.equal(url, AMIT_CONVERT_URL);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.useFlexibleMapping, true);
    assert.equal(body.invoiceType, "JSON"); assert.equal(body.outputFormat, "UBL XML");
    assert.equal(body.invoiceData.totals.taxInclusiveAmount, "110.00");
    return Response.json({ xml: rawXml, missingFields: { summary: "Conversion successful" } });
  } });
  assert.equal(outcome.validation.status, "not_run");
  assert.ok(outcome.invoice_xml.includes("TaxableAmount"));
});

for (const response of [new Response("offline", { status: 503 }), new Response("not JSON"), Response.json({ xml: null })]) test(`handles unusable provider response ${response.status}/${response.headers.get("content-type")}`, async () => {
  await assert.rejects(convertExtractedInvoice(fixture(), {}, { fetch: async () => response }), InvoiceMappingError);
});
test("handles a converter network failure", async () => {
  await assert.rejects(convertExtractedInvoice(fixture(), {}, { fetch: async () => { throw new Error("network details"); } }), /usable response/);
});

test("replays the actual 12 October extraction without editing hours or inventing missing references and ABNs", () => {
  const input = realFixture(), original = structuredClone(input);
  const mapped = mapExtractionToAmit(input);
  assert.deepEqual(input, original);
  assert.deepEqual(mapped.lines.map((line) => line.unitCode), ["HUR", "HUR"]);
  assert.equal(mapped.invoiceData.issueDate, "2026-10-12");
  assert.equal(mapped.invoiceData.dueDate, "2026-11-11");
  assert.equal(mapped.invoiceData.totalAmount, "550.00");
  assert.equal(mapped.invoiceData.totalTax, "50.00");
  const supplier = mapped.invoiceData.supplier as any;
  assert.equal(supplier.partyTaxScheme.companyID, "AU47555222000");
  assert.equal(supplier.address.countryCode, "AU");
  assert.ok(supplier.address.street.includes("University of Sydney"));
  assert.equal(mapped.invoiceData.buyerReference, undefined);
  assert.equal(supplier.partyLegalEntity, undefined);
  assert.equal((mapped.invoiceData.customer as any).partyLegalEntity, undefined);
});

test("maps common unit words and supported codes; refuses unknown words and code-like strings", () => {
  for (const [unit, expected] of [[" Hours ", "HUR"], ["hr", "HUR"], ["HUR", "HUR"], ["hur", "HUR"], ["each", "C62"], ["pieces", "H87"], ["kg", "KGM"], ["days", "DAY"], ["PCE", "H87"], ["pce", "H87"]]) {
    const input = realFixture(); input.extractor_result.documents[0].items[0].Unit.content = unit;
    assert.equal(mapExtractionToAmit(input).lines[0].unitCode, expected);
  }
  for (const unit of ["fortnights", "DOG", "xyz", "__proto__"]) {
    const input = realFixture(); input.extractor_result.documents[0].items[0].Unit.content = unit;
    assert.throws(() => mapExtractionToAmit(input), /Unknown unit/);
  }
});

test("keeps an extracted purchase order separate from the buyer reference", () => {
  const input = fixture();
  input.extractor_result.documents[0].fields.PurchaseOrderReference = { content: "PO-SYNTHETIC-27" };
  const before = structuredClone(input);
  const mapped = mapExtractionToAmit(input);
  assert.equal(mapped.invoiceData.purchaseOrderReference, "PO-SYNTHETIC-27");
  assert.equal(mapped.invoiceData.buyerReference, "MOCK-ORDER-96");
  assert.deepEqual(input, before);
  input.extractor_result.documents[0].fields.PurchaseOrderReference.content = " ";
  assert.throws(() => mapExtractionToAmit(input), /PurchaseOrderReference is required/);
});

test("accepts the extractor's PurchaseOrder alias and refuses conflicting order references", () => {
  const input = fixture(), fields = input.extractor_result.documents[0].fields;
  fields.PurchaseOrder = { content: "PO-SYNTHETIC-27" };
  const before = structuredClone(input);
  const mapped = mapExtractionToAmit(input);
  assert.equal(mapped.invoiceData.purchaseOrderReference, "PO-SYNTHETIC-27");
  assert.equal(mapped.invoiceData.buyerReference, "MOCK-ORDER-96");
  assert.deepEqual(input, before);
  fields.PurchaseOrderReference = "PO-SYNTHETIC-27";
  assert.equal(mapExtractionToAmit(input).invoiceData.purchaseOrderReference, "PO-SYNTHETIC-27");
  fields.PurchaseOrderReference = "PO-DIFFERENT";
  assert.throws(() => mapExtractionToAmit(input), /PurchaseOrderReference conflicts with PurchaseOrder/);
});

test("preserves a purchase order alongside extracted or fallback payment terms", () => {
  const input = fixture();
  const fields = input.extractor_result.documents[0].fields;
  fields.PurchaseOrderReference = "PO-SYNTHETIC-27";
  delete fields.PaymentTerm;
  const options = { paymentTerms: "Payment within 30 days" };
  const fallback = mapExtractionToAmit(input, options);
  assert.equal(fallback.invoiceData.paymentTerms, options.paymentTerms);
  assert.equal(fallback.invoiceData.purchaseOrderReference, "PO-SYNTHETIC-27");
  fields.PaymentTerm = "Payment within 14 days";
  const extracted = mapExtractionToAmit(input, options);
  assert.equal(extracted.invoiceData.paymentTerms, fields.PaymentTerm);
  assert.equal(extracted.invoiceData.purchaseOrderReference, "PO-SYNTHETIC-27");
});

test("writes a source purchase order into UBL when the converter omits it", () => {
  const input = fixture();
  delete input.extractor_result.documents[0].fields.BuyerReference;
  input.extractor_result.documents[0].fields.PurchaseOrderReference = "PO-SYNTHETIC-27";
  const mapped = mapExtractionToAmit(input);
  const raw = rawXml.replace("<b:BuyerReference>MOCK-ORDER-96</b:BuyerReference>", "");
  const completed = enrichAmitXml(raw, mapped);
  const doc = new DOMParser().parseFromString(completed, "application/xml");
  const orders = doc.getElementsByTagNameNS("urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2", "OrderReference");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].getElementsByTagNameNS("*", "ID")[0].textContent, "PO-SYNTHETIC-27");
  assert.equal(doc.getElementsByTagNameNS("*", "BuyerReference").length, 0);
  assert.ok(completed.indexOf(":OrderReference>") < completed.indexOf(":AccountingSupplierParty>"));
  assert.equal(enrichAmitXml(completed, mapped), completed);
});

test("rejects changed, duplicated or unsupplied converter purchase orders", () => {
  const input = fixture();
  input.extractor_result.documents[0].fields.PurchaseOrderReference = "PO-SYNTHETIC-27";
  const mapped = mapExtractionToAmit(input);
  const order = "<a:OrderReference><b:ID>PO-SYNTHETIC-27</b:ID></a:OrderReference>";
  const withOrder = rawXml.replace("<a:AccountingSupplierParty>", order + "<a:AccountingSupplierParty>");
  const kept = new DOMParser().parseFromString(enrichAmitXml(withOrder, mapped), "application/xml");
  assert.equal(kept.getElementsByTagNameNS("*", "OrderReference")[0].getElementsByTagNameNS("*", "ID")[0].textContent, "PO-SYNTHETIC-27");
  assert.throws(() => enrichAmitXml(withOrder.replace("<b:ID>PO-SYNTHETIC-27", "<b:ID>changed"), mapped), /changed or omitted ID/);
  assert.throws(() => enrichAmitXml(withOrder.replace(order, order + order), mapped), /OrderReference/);
  assert.throws(() => enrichAmitXml(withOrder, mapExtractionToAmit(fixture())), /unsupplied.*order reference/);
});

test("fills an explicit buyer reference, preserves extracted values and reports conflicts", () => {
  assert.equal(mapExtractionToAmit(realFixture(), { buyerReference: "DEMO-ORDER-96" }).invoiceData.buyerReference, "DEMO-ORDER-96");
  assert.equal(mapExtractionToAmit(fixture(), { buyerReference: "MOCK-ORDER-96" }).invoiceData.buyerReference, "MOCK-ORDER-96");
  assert.throws(() => mapExtractionToAmit(fixture(), { buyerReference: "different" }), /conflicts/);
  assert.throws(() => mapExtractionToAmit(realFixture(), { buyerReference: " " }), /buyerReference is required/);
});

test("maps quantities that include a supported unit without changing their value", () => {
  for (const [written, supplied, expected] of [
    ["2 HUR", "hours", "HUR"], ["2 hours", undefined, "HUR"],
    ["2.00 PCE", undefined, "H87"], [" 2.0000 pce ", "H87", "H87"],
    ["2\u00a0KGM", "kg", "KGM"], ["2 XBX", undefined, "XBX"],
  ] as const) {
    const input = fixture(), item = input.extractor_result.documents[0].items[0];
    item.Quantity.content = written;
    if (supplied === undefined) delete item.Unit;
    else item.Unit.content = supplied;
    const before = structuredClone(input);
    const mapped = mapExtractionToAmit(input);
    assert.equal(mapped.lines[0].quantity, "2.0000");
    assert.equal(mapped.lines[0].unitCode, expected);
    assert.equal(mapped.lines[0].amount, "100.00");
    assert.deepEqual(input, before);
  }
});

test("refuses conflicting units, malformed quantities and unbalanced inline quantities", () => {
  for (const [quantity, unit, expected] of [
    ["2 PCE", "HUR", /unit.*conflicts/i], ["2 DOG", undefined, /Unknown unit/],
    ["2 PCE extra", undefined, /Quantity.*decimal/], ["2.00001 PCE", undefined, /Quantity.*decimal/],
    ["2,00 PCE", undefined, /Quantity.*decimal/], ["-2 PCE", undefined, /Quantity.*decimal/],
    ["2e0 PCE", undefined, /Quantity.*decimal/], ["0 PCE", undefined, /Quantity times/],
    ["3 PCE", undefined, /Quantity times/],
  ] as const) {
    const input = fixture(), item = input.extractor_result.documents[0].items[0];
    item.Quantity.content = quantity;
    if (unit === undefined) delete item.Unit;
    else item.Unit.content = unit;
    assert.throws(() => mapExtractionToAmit(input), expected);
  }
});

test("balances a three-line piece invoice whose quantities carry PCE", () => {
  const input = fixture(), document = input.extractor_result.documents[0];
  const item = document.items[0];
  item.Quantity.content = "72.00 PCE";
  delete item.Unit;
  item.UnitPrice.details.amount = 4.49;
  item.Amount.details.amount = 323.28;
  document.items = Array.from({ length: 3 }, () => structuredClone(item));
  document.fields.SubTotal.details.amount = 969.84;
  document.fields.TotalTax.details.amount = 96.98;
  document.fields.InvoiceTotal.details.amount = document.fields.AmountDue.details.amount = 1066.82;
  const mapped = mapExtractionToAmit(input);
  assert.deepEqual(mapped.lines.map(line => [line.quantity, line.unitCode, line.unitPrice, line.amount]),
    Array.from({ length: 3 }, () => ["72.0000", "H87", "4.4900", "323.28"]));
  assert.deepEqual(mapped.taxGroups, [{ rate: "10.0000", taxable: "969.84", tax: "96.98" }]);
  assert.equal(mapped.invoiceData.totalAmount, "1066.82");
});

test("legal registration metadata is explicit and separate from the electronic address and tax identifier", () => {
  const mapped = mapExtractionToAmit(realFixture(), {
    seller: { legalRegistrationId: "47 555 222 000", legalRegistrationSchemeId: "0151", endpointId: "1234567890128", endpointSchemeId: "0088" },
    buyer: { legalRegistrationId: "91 888 222 000", legalRegistrationSchemeId: "0151" },
  });
  const seller = mapped.invoiceData.supplier as any, buyer = mapped.invoiceData.customer as any;
  assert.equal(seller.partyLegalEntity.companyID, "47555222000");
  assert.equal(seller.legalRegistrationSchemeId, "0151");
  assert.equal(seller.endpointID, "1234567890128");
  assert.equal(seller.partyTaxScheme.companyID, "AU47555222000");
  assert.equal(buyer.partyLegalEntity.companyID, "91888222000");
  assert.equal(buyer.partyTaxScheme, undefined);
  assert.throws(() => mapExtractionToAmit(realFixture(), { seller: { legalRegistrationId: "47555222000" } }), /legalRegistrationSchemeId/);
  assert.throws(() => mapExtractionToAmit(realFixture(), { buyer: { legalRegistrationSchemeId: "0151" } }), /legalRegistrationId/);
  assert.throws(() => mapExtractionToAmit(realFixture(), { seller: { legalRegistrationId: "47555222000", legalRegistrationSchemeId: "bad" } }), /four digits/);
});

test("normalises tax IDs for the selected profile without doubling prefixes or inventing a country", () => {
  assert.equal((mapExtractionToAmit(realFixture(), { profile: "pint-aunz" }).invoiceData.supplier as any).partyTaxScheme.companyID, "47555222000");
  const input = realFixture(), fields = input.extractor_result.documents[0].fields;
  fields.VendorTaxId.content = "AU 47 555 222 000";
  assert.equal((mapExtractionToAmit(input).invoiceData.supplier as any).partyTaxScheme.companyID, "AU47555222000");
  assert.equal((mapExtractionToAmit(input, { profile: "pint-aunz" }).invoiceData.supplier as any).partyTaxScheme.companyID, "47555222000");
  fields.VendorTaxId.content = "47 555 222 000";
  delete fields.VendorAddress.details.country_region;
  assert.throws(() => mapExtractionToAmit(input), /seller.countryCode/);
  assert.equal((mapExtractionToAmit(input, { seller: { countryCode: "AU" } }).invoiceData.supplier as any).partyTaxScheme.companyID, "AU47555222000");
  assert.throws(() => mapExtractionToAmit(realFixture(), { seller: { countryCode: "NZ" } }), /country conflicts/);
});

for (const [profile, suffix, expectedTaxId] of [["peppol-bis3", "bis", "AU47555222000"], ["pint-aunz", "pint", "47555222000"]] as const) {
  test(`completes the saved real ${profile} conversion with explicit references and both legal IDs`, () => {
    const mapped = mapExtractionToAmit(realFixture(), {
      profile, buyerReference: "CS95-DEMO-ORDER-0001",
      seller: { endpointId: "1234567890128", endpointSchemeId: "0088", legalRegistrationId: "47 555 222 000", legalRegistrationSchemeId: "0151" },
      buyer: { endpointId: "9876543210982", endpointSchemeId: "0088", legalRegistrationId: "91 888 222 000", legalRegistrationSchemeId: "0151" },
    });
    const raw = readFileSync(new URL(`./fixtures/amit-invoice.real.${suffix}.xml`, import.meta.url), "utf8");
    const completed = enrichAmitXml(raw, mapped);
    const doc = new DOMParser().parseFromString(completed, "application/xml");
    const value = (name: string) => doc.getElementsByTagNameNS("*", name)[0].textContent;
    assert.equal(value("BuyerReference"), "CS95-DEMO-ORDER-0001");
    assert.equal(value("CustomizationID"), INVOICE_PROFILES[profile].customization);
    const legalIds = Array.from(doc.getElementsByTagNameNS("*", "PartyLegalEntity")).map((legal) => legal.getElementsByTagNameNS("*", "CompanyID")[0]);
    assert.deepEqual(legalIds.map((node) => [node.textContent, node.getAttribute("schemeID")]), [["47555222000", "0151"], ["91888222000", "0151"]]);
    assert.equal(doc.getElementsByTagNameNS("*", "PartyTaxScheme")[0].getElementsByTagNameNS("*", "CompanyID")[0].textContent, expectedTaxId);
    assert.deepEqual(Array.from(doc.getElementsByTagNameNS("*", "InvoicedQuantity")).map((node) => node.getAttribute("unitCode")), ["HUR", "HUR"]);
    assert.equal(value("PayableAmount"), "550.00");
    assert.equal(enrichAmitXml(completed, mapped), completed);
    assert.throws(() => enrichAmitXml(raw.replace("<cbc:CompanyID>91888222000", "<cbc:CompanyID>other"), mapped), /CompanyID/);
  });
}


function splitClientLine(reverse = false) {
  const extraction = JSON.parse(readFileSync(new URL("./fixtures/upbrains-result-client-example-2026-10-27.json", import.meta.url), "utf8"));
  const document = extraction.extractor_result.documents[0];
  const line = structuredClone(document.items[0]);
  const amount = { Amount: line.Amount, _index: 1, page_number: "1" };
  delete line.Amount;
  line.page_number = "1";
  document.items = reverse ? [line, amount] : [amount, line];
  return extraction;
}

test("a separately extracted amount rejoins its unique adjacent same-page detail without inferring tax", () => {
  for (const reverse of [false, true]) {
    const extraction = splitClientLine(reverse);
    const before = structuredClone(extraction);
    const mapped = mapExtractionToAmit(extraction, { profile: "pint-aunz" });
    assert.deepEqual(mapped.lines.map(line => [line.description, line.quantity, line.amount, line.taxRate]), [["pencils", "500.0000", "100.00", "10.0000"]]);
    assert.equal(mapped.invoiceData.totalAmount, "110.00");
    assert.deepEqual(extraction, before);
  }
});

test("split rows with missing tax, different pages, mismatched amounts or competing neighbours stay invalid", () => {
  const missingTax = splitClientLine();
  delete missingTax.extractor_result.documents[0].items[1].TaxRate;
  const differentPage = splitClientLine();
  differentPage.extractor_result.documents[0].items[1].page_number = "2";
  const mismatch = splitClientLine();
  mismatch.extractor_result.documents[0].items[0].Amount = { content: "99.00", details: { amount: 99, code: "AUD" } };
  const ambiguous = splitClientLine();
  ambiguous.extractor_result.documents[0].items.push(structuredClone(ambiguous.extractor_result.documents[0].items[0]));
  for (const extraction of [missingTax, differentPage, mismatch, ambiguous]) {
    assert.throws(() => mapExtractionToAmit(extraction), InvoiceMappingError);
  }
});

test("changing the issue date requires explicitly resolving an older printed due date", () => {
  const input = fixture();
  assert.throws(() => mapExtractionToAmit(input, { issueDate: "2026-10-31" }), /DueDate precedes.*dueDate/);
  const mapped = mapExtractionToAmit(input, { issueDate: "2026-10-31", dueDate: "2026-11-30" });
  assert.equal(mapped.invoiceData.dueDate, "2026-11-30");
  assert.equal(mapExtractionToAmit(input).invoiceData.dueDate, "2026-10-26");
});

test("PINT A-NZ: the items ESS reported missing on 31 October are named before conversion", async () => {
  const { pintAunzMissingData, missingDataMessage } = await import("../../lib/composition/invoice-mapping.ts");
  const complete = {
    buyerReference: "PO-7", paymentTerms: "Payment within 30 days",
    supplier: { endpointID: "47555222000", address: { countryCode: "AU" }, partyLegalEntity: { companyID: "47555222000" } },
    customer: { address: { countryCode: "AU" }, partyLegalEntity: { companyID: "99000000000" } },
  };
  assert.deepEqual(pintAunzMissingData(complete), []);
  // A purchase order number stands for the buyer reference, and a due date for the payment terms.
  assert.deepEqual(pintAunzMissingData({ ...complete, buyerReference: undefined, purchaseOrderReference: "4500012", paymentTerms: undefined, dueDate: "2026-11-30" }), []);
  // A New Zealand buyer is not asked for an Australian ABN.
  assert.deepEqual(pintAunzMissingData({ ...complete, customer: { address: { countryCode: "NZ" } } }), []);
  const missing = pintAunzMissingData({ supplier: { address: { countryCode: "AU" } }, customer: {} });
  assert.equal(missing.length, 4);
  assert.match(missing.join(" | "), /buyer reference.*seller's ABN.*buyer's ABN.*payment terms/);
  // A buyer whose country the extraction did not read still needs its ABN.
  assert.deepEqual(pintAunzMissingData({ ...complete, customer: {} }), ["the buyer's ABN (enter the buyer's ABN)"]);
  const message = missingDataMessage(missing);
  assert.match(message, /^Stopped before conversion and validation/);
  assert.ok(message.length <= 500, "fits the cause shown on the workflow page");
});
