import assert from "node:assert/strict";
import test from "node:test";
import { routeHarness } from "../helpers/route-harness.ts";
import { InvoiceMappingError } from "../../lib/composition/invoice-mapping.ts";

function request(body: unknown, origin = "https://example.test") {
  return new Request("https://example.test/api/composed/extracted-invoice", {
    method: "POST", headers: { origin, host: "example.test", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function route(options: { authenticated?: boolean; convert?: (extraction: unknown, options?: unknown) => Promise<unknown> } = {}) {
  return routeHarness({
    "@/lib/auth": { APP_ROLES: ["viewer"], requireRole: async () => options.authenticated === false ? { response: Response.json({ error: "Sign in required" }, { status: 401 }) } : { user: { id: "test-user" } } },
    "@/lib/composition/invoice-mapping": { InvoiceMappingError },
    "@/lib/composition/extracted-invoice": { convertExtractedInvoice: options.convert ?? (async () => ({ invoice_xml: "<Invoice/>", validation: { status: "not_run" } })) },
  })("app/api/composed/extracted-invoice/route.ts");
}

test("requires same-origin authentication before invoking the converter", async () => {
  const convert = async () => { assert.fail("Converter must not run"); };
  assert.equal((await route({ convert }).POST(request({ extraction: {} }, "https://other.test"))).status, 403);
  assert.equal((await route({ convert, authenticated: false }).POST(request({ extraction: {} }))).status, 401);
});
test("returns completed XML without caching invoice data or claiming validation", async () => {
  const response = await route({ convert: async (extraction, options) => {
    assert.deepEqual(extraction, { extractor_result: {} }); assert.deepEqual(options, { currency: "AUD" });
    return { invoice_xml: "<Invoice/>", validation: { status: "not_run" } };
  } }).POST(request({ extraction: { extractor_result: {} }, options: { currency: "AUD" } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).validation.status, "not_run");
});
test("rejects malformed or oversized requests and enforces per-user quota", async () => {
  const handler = route();
  assert.equal((await handler.POST(request({}))).status, 400);
  assert.equal((await handler.POST(request({ extraction: "a".repeat(500_000) }))).status, 413);
  const bad = new Request("https://example.test", { method: "POST", headers: { origin: "https://example.test", host: "example.test" }, body: "not JSON" });
  assert.equal((await handler.POST(bad)).status, 400);
  for (let i = 0; i < 7; i++) assert.equal((await handler.POST(request({ extraction: {} }))).status, 200);
  const limited = await handler.POST(request({ extraction: {} }));
  assert.equal(limited.status, 429); assert.ok((await limited.json()).retryAfterSeconds > 0);
});
test("reports input failures as 422 and upstream failures as 502 with stable reasons", async () => {
  for (const code of ["invalid_extraction", "unsupported_invoice", "invalid_xml", "converter_unavailable"] as const) {
    const response = await route({ convert: async () => { throw new InvoiceMappingError(code, "Review required"); } }).POST(request({ extraction: {} }));
    assert.equal(response.status, code === "invalid_xml" || code === "converter_unavailable" ? 502 : 422);
    assert.equal((await response.json()).reason, code);
  }
});
test("does not disclose unexpected exception details", async () => {
  const response = await route({ convert: async () => { throw new Error("private provider details"); } }).POST(request({ extraction: {} }));
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes("private provider"));
});
