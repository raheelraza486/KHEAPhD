import assert from "node:assert/strict";
import test from "node:test";
import { validationFailureMessage } from "../../lib/workflow-deploy/validation-report.ts";

function state(failures: unknown[]) {
  return JSON.stringify({ document: "PRIVATE_INVOICE_BYTES", transformed: { document: "PRIVATE_EXTRACTION" },
    validation: { isValid: false, report: { status: "error", summary: "Validation failed", details: { steps: [
      { status: "success", details: { errors: ["ignore successful check"] } },
      { status: "error", details: { failures, errors: ["duplicate fallback"] } },
    ] } } } });
}

test("a failed validator exposes rule messages rather than private invoice or extraction data", () => {
  const message = validationFailureMessage(state([
    { rule: "ibr-081", severity: "fatal", message: "[ibr-081] Seller electronic address is required." },
    { rule: "aligned-ibr-001-aunz", severity: "fatal", message: "[aligned-ibr-001-aunz] Seller ABN is required." },
    { severity: "warning", message: "not fatal" },
  ]));
  assert.equal(message, "[ibr-081] Seller electronic address is required. [aligned-ibr-001-aunz] Seller ABN is required.");
  assert.doesNotMatch(message!, /PRIVATE_|duplicate|successful|not fatal/);
});

test("only failed validation reports are read, with bounded text and safe fallbacks", () => {
  for (const input of [undefined, "not JSON", "null", "[]", '{"document":"PRIVATE"}', '{"validation":{"isValid":true,"report":{"summary":"not an error"}}}']) {
    assert.equal(validationFailureMessage(input), null);
  }
  assert.equal(validationFailureMessage('{"validation07":{"isValid":false,"report":{"summary":"No schema matched"}}}'), "No schema matched");
  assert.equal(validationFailureMessage('{"validation":{"isValid":false,"report":{"details":{"steps":[{"status":"error","details":{"errors":["Invalid document"]}}]}}}}'), "Invalid document");
  assert.ok(validationFailureMessage(state([{ message: "x".repeat(2000) }]))!.length <= 500);
});
