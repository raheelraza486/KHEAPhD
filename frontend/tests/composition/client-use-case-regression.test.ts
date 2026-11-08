// Regression tests for the client's use case, run against a snapshot of the
// live catalogue instead of a hand-made one.
//
// The client's process is "convert PDF to UBL XML, validate using Australian
// rules and send via email or Peppol". Each case below is what Discovery read
// from one of the client's own wordings, so Gemini is not called. The snapshot
// (fixtures/client-use-case-catalogue.json) holds every active record's
// metadata and the schemas of the client's designated APIs used here: the
// three extraction APIs (Upbrains, EzzyBills, Nanonets), AmitTransform, ESS
// SmartDocFlow, Mailgun and B2Brouter. Other candidates have no schemas, so
// their chains show missing evidence; the designated chain does not.
//
// A failure here means a change to the search, the composition or the checks
// has stopped offering the client's chain for words the client really used.
// Refresh the snapshot when records are corrected on purpose.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { routeHarness } from "../helpers/route-harness.ts";
import { groundDiscoveryResult } from "../../lib/discovery/grounding.ts";

type Row = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/client-use-case-catalogue.json", import.meta.url), "utf8")) as {
  tables: Record<string, Row[]>;
};
const { tables } = fixture;

const ID = Object.fromEntries(Object.entries({
  upbrains: "Upbrains Extract Invoice From PDF API",
  ezzybills: "EzzyBills Upload Invoice Image API",
  nanonets: "Nanonets OCR Extract From File API",
  amit: "AmitTransform Convert UBL JSON to UBL XML API",
  ess: "ESS SmartDocFlow Validate PINT A-NZ Invoice API",
  mailgun: "Mailgun Send Message API",
  b2brouter: "B2Brouter Import Invoice API",
}).map(([key, name]) => {
  const record = tables.apis.find((api) => api.api_name === name);
  assert.ok(record, `${name} is missing from the snapshot`);
  return [key, String(record.id)];
})) as Record<"upbrains" | "ezzybills" | "nanonets" | "amit" | "ess" | "mailgun" | "b2brouter", string>;

/** The composition route with the snapshot standing in for the database. */
function liveSnapshot(t: TestContext, signedIn = false) {
  const previous = { url: process.env.SUPABASE_URL, secret: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  t.after(() => {
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.secret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.secret;
  });
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    let rows = tables[url.pathname.split("/").at(-1)!] ?? [];
    for (const [key, value] of url.searchParams) {
      if (value.startsWith("in.(")) {
        const ids = new Set(value.slice(4, -1).split(","));
        rows = rows.filter((row) => ids.has(String(row[key])));
      }
    }
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? rows.length);
    rows = rows.slice(offset, offset + limit);
    const columns = url.searchParams.get("select")?.split(",");
    if (columns) rows = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
    return Response.json(rows);
  });
  return routeHarness({ "@/lib/auth": { getCurrentAppUser: async () => signedIn ? { id: "regression-user" } : null } })("app/api/composition/route.ts");
}

type Step = { order: number; category: string; candidate_ids: string[]; system_added?: unknown; candidate_issue: string | null };
type Chain = { api_ids: string[]; status: string; links: Array<{ verdict: string }> };

async function compose(t: TestContext, inputText: string, steps: Row[]) {
  const route = liveSnapshot(t);
  const response = await route.POST(new Request("https://example.test/api/composition", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: "1.0", input_text: inputText, unmatched: [],
      steps: steps.map((step, index) => ({
        order: index + 1, input_format: null, output_format: null, rule_set: null, candidate_ids: null, ...step,
      })),
    }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json() as { steps: Step[]; composition: { issues: unknown[]; chains: Chain[] } };
  assert.deepEqual(body.composition.issues, []);
  return body;
}

/** The chain must be offered, and no link of it may fail. */
function assertChainOffered(chains: Chain[], ids: string[], label: string) {
  const chain = chains.find((item) => item.api_ids.join() === ids.join());
  assert.ok(chain, `${label}: the chain is not offered`);
  assert.ok(chain.links.every((link) => link.verdict !== "fail"), `${label}: a link fails`);
  return chain;
}

// The steps Discovery returned for the client's wordings.
const CASES = {
  sentence: {
    text: "convert pdf to ubl xml, validate using Australian rules and send via email or peppol",
    steps: [
      { category: "Transformation", task: "convert pdf to ubl xml", input_format: "pdf", output_format: "ubl xml" },
      { category: "Validation", task: "validate using Australian rules", rule_set: "Australian rules" },
      { category: "Communication", task: "send via email or peppol" },
    ],
    senders: ["mailgun", "b2brouter"],
  },
  whiteboard: {
    text: "convert pdf to ubl, validate via AU rules & send via email",
    steps: [
      { category: "Transformation", task: "convert pdf to ubl", input_format: "pdf", output_format: "ubl" },
      { category: "Validation", task: "validate via AU rules", rule_set: "AU rules" },
      { category: "Communication", task: "send via email" },
    ],
    senders: ["mailgun"],
  },
  spoken: {
    text: "convert PDF to UBL, validate by Australian rules and send by email",
    steps: [
      { category: "Transformation", task: "convert PDF to UBL", input_format: "PDF", output_format: "UBL" },
      { category: "Validation", task: "validate by Australian rules", rule_set: "Australian rules" },
      { category: "Communication", task: "send by email" },
    ],
    senders: ["mailgun"],
  },
} as const;

for (const [name, item] of Object.entries(CASES)) {
  test(`client use case (${name}): the designated APIs are found for every step`, async (t) => {
    const { steps } = await compose(t, item.text, [...item.steps]);
    // No single API turns a PDF into UBL XML, so an extraction step comes first.
    assert.deepEqual(steps.map((step) => step.category), ["Transformation", "Transformation", "Validation", "Communication"]);
    assert.ok(steps.some((step) => step.system_added), "the conversion was not split into two steps");
    assert.deepEqual(steps.map((step) => step.candidate_issue), [null, null, null, null]);
    for (const extractor of ["upbrains", "ezzybills", "nanonets"] as const) {
      assert.ok(steps[0].candidate_ids.includes(ID[extractor]), `extraction: ${extractor} is missing`);
    }
    assert.ok(steps[1].candidate_ids.includes(ID.amit), "conversion: AmitTransform is missing");
    assert.ok(steps[2].candidate_ids.includes(ID.ess), "validation: ESS PINT A-NZ is missing");
    for (const sender of item.senders) assert.ok(steps[3].candidate_ids.includes(ID[sender]), `sending: ${sender} is missing`);
  });

  test(`client use case (${name}): the designated chain is offered and no link fails`, async (t) => {
    const { composition } = await compose(t, item.text, [...item.steps]);
    for (const sender of item.senders) {
      const chain = assertChainOffered(composition.chains, [ID.upbrains, ID.amit, ID.ess, ID[sender]], `${name} via ${sender}`);
      // Signed out, the field mapping between Upbrains and AmitTransform is
      // the one open decision; the validator and the sender pass.
      assert.deepEqual(chain.links.map((link) => link.verdict), ["pending_user", "pass", "pass"]);
    }
  });
}

test("client use case: an email-only request does not offer the Peppol sender", async (t) => {
  const { steps } = await compose(t, CASES.whiteboard.text, [...CASES.whiteboard.steps]);
  assert.ok(!steps[3].candidate_ids.includes(ID.b2brouter));
});

test("AU candidate filtering remains strict when a reviewed input contains extra XML format fields", async t => {
  const { steps, composition } = await compose(t, CASES.sentence.text, CASES.sentence.steps.map(step => step.category === "Validation"
    ? { ...step, input_format: "UBL XML", output_format: "UBL XML" } : step));
  const validation = steps.find(step => step.category === "Validation")!;
  const names = validation.candidate_ids.map(id => tables.apis.find(api => api.id === id)?.api_name);
  assert.deepEqual(new Set(names), new Set(["ESS SmartDocFlow Validate PINT A-NZ Invoice API", "ECOSIO Validator Validate XML Document API"]));
  assertChainOffered(composition.chains, [ID.upbrains, ID.amit, ID.ess, ID.mailgun], "AU formats do not remove the designated chain");
});

test("the reported goal wording reaches the designated Peppol chain without manual field edits", async t => {
  const text = "Can you please list down some possible business processes for the ‘Send an Invoice’ scenario, where the input is in PDF format, validated for the Australian rules, and is sent in UBL XML format via Peppol network.";
  const raw = { version: '1.0', input_text: text, unmatched: [], suggested_order: true, steps: [
    { order: 1, category: 'Transformation', task: 'Convert PDF to UBL XML', input_format: 'PDF', output_format: 'UBL XML', rule_set: null, candidate_ids: null },
    { order: 2, category: 'Validation', task: 'Validate invoice', input_format: null, output_format: null, rule_set: 'Australian rules', candidate_ids: null },
    { order: 3, category: 'Communication', task: 'Send invoice', input_format: null, output_format: null, rule_set: null, candidate_ids: null },
  ], source_evidence: [1, 2, 3].map(() => ({ step_quote: text, input_format: null, output_format: null, rule_set: null, suggested: true })) };
  const grounded: any = groundDiscoveryResult(raw, { mode: 'text', text }).process;
  const { steps, composition } = await compose(t, text, grounded.steps);
  assert.ok(steps.find(step => step.category === 'Validation')?.candidate_ids.includes(ID.ess));
  assert.ok(steps.find(step => step.category === 'Communication')?.candidate_ids.includes(ID.b2brouter));
  assertChainOffered(composition.chains, [ID.upbrains, ID.amit, ID.ess, ID.b2brouter], 'Goal wording without re-entry');
});

test("independent matching separates rule-review records from nominated API IDs", async t => {
  const route = liveSnapshot(t, true);
  const response = await route.POST(new Request("https://example.test/api/composition?mode=match", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: "1.0", input_text: "Validate using Australian rules", unmatched: [], steps: [{
      order: 1, category: "Validation", task: "Validate invoice using Australian rules", rule_set: "Australian rules", input_format: "UBL XML", output_format: null, candidate_ids: null,
    }] }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.steps[0].candidate_ids.includes(ID.ess));
  const otherEss = tables.apis.find(api => api.api_name === "ESS SmartDocFlow Validate EN 16931 UBL Invoice API")!;
  assert.ok(body.rule_review[0].some((api: { id: string; status: string }) => api.id === otherEss.id && api.status === "unverified"));
  for (const api of body.rule_review[0]) assert.ok(!body.steps[0].candidate_ids.includes(api.id));
});

test("client use case: sending before validating is refused", async (t) => {
  const route = liveSnapshot(t);
  const response = await route.POST(new Request("https://example.test/api/composition", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: "1.0", input_text: "convert pdf to ubl xml and send via email", unmatched: [],
      steps: [
        { order: 1, category: "Transformation", task: "convert pdf to ubl xml", input_format: "pdf", output_format: "ubl xml", rule_set: null, candidate_ids: null },
        { order: 2, category: "Communication", task: "send via email", input_format: null, output_format: null, rule_set: null, candidate_ids: null },
      ],
    }),
  }));
  const body = await response.json() as { composition: { issues: Array<{ code: string }>; chains: unknown[] } };
  assert.ok(body.composition.issues.length > 0);
  assert.deepEqual(body.composition.chains, []);
});

// From the client's BPMN diagram with an email / Peppol gateway, Discovery
// carries the previous step's format into the sending step. A sender delivers
// whatever document it is given, so the search must not require that format.
test("client use case (gateway diagram): a sending step that carries UBL XML still offers Mailgun and B2Brouter", {
  todo: "passes once PR #132 (senders whatever the input format) is merged; then remove this todo",
}, async (t) => {
  const { steps } = await compose(t, "BPMN diagram: convert PDF to UBL XML, validate using Australian rules, send via email or Peppol", [
    { category: "Transformation", task: "Convert PDF to UBL XML", input_format: "PDF", output_format: "UBL XML" },
    { category: "Validation", task: "Validate using Australian rules", input_format: "UBL XML", rule_set: "Australian rules" },
    { category: "Communication", task: "Send via email or Peppol", input_format: "UBL XML" },
  ]);
  assert.ok(steps[3].candidate_ids.includes(ID.mailgun), "sending: mailgun is missing");
  assert.ok(steps[3].candidate_ids.includes(ID.b2brouter), "sending: b2brouter is missing");
});
