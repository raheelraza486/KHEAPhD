import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { crc32 } from "node:zlib";

import { generateWorkflow } from "../../lib/composition/step-functions.ts";
import { workflowFiles, zipFiles } from "../../lib/composition/workflow-package.ts";
import { routeHarness } from "../helpers/route-harness.ts";

const CONVERT = "11111111-1111-4111-8111-111111111111";
const VALIDATE = "33333333-3333-4333-8333-333333333333";
const SEND = "44444444-4444-4444-8444-444444444444";

function row(id: string, api_name: string, category: string, company_name: string) {
  return {
    id, api_name, official_api_name: api_name, description: "", instructions: "", company_name,
    country_region: "", category, network: "", communication_direction: "", is_active: true, duplicate_of: null,
    input_formats: ["JSON"], output_formats: ["XML"], invoice_standard: [], business_rules: [],
    api_endpoint: `https://${company_name.toLowerCase()}.example/run`, http_method: "POST",
    authentication_method: "None", authentication_details: "",
  };
}

const ROWS = [
  row(CONVERT, "AmitTransform Convert UBL JSON to UBL XML API", "Transformation", "AmitTransform"),
  row(VALIDATE, "ECOSIO Validator Validate XML Document API", "Validation", "Ecosio"),
  row(SEND, "Mailgun Send Message API", "Communication", "Mailgun"),
];

/** Mailgun's stored request: a multipart form with the invoice as attachment (migration 0040). */
const SCHEMAS = [{ id: "m-req", api_id: SEND, direction: "request", status_code: null, media_type: "multipart/form-data", raw: { type: "object" }, verified_by: null, content_hash: "m" }];
const FIELDS = [
  ["from", "string", true, null], ["to", "array", true, null], ["subject", "string", true, null], ["attachment[]", "string", false, "binary"],
].map(([path, json_type, is_required, format]) => ({
  schema_id: "m-req", path, leaf_name: String(path).replace(/\[\]$/, ""), leaf_name_norm: String(path).replace(/\[\]$/, ""),
  json_type, format, is_required, is_array_item: false, depth: 0, enum_values: null, description: null,
}));

/** Reads back a stored zip: names and contents, checking every CRC. */
function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const crc = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const data = buffer.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    files.set(name, data.toString("utf8"));
    offset += 30 + nameLength + size;
  }
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 10), files.size);
  return files;
}

function database(t: TestContext, failing = false) {
  const previous = { url: process.env.SUPABASE_URL, secret: process.env.SUPABASE_SECRET_KEY };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  t.after(() => {
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.secret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.secret;
  });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (failing) return new Response("down", { status: 500 });
    const table = url.pathname.split("/").at(-1)!;
    if (table === "apis") return Response.json(ROWS);
    if (table === "api_schema") return Response.json(SCHEMAS.filter((schema) => url.searchParams.get("api_id")!.includes(schema.api_id)));
    if (table === "api_schema_field") return Response.json(FIELDS);
    return Response.json([]);
  });
  return { route: routeHarness({})("app/api/composition/workflow/route.ts"), calls };
}

const post = (body: unknown, query = "") => new Request(`https://example.test/api/composition/workflow${query}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const NAME = "BP-AmitTransform-Ecosio-Mailgun";

test("the package is one folder for sam deploy: template, definition, input script, README and one function per API; it unzips intact", () => {
  // Mailgun with its Basic credential, as the catalogue records it.
  const rows = ROWS.map((row) => (row.id === SEND ? { ...row, authentication_method: "Basic" } : row));
  const result = generateWorkflow({ api_ids: [CONVERT, VALIDATE, SEND] }, rows);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const files = workflowFiles(result.workflow);
  const functions = result.workflow.lambdas.map((lambda) => lambda.function_name);
  assert.deepEqual(files.map((file) => file.path), [
    `${NAME}/README.txt`, `${NAME}/statemachine.asl.json`, `${NAME}/statemachine.asl.yaml`, `${NAME}/template.yaml`, `${NAME}/make_input.py`,
    ...functions.map((fn) => `${NAME}/lambdas/${fn}/lambda_function.py`),
  ]);
  assert.deepEqual(functions.map((fn) => fn.slice(9)), ["01-AmitTransformConvertUBLJSONToUBLXML", "02-ECOSIOValidatorValidateXMLDocument", "03-MailgunSendMessage"]);
  const unzipped = unzip(zipFiles(files));
  for (const file of files) assert.equal(unzipped.get(file.path), file.content);
  const readme = files[0].content;
  assert.match(readme, /sam deploy --guided --capabilities CAPABILITY_IAM/);
  assert.match(readme, /read -rs VALUE && aws secretsmanager create-secret --name bp-builder\/mailgun --secret-string "\$VALUE"/);
  assert.match(readme, /Stack name: bp-amittransform-ecosio-mailgun\./);
  assert.ok(readme.includes(`unzip -o ${NAME}.zip && cd ${NAME}`));
  assert.match(readme, /02 ECOSIO Validator Validate XML Document   Lambda bp[0-9a-f]{6}-02-/);
  assert.doesNotMatch(readme, /REPLACE_WITH_ARN/);
  assert.match(files[3].content, /CodeUri: lambdas\/bp[0-9a-f]{6}-01-AmitTransformConvertUBLJSONToUBLXML\//);
});

test("make_input.py writes the execution input: a PDF as base64, XML as text, with the options", () => {
  const result = generateWorkflow({ api_ids: [CONVERT, VALIDATE, SEND] }, ROWS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const script = workflowFiles(result.workflow).find((file) => file.path.endsWith("make_input.py"))!.content;
  assert.match(script, /base64\.b64encode\(data\)/);
  assert.match(script, /payload\["options"\] = json\.load\(handle\)/);
  assert.match(script, /LIMIT = 250000/);
});

test("POST /api/composition/workflow returns the zip for a chain, reading the catalogue once", async (t) => {
  const { route, calls } = database(t);
  const response = await route.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], status: "feasible" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(response.headers.get("content-disposition"), `attachment; filename="${NAME}.zip"`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const files = unzip(Buffer.from(await response.arrayBuffer()));
  assert.ok(files.has(`${NAME}/statemachine.asl.yaml`));
  const definition = JSON.parse(files.get(`${NAME}/statemachine.asl.json`)!);
  assert.equal(definition.States["02 ECOSIO Validator Validate XML Document"].Resource, "arn:aws:states:::lambda:invoke");
  const mailgun = [...files.keys()].find((path) => path.endsWith("-03-MailgunSendMessage/lambda_function.py"))!;
  assert.match(files.get(mailgun)!, /REQUEST_KIND = "file"/, "the function is built from the stored schema");
  assert.deepEqual([...new Set(calls)].sort(), ["/rest/v1/api_parameter", "/rest/v1/api_schema", "/rest/v1/api_schema_field", "/rest/v1/apis", "/rest/v1/format_alias"]);
  assert.equal(calls.length, 5, "one read per table");
});

test("?format=json returns the same files as JSON with the warnings", async (t) => {
  const { route } = database(t);
  const response = await route.POST(post({ api_ids: [CONVERT, VALIDATE], status: "needs_decision", name: "Demo" }, "?format=json"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.name, "Demo");
  assert.deepEqual(body.files.map((file: { path: string }) => file.path).slice(0, 3), ["Demo/README.txt", "Demo/statemachine.asl.json", "Demo/statemachine.asl.yaml"]);
  assert.match(body.warnings.join(" "), /needs a decision/);
  // The workflow canvas draws the definition and names each Lambda's API; the files stay out of it.
  assert.equal(body.definition.StartAt, "Check workflow input");
  assert.deepEqual(body.lambdas.map((lambda: { state_name: string; api_id: string }) => [lambda.state_name, lambda.api_id]), [
    ["01 AmitTransform Convert UBL JSON to UBL XML", CONVERT], ["02 ECOSIO Validator Validate XML Document", VALIDATE],
  ]);
  assert.equal("files" in body.lambdas[0], false);
  // Deploying from the canvas (#135) needs the parameters, the secrets and the stack name.
  assert.equal(body.stack_name, "bp-demo");
  assert.ok(Array.isArray(body.parameters) && Array.isArray(body.secrets));
  // Each API step says how its request is built: the call plan and the stored request's top-level fields.
  // This test catalogue stores no request schema for the converter, so the plan is the default guess.
  assert.equal(body.lambdas[0].call.from_schema.request, false);
  assert.equal(body.lambdas[0].request_fields, null);
});

test("bad bodies are 400, an impossible chain is 422 with the reason, and a database failure is 502", async (t) => {
  const { route } = database(t);
  assert.equal((await route.POST(post({ api_ids: [] }))).status, 400);
  assert.equal((await route.POST(post({ api_ids: ["not-a-uuid"] }))).status, 400);
  assert.equal((await route.POST(post({ api_ids: [CONVERT, VALIDATE, SEND, SEND, SEND] }))).status, 400);
  assert.equal((await route.POST(post({ api_ids: [CONVERT], status: "maybe" }))).status, 400);

  const skipped = await route.POST(post({ api_ids: [CONVERT, SEND] }));
  assert.equal(skipped.status, 422);
  assert.equal((await skipped.json()).details[0].code, "validation_skipped");

  const failing = database(t, true);
  assert.equal((await failing.route.POST(post({ api_ids: [CONVERT] }))).status, 502);
});
