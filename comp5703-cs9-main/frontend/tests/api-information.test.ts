import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { apiInformationCoverage, catalogueDate, publicWebUrl } from "../lib/api-information.ts";
import { normalizeApiRecord, type ApiRecord } from "../lib/types.ts";
import { componentHarness } from "./helpers/component-harness.ts";
import { formatFormatsForDisplay, formatInputFormatsForDisplay } from "../lib/format-display.ts";

const load = componentHarness();
const ApiInformation = load("components/api-information.tsx").default as ComponentType<{ record: ApiRecord; onCopyEndpoint: () => void }>;
const ApiRepository = load("components/api-repository.tsx").default as ComponentType<{ initialRecords: ApiRecord[]; initialApiId?: string; role: "publisher" | null; userId: string | null }>;

const record = normalizeApiRecord({
  id: "api-1", api_name: "Submit Invoice", company_name: "Provider", description: "Send an invoice for validation.",
  category: "Communication", communication_direction: "Send and receive", http_method: "post", api_endpoint: "https://example.test/invoices",
  input_formats: ["XML"], output_formats: ["JSON"], client_types: ["REST"], invoice_standard: ["UBL 2.1"], invoice_standard_source: "extracted",
  access_scope: "restricted", data_quality: "access_restricted", authentication_method: "API Key", authentication_details: "Use an X-API-Key header.",
  instructions: "Register with the provider first.", business_rules: ["Include a unique invoice number."],
  documentation_url: "https://example.test/docs", source_url: "https://example.test/openapi.json", website_url: "https://example.test",
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-14T00:00:00Z", created_by_user: "someone-else",
});

test("public details show saved integration information and its provenance without exposing management controls", () => {
  for (const role of [null, "publisher"] as const) {
    const html = renderToStaticMarkup(createElement(ApiRepository, { initialRecords: [record], role, userId: role ? "reader" : null }));
    for (const text of ["POST", "Client / interface type", "REST", "UBL 2.1", "Use an X-API-Key header.", "Register with the provider first.", "Include a unique invoice number.", "Information coverage", "Missing or unconfirmed", "Recorded information", "Sep 14, 2026", "Restricted / internal"]) assert.ok(html.includes(text), text);
    assert.match(html, /not yet confirmed against provider documentation/);
    assert.match(html, /href="\/apis\/api-1\/schemas"/);
    assert.doesNotMatch(html, /someone-else|Edit API|Delete API|Update status|Action history/);
  }
});

test("multiple input and output formats use slash separators throughout the public details", () => {
  assert.equal(formatFormatsForDisplay([" JSON ", "XML"]), "JSON / XML");
  assert.equal(formatFormatsForDisplay([]), "Not recorded");
  const multi = normalizeApiRecord({
    ...record,
    input_formats: ["JSON", "XML"],
    output_formats: ["PDF", "ZIP"],
  });
  const html = renderToStaticMarkup(createElement(ApiInformation, { record: multi, onCopyEndpoint: () => {} }));
  assert.match(html, /JSON \/ XML/);
  assert.match(html, /PDF \/ ZIP/);
  const coverage = apiInformationCoverage(multi);
  assert.equal(coverage.items.find((item) => item.key === "input_formats")?.value, "JSON / XML");
  assert.equal(coverage.items.find((item) => item.key === "output_formats")?.value, "PDF / ZIP");
});

test("a null input format is presented as an operation without a request body", () => {
  assert.equal(formatInputFormatsForDisplay([" NULL "]), "No request body");
  const noRequestBody = normalizeApiRecord({
    ...record,
    http_method: "get",
    input_formats: ["null"],
  });
  const html = renderToStaticMarkup(createElement(ApiInformation, { record: noRequestBody, onCopyEndpoint: () => {} }));
  assert.match(html, /No request body/);
  assert.doesNotMatch(html, />null</i);
  assert.equal(apiInformationCoverage(noRequestBody).items.find((item) => item.key === "input_formats")?.value, "No request body");
});

test("action history never renders spreadsheet evidence, remarks or source rows", () => {
  const owned = normalizeApiRecord({
    ...record,
    created_by_user: "reader",
    review_status: "Published",
    verification_notes: "内部备注，不应公开",
    audit_trail: [{
      id: "audit-internal",
      api_id: record.id,
      api_name: record.api_name,
      company_name: record.company_name,
      action: "verify",
      actor_name: "Repository administrator",
      action_at: "2026-09-16T00:00:00Z",
      details: JSON.stringify({
        type: "admin_metadata_bulk_update",
        fields: ["country_region", "invoice_standard", "network"],
        evidence: [{ source_row: 47, statement: "中文证据", note: "内部备注" }],
        source_rows: [47],
      }),
    }],
  });
  const html = renderToStaticMarkup(createElement(ApiRepository, {
    initialRecords: [owned], initialApiId: owned.id, role: "publisher", userId: "reader",
  }));
  assert.match(html, /country_region updated, invoice_standard updated, network updated/);
  assert.doesNotMatch(html, /内部|中文|statement|source_row|source_rows|&quot;evidence&quot;/iu);
});

test("missing metadata stays unknown and does not invent a method, invoice standard or schema", () => {
  const empty = normalizeApiRecord({ id: "empty" });
  assert.equal(empty.http_method, "");
  assert.equal(empty.access_scope, "unknown");
  assert.deepEqual(empty.invoice_standard, []);
  assert.equal(empty.invoice_standard_source, null);
  const html = renderToStaticMarkup(createElement(ApiInformation, { record: empty, onCopyEndpoint: () => {} }));
  assert.match(html, /Method not recorded/);
  assert.match(html, /Not confirmed/);
  assert.match(html, /No source links have been recorded/);
  assert.doesNotMatch(html, /Publicly offered|>GET<|>POST<|Confirmed against provider/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /id="api-schema-preview" hidden=""/);
  assert.match(html, /Client \/ interface type/);
  assert.match(html, /An empty value may be valid when this operation has no request body/);
});

test("information coverage separates recorded values from gaps and keeps request-body absence conditional", () => {
  const coverage = apiInformationCoverage(normalizeApiRecord({
    ...record,
    input_formats: [],
    client_types: [],
    country_region: "",
  }), { request_count: 0, response_count: 1 });
  assert.ok(coverage.recorded.some((item) => item.key === "response_schema" && item.value === "1 saved schema"));
  assert.ok(coverage.missing.some((item) => item.key === "client_types" && item.source === "catalogue"));
  const input = coverage.missing.find((item) => item.key === "input_formats");
  assert.equal(input?.source, "schema");
  assert.match(input?.guidance ?? "", /may be valid when this operation has no request body/);
  assert.ok(coverage.missing.some((item) => item.key === "request_schema"));
  assert.equal(coverage.checking.length, 0);
});

test("source links remain safe and record text is escaped", () => {
  const unsafe = normalizeApiRecord({ ...record, description: "<script>alert(1)</script>", documentation_url: "javascript:alert(1)", website_url: "data:text/html,bad", source_url: "https://user:password@example.test/docs" });
  const html = renderToStaticMarkup(createElement(ApiInformation, { record: unsafe, onCopyEndpoint: () => {} }));
  assert.doesNotMatch(html, /href="javascript:|href="data:|password@example|<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(publicWebUrl("https://example.test/docs"), "https://example.test/docs");
  assert.equal(publicWebUrl("/relative"), null);
});

test("catalogue dates are stable and an original source is only displayed once", () => {
  assert.equal(catalogueDate("bad-date"), "Not recorded");
  assert.equal(catalogueDate("2026-09-14T23:30:00Z"), "Sep 14, 2026");
  const html = renderToStaticMarkup(createElement(ApiInformation, { record: { ...record, documentation_url: "" }, onCopyEndpoint: () => {} }));
  assert.equal(html.match(/href="https:\/\/example.test\/openapi.json"/g)?.length, 1);
});

test("the compact overview retains location uncertainty and access conditions alongside its facts", () => {
  const ApiOverview = load("components/api-overview.tsx").default as ComponentType<{ record: ApiRecord }>;
  const html = renderToStaticMarkup(createElement(ApiOverview, { record: normalizeApiRecord({
    ...record, country_region: "", api_endpoint: "https://api.infast.fr/api/v2/transaction-usages",
    documentation_url: "https://api.infast.fr/docs", access_scope: "public", communication_direction: "Receive",
    client_types: [],
  }) }));
  const [facts, notes] = html.split('<details class="api-overview-notes">');
  assert.match(facts, /France/);
  assert.match(facts, /Suggested location/);
  assert.match(facts, /Service coverage not confirmed/);
  assert.match(facts, /Publicly offered/);
  assert.match(facts, /Sign-up or fees may apply/);
  assert.match(facts, /<dt>Direction<\/dt><dd>Receive<\/dd>/);
  assert.match(facts, /<dt>Client \/ interface type<\/dt><dd class="is-unknown">Not recorded<\/dd>/);
  assert.ok(notes, "Full source and access explanations remain in a closed disclosure");
  assert.match(notes, /Suggested by the provider name or source URL/);
  assert.match(notes, /does not mean anonymous or free access/);
  const unknown = renderToStaticMarkup(createElement(ApiOverview, { record: normalizeApiRecord({ category: "Validation" }) }));
  assert.match(unknown, /Service coverage is unknown/);
  assert.match(unknown, /Not confirmed/);
  assert.doesNotMatch(unknown, /<dt>Direction<\/dt>|Suggested location|Publicly offered/);
});
