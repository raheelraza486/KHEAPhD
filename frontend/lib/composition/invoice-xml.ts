import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import { decimal, InvoiceMappingError, type MappedInvoice } from "./invoice-mapping.ts";

const CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
const INVOICE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
export const INVOICE_PROFILES = {
  "peppol-bis3": { customization: "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0", process: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0", taxScheme: "VAT" },
  "pint-aunz": { customization: "urn:peppol:pint:billing-1@aunz-1", process: "urn:peppol:bis:billing", taxScheme: "GST" },
} as const;
const ROOT_ORDER = ["UBLVersionID", "CustomizationID", "ProfileID", "ID", "IssueDate", "DueDate", "InvoiceTypeCode", "Note", "DocumentCurrencyCode", "BuyerReference", "OrderReference", "AccountingSupplierParty", "AccountingCustomerParty", "PaymentTerms", "TaxTotal", "LegalMonetaryTotal", "InvoiceLine"];
const ROOT_BASIC = new Set(ROOT_ORDER.slice(0, 10));
const ROOT_AGGREGATE = new Set(ROOT_ORDER.slice(10));

function invalid(message: string): never { throw new InvoiceMappingError("invalid_xml", message); }
function children(parent: Element): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1);
}
function matching(parent: Element, name: string, namespace = CBC): Element[] {
  return children(parent).filter((node) => node.localName === name && node.namespaceURI === namespace);
}
function only(parent: Element, name: string, namespace = CBC): Element {
  const nodes = matching(parent, name, namespace);
  if (nodes.length !== 1) invalid(`AmitTransform must return exactly one ${name} in ${parent.localName}.`);
  return nodes[0];
}
function add(parent: Element, name: string, value?: string, namespace = CBC): Element {
  const node = parent.ownerDocument!.createElementNS(namespace, `${namespace === CBC ? "cbc" : "cac"}:${name}`);
  if (value != null) node.textContent = value;
  parent.appendChild(node);
  return node;
}
function expectValue(parent: Element, name: string, expected: unknown, numeric = false) {
  const actual = only(parent, name).textContent?.trim() ?? "";
  let equal = actual === String(expected);
  if (numeric) {
    try { equal = decimal(actual, name) === decimal(expected, name); } catch { equal = false; }
  }
  if (!equal) invalid(`AmitTransform changed or omitted ${name}; the output needs review.`);
}

/** Complete only the supported mapping, preserving source amounts. This is not a validator verdict. */
export function enrichAmitXml(xml: string, mapped: MappedInvoice): string {
  if (typeof xml !== "string" || xml.length > 1_000_000 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) invalid("AmitTransform returned an unsupported XML document.");
  let doc;
  try {
    doc = new DOMParser({ onError: () => { throw new Error("Malformed XML"); } }).parseFromString(xml, "application/xml");
  } catch { invalid("AmitTransform returned malformed XML."); }
  const root = doc.documentElement;
  if (!root || root.localName !== "Invoice" || root.namespaceURI !== INVOICE) invalid("AmitTransform did not return a UBL Invoice.");
  const profile = INVOICE_PROFILES[mapped.profile];
  const data = mapped.invoiceData;
  for (const [name, expected] of [["ID", data.invoiceId], ["IssueDate", data.issueDate], ["InvoiceTypeCode", "380"], ["DocumentCurrencyCode", mapped.currency]]) expectValue(root, name as string, expected);
  if (data.dueDate) expectValue(root, "DueDate", data.dueDate);
  if (data.buyerReference) expectValue(root, "BuyerReference", data.buyerReference);
  const orders = matching(root, "OrderReference", CAC);
  if (orders.length > 1) invalid("AmitTransform returned multiple OrderReference elements.");
  if (orders.length) {
    if (!data.purchaseOrderReference) invalid("AmitTransform introduced an unsupplied purchase order reference.");
    expectValue(orders[0], "ID", data.purchaseOrderReference);
    if (children(orders[0]).length !== 1) invalid("AmitTransform returned unsupported OrderReference fields.");
  } else if (data.purchaseOrderReference) {
    // The converter can omit a source purchase order. Restore its original
    // meaning as BT-13, separately from a buyer reference (BT-10).
    add(add(root, "OrderReference", undefined, CAC), "ID", String(data.purchaseOrderReference));
  }
  // The flexible mapper duplicates party, line and total fields directly under Invoice.
  for (const child of children(root)) {
    if (child.namespaceURI === CBC && !ROOT_BASIC.has(child.localName!)) root.removeChild(child);
    else if (child.namespaceURI !== CBC && (child.namespaceURI !== CAC || !ROOT_AGGREGATE.has(child.localName!))) invalid(`Unexpected Invoice element: ${child.localName}.`);
  }
  for (const name of ["CustomizationID", "ProfileID"]) for (const node of matching(root, name)) root.removeChild(node);
  // No invoice-level note or party identifier was supplied by this mapping.
  for (const node of matching(root, "Note")) root.removeChild(node);
  add(root, "CustomizationID", profile.customization);
  add(root, "ProfileID", profile.process);
  const totals = only(root, "LegalMonetaryTotal", CAC);
  for (const [name, expected] of Object.entries({ LineExtensionAmount: data.subtotal, TaxExclusiveAmount: data.subtotal, TaxInclusiveAmount: data.totalAmount, PayableAmount: data.payableAmount })) expectValue(totals, name, expected, true);
  const taxTotal = only(root, "TaxTotal", CAC);
  expectValue(taxTotal, "TaxAmount", data.totalTax, true);
  for (const subtotal of matching(taxTotal, "TaxSubtotal", CAC)) taxTotal.removeChild(subtotal);
  function taxCategory(parent: Element, name: string, rate: string) {
    const category = add(parent, name, undefined, CAC);
    add(category, "ID", "S");
    add(category, "Percent", rate);
    add(add(category, "TaxScheme", undefined, CAC), "ID", profile.taxScheme);
  }
  for (const group of mapped.taxGroups) {
    const subtotal = add(taxTotal, "TaxSubtotal", undefined, CAC);
    add(subtotal, "TaxableAmount", group.taxable);
    add(subtotal, "TaxAmount", group.tax);
    taxCategory(subtotal, "TaxCategory", group.rate);
  }
  const lines = matching(root, "InvoiceLine", CAC);
  if (lines.length !== mapped.lines.length) invalid("AmitTransform changed the number of invoice lines.");
  lines.forEach((line, index) => {
    const source = mapped.lines[index];
    expectValue(line, "ID", source.id);
    expectValue(line, "InvoicedQuantity", source.quantity, true);
    expectValue(line, "LineExtensionAmount", source.amount, true);
    if (only(line, "InvoicedQuantity").getAttribute("unitCode") !== source.unitCode) invalid("AmitTransform changed a line's unit code.");
    const item = only(line, "Item", CAC);
    expectValue(item, "Name", source.description);
    expectValue(only(line, "Price", CAC), "PriceAmount", source.unitPrice, true);
    for (const category of matching(item, "ClassifiedTaxCategory", CAC)) item.removeChild(category);
    taxCategory(item, "ClassifiedTaxCategory", source.taxRate);
  });
  for (const [element, source] of [["AccountingSupplierParty", data.supplier], ["AccountingCustomerParty", data.customer]] as const) {
    const party = only(only(root, element, CAC), "Party", CAC);
    const context = source as Record<string, unknown>;
    const legal = only(party, "PartyLegalEntity", CAC);
    expectValue(legal, "RegistrationName", context.name);
    const registration = context.partyLegalEntity as { companyID: string } | undefined;
    if (registration) {
      expectValue(legal, "CompanyID", registration.companyID);
      only(legal, "CompanyID").setAttribute("schemeID", String(context.legalRegistrationSchemeId));
    }
    for (const node of matching(party, "PartyIdentification", CAC)) party.removeChild(node);
    if (context.endpointID) {
      expectValue(party, "EndpointID", context.endpointID);
      only(party, "EndpointID").setAttribute("schemeID", String(context.endpointSchemeId));
    }
    const tax = context.partyTaxScheme as { companyID: string } | undefined;
    if (tax) expectValue(only(party, "PartyTaxScheme", CAC), "CompanyID", tax.companyID);
  }
  for (const node of Array.from(doc.getElementsByTagNameNS(CBC, "*"))) {
    if (node.localName?.endsWith("Amount")) node.setAttribute("currencyID", mapped.currency);
  }
  for (const node of Array.from(doc.getElementsByTagNameNS(CAC, "TaxScheme"))) only(node, "ID").textContent = profile.taxScheme;
  // UBL requires totals before lines; AmitTransform writes them in the opposite order.
  for (const child of children(root).sort((a, b) => ROOT_ORDER.indexOf(a.localName!) - ROOT_ORDER.indexOf(b.localName!))) root.appendChild(child);
  try { return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root, { requireWellFormed: true }); }
  catch { invalid("The completed invoice could not be serialized as XML."); }
}
