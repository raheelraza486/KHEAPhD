import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { routeHarness } from "../helpers/route-harness.ts";

const GOOD = "11111111-1111-4111-8111-111111111111";
const BAD = "22222222-2222-4222-8222-222222222222";
const VALIDATOR = "33333333-3333-4333-8333-333333333333";

function field(schemaId: string) {
  return {
    schema_id: schemaId, path: "invoiceNumber", leaf_name: "invoiceNumber", leaf_name_norm: "invoicenumber",
    json_type: "string", format: null, is_required: true, is_array_item: false,
    depth: 0, enum_values: null, description: null,
  };
}

function database(t: TestContext, failingTable?: string, capabilities: Record<string, unknown>[] = [], signedIn = false) {
  const previous = {
    url: process.env.SUPABASE_URL,
    secret: process.env.SUPABASE_SECRET_KEY,
    legacy: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.secret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.secret;
    if (previous.legacy === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.legacy;
  });
  const api = (id: string, name: string, category: string, output: string[]) => ({
    id, api_name: name, official_api_name: name, description: "Peppol BIS invoice", instructions: "",
    company_name: "Example", country_region: "", category, communication_direction: "Unspecified",
    is_active: true, duplicate_of: null, input_formats: ["JSON"], output_formats: output,
    invoice_standard: ["Peppol BIS 3.0"], business_rules: [], api_endpoint: null,
    http_method: "POST", authentication_method: "None", authentication_details: "",
  });
  const tables: Record<string, Record<string, unknown>[]> = {
    apis: [
      api(GOOD, "generateInvoice", "Transformation", ["JSON"]),
      api(BAD, "generateInvoice", "Transformation", ["XML"]),
      api(VALIDATOR, "validateInvoice", "Validation", ["JSON"]),
    ],
    api_schema: [
      { id: "good-response", api_id: GOOD, direction: "response", status_code: "200", media_type: "application/json", raw: { type: "object", required: ["invoiceNumber"] }, verified_by: "r", content_hash: "a" },
      { id: "bad-response", api_id: BAD, direction: "response", status_code: "200", media_type: "application/xml", raw: { type: "object", required: ["invoiceNumber"] }, verified_by: "r", content_hash: "b" },
      { id: "validator-request", api_id: VALIDATOR, direction: "request", status_code: null, media_type: "application/json", raw: { type: "object", required: ["invoiceNumber"] }, verified_by: "r", content_hash: "c" },
    ],
    api_schema_field: [field("good-response"), field("bad-response"), field("validator-request")],
    api_parameter: [],
    check_choice: [],
    api_invoice_standard_capability: capabilities,
    format_alias: [
      { alias: "JSON", canonical: "JSON" }, { alias: "application/json", canonical: "JSON" },
      { alias: "XML", canonical: "XML" }, { alias: "application/xml", canonical: "XML" },
    ],
  };
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    const table = url.pathname.split("/").at(-1)!;
    if (table === failingTable) return new Response("private database failure", {
      status: table === "api_invoice_standard_capability" ? 404 : 500,
    });
    let rows = tables[table] ?? [];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("in.(")) {
        const ids = new Set(value.slice(4, -1).split(","));
        rows = rows.filter((row) => ids.has(String(row[key])));
      }
    }
    const columns = url.searchParams.get("select")?.split(",");
    if (columns) rows = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    return Response.json(rows);
  });
  const route = routeHarness({
    "@/lib/auth": { getCurrentAppUser: async () => signedIn ? { id: GOOD } : null },
  })("app/api/composition/route.ts");
  return { route, calls, tables };
}

const processJson = {
  version: "1.0", input_text: "generate a Peppol invoice, then validate it", unmatched: [],
  steps: [
    { order: 1, category: "Transformation", task: "generate Peppol BIS invoice", candidate_ids: null },
    { order: 2, category: "Validation", task: "validate Peppol BIS invoice", candidate_ids: null },
  ],
};
const request = (body: unknown) => new Request("https://example.test/api/composition", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test('independent matching handles unsupported chain order and only reads catalogue evidence', async t => {
  const { route, calls } = database(t, undefined, [], true);
  const response = await route.POST(new Request('https://example.test/api/composition?mode=match', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...processJson, steps: [...processJson.steps].reverse().map((step, i) => ({ ...step, order: i + 1 })) }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.steps.length, 2);
  assert.deepEqual(body.steps.map((step: { candidate_ids: string[] }) => step.candidate_ids), [[VALIDATOR], [GOOD, BAD]]);
  assert.equal(body.composition, undefined);
  assert.deepEqual(calls.map(url => url.pathname.split('/').at(-1)).sort(), ['api_invoice_standard_capability', 'apis']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('independent matching requires authentication and performs no database reads for signed-out users', async t => {
  const { route, calls } = database(t);
  const response = await route.POST(new Request('https://example.test/api/composition?mode=match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(processJson) }));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("POST /api/composition narrows real IDs and checks links with one bulk read per table", async (t) => {
  const { route, calls } = database(t);
  const response = await route.POST(request(processJson));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.version, "1.1");
  assert.deepEqual(body.check_scope, { technical: true, invoice_standard_jurisdiction: false, directional_standard_version: true });
  assert.ok(body.standard_checks.every((item: { status: string }) => item.status === "pass"));
  assert.equal(body.standard_checks[0].review.source.status, "not_assessed");
  assert.equal(body.input_text, processJson.input_text);
  assert.deepEqual(body.steps.map((step: { candidate_ids: string[] }) => step.candidate_ids), [[GOOD, BAD], [VALIDATOR]]);
  assert.deepEqual(body.steps.map((step: { candidate_source: string }) => step.candidate_source), ["keywords", "keywords"]);
  assert.deepEqual(body.composition.chains.map((chain: { api_ids: string[] }) => chain.api_ids), [[GOOD, VALIDATOR]]);
  assert.equal(body.composition.counts.feasible, 1);
  assert.equal(body.technical_checks.find((item: { source_id: string }) => item.source_id === BAD).blocking_reason, "incompatible");
  assert.deepEqual(calls.map((url) => url.pathname.split("/").at(-1)).sort(), [
    "api_invoice_standard_capability", "api_parameter", "api_schema", "api_schema_field", "apis", "format_alias",
  ]);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/apis")).length, 1);
});

function conversionFixture(t: TestContext) {
  const fixture = database(t);
  const { tables } = fixture;
  Object.assign(tables.apis[0], { api_name: "Upbrains Extract Invoice Data", input_formats: ["JSON"] });
  Object.assign(tables.apis[1], { api_name: "AmitTransform Convert UBL JSON to UBL XML", output_formats: ["JSON"] });
  const storedSchema = (id: string, apiId: string, direction: string, raw: unknown = { type: "object" }, media = "application/json") => ({
    id, api_id: apiId, direction, status_code: direction === "response" ? "200" : null,
    media_type: media, raw, verified_by: "r", content_hash: id,
  });
  tables.api_schema = [
    storedSchema("extract-request", GOOD, "request"),
    storedSchema("extract-response", GOOD, "response"),
    storedSchema("convert-request", BAD, "request"),
    storedSchema("convert-response", BAD, "response"),
    storedSchema("validator-request", VALIDATOR, "request", { type: "string" }, "application/xml"),
  ];
  const storedField = (schemaId: string, name: string, format: string | null = null) => ({
    ...field(schemaId), path: name, leaf_name: name, leaf_name_norm: name.toLowerCase(), format,
  });
  tables.api_schema_field = [
    storedField("extract-request", "fileBase64", "byte"),
    storedField("extract-response", "invoiceNumber"),
    storedField("convert-request", "invoiceNumber"),
    storedField("convert-response", "xml"),
  ];
  tables.apis[2].input_formats = ["XML"];
  tables.format_alias.push({ alias: "PDF", canonical: "PDF" }, { alias: "UBL XML", canonical: "UBL" });
  return { ...fixture, body: { ...processJson,
    input_text: "Convert PDF to UBL XML, then validate the invoice",
    steps: [
      { order: 1, category: "Transformation", task: "Convert PDF to UBL XML", input_format: "PDF", output_format: "UBL XML", candidate_ids: null },
      { order: 2, category: "Validation", task: "Validate invoice", candidate_ids: [VALIDATOR] },
    ],
  } };
}

test("a keyword miss can expand to a PDF extraction and JSON-wrapped UBL conversion", async (t) => {
  const { route, body: input, calls } = conversionFixture(t);
  const body = await (await route.POST(request(input))).json();
  assert.equal(body.input_text, input.input_text);
  assert.deepEqual(body.steps.map((step: { candidate_ids: string[] }) => step.candidate_ids), [[GOOD], [BAD], [VALIDATOR]]);
  assert.deepEqual(body.steps.map((step: { candidate_source: string }) => step.candidate_source), ["formats", "formats", "discovery"]);
  assert.equal(body.steps[0].system_added, undefined);
  assert.equal(body.steps[1].system_added.original_order, 1);
  assert.match(body.steps[1].system_added.reason, /second Transformation was added/);
  assert.equal(body.composition.plan[2].input_from, 2);
  assert.deepEqual(body.composition.chains[0].api_ids, [GOOD, BAD, VALIDATOR]);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/api_schema")).length, 1);
  assert.ok(calls.every((url) => url.hostname === "database.example.test"));
});

test("unrecognised formats reach the response as recognition issues, not missing conversions", async (t) => {
  const { route, body: input } = conversionFixture(t);
  for (const name of ["XRechnung", "CII", "image", "CSV"]) {
    for (const direction of ["input", "output"]) {
      const requestBody = { ...input, steps: [{ ...input.steps[0], [`${direction}_format`]: name }] };
      const response = await route.POST(request(requestBody));
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.composition.issues[0].code, "unrecognised_format");
      assert.ok(body.composition.issues[0].message.includes(`${direction} format "${name}"`));
      assert.equal(body.steps[0].candidate_issue, "unrecognised_format");
      assert.deepEqual(body.steps[0].candidate_ids, []);
      assert.deepEqual(body.composition.chains, []);
    }
  }
});

test("documented Peppol output selects a generator while 2.0b alone decides standard compatibility", async (t) => {
  const { route, body: input, tables } = conversionFixture(t);
  Object.assign(tables.apis[1], {
    api_name: "beliq API generateInvoice", official_api_name: "generateInvoice",
    description: "Generate an invoice", output_formats: ["XML"],
  });
  Object.assign(tables.api_schema.find((row) => row.id === "convert-response")!, {
    media_type: "application/xml", raw: { type: "string" },
  });
  tables.api_schema_field = tables.api_schema_field.filter((row) => row.schema_id !== "convert-response");
  const outputClaim = {
    id: "generate-peppol", api_id: BAD, direction: "output", standard: "Peppol BIS Billing", version: "3.0",
    profile: "", condition: "", status: "reported", evidence_url: "https://docs.beliq.eu/api-reference/generate/",
  };
  tables.api_invoice_standard_capability.push(outputClaim, {
    ...outputClaim, id: "validate-peppol", api_id: VALIDATOR, direction: "input", status: "confirmed",
  });
  for (const inputFormat of ["JSON", "PDF"]) {
    const requestBody = { ...input, steps: [
      { ...input.steps[0], task: `Convert ${inputFormat} to UBL XML`, input_format: inputFormat }, input.steps[1],
    ] };
    for (const [status, condition] of [
      ["reported", ""],
      ["confirmed", "standard=peppol-bis; output=xml"],
      ["confirmed", ""],
    ]) {
      Object.assign(outputClaim, { status, condition });
      const body = await (await route.POST(request(requestBody))).json();
      assert.deepEqual(body.composition.issues, []);
      assert.deepEqual(body.composition.chains.map((chain: { api_ids: string[] }) => chain.api_ids),
        [inputFormat === "JSON" ? [BAD, VALIDATOR] : [GOOD, BAD, VALIDATOR]]);
      assert.equal(body.composition.chains[0].status, "feasible");
      assert.equal(body.composition.counts.feasible, 1);
      const standard = body.standard_checks.find((item: { source_id: string; target_id: string }) => item.source_id === BAD && item.target_id === VALIDATOR);
      assert.equal(standard.status, "pass");
      assert.equal(standard.review.source.status, status === "reported" ? "unreviewed" : "confirmed");
      const link = body.technical_checks.find((item: { source_id: string; target_id: string }) => item.source_id === BAD && item.target_id === VALIDATOR);
      assert.deepEqual(link.standard_flags, standard.flags);
      assert.deepEqual(link.standard_conditions, standard.conditions);
      assert.equal(standard.flags.includes("claims_unreviewed"), status === "reported");
      assert.equal(standard.flags.includes("configuration_required"), Boolean(condition));
      assert.deepEqual(standard.conditions, condition
        ? [{ side: "source", standard: "Peppol BIS Billing 3.0", condition }] : []);
    }
  }
});

test("an empty catalogue does not turn recognised conversion formats into unrecognised ones", async (t) => {
  const { route, body: input, tables, calls } = conversionFixture(t);
  tables.apis = [];
  const body = await (await route.POST(request({ ...input, steps: [input.steps[0]] }))).json();
  assert.equal(body.composition.issues[0].code, "conversion_unresolved");
  assert.deepEqual(body.composition.chains, []);
  assert.deepEqual(calls.map((url) => url.pathname.split("/").at(-1)), ["apis", "api_invoice_standard_capability", "format_alias"]);
});

test("an added conversion rejects disjoint field constraints and retains reviewable missing fields", async (t) => {
  const { route, body: input, tables } = conversionFixture(t);
  const target = tables.api_schema_field.find((row) => row.schema_id === "convert-request")!;
  const source = tables.api_schema_field.find((row) => row.schema_id === "extract-response")!;
  source.enum_values = ["INV-001"];
  target.enum_values = ["INV-002"];
  let body = await (await route.POST(request(input))).json();
  assert.deepEqual(body.composition.chains, []);
  assert.equal(body.technical_checks.find((row: { target_id: string }) => row.target_id === BAD).status, "fail");
  source.enum_values = null;
  target.enum_values = null;
  Object.assign(target, { path: "invoiceData", leaf_name: "invoiceData", leaf_name_norm: "invoicedata" });
  body = await (await route.POST(request(input))).json();
  assert.equal(body.composition.counts.feasible, 0);
  assert.equal(body.composition.counts.needs_decision, 1);
});

test("an unresolved conversion or a fifth step returns an explicit planning issue", async (t) => {
  const { route, body: input, tables } = conversionFixture(t);
  const excessive = { ...input, steps: [...input.steps,
    { order: 3, category: "Validation", task: "Validate again", candidate_ids: [VALIDATOR] },
    { order: 4, category: "Validation", task: "Validate again", candidate_ids: [VALIDATOR] },
  ] };
  let body = await (await route.POST(request(excessive))).json();
  assert.deepEqual(body.composition.issues.map((issue: { code: string }) => issue.code), ["too_many_steps"]);
  assert.deepEqual(body.composition.chains, []);
  assert.ok(body.steps.every((step: { system_added?: unknown }) => !step.system_added));
  tables.apis[1].api_name = "Convert JSON to XML";
  body = await (await route.POST(request(input))).json();
  assert.equal(body.composition.issues[0].code, "conversion_unresolved");
  assert.match(body.composition.issues[0].message, /PDF to UBL XML/);
  assert.deepEqual(body.composition.chains, []);
});

test("composition reads network metadata and returns Mailgun alongside Peppol delivery", async (t) => {
  const { route, tables, calls } = database(t);
  const EMAIL = "44444444-4444-4444-8444-444444444444";
  const PEPPOL = "55555555-5555-4555-8555-555555555555";
  tables.apis.push({
    id: EMAIL, api_name: "Mailgun Send Message API", official_api_name: "POST-v3--domain-name--messages",
    category: "Communication", network: "Email", communication_direction: "Send", is_active: true,
    description: "Pass To, From, Subject and attachments to build a MIME message.",
  }, {
    id: PEPPOL, api_name: "Send Invoice", category: "Communication", network: "Peppol",
    communication_direction: "Send", is_active: true,
  });
  for (const task of ["send via email", "send invoice via email or peppol"]) {
    const response = await route.POST(request({
      ...processJson, input_text: task,
      steps: [{ order: 1, category: "Communication", task, candidate_ids: null }],
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.steps[0].candidate_issue, null);
    assert.deepEqual(new Set(body.steps[0].candidate_ids), new Set(task.includes("or") ? [EMAIL, PEPPOL] : [EMAIL]));
  }
  assert.ok(calls.filter((url) => url.pathname.endsWith("/apis"))
    .every((url) => url.searchParams.get("select")?.split(",").includes("network")));
  assert.ok(calls.every((url) => url.hostname === "database.example.test"));
});

test("missing directional migration keeps the technical result and marks the scope", async (t) => {
  const { route } = database(t, "api_invoice_standard_capability");
  const body = await (await route.POST(request(processJson))).json();
  assert.equal(body.check_scope.directional_standard_version, false);
  assert.equal(body.standard_checks[0].status, "pass");
  assert.equal(body.standard_checks[0].source_basis, "catalogue");
  assert.equal(body.standard_checks[0].review.source.status, "not_assessed");
  assert.equal(body.composition.counts.feasible, 1);
});

test("missing target input is retained as unknown with a reason, not discarded", async (t) => {
  const { route, tables } = database(t);
  tables.api_schema = tables.api_schema.filter((row) => row.api_id !== VALIDATOR);
  tables.api_schema_field = tables.api_schema_field.filter((row) => row.schema_id !== "validator-request");
  const body = await (await route.POST(request(processJson))).json();
  assert.equal(body.composition.counts.feasible, 0);
  assert.equal(body.composition.counts.needs_decision, 2);
  assert.equal(body.composition.chains.find((chain: { api_ids: string[] }) => chain.api_ids[0] === GOOD).links[0].verdict, "unknown");
  const check = body.technical_checks.find((item: { source_id: string }) => item.source_id === GOOD);
  assert.equal(check.status, "unknown");
  assert.equal(check.blocking_reason, "insufficient_info");
  assert.deepEqual(check.missing_sides, ["target_input"]);
});

test("an unknown value constraint remains reviewable even with both schemas present", async (t) => {
  const { route, tables } = database(t);
  const targetField = tables.api_schema_field.find((row) => row.schema_id === "validator-request");
  assert.ok(targetField);
  targetField.enum_values = ["AU", "NZ"];
  const body = await (await route.POST(request(processJson))).json();
  const check = body.technical_checks.find((item: { source_id: string }) => item.source_id === GOOD);
  assert.equal(check.status, "unknown");
  assert.equal(check.blocking_reason, "insufficient_info");
  assert.deepEqual(check.missing_sides, []);
  assert.equal(body.composition.counts.needs_decision, 1);
});

test("saved field answers are applied only for a signed-in composition request", async (t) => {
  const { route, tables, calls } = database(t, undefined, [], true);
  tables.api_schema_field.push({
    ...field("validator-request"), path: "dueDate", leaf_name: "dueDate", leaf_name_norm: "duedate",
  });
  tables.check_choice.push({
    id: "choice-1", source_api_id: GOOD, target_api_id: VALIDATOR, target_path: "dueDate",
    kind: "user", option: "external", chosen_source_path: null,
    source_content_hash: "a", target_content_hash: "c", chosen_by: GOOD,
    chosen_at: "2026-09-30T00:00:00Z",
  });
  const body = await (await route.POST(request(processJson))).json();
  assert.equal(body.composition.counts.feasible, 1);
  assert.equal(body.technical_checks.find((item: { source_id: string }) => item.source_id === GOOD).status, "pass");
  assert.equal(calls.filter((url) => url.pathname.endsWith("/check_choice")).length, 1);
});

test("anonymous composition does not read private field answers", async (t) => {
  const { route, tables, calls } = database(t);
  tables.api_schema_field.push({
    ...field("validator-request"), path: "dueDate", leaf_name: "dueDate", leaf_name_norm: "duedate",
  });
  tables.check_choice.push({
    id: "choice-1", source_api_id: GOOD, target_api_id: VALIDATOR, target_path: "dueDate",
    kind: "user", option: "external", chosen_source_path: null,
    source_content_hash: "a", target_content_hash: "c", chosen_by: GOOD,
    chosen_at: "2026-09-30T00:00:00Z",
  });
  const body = await (await route.POST(request(processJson))).json();
  assert.equal(body.composition.counts.needs_decision, 1);
  assert.equal(body.technical_checks.find((item: { source_id: string }) => item.source_id === GOOD).status, "pending_user");
  assert.equal(calls.some((url) => url.pathname.endsWith("/check_choice")), false);
});

test("beliq -> Peppol Validator uses 2.0b and displays claim review without gating the chain", async (t) => {
  const capability = (api_id: string, direction: string, version: string, status: string) => ({
    id: crypto.randomUUID(), api_id, direction, standard: "Peppol BIS Billing",
    version, profile: "", condition: "", status, evidence_url: "https://provider.example/docs",
  });
  const rows = [capability(GOOD, "output", "3.0", "confirmed"), capability(VALIDATOR, "input", "3.0", "reported")];
  const { route, tables } = database(t, undefined, rows);
  // An opaque XML handoff with profile/configuration metadata that used to
  // trigger the separate Composition gate. This is a fixture, not a provider call.
  Object.assign(tables.apis[0], { company_name: "beliq", output_formats: ["XML"] });
  Object.assign(tables.apis[2], { api_name: "Peppol Validator", input_formats: ["XML"] });
  for (const record of tables.api_schema) Object.assign(record, { media_type: "application/xml", raw: { type: "string" } });
  tables.api_schema_field = [];
  rows[0].condition = "standard=peppol";
  rows[0].profile = "billing";
  const selected = { ...processJson, steps: processJson.steps.map((step, i) => ({ ...step, candidate_ids: [i === 0 ? GOOD : VALIDATOR] })) };
  const reported = await (await route.POST(request(selected))).json();
  assert.equal(reported.composition.counts.feasible, 1);
  assert.equal(reported.composition.counts.needs_decision, 0);
  const standard = reported.standard_checks[0];
  assert.equal(standard.status, "pass");
  assert.equal(standard.matches[0].relation, "same");
  assert.ok(standard.flags.includes("claims_unreviewed"));
  assert.ok(standard.flags.includes("configuration_required"));
  assert.deepEqual(standard.conditions, [{ side: "source", standard: "Peppol BIS Billing 3.0", condition: "standard=peppol" }]);
  assert.deepEqual(reported.technical_checks[0].standard_flags, standard.flags);
  assert.deepEqual(reported.technical_checks[0].standard_conditions, standard.conditions);
  assert.deepEqual(standard.review, {
    source: { direction: "output", status: "confirmed" },
    target: { direction: "input", status: "unreviewed" },
  });

  rows[1] = capability(VALIDATOR, "input", "3.0", "confirmed");
  const matched = await (await route.POST(request(selected))).json();
  assert.equal(matched.composition.counts.feasible, 1);
  assert.equal(matched.standard_checks[0].status, standard.status);
  assert.deepEqual(matched.standard_checks[0].matches, standard.matches);
  assert.equal(matched.standard_checks[0].review.target.status, "confirmed");
  assert.ok(!matched.standard_checks[0].flags.includes("claims_unreviewed"));
  // Review confirmation must not discard the request option needed by beliq.
  assert.ok(matched.standard_checks[0].flags.includes("configuration_required"));
  assert.deepEqual(matched.standard_checks[0].conditions, standard.conditions);
});

for (const scenario of [
  { source: "Peppol BIS Billing 3.0", target: "EN 16931", relation: "subset", status: "pass", feasible: 1, pending: 0 },
  { source: "Peppol BIS Billing 3.0", target: "Peppol PINT A-NZ 1.1.3", relation: "fillable", flag: "fill_required", status: "pass", feasible: 1, pending: 0 },
  { source: "EN 16931", target: "Peppol BIS Billing 3.0", relation: "superset", flag: "customization_unconfirmed", status: "unknown", feasible: 0, pending: 1 },
  { source: "XRechnung 3.0", target: "XRechnung 3.0.2", relation: "version_differs", flag: "version_differs", status: "not_voting", feasible: 1, pending: 0 },
  { source: "XRechnung 3.0.2", target: "Peppol BIS Billing 3.0", status: "fail", feasible: 0, pending: 0 },
]) test(`Composition follows 2.0b for ${scenario.source} -> ${scenario.target}`, async (t) => {
  const rows = [
    { api_id: GOOD, direction: "output", standard: scenario.source },
    { api_id: VALIDATOR, direction: "input", standard: scenario.target },
  ].map((row) => ({ ...row, id: crypto.randomUUID(), version: "", profile: "", condition: "", status: "reported", evidence_url: "https://provider.example/docs" }));
  const { route } = database(t, undefined, rows);
  const selected = { ...processJson, steps: processJson.steps.map((step, i) => ({
    ...step, task: i === 0 ? "generate invoice" : "validate invoice", candidate_ids: [i === 0 ? GOOD : VALIDATOR],
  })) };
  const body = await (await route.POST(request(selected))).json();
  assert.equal(body.standard_checks.length, 1);
  const standard = body.standard_checks[0];
  assert.equal(standard.status, scenario.status);
  assert.equal(standard.matches[0]?.relation, scenario.relation);
  if (scenario.flag) assert.ok(standard.flags.includes(scenario.flag));
  assert.equal(standard.review.source.status, "unreviewed");
  assert.equal(body.composition.counts.feasible, scenario.feasible);
  assert.equal(body.composition.counts.needs_decision, scenario.pending);
  if (scenario.status === "fail" || scenario.status === "unknown") {
    assert.ok(body.technical_checks[0].blocking_checks.includes("check2.0b"));
  }
});

test("missing standards remain not_voting rather than being displayed as reviewed or compatible", async (t) => {
  const { route, tables } = database(t);
  for (const api of tables.apis) api.invoice_standard = [];
  const selected = { ...processJson, steps: processJson.steps.map((step, i) => ({
    ...step, task: i === 0 ? "generate invoice" : "validate invoice", candidate_ids: [i === 0 ? GOOD : VALIDATOR],
  })) };
  const body = await (await route.POST(request(selected))).json();
  assert.equal(body.standard_checks[0].status, "not_voting");
  assert.equal(body.standard_checks[0].review.source.status, "not_recorded");
  assert.ok(body.standard_checks[0].flags.includes("standard_not_recorded"));
  assert.equal(body.composition.counts.feasible, 1);
});

test("a task with no catalogue match returns an empty shortlist without loading pair data", async (t) => {
  const { route, calls } = database(t);
  const response = await route.POST(request({ ...processJson, steps: [
    { order: 1, category: "Communication", task: "send invoice by email", candidate_ids: null },
  ] }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.steps[0].candidate_ids, []);
  assert.equal(body.steps[0].candidate_issue, "no_match");
  assert.deepEqual(body.composition.chains, []);
  assert.deepEqual(calls.map((url) => url.pathname.split("/").at(-1)), ["apis", "api_invoice_standard_capability"]);
});

test("malformed process JSON is rejected before any catalogue read", async (t) => {
  const { route, calls } = database(t);
  const response = await route.POST(request({ ...processJson, version: "2.0" }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.ok(body.details.some((item: { path: string }) => item.path === "version"));
  assert.deepEqual(calls, []);
});

test("invalid process order is returned as a plan issue", async (t) => {
  const { route, calls } = database(t);
  const response = await route.POST(request({ ...processJson, steps: [...processJson.steps].reverse().map((step, index) => ({ ...step, order: index + 1 })) }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.composition.issues.map((issue: { code: string }) => issue.code), ["order_reversed"]);
  assert.deepEqual(body.composition.chains, []);
  assert.deepEqual(calls, []);
});

test("database errors are reported without exposing private details", async (t) => {
  const { route } = database(t, "apis");
  const response = await route.POST(request(processJson));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error, "The composition could not be calculated.");
  assert.ok(!JSON.stringify(body).includes("private database failure"));
});
