import assert from "node:assert/strict";
import test from "node:test";
import { invoiceOverrideError, invoiceFailureHint } from "../../lib/composition/invoice-run-options.ts";
test("sandbox replacement fields are checked without modifying original invoice defaults", () => {
  assert.equal(invoiceOverrideError({}), null);
  assert.equal(invoiceOverrideError({ invoiceId: "EBWASP1002-DEMO2", issueDate: "2026-10-31", dueDate: "2026-11-30" }, "2026-10-31"), null);
  assert.match(invoiceOverrideError({ issueDate: "2026-11-01" }, "2026-10-31")!, /must not be after today/);
  for (const value of ["2026-02-30", "31/10/2026", "", null, 1000]) assert.match(invoiceOverrideError({ issueDate: value })!, /real date/);
  for (const value of ["", "x".repeat(61), "<test>", "x\n", null]) assert.match(invoiceOverrideError({ invoiceId: value })!, /Invoice number/);
  assert.match(invoiceOverrideError({ issueDate: "2026-10-31", dueDate: "2022-01-01" })!, /must not precede/);
});
test("provider errors describe the actual remedy without assuming a quota problem", () => {
  assert.match(invoiceFailureHint("Validation failed: Number has already been taken")!, /already stored/);
  assert.match(invoiceFailureHint("You cannot send invoices dated from a closed fiscal year")!, /open financial year/);
  assert.match(invoiceFailureHint("To use Peppol Network you need to configure this connection to your account")!, /does not report exhausted/);
  assert.equal(invoiceFailureHint("Unknown service error"), null);
});
