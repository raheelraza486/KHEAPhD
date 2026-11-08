import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { AwsError } from "../../lib/workflow-deploy/types.ts";
import { routeHarness } from "../helpers/route-harness.ts";
import { FakeAws } from "./fake-aws.ts";

const CONVERT = "11111111-1111-4111-8111-111111111111";
const VALIDATE = "33333333-3333-4333-8333-333333333333";
const SEND = "44444444-4444-4444-8444-444444444444";
const STACK = "bp-amittransform-ecosio-mailgun";
const MACHINE = "arn:aws:states:ap-southeast-2:803964123922:stateMachine:BP-AmitTransform-Ecosio-Mailgun";

function row(id: string, api_name: string, category: string, company_name: string, authentication_method = "None") {
  return {
    id, api_name, official_api_name: api_name, description: "", instructions: "", company_name,
    country_region: "", category, network: "", communication_direction: "", is_active: true, duplicate_of: null,
    input_formats: ["JSON"], output_formats: ["XML"], invoice_standard: [], business_rules: [],
    api_endpoint: `https://${company_name.toLowerCase()}.example/run`, http_method: "POST",
    authentication_method, authentication_details: "",
  };
}

const ROWS = [
  row(CONVERT, "AmitTransform Convert UBL JSON to UBL XML API", "Transformation", "AmitTransform"),
  row(VALIDATE, "ECOSIO Validator Validate XML Document API", "Validation", "Ecosio"),
  row(SEND, "Mailgun Send Message API", "Communication", "Mailgun", "Basic"),
];

/** Mailgun's stored request: a multipart form with the invoice as attachment, and an optional text body. */
const SCHEMAS = [{ id: "m-req", api_id: SEND, direction: "request", status_code: null, media_type: "multipart/form-data", raw: { type: "object" }, verified_by: null, content_hash: "m" }];
const FIELDS = [
  ["from", "string", true, null], ["to", "array", true, null], ["subject", "string", true, null], ["text", "string", false, null], ["attachment[]", "string", false, "binary"],
].map(([path, json_type, is_required, format]) => ({
  schema_id: "m-req", path, leaf_name: String(path).replace(/\[\]$/, ""), leaf_name_norm: String(path).replace(/\[\]$/, ""),
  json_type, format, is_required, is_array_item: false, depth: 0, enum_values: null, description: null,
}));

const ADMIN = { requireRole: async () => ({ user: { id: "admin-1", role: "admin", email: "b@example.test" } }) };
const GUEST = { requireRole: async () => ({ response: new Response(JSON.stringify({ error: "Sign in to continue." }), { status: 401 }) }) };

function setup(t: TestContext, options: { auth?: object; bucket?: string | null } = {}) {
  const saved = { ...process.env };
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
  process.env.MAILGUN_DOMAIN = "mg.example.test";
  delete process.env.MAILGUN_ALLOWED_RECIPIENTS;
  if (options.bucket === null) delete process.env.WORKFLOW_ARTIFACT_BUCKET;
  else process.env.WORKFLOW_ARTIFACT_BUCKET = options.bucket ?? "bp-sfn-artifacts-test";
  t.after(() => {
    for (const key of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "MAILGUN_DOMAIN", "MAILGUN_ALLOWED_RECIPIENTS", "WORKFLOW_ARTIFACT_BUCKET"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    const table = url.pathname.split("/").at(-1)!;
    if (table === "apis") return Response.json(ROWS);
    if (table === "api_schema") return Response.json(SCHEMAS.filter((schema) => url.searchParams.get("api_id")!.includes(schema.api_id)));
    if (table === "api_schema_field") return Response.json(FIELDS);
    return Response.json([]);
  });
  const aws = new FakeAws();
  aws.secrets = new Set(["bp-builder/mailgun"]);
  const load = routeHarness({ "@/lib/auth": options.auth ?? ADMIN, "@/lib/workflow-deploy/aws": { deployAws: () => aws } });
  type Handler = (request: Request, context?: unknown) => Promise<Response>;
  const route = (file: string) => load(file) as unknown as Record<string, Handler>;
  return {
    aws,
    deployments: route("app/api/workflows/deployments/route.ts"),
    deployment: route("app/api/workflows/deployments/[id]/route.ts"),
    runs: route("app/api/workflows/deployments/[id]/executions/route.ts"),
    run: route("app/api/workflows/executions/[arn]/route.ts"),
  };
}

const SAME_ORIGIN = { origin: "https://example.test", host: "example.test" };
const post = (body: unknown, headers: Record<string, string> = SAME_ORIGIN) => new Request("https://example.test/api/workflows/deployments", {
  method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const get = (path: string, method = "GET", headers: Record<string, string> = SAME_ORIGIN) => new Request(`https://example.test${path}`, { method, headers });
const upload = (form: FormData, headers: Record<string, string> = SAME_ORIGIN) =>
  new Request(`https://example.test/api/workflows/deployments/${STACK}/executions`, { method: "POST", body: form, headers });
const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

test("only an admin deploys: a guest is refused before anything is read or sent", async (t) => {
  const { aws, deployments, deployment, runs, run } = setup(t, { auth: GUEST });
  assert.equal((await deployments.POST(post({ api_ids: [CONVERT] }))).status, 401);
  assert.equal((await deployment.GET(get(`/api/workflows/deployments/${STACK}`), params({ id: STACK }))).status, 401);
  assert.equal((await deployment.DELETE(get(`/api/workflows/deployments/${STACK}`, "DELETE"), params({ id: STACK }))).status, 401);
  assert.equal((await runs.POST(get(`/api/workflows/deployments/${STACK}/executions`, "POST"), params({ id: STACK }))).status, 401);
  assert.equal((await run.GET(get("/api/workflows/executions/x"), params({ arn: "x" }))).status, 401);
  assert.equal(aws.created.length + aws.objects.size, 0);
});

test("the routes that change something refuse a cross-origin request, as the composed routes do", async (t) => {
  const { aws, deployments, deployment, runs } = setup(t);
  aws.stack(STACK, "CREATE_COMPLETE", { StateMachineArn: { value: MACHINE, description: null } });
  const elsewhere = { origin: "https://attacker.example", host: "example.test" };
  const form = new FormData();
  form.set("invoice", new File(["%PDF-1.4 test"], "invoice.pdf", { type: "application/pdf" }));
  assert.equal((await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], parameters: { MailgunTo: "b@example.test" } }, elsewhere))).status, 403);
  assert.equal((await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], parameters: { MailgunTo: "b@example.test" } }, {}))).status, 403, "no Origin header");
  assert.equal((await deployment.DELETE(get(`/api/workflows/deployments/${STACK}`, "DELETE", elsewhere), params({ id: STACK }))).status, 403);
  assert.equal((await runs.POST(upload(form, elsewhere), params({ id: STACK }))).status, 403);
  assert.equal(aws.created.length + aws.deleted.length + aws.started.length, 0);
  assert.equal((await deployment.GET(get(`/api/workflows/deployments/${STACK}`, "GET", {}), params({ id: STACK }))).status, 200, "reading needs no Origin");
});

test("POST deploys the chain: the server fills the sender, the change set is created and executed, 202", async (t) => {
  const { aws, deployments } = setup(t);
  const response = await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], status: "feasible", parameters: { MailgunTo: "b@example.test" } }));
  const body = await response.json();
  assert.equal(response.status, 202, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.deployment_id, STACK);
  assert.equal(body.stack_name, STACK);
  assert.equal(body.state_machine_name, "BP-AmitTransform-Ecosio-Mailgun");
  assert.equal(body.status, "in_progress");
  assert.equal(aws.created[0].type, "CREATE");
  assert.deepEqual(Object.keys(aws.created[0].parameters).sort(), ["MailgunFrom", "MailgunSubject", "MailgunText", "MailgunTo"]);
  assert.equal(aws.created[0].parameters.MailgunFrom, "postmaster@mg.example.test");
  assert.equal(aws.executed.length, 1);
  assert.doesNotMatch(JSON.stringify(body), /b@example\.test/, "parameter values are not echoed");
});

test("POST emails only the admin's own address or one the administrators allowed", async (t) => {
  const { aws, deployments } = setup(t);
  const stranger = await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], parameters: { MailgunTo: "stranger@example.test" } }));
  assert.equal(stranger.status, 403);
  assert.deepEqual((await stranger.json()).details, [{ code: "recipient_not_allowed", parameter: "MailgunTo" }]);
  assert.equal(aws.created.length + aws.objects.size, 0);

  process.env.MAILGUN_ALLOWED_RECIPIENTS = "client@example.test, stranger@example.test";
  assert.equal((await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], parameters: { MailgunTo: "stranger@example.test" } }))).status, 202);
});

test("POST refuses: not configured 503, a missing parameter 400, a missing secret 412, an impossible chain 422", async (t) => {
  assert.equal((await setup(t, { bucket: null }).deployments.POST(post({ api_ids: [CONVERT] }))).status, 503);

  const { aws, deployments } = setup(t);
  const missing = await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND] }));
  assert.equal(missing.status, 400);
  assert.deepEqual((await missing.json()).details, [{ code: "missing_parameter", parameter: "MailgunTo" }]);
  assert.equal((await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], parameters: { MailgunTo: 7 } }))).status, 400);

  aws.secrets = new Set();
  const noSecret = await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], parameters: { MailgunTo: "b@example.test" } }));
  assert.equal(noSecret.status, 412);
  assert.equal((await noSecret.json()).details[0].secret, "bp-builder/mailgun");

  const skipped = await deployments.POST(post({ api_ids: [CONVERT, SEND] }));
  assert.equal(skipped.status, 422);
  assert.equal((await skipped.json()).details[0].code, "validation_skipped");
  assert.equal(aws.created.length, 0);
});

test("POST passes on AWS's own refusal as 502", async (t) => {
  const { aws, deployments } = setup(t);
  aws.failUpload = new AwsError("s3", "AccessDenied", "Access Denied");
  const response = await deployments.POST(post({ api_ids: [CONVERT, VALIDATE, SEND], parameters: { MailgunTo: "b@example.test" } }));
  assert.equal(response.status, 502);
  assert.deepEqual((await response.json()).details, [{ code: "aws_error", service: "s3", message: "Access Denied" }]);
});

test("GET reads the deployment back; an id that is not a bp- stack is 404 without asking AWS; DELETE deletes it", async (t) => {
  const { aws, deployment } = setup(t);
  assert.equal((await deployment.GET(get("/api/workflows/deployments/Demo"), params({ id: "Demo" }))).status, 404);
  assert.equal((await deployment.GET(get(`/api/workflows/deployments/${STACK}`), params({ id: STACK }))).status, 404);
  aws.stack(STACK, "CREATE_COMPLETE", { StateMachineArn: { value: MACHINE, description: null } });
  const response = await deployment.GET(get(`/api/workflows/deployments/${STACK}`), params({ id: STACK }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "succeeded");
  assert.equal(body.state_machine_arn, MACHINE);

  const deleted = await deployment.DELETE(get(`/api/workflows/deployments/${STACK}`, "DELETE"), params({ id: STACK }));
  assert.equal(deleted.status, 202);
  assert.deepEqual(aws.deleted, [STACK]);
});

test("a trial run: an invoice file starts the execution; its status is read by the URL-encoded ARN", async (t) => {
  const { aws, runs, run } = setup(t);
  aws.stack(STACK, "UPDATE_COMPLETE", { StateMachineArn: { value: MACHINE, description: null } });
  const form = new FormData();
  form.set("invoice", new File(["%PDF-1.4 test"], "invoice.pdf", { type: "application/pdf" }));
  form.set("options", '{"buyerReference":"PO-7"}');
  const started = await runs.POST(upload(form), params({ id: STACK }));
  const body = await started.json();
  assert.equal(started.status, 202, JSON.stringify(body));
  assert.deepEqual(JSON.parse(aws.started[0].input), { document: Buffer.from("%PDF-1.4 test").toString("base64"), options: { buyerReference: "PO-7" } });

  const empty = await runs.POST(upload(new FormData()), params({ id: STACK }));
  assert.equal(empty.status, 400);

  const definition = JSON.stringify({ StartAt: "A", States: { A: { Type: "Succeed" } } });
  aws.executions.set(body.execution_arn, {
    description: { status: "SUCCEEDED", state_machine_arn: MACHINE, output: "{}", error: null, cause: null, started_at: "", stopped_at: "" },
    history: [{ id: 1, type: "SucceedStateEntered", timestamp: "t", state: "A", error: null, cause: null }],
    definition,
  });
  const encoded = encodeURIComponent(body.execution_arn);
  const status = await run.GET(get(`/api/workflows/executions/${encoded}`), params({ arn: encoded }));
  const view = await status.json();
  assert.equal(status.status, 200, JSON.stringify(view));
  assert.deepEqual(view.states, [{ name: "A", status: "succeeded", started_at: "t" }]);
  assert.equal((await run.GET(get("/api/workflows/executions/nope"), params({ arn: "nope" }))).status, 404);
});

test("each admin starts at most five trial runs a minute, since each one really sends", async (t) => {
  const { aws, runs } = setup(t);
  aws.stack(STACK, "UPDATE_COMPLETE", { StateMachineArn: { value: MACHINE, description: null } });
  const form = () => {
    const value = new FormData();
    value.set("invoice", new File(["%PDF-1.4 test"], "invoice.pdf", { type: "application/pdf" }));
    return value;
  };
  for (let run = 0; run < 5; run++) assert.equal((await runs.POST(upload(form()), params({ id: STACK }))).status, 202);
  const limited = await runs.POST(upload(form()), params({ id: STACK }));
  assert.equal(limited.status, 429);
  assert.ok((await limited.json()).details.retry_after_seconds > 0);
  assert.equal(aws.started.length, 5);
});

test("POST accepts a PDF over 1 MB through stored input and refuses a stale deployment before upload", async t => {
  const { aws, runs } = setup(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 32); bytes.write("%PDF-1.4");
  const form = () => {
    const body = new FormData(); body.set("invoice", new File([bytes], "large.pdf", { type: "application/pdf" }));
    body.set("options", JSON.stringify({ buyerReference: "PO-7" })); return body;
  };
  aws.stack(STACK, "UPDATE_COMPLETE", { StateMachineArn: { value: MACHINE, description: null } });
  const old = await runs.POST(upload(form()), params({ id: STACK }));
  assert.equal(old.status, 409);
  assert.match((await old.json()).error, /Deploy this workflow again/);
  assert.equal(aws.objects.size + aws.started.length, 0);
  aws.stack(STACK, "UPDATE_COMPLETE", {
    StateMachineArn: { value: MACHINE, description: null },
    InputStorageBucket: { value: "bp-sfn-artifacts-test", description: null },
    StoredInputVersion: { value: "1", description: null },
  });
  const current = await runs.POST(upload(form()), params({ id: STACK }));
  assert.equal(current.status, 202, JSON.stringify(await current.json()));
  assert.equal(aws.objects.size, 1);
  assert.ok(Buffer.byteLength(aws.started[0].input) < 1000);
  assert.equal(JSON.parse(aws.started[0].input).document.s3.bucket, "bp-sfn-artifacts-test");
});
