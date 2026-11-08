import assert from "node:assert/strict";
import test from "node:test";
import { getExecutionAvailability } from "../../lib/composition/execution-registry.ts";

const UPBRAINS = "974405cd-82b2-4e76-a628-278a56ac4e9a";
const AMIT = "17455a7a-f107-4180-a907-0f8879bcd746";
const ESS = "10feb4e1-16d8-4f67-8463-99d44565580d";
const MAILGUN = "08885479-e750-4a42-99d6-b4d32ad62983";
const B2B_ROUTER = "8c305642-44f0-4400-ae99-49801ae06131";

function selected(apiIds: string[]) {
  return { chain: { api_ids: apiIds } } as Parameters<
    typeof getExecutionAvailability
  >[0];
}

test("registers the exact email chain", () => {
  const result = getExecutionAvailability(
    selected([UPBRAINS, AMIT, ESS, MAILGUN]),
  );
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.integration, "pdf_invoice_email");
    assert.equal(result.workflowHref, "/compose/pdf-invoice");
    assert.equal(result.endpoint, "/api/composed/pdf-invoice");
  }
});

test("registers the exact Peppol chain", () => {
  const result = getExecutionAvailability(
    selected([UPBRAINS, AMIT, ESS, B2B_ROUTER]),
  );
  assert.equal(result.status, "available");
  if (result.status === "available") {
    assert.equal(result.integration, "pdf_invoice_peppol");
    assert.equal(result.workflowHref, "/compose/pdf-invoice");
  }
});

test("does not register a reordered chain", () => {
  const result = getExecutionAvailability(
    selected([AMIT, UPBRAINS, ESS, MAILGUN]),
  );
  assert.equal(result.status, "integration_unavailable");
});

test("does not register a partial or extended chain", () => {
  assert.equal(
    getExecutionAvailability(selected([UPBRAINS, AMIT, ESS])).status,
    "integration_unavailable",
  );
  assert.equal(
    getExecutionAvailability(
      selected([UPBRAINS, AMIT, ESS, MAILGUN, "unexpected-api"]),
    ).status,
    "integration_unavailable",
  );
});
