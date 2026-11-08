import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSchema, buildIndex } from "../../lib/compatibility/normalize.ts";
import {
  compareEnum,
  compareSchemas,
  classifyIssues,
  makeIssue,
  DIRECT,
  MAPPING,
  INCOMPATIBLE,
} from "../../lib/compatibility/engine.ts";

const type = (t: string) => ({ type: t });

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

// ---- normalisation

test("normalizeSchema: no required list means every property is required; properties and required are sorted", () => {
  const n = normalizeSchema({ type: "object", properties: { b: type("string"), a: type("string") } });
  assert.deepEqual((n as { required: string[] }).required, ["a", "b"]);
  // sorted on purpose: jsonb storage does not keep key order, and the engine's
  // greedy claiming of source paths depends on visiting order
  assert.deepEqual(Object.keys((n as { properties: object }).properties), ["a", "b"]);
});

test("normalizeSchema: an explicit required list is kept (and sorted), XML attributes are always required", () => {
  const n = normalizeSchema({
    type: "object",
    properties: { z: type("string"), a: type("string") },
    attributes: { id: "string" },
    required: ["z"],
  });
  assert.deepEqual((n as { required: string[] }).required, ["@id", "z"]);
  assert.equal(((n as { properties: Record<string, { type: string }> }).properties)["@id"].type, "string");
});

test("normalizeSchema: XML extractor output {root, schema} becomes the schema plus xml_root", () => {
  const n = normalizeSchema({ root: "Invoice", schema: { type: "object", properties: { ID: type("string") } } });
  assert.equal((n as { xml_root: string }).xml_root, "Invoice");
  assert.equal((n as { type: string }).type, "object");
});

test("normalizeSchema: allOf branches are merged into one object (properties and required unioned, nested allOf too)", () => {
  // Stored schemas keep allOf as written; only $ref is inlined before storage.
  const n = normalizeSchema({
    allOf: [
      { type: "object", properties: { id: type("string") }, required: ["id"] },
      { allOf: [{ properties: { total: type("number") }, required: ["total"] }] },
      { properties: { note: type("string") } },
    ],
    description: "Invoice",
  }) as { type: string; properties: Record<string, unknown>; required: string[]; description?: string };
  assert.equal(n.type, "object");
  assert.deepEqual(Object.keys(n.properties), ["id", "note", "total"]);
  assert.deepEqual(n.required, ["id", "total"]);
  assert.equal(n.description, "Invoice");
});

test("allOf on the target side: fields that arrive through allOf are required fields like any other", () => {
  const r = compareSchemas(
    { type: "object", properties: { id: type("string") } },
    { allOf: [{ type: "object", properties: { id: type("string") } }, { properties: { total: type("number") }, required: ["total"] }] },
    "src",
    "tgt",
  );
  assert.equal(r.compatibility, INCOMPATIBLE);
  assert.ok(r.issues.some((i) => i.code === "missing_required_field" && i.target_path === "total"));
});

test("buildIndex: every node gets a path, arrays use [] and the root leaf is 'root'", () => {
  const n = normalizeSchema({
    type: "object",
    properties: { items: { type: "array", items: { type: "object", properties: { price: type("number") } } } },
  });
  const paths = buildIndex(n, "$").map((e) => `${e.path}:${e.leaf}`);
  assert.deepEqual(paths, ["$:root", "items:items", "items[]:items", "items[].price:price"]);
});

// ---- enums

test("compareEnum: no overlap is blocking and the message uses Python repr", () => {
  const issue = compareEnum({ type: "string", enum: ["A"] }, { type: "string", enum: ["B"] }, "$.s", "$.t");
  assert.equal(issue?.code, "enum_mismatch");
  assert.equal(issue?.kind, "blocking");
  assert.equal(issue?.message, "Source enum values ['A'] do not overlap with target enum values ['B'].");
});

test("compareEnum: partial overlap needs value translation and names the values the target rejects", () => {
  const issue = compareEnum({ type: "string", enum: ["S", "Z", "E", "AE"] }, { type: "string", enum: ["S", "Z"] }, "$.s", "$.t");
  assert.equal(issue?.code, "enum_mapping_required");
  assert.equal(issue?.kind, "mapping");
  assert.equal(
    issue?.message,
    "Source enum contains values outside the target enum. Value translation may be required. Values not accepted by the target: ['AE', 'E'].",
  );
});

test("compareEnum: subset is fine, and a target without enum is skipped", () => {
  assert.equal(compareEnum({ type: "string", enum: ["A"] }, { type: "string", enum: ["A", "B"] }, "$.s", "$.t"), null);
  assert.equal(compareEnum({ type: "string", enum: ["A"] }, { type: "string" }, "$.s", "$.t"), null);
});

// ---- classification

test("classifyIssues picks the worst kind present", () => {
  const blocking = makeIssue("type_mismatch", "blocking", "error", "", "", "m", "s");
  const mapping = makeIssue("field_mapping_required", "mapping", "warning", "", "", "m", "s");
  const info = makeIssue("exact_path_match", "info", "information", "", "", "m", "s");
  assert.equal(classifyIssues([blocking, mapping, info]), INCOMPATIBLE);
  assert.equal(classifyIssues([mapping, info]), MAPPING);
  assert.equal(classifyIssues([info]), DIRECT);
  assert.equal(classifyIssues([]), DIRECT);
});

// ---- compareSchemas end to end

test("exact name matches surface as info-level issues and stay directly compatible", () => {
  const r = compareSchemas(
    { type: "object", properties: { date: type("string") } },
    { type: "object", properties: { date: type("string") } },
    "src",
    "tgt",
  );
  assert.ok(r.issues.some((i) => i.code === "exact_path_match"));
  assert.equal(r.compatibility, DIRECT);
});

test("a missing required field with no candidate makes the comparison incompatible", () => {
  const r = compareSchemas(
    { type: "object", properties: {} },
    { type: "object", properties: { total: type("number") }, required: ["total"] },
    "src",
    "tgt",
  );
  assert.equal(r.compatibility, INCOMPATIBLE);
});

test("a field reachable only through type conversion is mapping, not incompatible", () => {
  const r = compareSchemas(
    { type: "object", properties: { amount: type("string") } },
    { type: "object", properties: { amount: type("number") } },
    "src",
    "tgt",
  );
  assert.equal(r.compatibility, MAPPING);
  assert.ok(r.issues.some((i) => i.code === "type_conversion_required"));
});

test("object vs array produces array_to_object_mapping and keeps comparing the items", () => {
  const r = compareSchemas(
    { type: "array", items: { type: "object", properties: { id: type("string") } } },
    { type: "object", properties: { id: type("string") } },
    "src",
    "tgt",
  );
  assert.equal(r.issues[0].code, "array_to_object_mapping");
  assert.equal(r.compatibility, MAPPING);
});

test("a single value where an array is expected is singleton_array_mapping when castable", () => {
  const r = compareSchemas(
    { type: "object", properties: { tags: type("string") } },
    { type: "object", properties: { tags: { type: "array", items: type("string") } } },
    "src",
    "tgt",
  );
  assert.ok(r.issues.some((i) => i.code === "singleton_array_mapping"));
  assert.equal(r.compatibility, MAPPING);
});

test("oneOf: the best-scoring variant pair is chosen", () => {
  const r = compareSchemas(
    { oneOf: [{ type: "object", properties: {} }, { type: "object", properties: { total: type("number") } }] },
    { type: "object", properties: { total: type("number") }, required: ["total"] },
    "src",
    "tgt",
  );
  assert.equal(r.compatibility, DIRECT);
  assert.deepEqual(r.chosen_variant, { source_variant_index: 1, target_variant_index: 0 });
});

// ---- acceptance case: Ecosio output -> Zoho input (client demo files)

test("Ecosio -> Zoho: the demo pair reproduces the upstream engine's verdict", () => {
  const ecosio = fixture("ecosio-invoice-api.json");
  const zoho = fixture("zoho-invoice.json");
  const sourceSchema = ecosio.paths["/invoices/{id}"].get.responses["200"].content["application/json"].schema;
  const targetSchema = zoho.paths["/invoices"].post.requestBody.content["application/json"].schema;

  const r = compareSchemas(sourceSchema, targetSchema, "EcosioInvoiceAPI", "Zoho Invoice");

  assert.equal(r.compatibility, INCOMPATIBLE);
  assert.deepEqual(r.summary, {
    compatibility_label: "Incompatible",
    blocking_issues: 2,
    mapping_issues: 1,
    informational_issues: 6,
    issue_count: 9,
  });

  const brief = r.issues.map((i) => [i.code, i.source_path, i.target_path, i.match_tier ?? null]);
  assert.deepEqual(brief, [
    ["exact_path_match", "customer_id", "customer_id", null],
    ["exact_path_match", "date", "date", null],
    ["field_mapping_required", "items", "line_items", 2],
    ["missing_required_field", "items[]", "line_items[].item_id", null],
    ["exact_path_match", "items[].quantity", "line_items[].quantity", null],
    ["missing_required_field", "items[]", "line_items[].rate", null],
    ["extra_source_field", "items[].name", "line_items[]", null],
    ["extra_source_field", "items[].price", "line_items[]", null],
    ["extra_source_field", "currency_code", "$", null],
  ]);
});

// ---- additions beyond the upstream engine

test("property order no longer changes the verdict: the same pair in two key orders gives identical issues", () => {
  const src = { type: "object", properties: { invoice_date: type("string"), invoiceDateNote: type("string") } };
  const tgtA = { type: "object", properties: { invoiceDate: type("string"), note: type("string") } };
  const tgtB = { type: "object", properties: { note: type("string"), invoiceDate: type("string") } };
  const a = compareSchemas(src, tgtA, "s", "t").issues.map((i) => [i.code, i.source_path, i.target_path]);
  const b = compareSchemas(src, tgtB, "s", "t").issues.map((i) => [i.code, i.source_path, i.target_path]);
  assert.deepEqual(a, b);
});

test("format: same type but different value convention needs a conversion, not a cast", () => {
  const r = compareSchemas(
    { type: "object", properties: { date: { type: "string", format: "date-time" } } },
    { type: "object", properties: { date: { type: "string", format: "date" } } },
    "src",
    "tgt",
  );
  const f = r.issues.find((i) => i.code === "format_conversion_required");
  assert.ok(f);
  assert.equal(f?.kind, "mapping");
  assert.equal(f?.message, "Source value format 'date-time' differs from target value format 'date'; a value conversion is required.");
  assert.equal(r.compatibility, MAPPING);
});

test("format: only flagged when both sides declare one", () => {
  const r = compareSchemas(
    { type: "object", properties: { id: { type: "string" } } },
    { type: "object", properties: { id: { type: "string", format: "uuid" } } },
    "src",
    "tgt",
  );
  assert.equal(r.issues.some((i) => i.code === "format_conversion_required"), false);
  assert.equal(r.compatibility, DIRECT);
});

// ---- what a mapping issue records about its own evidence
//
// Two facts a mapping issue used to leave unsaid: whether the choice was
// forced, and whether anything depends on it. Both are recorded and neither
// changes the verdict -- the point of writing them down is that a policy about
// what a verdict may claim can then be stated at all. These tests fix that
// separation: the numbers must be right, and the level must not move.

test("a forced mapping records one alternative", () => {
  const r = compareSchemas(
    { type: "object", properties: { invoice_date: type("string") } },
    { type: "object", properties: { invoiceDate: type("string") } },
    "src",
    "tgt",
  );
  const mapping = r.issues.find((i) => i.code === "field_mapping_required");
  assert.ok(mapping, "expected a field mapping");
  assert.equal(mapping.match_alternatives, 1);
  assert.equal(r.compatibility, MAPPING);
});

test("a tie records how many source fields were equally good, and does not change the level", () => {
  // Two source dates each contain the target's tokens and nothing matches its
  // name outright, so both qualify at the same tier and the winner is whichever
  // path is shorter -- which is not a statement about meaning. (A field named
  // end_date would have won at tier 0 on its own and there would be no tie,
  // which is the distinction this records: the tie has to be at the *winning*
  // tier to matter.)
  const r = compareSchemas(
    {
      type: "object",
      properties: {
        turnover_end_date: type("string"),
        historical_end_date: type("string"),
      },
    },
    { type: "object", properties: { endDate: type("string") } },
    "src",
    "tgt",
  );
  const mapping = r.issues.find((i) => i.code === "field_mapping_required");
  assert.ok(mapping, "expected a field mapping");
  assert.ok(
    (mapping.match_alternatives ?? 0) >= 2,
    `expected a tie, got ${mapping.match_alternatives}`,
  );
  // Recorded, not acted on.
  assert.equal(r.compatibility, MAPPING);
});

test("a mapping says whether the target field it satisfies is required", () => {
  const required = compareSchemas(
    { type: "object", properties: { invoice_total: type("number") } },
    { type: "object", properties: { invoiceTotal: type("number") }, required: ["invoiceTotal"] },
    "src",
    "tgt",
  );
  const onRequired = required.issues.find((i) => i.code === "field_mapping_required");
  assert.ok(onRequired);
  assert.equal(onRequired.target_required, true);

  // normalizeSchema treats an absent `required` list as "every property is
  // required", so an optional field has to be stated by listing another one.
  const optional = compareSchemas(
    { type: "object", properties: { invoice_total: type("number"), id: type("string") } },
    {
      type: "object",
      properties: { invoiceTotal: type("number"), id: type("string") },
      required: ["id"],
    },
    "src",
    "tgt",
  );
  const onOptional = optional.issues.find((i) => i.code === "field_mapping_required");
  assert.ok(onOptional);
  assert.equal(onOptional.target_required, false);
});

test("the conversion codes carry neither field: they transform a value, not decide which value it is", () => {
  const r = compareSchemas(
    { type: "object", properties: { amount: type("string") } },
    { type: "object", properties: { amount: type("number") } },
    "src",
    "tgt",
  );
  const conversion = r.issues.find((i) => i.code === "type_conversion_required");
  assert.ok(conversion);
  assert.equal(conversion.match_alternatives, undefined);
  assert.equal(conversion.target_required, undefined);
});
