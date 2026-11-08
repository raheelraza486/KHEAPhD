/**
 * The copy of a validated PINT A-NZ invoice that the PDF flow (pdf-invoice.ts)
 * hands to B2Brouter.
 *
 * B2Brouter's sandbox recipients receive only Peppol BIS Billing 3.0, and
 * B2Brouter falls back to it without saying so; a tax it then reads as "GST"
 * has no category there, and the invoice is not sent (seen on 13 October 2026).
 * The copy changes the two specification identifiers, the name of the tax
 * scheme, and how a tax number is written: BIS 3.0 wants the country in front
 * of it (BR-CO-09), where PINT A-NZ takes the bare ABN. A seller without a tax
 * number is given its ABN as one (BIS 3.0's BR-S-02), and an Australian seller
 * whose printed tax number is not its ABN is given its ABN instead, because
 * B2Brouter matches the sending company by that number. Every amount, party
 * and line is the same.
 */
import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import { InvoiceMappingError } from "./invoice-mapping.ts";
import { INVOICE_PROFILES } from "./invoice-xml.ts";

export const PINT_AUNZ = { rule_set: "Peppol PINT A-NZ Billing", ...INVOICE_PROFILES["pint-aunz"] } as const;
export const PEPPOL_BIS3 = { format: "Peppol BIS Billing 3.0", ...INVOICE_PROFILES["peppol-bis3"] } as const;

const INVOICE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
const CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
const CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";

const unreadable = (): never => { throw new InvoiceMappingError("invalid_xml", "The completed invoice could not be read back."); };
const child = (parent: Element, ns: string, name: string): Element | null =>
  (Array.from(parent.childNodes).find((node) => node.nodeType === 1 && (node as Element).namespaceURI === ns && (node as Element).localName === name) as Element | undefined) ?? null;

/** The party's ABN: an 11-digit identifier under scheme 0151, in its legal registration or electronic address. */
function partyAbn(party: Element): string | null {
  const legal = child(party, CAC, "PartyLegalEntity");
  return [legal && child(legal, CBC, "CompanyID"), child(party, CBC, "EndpointID")]
    .find((node) => node?.getAttribute("schemeID") === "0151" && /^\d{11}$/.test(node.textContent?.trim() ?? ""))?.textContent?.trim() ?? null;
}

function partyCountry(party: Element): string {
  const postal = child(party, CAC, "PostalAddress");
  const land = postal && child(postal, CAC, "Country");
  return (land && child(land, CBC, "IdentificationCode"))?.textContent?.trim().toUpperCase() ?? "";
}

export function asPeppolBis3(xml: string): { xml: string; changes: string[] } {
  let root: Element | null;
  try {
    root = new DOMParser({ onError: () => { throw new Error("malformed"); } }).parseFromString(xml, "application/xml").documentElement as Element | null;
  } catch {
    return unreadable();
  }
  if (!root || root.localName !== "Invoice" || root.namespaceURI !== INVOICE) return unreadable();
  const customization = child(root, CBC, "CustomizationID");
  const profile = child(root, CBC, "ProfileID");
  if (!customization || !profile) return unreadable();
  customization.textContent = PEPPOL_BIS3.customization;
  profile.textContent = PEPPOL_BIS3.process;
  let schemes = 0;
  for (const scheme of Array.from(root.getElementsByTagNameNS(CAC, "TaxScheme")) as Element[]) {
    const id = child(scheme, CBC, "ID");
    if (id && id.textContent === PINT_AUNZ.taxScheme) { id.textContent = PEPPOL_BIS3.taxScheme; schemes += 1; }
  }
  // BIS 3.0 needs the seller's VAT identifier (BT-31) on a standard-rated invoice (BR-S-02);
  // PINT A-NZ does not. An Australian seller's GST identifier is its ABN, so when the invoice
  // has none it is written from the ABN the invoice already carries (scheme 0151).
  let addedTaxId: string | null = null;
  const sellerParty = (() => { const supplier = child(root, CAC, "AccountingSupplierParty"); return supplier && child(supplier, CAC, "Party"); })();
  const standardRated = (Array.from(root.getElementsByTagNameNS(CAC, "ClassifiedTaxCategory")) as Element[]).some((category) => child(category, CBC, "ID")?.textContent?.trim() === "S");
  if (sellerParty && standardRated && !child(sellerParty, CAC, "PartyTaxScheme")) {
    const legal = child(sellerParty, CAC, "PartyLegalEntity");
    const abn = partyAbn(sellerParty);
    if (abn) {
      const doc = root.ownerDocument ?? unreadable();
      const registration = doc.createElementNS(CAC, "cac:PartyTaxScheme");
      const number = doc.createElementNS(CBC, "cbc:CompanyID");
      number.textContent = abn;
      const scheme = doc.createElementNS(CAC, "cac:TaxScheme");
      const id = doc.createElementNS(CBC, "cbc:ID");
      id.textContent = PEPPOL_BIS3.taxScheme;
      scheme.appendChild(id);
      registration.appendChild(number);
      registration.appendChild(scheme);
      // UBL order: after PostalAddress, before PartyLegalEntity and Contact.
      const before = legal ?? child(sellerParty, CAC, "Contact");
      if (before) sellerParty.insertBefore(registration, before); else sellerParty.appendChild(registration);
      addedTaxId = abn;
    }
  }
  // B2Brouter sends only for a seller whose tax number (BT-31) is one of the account's companies;
  // it does not read the ABN in the legal registration. The client's CII sample prints a French
  // "TVA No: FR75412193567" for an Australian seller, and B2Brouter refused the copy on 31 October
  // 2026 although that seller's ABN is a company of the sandbox account. So for an Australian
  // seller, the copy carries its ABN as the tax number; the validated invoice keeps what it printed.
  let replacedTaxId: { from: string; to: string } | null = null;
  const sellerTax = sellerParty && child(sellerParty, CAC, "PartyTaxScheme");
  const sellerTaxNumber = sellerTax && child(sellerTax, CBC, "CompanyID");
  const sellerAbn = sellerParty && partyAbn(sellerParty);
  if (sellerTaxNumber && sellerAbn && partyCountry(sellerParty) === "AU") {
    const printed = sellerTaxNumber.textContent?.trim() ?? "";
    if (printed.replace(/\s+/g, "").toUpperCase().replace(/^AU(?=\d{11}$)/, "") !== sellerAbn) {
      sellerTaxNumber.textContent = sellerAbn;
      replacedTaxId = { from: printed, to: sellerAbn };
    }
  }
  const prefixed: string[] = [];
  for (const registration of Array.from(root.getElementsByTagNameNS(CAC, "PartyTaxScheme")) as Element[]) {
    const number = child(registration, CBC, "CompanyID");
    const postal = child(registration.parentNode as Element, CAC, "PostalAddress");
    const land = postal && child(postal, CAC, "Country");
    const code = (land && child(land, CBC, "IdentificationCode"))?.textContent?.trim().toUpperCase() ?? "";
    const value = number?.textContent?.trim() ?? "";
    if (!number || !/^[A-Z]{2}$/.test(code) || value === "" || /^[A-Za-z]{2}/.test(value)) continue;
    number.textContent = `${code}${value}`;
    prefixed.push(`${code}${value}`);
  }
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}\n`,
    changes: [
      `the specification identifiers, from ${PINT_AUNZ.rule_set} to ${PEPPOL_BIS3.format}`,
      `the tax scheme's name, from ${PINT_AUNZ.taxScheme} to ${PEPPOL_BIS3.taxScheme}, in ${schemes} places`,
      ...(replacedTaxId ? [`the seller's tax number, from ${replacedTaxId.from} as printed to its ABN ${replacedTaxId.to}, because B2Brouter sends only for a seller tax number that is one of the account's companies`] : []),
      ...(addedTaxId ? [`the seller's GST identifier (BT-31), its ABN ${addedTaxId}, which BIS 3.0 needs on a standard-rated invoice (BR-S-02)`] : []),
      ...(prefixed.length > 0 ? [`the country written in front of the tax number (${prefixed.join(", ")})`] : []),
    ],
  };
}
