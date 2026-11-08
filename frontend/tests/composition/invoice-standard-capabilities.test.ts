import assert from "node:assert/strict";
import test from "node:test";
import { hasUblOutputClaim, type InvoiceStandardCapability } from "../../lib/composition/invoice-standard-capabilities.ts";

function claim(overrides: Partial<InvoiceStandardCapability> = {}): InvoiceStandardCapability {
  return {
    id: crypto.randomUUID(), api_id: "source", direction: "output",
    standard: "Peppol BIS Billing", version: "3.0", profile: "", condition: "",
    status: "reported", evidence_url: "https://provider.example/docs", ...overrides,
  };
}

test("documented UBL output still nominates candidates independently of review", () => {
  assert.equal(hasUblOutputClaim("source", [claim()]), true);
  assert.equal(hasUblOutputClaim("source", [claim({ standard: "UBL", version: "2.1" })]), true);
  for (const overrides of [
    { status: "rejected" as const }, { direction: "input" as const },
    { evidence_url: "" }, { standard: "EN 16931" }, { api_id: "other" },
  ]) assert.equal(hasUblOutputClaim("source", [claim(overrides)]), false);
});
