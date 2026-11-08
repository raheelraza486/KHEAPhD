/** Directional claims. A catalogue-wide label cannot tell input from output. */
export interface InvoiceStandardCapability {
  id: string;
  api_id: string;
  direction: "input" | "output";
  standard: string;
  version: string;
  profile: string;
  /** Nonempty when a request option must be selected to use this version. */
  condition: string;
  status: "reported" | "confirmed" | "rejected";
  evidence_url: string;
}

function standardKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function versionKey(value: string) {
  return value.trim().toLowerCase().replace(/^v(?=\d)/, "");
}

/** Documented output claims can nominate UBL candidates; link checks still decide feasibility. */
export function hasUblOutputClaim(apiId: string, rows: readonly InvoiceStandardCapability[]): boolean {
  return rows.some((row) => {
    if (row.api_id !== apiId || row.direction !== "output" || row.status === "rejected"
      || !/^https?:\/\/\S+$/i.test(row.evidence_url)) return false;
    const standard = standardKey(row.standard);
    if (["ubl", "ublxml", "oasisubl"].includes(standard)) return true;
    // BIS Billing 3.0 binds its invoice and credit note to UBL. A generic
    // Peppol, EN 16931 or XRechnung label does not establish that syntax.
    // https://docs.peppol.eu/poacc/billing/3.0/
    const version = versionKey(row.version);
    return (standard === "peppolbisbilling" && version === "3.0")
      || (standard === "peppolbisbilling30" && (!version || version === "3.0"));
  });
}
