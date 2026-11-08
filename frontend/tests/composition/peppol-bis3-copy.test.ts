import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { InvoiceMappingError, mapExtractionToAmit } from "../../lib/composition/invoice-mapping.ts";
import { enrichAmitXml } from "../../lib/composition/invoice-xml.ts";
import { asPeppolBis3, PEPPOL_BIS3, PINT_AUNZ } from "../../lib/composition/peppol-bis3-copy.ts";

// The group's calls: what Upbrains returned for a one-page test invoice on
// 12 October 2026, and what AmitTransform returned on 14 October for #96's
// mapping of it. The invoice and its parties are made up.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ABN = "47555222000";
const completed = () => enrichAmitXml(fixture("amittransform-output-2026-10-14.xml"), mapExtractionToAmit(JSON.parse(fixture("upbrains-result-2026-10-12.json")), {
  profile: "pint-aunz", buyerReference: "PO-7",
  seller: { endpointId: ABN, endpointSchemeId: "0151", legalRegistrationId: ABN, legalRegistrationSchemeId: "0151" },
  buyer: { endpointId: "9508397101047", endpointSchemeId: "0088", legalRegistrationId: "99000000000", legalRegistrationSchemeId: "0151" },
}));

test("the BIS 3.0 copy differs from the completed invoice in its identifiers, the tax scheme's name and the tax number's prefix only", () => {
  const original = completed();
  const { xml, changes } = asPeppolBis3(original);
  assert.ok(xml.includes(`<cbc:CustomizationID>${PEPPOL_BIS3.customization}</cbc:CustomizationID>`));
  assert.ok(xml.includes(`<cbc:ProfileID>${PEPPOL_BIS3.process}</cbc:ProfileID>`));
  assert.ok(!xml.includes("<cbc:ID>GST</cbc:ID>"));
  // BR-CO-09: a VAT identifier starts with its country. The legal registration and the electronic address keep the bare ABN.
  assert.equal(xml.match(new RegExp(`<cbc:CompanyID>AU${ABN}</cbc:CompanyID>`, "g"))?.length, 1);
  assert.ok(xml.includes(`<cbc:CompanyID schemeID="0151">${ABN}</cbc:CompanyID>`));
  assert.ok(xml.includes(`<cbc:EndpointID schemeID="0151">${ABN}</cbc:EndpointID>`));
  // Put the four things back, and it is the completed invoice again.
  const restored = xml
    .replace(`<cbc:CompanyID>AU${ABN}</cbc:CompanyID>`, `<cbc:CompanyID>${ABN}</cbc:CompanyID>`)
    .replace(PEPPOL_BIS3.customization, PINT_AUNZ.customization)
    .replace(`<cbc:ProfileID>${PEPPOL_BIS3.process}`, `<cbc:ProfileID>${PINT_AUNZ.process}`)
    .replaceAll("<cbc:ID>VAT</cbc:ID>", "<cbc:ID>GST</cbc:ID>");
  assert.equal(restored.trim(), original.trim());
  const schemes = original.match(/<cbc:ID>GST<\/cbc:ID>/g)?.length;
  assert.deepEqual(changes, [
    "the specification identifiers, from Peppol PINT A-NZ Billing to Peppol BIS Billing 3.0",
    `the tax scheme's name, from GST to VAT, in ${schemes} places`,
    `the country written in front of the tax number (AU${ABN})`,
  ]);
  // A number that already starts with its country is left alone.
  assert.equal(asPeppolBis3(xml).changes.length, 2);
  assert.throws(() => asPeppolBis3("<Invoice>"), (error: unknown) => error instanceof InvoiceMappingError && error.code === "invalid_xml");
});

test("the client's example invoice has no seller tax number: the copy writes the seller's ABN as its GST identifier (BR-S-02)", () => {
  // Upbrains missed the ABN printed on it; the seller's ABN came from the options (27 October).
  const seller = "80647710156";
  const original = enrichAmitXml(fixture("amittransform-output-client-example-2026-10-27.xml"), mapExtractionToAmit(JSON.parse(fixture("upbrains-result-client-example-2026-10-27.json")), {
    profile: "pint-aunz", buyerReference: "PO-7", paymentTerms: "Payment within 30 days",
    seller: { endpointId: seller, endpointSchemeId: "0151", legalRegistrationId: seller, legalRegistrationSchemeId: "0151" },
    buyer: { endpointId: "9508397101047", endpointSchemeId: "0088", legalRegistrationId: "99000000000", legalRegistrationSchemeId: "0151" },
  }));
  assert.ok(!original.includes("PartyTaxScheme"), "the PINT A-NZ invoice is sent without one");
  const { xml, changes } = asPeppolBis3(original);
  const party = xml.slice(xml.indexOf("<cac:AccountingSupplierParty>"), xml.indexOf("</cac:AccountingSupplierParty>"));
  assert.match(party, new RegExp(`</cac:PostalAddress>\\s*<cac:PartyTaxScheme><cbc:CompanyID>AU${seller}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>\\s*<cac:PartyLegalEntity>`), party);
  assert.ok(!xml.slice(xml.indexOf("<cac:AccountingCustomerParty>")).includes("PartyTaxScheme"), "the buyer's is not written");
  assert.ok(changes.includes(`the seller's GST identifier (BT-31), its ABN ${seller}, which BIS 3.0 needs on a standard-rated invoice (BR-S-02)`), changes.join("\n"));
  assert.ok(changes.includes(`the country written in front of the tax number (AU${seller})`), changes.join("\n"));
  assert.equal(asPeppolBis3(xml).changes.length, 2, "once written, nothing more is added");
});

test("an Australian seller whose printed tax number is not its ABN is given its ABN in the copy, as B2Brouter matches the sending company by it", () => {
  // 31 October 2026: the client's CII sample printed "TVA No: FR75412193567" for an Australian
  // seller whose ABN is a company of the sandbox account; B2Brouter refused the copy that carried it.
  const original = completed().replace(`<cbc:CompanyID>${ABN}</cbc:CompanyID>`, "<cbc:CompanyID>FR75412193567</cbc:CompanyID>");
  assert.ok(original.includes("FR75412193567"), "the fixture's seller tax number was replaced");
  const { xml, changes } = asPeppolBis3(original);
  assert.ok(!xml.includes("FR75412193567"));
  assert.equal(xml.match(new RegExp(`<cbc:CompanyID>AU${ABN}</cbc:CompanyID>`, "g"))?.length, 1);
  assert.match(changes.join(" | "), /seller's tax number, from FR75412193567 as printed to its ABN 47555222000/);
  // The validated invoice keeps what the invoice printed.
  assert.ok(original.includes("<cbc:CompanyID>FR75412193567</cbc:CompanyID>"));
  // Only an Australian seller: a seller elsewhere keeps its tax number.
  const abroad = original.replace(/(<cac:AccountingSupplierParty>[\s\S]*?<cbc:IdentificationCode>)AU(<\/cbc:IdentificationCode>)/, "$1NZ$2");
  assert.notEqual(abroad, original);
  assert.ok(asPeppolBis3(abroad).xml.includes("FR75412193567"));
});
