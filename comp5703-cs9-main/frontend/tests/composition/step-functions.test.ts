import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { generateWorkflow, type LambdaTemplate, type WorkflowApi } from "../../lib/composition/step-functions.ts";
import { AMIT, B2BROUTER, CLIENT_CHAIN, ESS, MAILGUN, UPBRAINS } from "./fixtures/workflow-chain.ts";

function api(id: string, category: string, over: Partial<WorkflowApi> = {}): WorkflowApi {
  return {
    id,
    api_name: `${id} API`,
    company_name: `${id[0].toUpperCase()}${id.slice(1)}`,
    category,
    api_endpoint: `https://${id}.example/v1/run`,
    http_method: "POST",
    authentication_method: "None",
    authentication_details: "",
    ...over,
  };
}

/** A chain without schemas: extract → convert → validate → send. */
const CATALOGUE = [
  api("extract", "Transformation", { authentication_method: "Token", input_formats: ["PDF"], output_formats: ["JSON"] }),
  api("amit", "Transformation", { company_name: "AmitTransform", output_formats: ["XML"] }),
  api("ess", "Validation", { company_name: "EB Software Services (ESS)", authentication_method: "API Key", authentication_details: "API key in the x-api-key header." }),
  api("mailgun", "Communication", { company_name: "Mailgun", authentication_method: "Basic" }),
  api("other", "Other"),
];

function workflow(ids: string[], catalogue: readonly WorkflowApi[] = CATALOGUE, status?: "feasible" | "needs_decision", name?: string) {
  const result = generateWorkflow({ api_ids: ids, status }, catalogue, { name });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result.workflow;
}

type Bundle = ReturnType<typeof workflow>;
const lambdaOf = (bundle: Bundle, state: string): LambdaTemplate => {
  const found = bundle.lambdas.find((lambda) => lambda.state_name === state);
  assert.ok(found, `no function for ${state}: ${bundle.lambdas.map((lambda) => lambda.state_name).join(", ")}`);
  return found;
};
const source = (bundle: Bundle, state: string, file = "lambda_function.py") =>
  lambdaOf(bundle, state).files.find((item) => item.path === file)!.content;

test("the diagram: an input check, one Lambda step per API named after it, Check validation, and the three exits", () => {
  const { definition } = workflow(["extract", "amit", "ess", "mailgun"]);
  assert.equal(definition.StartAt, "Check workflow input");
  assert.deepEqual(Object.keys(definition.States), [
    "Check workflow input", "Workflow input rejected",
    "01 extract", "02 amit", "03 ess", "Check validation", "04 mailgun",
    "Validation failed", "Composition failed",
  ]);
  const s = definition.States;
  assert.equal((s["Check workflow input"].Choices as Array<{ Next: string }>)[0].Next, "01 extract");
  assert.equal(s["Check workflow input"].Default, "Workflow input rejected");
  assert.equal(s["Workflow input rejected"].Error, "WorkflowInputRejected");
  assert.equal(s["03 ess"].Next, "Check validation");
  assert.equal(s["Check validation"].Default, "Validation failed");
  assert.equal((s["Check validation"].Choices as Array<{ Next: string }>)[0].Next, "04 mailgun");
  assert.equal(s["04 mailgun"].End, true);
  assert.deepEqual(s["Validation failed"], { Type: "Fail", Error: "ValidationFailed", Cause: "The invoice did not pass validation." });
  assert.deepEqual(s["Composition failed"], { Type: "Fail", Comment: "A step failed; its error and cause are kept.", ErrorPath: "$.error.Error", CausePath: "$.error.Cause" });
});

test("each step invokes its own Lambda function, whose ARN the template fills in; errors go to Composition failed", () => {
  const { definition, lambdas, template } = workflow(["extract", "amit", "ess", "mailgun"]);
  const workflowResource = (template.Resources as Record<string, { Properties: Record<string, unknown> }>).Workflow.Properties;
  const substitutions = workflowResource.DefinitionSubstitutions as Record<string, unknown>;
  for (const lambda of lambdas) {
    const state = definition.States[lambda.state_name];
    assert.equal(state.Resource, "arn:aws:states:::lambda:invoke", "the console draws a Lambda step");
    assert.equal((state.Parameters as Record<string, unknown>).FunctionName, `\${${lambda.substitution}}`);
    assert.equal(lambda.arn_placeholder, `\${${lambda.substitution}}`, "the workflow canvas finds a step's function by it");
    assert.deepEqual(substitutions[lambda.substitution], { "Fn::GetAtt": [lambda.logical_id, "Arn"] });
    assert.deepEqual(state.Catch, [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "Composition failed" }]);
    assert.match(lambda.function_name, /^bp[0-9a-f]{6}-\d\d-[A-Za-z0-9]+$/);
    assert.ok(lambda.function_name.length <= 64);
  }
  assert.deepEqual(lambdas.map((lambda) => lambda.function_name.slice(9)), ["01-Extract", "02-Amit", "03-Ess", "04-Mailgun"]);
  assert.doesNotMatch(JSON.stringify(definition), /arn:aws:lambda/);
});

test("results are kept under their own keys and each step reads the document it needs", () => {
  const { States: s } = workflow(["extract", "amit", "ess", "mailgun"]).definition;
  assert.equal(s["01 extract"].InputPath, undefined, "the first step reads the execution input");
  assert.equal(s["01 extract"].ResultPath, "$", "the first result replaces the input, so the PDF is not carried on");
  assert.deepEqual(s["01 extract"].ResultSelector, { transformed: { "document.$": "$.Payload.document" }, "options.$": "$.Payload.options" });
  assert.equal(s["02 amit"].InputPath, "$.transformed");
  assert.equal(s["02 amit"].ResultPath, "$.transformed2");
  assert.equal(s["03 ess"].InputPath, "$.transformed2");
  assert.equal(s["03 ess"].ResultPath, "$.validation");
  assert.deepEqual(s["03 ess"].ResultSelector, { "isValid.$": "$.Payload.isValid", "report.$": "$.Payload.report" });
  assert.equal(s["04 mailgun"].InputPath, "$.transformed2", "the sender gets the converted document, not the report");
  assert.equal(s["04 mailgun"].ResultPath, "$.delivery");
});

test("Check validation passes only a boolean true; the input check wants a document", () => {
  const { definition } = workflow(["amit", "ess", "mailgun"]);
  const choice = (definition.States["Check validation"].Choices as Array<{ And: Array<Record<string, unknown>> }>)[0];
  assert.deepEqual(choice.And, [
    { Variable: "$.validation.isValid", IsPresent: true },
    { Variable: "$.validation.isValid", IsBoolean: true },
    { Variable: "$.validation.isValid", BooleanEquals: true },
  ]);
  const input = (definition.States["Check workflow input"].Choices as Array<{ And: unknown[] }>)[0];
  assert.deepEqual(input.And, [{ Variable: "$.document", IsPresent: true }, { Not: { Variable: "$.document", IsNull: true } }]);
});

test("a chain ending with a validator ends in Done; without a validator there is no Check validation", () => {
  const ending = workflow(["amit", "ess"]).definition;
  assert.equal((ending.States["Check validation"].Choices as Array<{ Next: string }>)[0].Next, "Done");
  assert.equal(ending.States.Done.Type, "Succeed");
  assert.deepEqual(Object.keys(workflow(["extract", "amit"]).definition.States), [
    "Check workflow input", "Workflow input rejected", "01 extract", "02 amit", "Composition failed",
  ]);
});

test("JSON and YAML carry the same definition, and template.yaml the same template, without YAML aliases", () => {
  const bundle = workflow(["amit", "ess", "mailgun"], CATALOGUE, undefined, "SendInvoice-BP");
  assert.equal(bundle.name, "SendInvoice-BP");
  assert.deepEqual(JSON.parse(bundle.json), bundle.definition);
  assert.deepEqual(parseYaml(bundle.yaml), bundle.definition);
  assert.doesNotMatch(bundle.yaml, /[&*]a\d/);
  assert.match(bundle.template_yaml, /^AWSTemplateFormatVersion: "2010-09-09"$/m);
  assert.deepEqual(parseYaml(bundle.template_yaml), bundle.template);
  assert.doesNotMatch(bundle.template_yaml, /[&*]a\d/);
  assert.equal(workflow(["amit", "ess", "mailgun"]).name, "BP-AmitTransform-ESS-Mailgun", "the default name lists the companies");
});

test("the SAM template: one function per step, the state machine, its invoke policies and the secrets' read policies", () => {
  const bundle = workflow(["extract", "amit", "ess", "mailgun"]);
  const template = bundle.template as Record<string, any>;
  assert.equal(template.Transform, "AWS::Serverless-2016-10-31");
  const functions = Object.entries(template.Resources).filter(([, resource]: [string, any]) => resource.Type === "AWS::Serverless::Function");
  assert.deepEqual(functions.map(([id]) => id), ["Step01Function", "Step02Function", "Step03Function", "Step04Function"]);
  const ess = template.Resources.Step03Function.Properties;
  assert.equal(ess.CodeUri, `lambdas/${bundle.lambdas[2].function_name}/`);
  assert.equal(ess.Runtime, "python3.12");
  assert.equal(ess.Timeout, 60);
  assert.deepEqual(ess.Policies, [{
    AWSSecretsManagerGetSecretValuePolicy: { SecretArn: { "Fn::Sub": "arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:bp-builder/ess-*" } },
  }]);
  assert.equal(template.Resources.Step02Function.Properties.Policies, undefined, "an API without authentication reads no secret");
  const machine = template.Resources.Workflow;
  assert.equal(machine.Type, "AWS::Serverless::StateMachine");
  assert.equal(machine.Properties.DefinitionUri, "statemachine.asl.json");
  assert.deepEqual(machine.Properties.Policies.map((policy: any) => policy.LambdaInvokePolicy.FunctionName.Ref), functions.map(([id]) => id));
  assert.deepEqual(template.Outputs.StateMachineArn.Value, { Ref: "Workflow" });
  assert.deepEqual(bundle.secrets.map((secret) => secret.name), ["bp-builder/extract", "bp-builder/ess", "bp-builder/mailgun"]);
});

test("Python functions: Python 3.12, the credential from Secrets Manager, document in, document out", () => {
  const bundle = workflow(["extract", "ess", "mailgun"]);
  const [extract, ess] = bundle.lambdas;
  assert.equal(extract.runtime, "python3.12");
  assert.equal(extract.handler, "lambda_function.lambda_handler");
  assert.equal(extract.timeout_seconds, 60);
  assert.deepEqual(ess.environment, { API_ENDPOINT: "https://ess.example/v1/run", SECRET_NAME: "bp-builder/ess", API_KEY_HEADER: "x-api-key" });
  const first = source(bundle, "01 extract");
  assert.match(first, /build_request\(event\.get\("document"\)\)/);
  assert.match(first, /return \{"document": result, "options": event.get\("options"\), "status": "ok"\}/);
  assert.match(first, /boto3\.client\("secretsmanager"\)\.get_secret_value\(SecretId=name\)/);
  assert.match(first, /"Authorization"\] = "Bearer " \+ credential\(\)/);
  assert.match(first, /raise ApiError\(f"HTTP \{error\.code\}/, "an error status ends the run with the API's answer");
  assert.doesNotMatch(first, /API_TOKEN"\]/);
  assert.match(source(bundle, "02 ess"), /API_KEY_HEADER", "x-api-key"/);
  assert.match(source(bundle, "02 ess"), /result\.get\("status"\) in \("success", "valid"\)/);
  assert.doesNotMatch(source(bundle, "02 ess"), /raise ApiError/, "a validator keeps the report of an invalid document");
  assert.match(source(bundle, "03 mailgun"), /"Basic " \+ base64/);
  assert.match(source(bundle, "03 mailgun"), /return \{"receipt": result, "status": "ok"\}/);
});

test("the client's chain: each function sends the request its API takes; deploy-time values are template parameters", () => {
  const bundle = workflow([UPBRAINS, AMIT, ESS, MAILGUN], CLIENT_CHAIN);
  const upbrains = source(bundle, "01 Upbrains Extract Invoice From PDF");
  assert.match(upbrains, /REQUEST_KIND = "base64"/);
  assert.match(upbrains, /DOCUMENT_FIELD = "fileBase64"/);
  const amit = source(bundle, "03 AmitTransform Convert UBL JSON to UBL XML");
  assert.match(amit, /REQUEST_KIND = "json"/);
  assert.match(amit, /DOCUMENT_FIELD = "invoiceData"/);
  assert.match(amit, /FIXED_FIELDS = \{"invoiceType":"JSON","outputFormat":"UBL XML","useFlexibleMapping":True\}/);
  assert.match(amit, /RESPONSE_KIND = "text"/);
  assert.match(amit, /RESPONSE_FIELD = "xml"/);
  const ess = source(bundle, "05 ESS SmartDocFlow Validate PINT A-NZ Invoice");
  assert.match(ess, /DOCUMENT_FIELD = "content"/);
  assert.match(ess, /REQUIRED_SETTINGS = \["filename"\]/);
  assert.match(ess, /FIXED_FIELDS = \{"pack":"billing"\}/, "the rule pack, as pdf-invoice.ts sends it");
  const mailgun = source(bundle, "06 Mailgun Send Message");
  assert.match(mailgun, /REQUEST_KIND = "file"/);
  assert.match(mailgun, /DOCUMENT_FIELD = "attachment"/);
  assert.match(mailgun, /REQUIRED_SETTINGS = \["from","to","subject","text"\]/, "Mailgun refuses a message without a body");

  assert.deepEqual(bundle.parameters.map((parameter) => [parameter.name, parameter.no_echo, parameter.default ?? null]), [
    ["UpbrainsFlowId", true, null],
    ["WorkflowInputBucket", false, ""],
    ["ESSFilename", false, "invoice.xml"],
    ["MailgunDomainName", false, null],
    ["MailgunFrom", false, null],
    ["MailgunTo", false, null],
    ["MailgunSubject", false, "Invoice from the BP-Builder workflow"],
    ["MailgunText", false, "The invoice is attached as a UBL XML file. It passed validation before it was sent."],
  ]);
  const env = (state: string) => lambdaOf(bundle, state).environment;
  assert.deepEqual(env("01 Upbrains Extract Invoice From PDF"), { API_ENDPOINT: "https://ai.upbrains.ai/api/v1/webhooks/${UpbrainsFlowId}/sync", INPUT_BUCKET: "${WorkflowInputBucket}", INPUT_PREFIX: "${AWS::StackName}/inputs/" });
  assert.equal(env("06 Mailgun Send Message").REQUEST_FIELDS, '{"from":"${MailgunFrom}","to":"${MailgunTo}","subject":"${MailgunSubject}","text":"${MailgunText}"}');
  const resources = (bundle.template as Record<string, any>).Resources;
  assert.deepEqual(resources.Step01Function.Properties.Environment.Variables, {
    API_ENDPOINT: { "Fn::Sub": "https://ai.upbrains.ai/api/v1/webhooks/${UpbrainsFlowId}/sync" },
    INPUT_BUCKET: { "Fn::Sub": "${WorkflowInputBucket}" },
    INPUT_PREFIX: { "Fn::Sub": "${AWS::StackName}/inputs/" },
  }, "CloudFormation fills the parameters in");
  assert.equal(resources.Step03Function.Properties.Environment.Variables.API_ENDPOINT, "https://invoice-conversion-api.onrender.com/api/convert");
  assert.deepEqual(lambdaOf(bundle, "06 Mailgun Send Message").setup, [
    "Before deploying, create the Secrets Manager secret bp-builder/mailgun: user:password as plain text (Mailgun: api:<key>).",
    "sam deploy asks for MailgunDomainName, MailgunFrom, MailgunTo, MailgunSubject, MailgunText.",
  ]);
  assert.equal(env("05 ESS SmartDocFlow Validate PINT A-NZ Invoice").API_KEY_HEADER, "x-api-key", "ESS's header, as pdf-invoice.ts sends it");
  const parameters = (bundle.template as Record<string, any>).Parameters;
  assert.equal(parameters.UpbrainsFlowId.NoEcho, true, "the flow id is the webhook's secret");
  assert.equal(parameters.ESSFilename.Default, "invoice.xml");
  assert.deepEqual(bundle.warnings, []);
});

test("between Upbrains and AmitTransform the adapter steps are drawn: map before, complete after, as /api/composed/pdf-invoice does", () => {
  const bundle = workflow([UPBRAINS, AMIT, ESS, MAILGUN], CLIENT_CHAIN);
  const s = bundle.definition.States;
  assert.deepEqual(Object.keys(s), [
    "Check workflow input", "Workflow input rejected",
    "01 Upbrains Extract Invoice From PDF", "02 Adapter Upbrains to AmitTransform",
    "03 AmitTransform Convert UBL JSON to UBL XML", "04 Adapter complete AmitTransform UBL",
    "05 ESS SmartDocFlow Validate PINT A-NZ Invoice", "Check validation", "06 Mailgun Send Message",
    "Validation failed", "Composition failed",
  ]);
  const map = s["02 Adapter Upbrains to AmitTransform"];
  assert.equal(map.InputPath, undefined, "the mapping reads the extraction and the execution input's options");
  assert.equal(map.ResultPath, "$.mapped");
  assert.equal(s["03 AmitTransform Convert UBL JSON to UBL XML"].InputPath, "$.mapped");
  const complete = s["04 Adapter complete AmitTransform UBL"];
  assert.deepEqual((complete.Parameters as Record<string, unknown>).Payload, { "xml.$": "$.transformed2.document", "mapped.$": "$.mapped.mapped" });
  assert.equal(complete.ResultPath, "$.completed");
  assert.equal(s["05 ESS SmartDocFlow Validate PINT A-NZ Invoice"].InputPath, "$.completed");
  assert.equal(s["06 Mailgun Send Message"].InputPath, "$.completed", "the sender gets the completed XML");

  const mapper = lambdaOf(bundle, "02 Adapter Upbrains to AmitTransform");
  assert.equal(mapper.runtime, "nodejs22.x");
  assert.equal(mapper.handler, "index.handler");
  assert.equal(mapper.category, "Mapping", "the workflow canvas draws a Mapping function as an adapter");
  assert.deepEqual(mapper.setup, []);
  assert.deepEqual(mapper.environment, { DEFAULT_PROFILE: "pint-aunz" }, "an A-NZ validator: map under PINT A-NZ");
  assert.deepEqual(mapper.files.map((file) => file.path), ["index.mjs", "invoice-mapping.mjs", "package.json"]);
  assert.match(mapper.files[0].content, /event\?\.transformed\?\.document/);
  assert.match(mapper.files[1].content, /export function mapExtractionToAmit/);
  const completer = lambdaOf(bundle, "04 Adapter complete AmitTransform UBL");
  const paths = completer.files.map((file) => file.path);
  assert.deepEqual(paths.slice(0, 4), ["index.mjs", "invoice-xml.mjs", "invoice-mapping.mjs", "package.json"]);
  assert.ok(paths.includes("node_modules/@xmldom/xmldom/package.json"), "xmldom is carried, so nothing is installed");
  assert.ok(paths.includes("node_modules/@xmldom/xmldom/lib/index.js"));
  assert.deepEqual(JSON.parse(completer.files[3].content).dependencies, { "@xmldom/xmldom": "0.9.12" });
  assert.match(completer.files[1].content, /from "\.\/invoice-mapping\.mjs"/);
  assert.equal(bundle.uses_options, true);
});

// What the run form sends by default (lib/workflow-canvas/deployment.ts runOptions).
const RUN_OPTIONS = { buyerReference: "PO-7", buyer: { legalRegistrationId: "99000000000", legalRegistrationSchemeId: "0151" } };

test("the adapter functions run as packaged: the ABN from the invoice, then the completed PINT A-NZ XML", async (t) => {
  const bundle = workflow([UPBRAINS, AMIT, ESS, MAILGUN], CLIENT_CHAIN);
  const dir = mkdtempSync(path.join(tmpdir(), "bp-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const load = async (state: string) => {
    const lambda = lambdaOf(bundle, state);
    for (const file of lambda.files) {
      const target = path.join(dir, lambda.function_name, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    return (await import(pathToFileURL(path.join(dir, lambda.function_name, "index.mjs")).href)) as { handler: (event: unknown) => Promise<any> };
  };
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  const previous = process.env.DEFAULT_PROFILE;
  process.env.DEFAULT_PROFILE = "pint-aunz";
  t.after(() => { if (previous === undefined) delete process.env.DEFAULT_PROFILE; else process.env.DEFAULT_PROFILE = previous; });

  const mapped = await (await load("02 Adapter Upbrains to AmitTransform")).handler({ document: "<pdf>", transformed: { document: JSON.parse(fixture("upbrains-result-2026-10-12.json")) }, options: RUN_OPTIONS });
  assert.equal(mapped.mapped.profile, "pint-aunz");
  const supplier = mapped.document.supplier;
  assert.equal(supplier.endpointID, "47555222000", "the ABN printed on the invoice");
  assert.equal(supplier.endpointSchemeId, "0151", "the seller's ABN is its electronic address, as the site maps it");
  await assert.rejects((await load("02 Adapter Upbrains to AmitTransform")).handler({ transformed: { document: JSON.parse(fixture("upbrains-result-2026-10-12.json")) }, options: { seller: { legalRegistrationId: "80647710156", legalRegistrationSchemeId: "0151" } } }), /seller ABN conflicts/);
  // Without the buyer reference and the buyer's ABN the run stops here, before AmitTransform and ESS,
  // and says which fields to fill in (31 October: ESS reported both missing).
  await assert.rejects((await load("02 Adapter Upbrains to AmitTransform")).handler({ transformed: { document: JSON.parse(fixture("upbrains-result-2026-10-12.json")) } }),
    (error: Error) => error.name === "MissingInvoiceData" && /buyer reference/.test(error.message) && /buyer's ABN/.test(error.message) && !/seller's ABN/.test(error.message));
  const replay = await (await load("02 Adapter Upbrains to AmitTransform")).handler({ transformed: { document: JSON.parse(fixture("upbrains-result-2026-10-12.json")) }, options: { ...RUN_OPTIONS, invoiceId: "REPLAY-2", issueDate: "2026-10-31", dueDate: "2026-11-30" } });
  assert.deepEqual([replay.document.invoiceId, replay.document.issueDate, replay.document.dueDate], ["REPLAY-2", "2026-10-31", "2026-11-30"]);
  const completed = await (await load("04 Adapter complete AmitTransform UBL")).handler({ xml: fixture("amittransform-output-2026-10-14.xml"), mapped: mapped.mapped });
  assert.match(completed.document, /urn:peppol:pint:billing-1@aunz-1/);
  assert.match(completed.document, /schemeID="0151">47555222000</);
});

test("over Peppol, B2Brouter is asked to issue and send, and is given the BIS 3.0 copy of the validated invoice", () => {
  const bundle = workflow([UPBRAINS, AMIT, ESS, B2BROUTER], CLIENT_CHAIN);
  const s = bundle.definition.States;
  assert.deepEqual(Object.keys(s).slice(7, 10), ["Check validation", "06 Adapter Peppol BIS 3 copy for B2Brouter", "07 B2Brouter Import Invoice"]);
  assert.equal((s["Check validation"].Choices as Array<{ Next: string }>)[0].Next, "06 Adapter Peppol BIS 3 copy for B2Brouter", "only a valid invoice is copied and sent");
  const copy = s["06 Adapter Peppol BIS 3 copy for B2Brouter"];
  assert.deepEqual((copy.Parameters as Record<string, unknown>).Payload, { "xml.$": "$.completed.document" }, "the copy is made from the document the validator passed");
  assert.equal(copy.ResultPath, "$.bis3");
  assert.equal(copy.Next, "07 B2Brouter Import Invoice");
  assert.equal(s["07 B2Brouter Import Invoice"].InputPath, "$.bis3");
  const adapter = lambdaOf(bundle, "06 Adapter Peppol BIS 3 copy for B2Brouter");
  assert.equal(adapter.category, "Mapping");
  assert.deepEqual(adapter.files.map((file) => file.path).slice(0, 5), ["index.mjs", "peppol-bis3-copy.mjs", "invoice-xml.mjs", "invoice-mapping.mjs", "package.json"]);
  assert.equal(lambdaOf(bundle, "07 B2Brouter Import Invoice").environment.API_ENDPOINT,
    "https://api.b2brouter.net/accounts/${B2BrouterAccount}/invoices/import?issued=true&send_after_import=true&transport_type_code_for_contact=peppol&document_type_code_for_contact=xml.ubl.invoice.bis3",
    "as peppol-invoice.ts imports it: issued and sent over Peppol, not left as a draft");
  assert.deepEqual(bundle.warnings, []);
});

test("the B2Brouter step fails when B2Brouter keeps the invoice but does not send it", (t) => {
  const python = spawnSync("python3", ["--version"]);
  if (python.status !== 0) return t.skip("python3 is not installed");
  const lambda = lambdaOf(workflow([UPBRAINS, AMIT, ESS, B2BROUTER], CLIENT_CHAIN), "07 B2Brouter Import Invoice");
  const dir = mkdtempSync(path.join(tmpdir(), "bp-b2brouter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "lambda_function.py"), lambda.files[0].content);
  // B2Brouter's answer on 27 October to the client's 2022 invoice: 201, stored, not sent.
  const run = (invoice: object) => spawnSync("python3", ["-I", "-c", `
import io, json, sys, urllib.request
sys.path.insert(0, ${JSON.stringify(dir)})
import lambda_function as step
class Answer(io.BytesIO):
    headers = {"Content-Type": "application/json"}
    def __enter__(self): return self
    def __exit__(self, *args): return False
urllib.request.urlopen = lambda request, timeout: Answer(json.dumps({"invoice": json.loads(sys.argv[1])}).encode())
try:
    print(json.dumps(step.lambda_handler({"document": "<Invoice/>"}, None)))
except step.ApiError as error:
    print("ApiError:", error)
`, JSON.stringify(invoice)], { env: { ...process.env, API_ENDPOINT: "https://b2brouter.test/import", API_TOKEN: "test" }, encoding: "utf8" });
  const refused = run({ number: "EBWASP1002", state: "error", errors: [
    { error: "Cannot send invoice EBWASP1002: Validation failed: You cannot send invoices dated from a closed fiscal year" },
    { error: "Cannot send invoice EBWASP1002: Validation failed: You cannot send invoices dated from a closed fiscal year" },
  ] });
  assert.equal(refused.stdout.trim(), "ApiError: B2Brouter did not send invoice EBWASP1002 (state error): Cannot send invoice EBWASP1002: Validation failed: You cannot send invoices dated from a closed fiscal year", refused.stderr);
  const sending = run({ number: "CS95-PDF-0015", state: "sending", errors: [] });
  assert.equal(JSON.parse(sending.stdout).receipt.invoice.state, "sending", sending.stderr);
});

test("the BIS 3.0 adapter runs as packaged: the completed PINT A-NZ invoice becomes BIS 3.0 with the same lines", async (t) => {
  const bundle = workflow([UPBRAINS, AMIT, ESS, B2BROUTER], CLIENT_CHAIN);
  const dir = mkdtempSync(path.join(tmpdir(), "bp-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const load = async (state: string) => {
    const lambda = lambdaOf(bundle, state);
    for (const file of lambda.files) {
      const target = path.join(dir, lambda.function_name, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    return (await import(pathToFileURL(path.join(dir, lambda.function_name, "index.mjs")).href)) as { handler: (event: unknown) => Promise<any> };
  };
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  const previous = process.env.DEFAULT_PROFILE;
  process.env.DEFAULT_PROFILE = "pint-aunz";
  t.after(() => { if (previous === undefined) delete process.env.DEFAULT_PROFILE; else process.env.DEFAULT_PROFILE = previous; });
  const mapped = await (await load("02 Adapter Upbrains to AmitTransform")).handler({ document: "<pdf>", transformed: { document: JSON.parse(fixture("upbrains-result-2026-10-12.json")) }, options: RUN_OPTIONS });
  const completed = await (await load("04 Adapter complete AmitTransform UBL")).handler({ xml: fixture("amittransform-output-2026-10-14.xml"), mapped: mapped.mapped });
  const copy = await (await load("06 Adapter Peppol BIS 3 copy for B2Brouter")).handler({ xml: completed.document });
  assert.match(copy.document, /urn:cen\.eu:en16931:2017#compliant#urn:fdc:peppol\.eu:2017:poacc:billing:3\.0/);
  assert.doesNotMatch(copy.document, /urn:peppol:pint:billing-1@aunz-1/);
  const lines = (xml: string) => xml.match(/<cac:InvoiceLine>/g)?.length ?? 0;
  assert.equal(lines(copy.document), lines(completed.document));
  assert.ok(copy.changes.length >= 2);
});

test("no BIS 3.0 copy when the chain sends by email", () => {
  const email = workflow([UPBRAINS, AMIT, ESS, MAILGUN], CLIENT_CHAIN);
  assert.ok(!Object.keys(email.definition.States).some((state) => /BIS 3 copy/.test(state)));
});

test("no adapter step is added for a converter that is not fed by Upbrains", () => {
  const { definition } = workflow([AMIT, ESS], CLIENT_CHAIN);
  assert.deepEqual(Object.keys(definition.States), [
    "Check workflow input", "Workflow input rejected",
    "01 AmitTransform Convert UBL JSON to UBL XML", "02 ESS SmartDocFlow Validate PINT A-NZ Invoice",
    "Check validation", "Validation failed", "Composition failed", "Done",
  ]);
});

test("two APIs from one company get distinct states and functions; another chain gets other function names", () => {
  const catalogue = [
    api("convert", "Transformation", { company_name: "AmitTransform", api_name: "AmitTransform Analyse Missing Invoice Fields API" }),
    api("apply", "Transformation", { company_name: "AmitTransform", api_name: "AmitTransform Apply Fixes and Convert to UBL XML API" }),
  ];
  const bundle = workflow(["convert", "apply"], catalogue);
  assert.deepEqual(bundle.lambdas.map((lambda) => lambda.state_name), [
    "01 AmitTransform Analyse Missing Invoice Fields", "02 AmitTransform Apply Fixes and Convert to UBL XML",
  ]);
  const names = bundle.lambdas.map((lambda) => lambda.function_name);
  assert.equal(new Set(names).size, 2, names.join(", "));
  assert.ok(names.every((n) => n.length <= 64), names.join(", "));
  const other = workflow(["apply", "convert"], catalogue).lambdas.map((lambda) => lambda.function_name);
  assert.notEqual(names[0].slice(0, 8), other[0].slice(0, 8), "the code before the step number is the chain's own");
});

test("the API-key header comes from the catalogue's note, else a known provider; an unknown one is a warning", () => {
  const catalogue = [
    api("convert", "Transformation"),
    api("validate", "Validation"),
    api("billit", "Communication", { company_name: "Billit", authentication_method: "API Key", authentication_details: "Request header apiKey with the key from MyBillit Profile, plus header partyID." }),
    api("router", "Communication", { company_name: "B2Brouter", authentication_method: "API Key" }),
    api("unknown", "Communication", { company_name: "Unknown", authentication_method: "API Key" }),
  ];
  const header = (id: string) => {
    const bundle = workflow(["convert", "validate", id], catalogue);
    return { header: bundle.lambdas[2].environment.API_KEY_HEADER, warnings: bundle.warnings.join("\n") };
  };
  assert.equal(header("billit").header, "apiKey");
  assert.equal(header("router").header, "X-B2B-API-Key");
  assert.equal(header("unknown").header, "x-api-key");
  assert.match(header("unknown").warnings, /does not say which header carries the API key/);
  assert.doesNotMatch(header("billit").warnings, /which header/);
});

test("an unknown API, an Other category or a broken order is refused with the reason", () => {
  const unknown = generateWorkflow({ api_ids: ["amit", "missing"] }, CATALOGUE);
  assert.equal(!unknown.ok && unknown.issues[0].code, "unknown_api");
  const other = generateWorkflow({ api_ids: ["other"] }, CATALOGUE);
  assert.equal(!other.ok && other.issues[0].code, "unsupported_category");
  const skipped = generateWorkflow({ api_ids: ["amit", "mailgun"] }, CATALOGUE);
  assert.equal(!skipped.ok && skipped.issues[0].code, "validation_skipped");
  const empty = generateWorkflow({ api_ids: [] }, CATALOGUE);
  assert.equal(!empty.ok && empty.issues[0].code, "empty_chain");
});

test("warnings: no endpoint, no stored schema, a chain that still needs a decision; a path parameter is a deploy parameter", () => {
  const catalogue = [
    api("convert", "Transformation", { api_endpoint: null }),
    api("validate", "Validation", { api_endpoint: "https://validator.example/validate/{vesid}" }),
  ];
  const bundle = workflow(["convert", "validate"], catalogue, "needs_decision");
  const warnings = bundle.warnings.join("\n");
  assert.match(warnings, /no endpoint/);
  assert.match(warnings, /no stored request schema/);
  assert.match(warnings, /needs a decision/);
  assert.deepEqual(bundle.parameters.map((parameter) => parameter.name), ["ValidateVesid"]);
  assert.equal(bundle.lambdas[1].environment.API_ENDPOINT, "https://validator.example/validate/${ValidateVesid}");
});

test("stored PDF inputs have a scoped read policy and are resolved before the extractor request", t => {
  const bundle = workflow([UPBRAINS, AMIT, ESS, MAILGUN], CLIENT_CHAIN);
  const template = bundle.template as any;
  assert.equal(template.Parameters.WorkflowInputBucket.Default, "");
  assert.equal(template.Outputs.StoredInputVersion.Value, "1");
  const lambda = bundle.lambdas[0];
  assert.deepEqual(template.Resources[lambda.logical_id].Properties.Environment.Variables.INPUT_PREFIX, { "Fn::Sub": "${AWS::StackName}/inputs/" });
  const policy = template.Resources[lambda.logical_id].Properties.Policies.at(-1)["Fn::If"];
  assert.equal(policy[0], "HasInputBucket");
  assert.deepEqual(policy[1].Statement[0], { Effect: "Allow", Action: "s3:GetObject", Resource: { "Fn::Sub": "arn:${AWS::Partition}:s3:::${WorkflowInputBucket}/${AWS::StackName}/inputs/*" } });
  for (const other of bundle.lambdas.slice(1)) assert.ok(!JSON.stringify(template.Resources[other.logical_id]).includes("s3:GetObject"));
  const dir = mkdtempSync(path.join(tmpdir(), "bp-stored-input-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "lambda_function.py"), lambda.files[0].content);
  const run = spawnSync("python3", ["-I", "-c", `
import io, json, sys, types, os
sys.path.insert(0, ${JSON.stringify(dir)})
import lambda_function as step
os.environ["INPUT_BUCKET"] = "private-inputs"
os.environ["INPUT_PREFIX"] = "bp-demo/inputs/"
class S3:
    def get_object(self, **kwargs):
        assert kwargs == {"Bucket": "private-inputs", "Key": "bp-demo/inputs/a.pdf"}
        self.body = io.BytesIO(b"%PDF-1.4 test")
        return {"Body": self.body}
s3 = S3()
sys.modules["boto3"] = types.SimpleNamespace(client=lambda name: s3)
data, media, name = step.document_bytes({"s3": {"bucket": "private-inputs", "key": "bp-demo/inputs/a.pdf"}})
assert data == b"%PDF-1.4 test" and media == "application/pdf" and s3.body.closed
for ref in [{"bucket":"other","key":"bp-demo/inputs/a.pdf"}, {"bucket":"private-inputs","key":"other/inputs/a.pdf"}]:
    try: step.document_bytes({"s3": ref})
    except ValueError: pass
    else: raise AssertionError("foreign input accepted")
print("ok")
`], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "ok");
});
