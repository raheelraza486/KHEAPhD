import assert from "node:assert/strict";
import { test } from "node:test";
import { routeHarness } from "../helpers/route-harness.ts";

const document = {
  openapi: "3.0.3",
  paths: {
    "/invoices": {
      get: { responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } } },
      post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } } },
    },
  },
};

function request(origin = "https://catalogue.example.test") {
  return new Request("https://catalogue.example.test/api/compatibility/schema-url", {
    method: "POST",
    headers: { origin, host: "catalogue.example.test", "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://provider.example.test/openapi.json", side: "source" }),
  });
}

test("a same-origin comparison preview returns selectable schema choices without saving", async () => {
  const route = routeHarness({
    "@/lib/schema/document-loader": { loadSchemaDocument: async () => ({ ok: true, document, final_url: "https://provider.example.test/openapi.json" }) },
    "@/lib/mutation-rate-limit": { checkMutationRateLimit: () => 0 },
  })("app/api/compatibility/schema-url/route.ts");
  const response = await route.POST(request());
  const payload = await response.json() as { choices: { operationLabel: string; mediaType: string }[] };
  assert.equal(response.status, 200);
  assert.equal(payload.choices.length, 1);
  assert.match(payload.choices[0].operationLabel, /GET \/invoices.*200 response/);
  assert.equal(payload.choices[0].mediaType, "application/json");
});

test("cross-origin callers cannot make the server fetch a comparison link", async () => {
  let loaded = false;
  const route = routeHarness({
    "@/lib/schema/document-loader": { loadSchemaDocument: async () => { loaded = true; return { ok: true, document, final_url: "https://provider.example.test/openapi.json" }; } },
    "@/lib/mutation-rate-limit": { checkMutationRateLimit: () => 0 },
  })("app/api/compatibility/schema-url/route.ts");
  const response = await route.POST(request("https://other.example.test"));
  assert.equal(response.status, 403);
  assert.equal(loaded, false);
});
