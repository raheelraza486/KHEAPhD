import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck1, commonFormats } from "../../lib/checks/check1-format.ts";
import { runSchemaAvailability, selectSourceSchema } from "../../lib/checks/check2-schema.ts";
import { runAuth } from "../../lib/checks/check2-auth.ts";
import { api, pair, param, schema, side } from "./helpers.ts";

const req = (specs: string[] = ["invoiceNumber:string:req"]) => schema({ direction: "request" }, specs);
const res = (specs: string[] = ["invoiceNumber:string:req"], status_code = "200") => schema({ direction: "response", status_code }, specs);

// ---- Check 1 (Check Manual chapter 6)

test("1.1/1.3: canonical intersection passes; disjoint sets fail", () => {
  const ok = runCheck1(pair(side(api({ output_formats: ["application/json"] }), [res()]), side(api({ input_formats: ["JSON", "XML"] }), [req()])));
  assert.equal(ok.status, "pass");
  assert.deepEqual(ok.common_formats, ["JSON"]);
  const bad = runCheck1(pair(side(api({ output_formats: ["JSON"] }), [res()]), side(api({ input_formats: ["XML"] }), [req()])));
  assert.equal(bad.status, "fail");
  assert.equal(bad.reason_code, null);
});

test("1.1: a target accepting XML can parse UBL; unrecognised values are reported, not guessed", () => {
  assert.deepEqual(commonFormats(["UBL"], ["XML"]), ["UBL"]);
  const r = runCheck1(pair(side(api({ output_formats: ["UBL XML", "Weird"] }), [res()]), side(api({ input_formats: ["XML"] }), [req()])));
  assert.equal(r.status, "pass");
  assert.deepEqual(r.unrecognised_values, ["Weird"]);
});

test("1.2: no request schema + parameters -> not_voting with input_in_parameters; neither -> target_no_input_schema", () => {
  const nv = runCheck1(pair(side(api(), [res()]), side(api({ input_formats: [] }), [], [param("id")])));
  assert.equal(nv.status, "not_voting");
  assert.deepEqual(nv.flags, ["input_in_parameters"]);
  const un = runCheck1(pair(side(api(), [res()]), side(api({ input_formats: ["JSON"] }), [], [])));
  assert.equal(un.status, "unknown");
  assert.equal(un.reason_code, "target_no_input_schema");
});

test("1.3: empty or unrecognised formats on a side are undetermined with the side's reason code", () => {
  const s = runCheck1(pair(side(api({ output_formats: [] }), [res()]), side(api(), [req()])));
  assert.equal(s.reason_code, "source_no_format");
  const t = runCheck1(pair(side(api(), [res()]), side(api({ input_formats: ["nope"] }), [req()])));
  assert.equal(t.reason_code, "target_no_format");
});

// ---- 2.0 (Check Manual §7.3)

test("2.0 counts credential sets and flags credentials obtained from another call; never fails", () => {
  const same = runAuth(pair(side(api({ company_name: "V", authentication_method: "Token" })), side(api({ company_name: "V", authentication_method: "Token", authentication_details: "Bearer token obtained from /auth/login" }))));
  assert.equal(same.status, "pass");
  assert.equal(same.credential_sets, 1);
  assert.equal(same.auth_requires_prior_call, true);
  const none = runAuth(pair(side(api({ authentication_method: "None" })), side(api({ authentication_method: "None" }))));
  assert.equal(none.credential_sets, 0);
  const two = runAuth(pair(side(api({ company_name: "A", authentication_method: "OAuth2" })), side(api({ company_name: "B", authentication_method: "Basic" }))));
  assert.equal(two.credential_sets, 2);
});

// ---- 2.1 (Check Manual §7.4)

test("2.1 rule (3): smallest 2xx wins, others are alternatives, default only without 2xx, 4xx never", () => {
  const pick = selectSourceSchema([res([], "201"), res([], "200"), res([], "422"), res([], "default")]);
  assert.equal(pick.used?.status_code, "200");
  assert.deepEqual(pick.alternatives.map((s) => s.status_code), ["201"]);
  const dflt = selectSourceSchema([res([], "422"), res([], "default")]);
  assert.equal(dflt.used?.status_code, "default");
  assert.equal(selectSourceSchema([res([], "500")]).used, null);
});

test("2.1 rules (1)(2): missing sides are undetermined; 'Status Codes' output means no output body -> fail", () => {
  const noTarget = runSchemaAvailability(pair(side(api(), [res()]), side(api(), [], [])), false);
  assert.equal(noTarget.result.reason_code, "target_no_input_schema");
  const noSource = runSchemaAvailability(pair(side(api(), []), side(api(), [req()])), false);
  assert.equal(noSource.result.reason_code, "source_no_output_schema");
  const noBody = runSchemaAvailability(pair(side(api({ output_formats: ["Status Codes"] }), []), side(api(), [req()])), false);
  assert.equal(noBody.result.status, "fail");
  assert.equal(noBody.result.reason_code, "source_no_output_body");
});

test("2.1 rule (5): scalar body becomes (body); top-level anyOf is schema_unsupported_shape", () => {
  const scalar = schema({ direction: "response", raw: { type: "string" } }, []);
  const r = runSchemaAvailability(pair(side(api(), [scalar]), side(api(), [req()])), false);
  assert.equal(r.result.status, "pass");
  assert.deepEqual(r.sourceFields.map((f) => f.path), ["(body)"]);
  assert.equal(r.sourceFields[0].required, true);
  const anyOf = schema({ direction: "response", raw: { anyOf: [{ type: "object" }] } }, []);
  assert.equal(runSchemaAvailability(pair(side(api(), [anyOf]), side(api(), [req()])), false).result.reason_code, "schema_unsupported_shape");
});

test("2.1 rules (4)(6)(7): parameters are compared with the body when both exist; thin and unverified flags", () => {
  const r = runSchemaAvailability(pair(side(api(), [res(["a:string", "b:string", "c:string"])]), side(api(), [req(["x:string"])], [param("id")])), false);
  assert.deepEqual(r.result.target_inputs, ["body", "parameters"]);
  assert.deepEqual(r.targetFields.map((f) => f.path), ["x", "id"]);
  assert.ok(r.result.flags.includes("thin_schema"));
  assert.ok(r.result.flags.includes("schema_unverified"));
  const verified = schema({ direction: "response", verified_by: "someone" }, ["a:string", "b:string", "c:string"]);
  const v = runSchemaAvailability(pair(side(api(), [verified]), side(api(), [schema({ direction: "request", verified_by: "x" }, ["a:string", "b:string", "c:string"])])), false);
  assert.deepEqual(v.result.flags, []);
});

test("explicit schema selection controls the schemas used by Check 1 and Check 2", () => {
  const source200 = schema({ id: "source-200-json", direction: "response", status_code: "200", media_type: "application/json" }, ["automatic:string:req"]);
  const source201 = schema({ id: "source-201-xml", direction: "response", status_code: "201", media_type: "application/xml" }, ["selected:string:req"]);
  const targetJson = schema({ id: "target-json", direction: "request", media_type: "application/json" }, ["automatic:string:req"]);
  const targetXml = schema({ id: "target-xml", direction: "request", media_type: "application/xml" }, ["selected:string:req"]);

  const input = pair(
    side(api({ output_formats: ["JSON", "XML"] }), [source200, source201]),
    side(api({ input_formats: ["JSON", "XML"] }), [targetJson, targetXml]),
  );

  input.selectedSourceSchemaId = "source-201-xml";
  input.selectedTargetSchemaId = "target-xml";

  const check1 = runCheck1({
    ...input,
    source: { ...input.source, schemas: input.source.schemas.filter((item) => item.id === input.selectedSourceSchemaId) },
    target: { ...input.target, schemas: input.target.schemas.filter((item) => item.id === input.selectedTargetSchemaId) },
  });

  assert.equal(check1.format_selected, "XML");

  const result = runSchemaAvailability(
    {
      ...input,
      selectedFormat: "XML",
      source: { ...input.source, schemas: input.source.schemas.filter((item) => item.id === input.selectedSourceSchemaId) },
      target: { ...input.target, schemas: input.target.schemas.filter((item) => item.id === input.selectedTargetSchemaId) },
    },
    false,
  );

  assert.equal(result.result.source_schema_used?.schema_id, "source-201-xml");
  assert.equal(result.result.target_schema_used?.schema_id, "target-xml");
  assert.deepEqual(result.sourceFields.map((field) => field.path), ["selected"]);
  assert.deepEqual(result.targetFields.map((field) => field.path), ["selected"]);
});
