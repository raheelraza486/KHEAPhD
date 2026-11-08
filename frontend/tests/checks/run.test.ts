import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks } from "../../lib/checks/run.ts";
import { api, pair, param, schema, side } from "./helpers.ts";

const res = (specs: string[]) => schema({ direction: "response", status_code: "200", verified_by: "reviewer" }, specs);
const req = (specs: string[]) => schema({ direction: "request", verified_by: "reviewer" }, specs);

const SOURCE = ["invoiceNumber:string:req", "issueDate:string:req:date", "seller.name:string:req", "buyer.name:string:req", "totalAmount:number:req"];

test("end to end: all voting checks pass and unconstrained Check 3 does not vote", () => {
  const r = runChecks(pair(side(api({ company_name: "A" }), [res(SOURCE)]), side(api({ company_name: "B" }), [req(["invoice_no:string:req", "invoiceDate:string:req:date", "sellerName:string:req", "totalAmount:string"])])));
  assert.equal(r.check0.status, "pass");
  assert.deepEqual(r.check0.flags, ["same_operation_category"],);
  assert.equal(r.check3.status, "not_voting");
  assert.equal(r.check1.status, "pass");
  assert.equal(r.check2.schema.status, "pass");
  assert.equal(r.check2.semantics?.status, "complete");
  assert.equal(r.check2.types?.status, "pass");
  assert.equal(r.check2.required?.status, "pass");
  assert.equal(r.overall.overall, "pass");
  assert.equal(r.check2.types?.conversions.find((c) => c.target_path === "totalAmount")?.kind, "lossless");
});

test("overall: undetermined counts as fail with insufficient_info and the reason code", () => {
  const r = runChecks(pair(side(api({ output_formats: [] }), [res(SOURCE)]), side(api(), [req(["invoiceNumber:string:req"])])));
  assert.equal(r.overall.overall, "fail");
  assert.equal(r.overall.blocking_reason, "insufficient_info");
  assert.deepEqual(r.overall.blocking_checks, ["check1"]);
  assert.deepEqual(r.overall.reason_codes, ["source_no_format"]);
});

test("overall: a required field without a source waits for the user, then fails or passes by the choice", () => {
  const input = pair(side(api(), [res(SOURCE)]), side(api(), [req(["invoiceNumber:string:req", "dueDate:string:req"])]));
  const first = runChecks(input);
  assert.equal(first.overall.overall, "pending_user");
  assert.deepEqual(first.check2.semantics?.not_found.map((n) => n.target_path), ["dueDate"]);
  assert.ok(first.check2.types, "2.3 runs on the mappings known so far");
  assert.equal(first.check2.required, null, "2.4 waits for a complete mapping table");

  const none = runChecks({ ...input, choices: [{ target_path: "dueDate", chosen_source_path: null, option: "none" }] });
  assert.equal(none.overall.overall, "fail");
  assert.equal(none.overall.blocking_reason, "incompatible");
  assert.deepEqual(none.overall.reason_codes, ["required_field_uncovered"]);

  const external = runChecks({ ...input, choices: [{ target_path: "dueDate", chosen_source_path: null, option: "external" }] });
  assert.equal(external.overall.overall, "pass");
  assert.deepEqual(external.check2.required?.external_inputs, ["dueDate"]);
});

test("overall: a pair blocked by Check 1 is not sent to the user", () => {
  const r = runChecks(pair(side(api({ output_formats: ["XML"] }), [res(SOURCE)]), side(api({ input_formats: ["JSON"] }), [req(["dueDate:string:req"])])));
  assert.equal(r.check1.status, "fail");
  assert.equal(r.overall.overall, "fail");
  assert.equal(r.overall.blocking_reason, "incompatible");
});

test("parameters-only target: Check 1 does not vote and the parameters are compared", () => {
  const r = runChecks(pair(side(api(), [res(["invoiceNumber:string:req", "status:string"])]), side(api({ input_formats: [] }), [], [param("invoiceNumber")])));
  assert.equal(r.check1.status, "not_voting");
  assert.deepEqual(r.check2.schema.target_inputs, ["parameters"]);
  assert.equal(r.check2.semantics?.mappings[0]?.source_path, "invoiceNumber");
  assert.equal(r.overall.overall, "pass");
});

test("hollow pass is flagged, and a target with no fields and no parameters passes without the flag", () => {
  const hollow = runChecks(pair(side(api(), [res(SOURCE)]), side(api(), [req(["invoiceNumber:string"])])));
  assert.ok(hollow.check2.required?.flags.includes("required_info_missing"));
  assert.equal(hollow.overall.overall, "pass");
  const confirmedOptional = runChecks(pair(
    side(api(), [res(SOURCE)]),
    side(api(), [schema({ direction: "request", verified_by: "reviewer", raw: { type: "object", required: [] } }, ["invoiceNumber:string"])]),
  ));
  assert.deepEqual(confirmedOptional.check2.required?.flags, []);
  const empty = runChecks(pair(side(api(), [res(SOURCE)]), side(api(), [req([])])));
  assert.deepEqual(empty.check2.required?.flags, []);
  assert.equal(empty.overall.overall, "pass");
});

test("candidates handed to the page are capped at 8", () => {
  const many = Array.from({ length: 12 }, (_, i) => `p${i}.invoiceNumber:string`);
  const r = runChecks(pair(side(api(), [res(many)]), side(api(), [req(["invoiceNumber:string:req"])])));
  assert.equal(r.overall.overall, "pending_user");
  assert.equal(r.check2.semantics?.ambiguous[0].candidates.length, 8);
});

test("a saved choice is applied only while the schemas it was given against are unchanged", () => {
  const source = side(api(), [schema({ direction: "response", status_code: "200", verified_by: "r", content_hash: "src-v1" }, SOURCE)]);
  const target = side(api(), [schema({ direction: "request", verified_by: "r", content_hash: "tgt-v1" }, ["invoiceNumber:string:req", "dueDate:string:req"])]);
  const choice = { target_path: "dueDate", chosen_source_path: null, option: "external" as const };
  const live = runChecks({ ...pair(source, target), choices: [{ ...choice, source_content_hash: "src-v1", target_content_hash: "tgt-v1" }] });
  assert.equal(live.overall.overall, "pass");
  assert.deepEqual(live.check2.semantics?.stale_choices, []);
  const stale = runChecks({ ...pair(source, target), choices: [{ ...choice, source_content_hash: "src-v0", target_content_hash: "tgt-v1" }] });
  assert.equal(stale.overall.overall, "pending_user");
  assert.deepEqual(stale.check2.semantics?.stale_choices, [{ target_path: "dueDate", reason: "source_schema_changed" }]);
  const noHash = runChecks({ ...pair(source, target), choices: [choice] });
  assert.equal(noHash.overall.overall, "pass", "a choice without hashes is applied as is");
});

test("answer history: agreed applies, conflict waits for an administrator, admin answer is final", () => {
  const input = pair(side(api(), [res(SOURCE)]), side(api(), [req(["invoiceNumber:string:req", "dueDate:string:req"])]));
  const a = { target_path: "dueDate", chosen_source_path: "issueDate", option: "candidate" as const, chosen_by: "A", chosen_at: "2026-09-17T01:00:00Z" };
  const b = { ...a, chosen_source_path: null, option: "external" as const, chosen_by: "B", chosen_at: "2026-09-17T02:00:00Z" };

  const agreed = runChecks({ ...input, choices: [a, { ...a, chosen_by: "C", chosen_at: "2026-09-17T03:00:00Z" }] });
  // issueDate -> dueDate differs in representation (S-7); since V2.1 that is a
  // notice for a transformation step, not a Check 3 vote.
  assert.equal(agreed.overall.overall, "pass");
  assert.equal(agreed.check3.status, "not_voting");
  assert.ok(agreed.check3.flags.includes("value_mapping_required"));
  assert.deepEqual(agreed.check3.representation_differs.map((r) => r.source_path), ["issueDate"]);
  assert.deepEqual(agreed.check2.semantics?.applied, [{ target_path: "dueDate", state: "agreed", option: "candidate", chosen_source_path: "issueDate" }]);
  assert.deepEqual(agreed.check2.semantics?.conflicts, []);

  const conflict = runChecks({ ...input, choices: [a, b] });
  assert.equal(conflict.overall.overall, "pending_admin");
  assert.equal(conflict.check2.required, null);
  assert.equal(conflict.check2.semantics?.conflicts.length, 1);
  assert.deepEqual(conflict.check2.semantics?.conflicts[0].answers.map((x) => [x.source, x.option, x.chosen_by]), [["user", "candidate", "A"], ["user", "external", "B"]]);
  assert.ok(!conflict.check2.semantics?.not_found.some((n) => n.target_path === "dueDate"), "a field in conflict is not asked again");

  const resolved = runChecks({ ...input, choices: [a, b, { ...b, kind: "admin" as const, chosen_by: "admin", chosen_at: "2026-09-17T04:00:00Z" }] });
  assert.equal(resolved.overall.overall, "pass");
  assert.deepEqual(resolved.check2.semantics?.applied, [{ target_path: "dueDate", state: "resolved", option: "external", chosen_source_path: null }]);
  assert.deepEqual(resolved.check2.required?.external_inputs, ["dueDate"]);
});

test("answer history: a user answer that disagrees with the registry's automatic match is a conflict; an admin answer overrides the registry", () => {
  const input = pair(side(api(), [res(SOURCE)]), side(api(), [req(["invoiceNumber:string:req"])]));
  const auto = runChecks(input);
  assert.equal(auto.check2.semantics?.mappings[0]?.source_path, "invoiceNumber");
  const user = { target_path: "invoiceNumber", chosen_source_path: "issueDate", option: "candidate" as const, chosen_by: "A", chosen_at: "2026-09-17T01:00:00Z" };
  const clash = runChecks({ ...input, choices: [user] });
  assert.equal(clash.overall.overall, "pending_admin");
  assert.deepEqual(clash.check2.semantics?.conflicts[0].answers.map((x) => [x.source, x.chosen_source_path]), [["registry", "invoiceNumber"], ["user", "issueDate"]]);
  const same = runChecks({ ...input, choices: [{ ...user, chosen_source_path: "invoiceNumber" }] });
  assert.equal(same.overall.overall, "pass");
  assert.equal(same.check2.semantics?.applied[0]?.state, "agreed");
  const admin = runChecks({ ...input, choices: [user, { ...user, kind: "admin" as const, chosen_by: "admin", chosen_at: "2026-09-17T02:00:00Z" }] });
  assert.equal(admin.overall.overall, "pass");
  assert.equal(admin.check3.status, "not_voting");
  assert.ok(admin.check3.flags.includes("value_mapping_required"));
  assert.equal(admin.check2.semantics?.mappings[0]?.source_path, "issueDate");
  assert.equal(admin.check2.semantics?.mappings[0]?.origin, "user_choice");
});

test("a conflict on a pair already blocked by Check 1 does not reach the administrator", () => {
  const input = pair(side(api({ output_formats: ["XML"] }), [res(SOURCE)]), side(api({ input_formats: ["JSON"] }), [req(["dueDate:string:req"])]));
  const a = { target_path: "dueDate", chosen_source_path: "issueDate", option: "candidate" as const, chosen_by: "A", chosen_at: "1" };
  const b = { ...a, chosen_source_path: null, option: "external" as const, chosen_by: "B", chosen_at: "2" };
  const r = runChecks({ ...input, choices: [a, b] });
  assert.equal(r.overall.overall, "fail");
  assert.equal(r.check2.semantics?.status, "pending_admin", "the conflict is still recorded for later");
});

test("runChecks keeps automatic schema selection when IDs are absent", () => {
  const sourceDefault = schema({ id: "source-default", direction: "response", status_code: "200", media_type: "application/json" }, ["invoiceNumber:string:req"]);
  const targetDefault = schema({ id: "target-default", direction: "request", media_type: "application/json" }, ["invoiceNumber:string:req"]);
  const report = runChecks(pair(
    side(api({ output_formats: ["JSON"] }), [sourceDefault]),
    side(api({ input_formats: ["JSON"] }), [targetDefault]),
  ));
  assert.equal(report.check2.schema.source_schema_used?.schema_id, "source-default");
  assert.equal(report.check2.schema.target_schema_used?.schema_id, "target-default");
  assert.equal(report.overall.overall, "pass");
});

test("runChecks uses the schemas explicitly selected by the workspace", () => {
  const sourceDefault = schema({ id: "source-default", direction: "response", status_code: "200", media_type: "application/json" }, ["defaultField:string:req"]);
  const sourceSelected = schema({ id: "source-selected", direction: "response", status_code: "201", media_type: "application/json" }, ["selectedField:string:req"]);
  const targetDefault = schema({ id: "target-default", direction: "request", media_type: "application/json" }, ["defaultField:string:req"]);
  const targetSelected = schema({ id: "target-selected", direction: "request", media_type: "application/json" }, ["selectedField:string:req"]);

  const input = pair(
    side(api({ output_formats: ["JSON"] }), [sourceDefault, sourceSelected]),
    side(api({ input_formats: ["JSON"] }), [targetDefault, targetSelected]),
  );

  input.selectedSourceSchemaId = "source-selected";
  input.selectedTargetSchemaId = "target-selected";
  const report = runChecks(input);

  assert.equal(report.check2.schema.source_schema_used?.schema_id, "source-selected");
  assert.equal(report.check2.schema.target_schema_used?.schema_id, "target-selected");
  assert.deepEqual(
    report.check2.semantics?.not_found.map((field) => [
      field.target_path,
      field.suggestions.map((suggestion) => suggestion.source_path),
    ]),
    [["selectedField", ["selectedField"]]],
  );
  assert.equal(
    JSON.stringify(report.check2.semantics).includes("defaultField"),
    false,
  );
});
