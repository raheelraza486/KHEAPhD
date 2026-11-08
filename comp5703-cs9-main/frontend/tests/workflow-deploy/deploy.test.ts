import assert from "node:assert/strict";
import test from "node:test";

import { generateWorkflow } from "../../lib/composition/step-functions.ts";
import { stackName } from "../../lib/composition/workflow-package.ts";
import {
  deleteDeployment,
  deploymentStatus,
  deploymentView,
  packageDeployment,
  refusedRecipients,
  resolveParameters,
  startDeployment,
  type DeployEnv,
} from "../../lib/workflow-deploy/deploy.ts";
import { AwsError } from "../../lib/workflow-deploy/types.ts";
import { AMIT, CLIENT_CHAIN, ESS, MAILGUN, UPBRAINS } from "../composition/fixtures/workflow-chain.ts";
import { FakeAws } from "./fake-aws.ts";

const ENV: DeployEnv = {
  bucket: "bp-sfn-artifacts-test",
  mailgunDomain: "mg.example.test",
  upbrainsWebhookUrl: "https://agents.upbrains.ai/v1/webhooks/flow-123",
};
const STACK = "bp-upbrains-amittransform-ess-mailgun";

function bundle() {
  const result = generateWorkflow({ api_ids: [UPBRAINS, AMIT, ESS, MAILGUN] }, CLIENT_CHAIN);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("not generated");
  return result.workflow;
}

const values = () => resolveParameters(bundle(), { MailgunTo: "b@example.test" }, ENV).values;

/** The entries of a stored zip: name, Unix mode and content. */
function entries(zip: Buffer) {
  const found: Array<{ name: string; mode: number; content: string }> = [];
  const end = zip.length - 22;
  let offset = zip.readUInt32LE(end + 16);
  while (zip.readUInt32LE(offset) === 0x02014b50) {
    const madeBy = zip.readUInt16LE(offset + 4) >> 8;
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const size = zip.readUInt32LE(offset + 20);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + zip.readUInt16LE(local + 26);
    found.push({ name, mode: madeBy === 3 ? zip.readUInt32LE(offset + 38) >>> 16 : 0, content: zip.subarray(dataStart, dataStart + size).toString("utf8") });
    offset += 46 + nameLength;
  }
  return found;
}

test("the stack is the workflow's name in lower case, always starting with bp-", () => {
  assert.equal(stackName(bundle()), STACK);
  assert.equal(stackName({ name: "Demo" }), "bp-demo");
  assert.equal(stackName({ name: "BP--Invoice__Run" }), "bp-invoice-run");
});

test("parameters: the person's choices, the server's own settings, the template's defaults", () => {
  const resolved = resolveParameters(bundle(), { MailgunTo: "b@example.test", MailgunSubject: "Invoice 42" }, ENV);
  assert.deepEqual(resolved.issues, []);
  assert.deepEqual(resolved.server_missing, []);
  assert.deepEqual(resolved.values, {
    WorkflowInputBucket: ENV.bucket,
    UpbrainsFlowId: "flow-123",
    ESSFilename: "invoice.xml",
    MailgunDomainName: "mg.example.test",
    MailgunFrom: "postmaster@mg.example.test",
    MailgunTo: "b@example.test",
    MailgunSubject: "Invoice 42",
    MailgunText: "The invoice is attached as a UBL XML file. It passed validation before it was sent.",
  });
  assert.equal(resolveParameters(bundle(), { MailgunTo: "b@example.test" }, { ...ENV, mailgunFrom: "Invoices <i@mg.example.test>" }).values.MailgunFrom,
    "Invoices <i@mg.example.test>");
});

test("parameters: a hidden one from the page, an unknown one, a quote and a missing value are refused", () => {
  const resolved = resolveParameters(bundle(), { UpbrainsFlowId: "x", Colour: "blue", MailgunSubject: 'say "hi"' }, ENV);
  assert.deepEqual(resolved.issues, [
    { code: "server_parameter", parameter: "UpbrainsFlowId" },
    { code: "unknown_parameter", parameter: "Colour" },
    { code: "invalid_parameter", parameter: "MailgunSubject", message: "MailgunSubject must not contain quotes, backslashes or control characters." },
    { code: "missing_parameter", parameter: "MailgunTo" },
  ]);
  assert.deepEqual(resolveParameters(bundle(), { MailgunTo: "b@example.test" }, { bucket: "b" }).server_missing, ["UpbrainsFlowId"]);
  assert.deepEqual(resolveParameters(bundle(), { MailgunTo: "b@example.test" }, { bucket: "b", upbrainsWebhookUrl: ENV.upbrainsWebhookUrl }).issues,
    [{ code: "missing_parameter", parameter: "MailgunDomainName" }, { code: "missing_parameter", parameter: "MailgunFrom" }],
    "without MAILGUN_DOMAIN the domain and the sender must be chosen");
});

test("parameters: Upbrains' flow id is read from the webhook address with or without /sync, as the site reads it", () => {
  const flowId = (upbrainsWebhookUrl: string) => resolveParameters(bundle(), { MailgunTo: "b@example.test" }, { ...ENV, upbrainsWebhookUrl }).values.UpbrainsFlowId;
  assert.equal(flowId("https://agents.upbrains.ai/v1/webhooks/Ab_9-z"), "Ab_9-z");
  assert.equal(flowId("https://agents.upbrains.ai/v1/webhooks/Ab_9-z/sync"), "Ab_9-z");
  assert.equal(flowId(" https://agents.upbrains.ai/v1/webhooks/Ab_9-z/sync/ "), "Ab_9-z");
  assert.equal(flowId("https://ai.upbrains.ai/api/v1/webhooks/flow-123/sync"), "flow-123");
  assert.deepEqual(resolveParameters(bundle(), { MailgunTo: "b@example.test" }, { ...ENV, upbrainsWebhookUrl: "https://agents.upbrains.ai/v1/flows/x" }).server_missing,
    ["UpbrainsFlowId"], "an address without /webhooks/<id> gives no flow id");
});

test("recipients: the admin's own address or the allow-list, as for a composed invoice sent by email", () => {
  const values = { MailgunTo: "B@Example.test", MailgunSubject: "Invoice" };
  assert.deepEqual(refusedRecipients(values, "b@example.test", ENV), [], "the admin's own address, in any case");
  assert.deepEqual(refusedRecipients(values, "a@example.test", ENV), ["MailgunTo"]);
  assert.deepEqual(refusedRecipients(values, null, { ...ENV, allowedRecipients: ["b@example.test"] }), []);
  assert.deepEqual(refusedRecipients({ MailgunTo: "a@example.test, b@example.test" }, "b@example.test", ENV), ["MailgunTo"], "one address, not a list");
  assert.deepEqual(refusedRecipients({ ESSFilename: "invoice.xml" }, null, ENV), [], "a workflow that emails no one");
});

test("packaging: each function zipped with readable files, the definition and the template on S3, keyed by content", () => {
  const workflow = bundle();
  const packaged = packageDeployment(workflow, ENV.bucket, "ap-southeast-2");
  assert.equal(packaged.stack, STACK);
  assert.equal(packaged.artifacts.length, workflow.lambdas.length + 2);
  const template = JSON.parse(packaged.artifacts.at(-1)!.body.toString("utf8"));
  for (const lambda of workflow.lambdas) {
    const uri = template.Resources[lambda.logical_id].Properties.CodeUri;
    assert.equal(uri.Bucket, ENV.bucket);
    assert.match(uri.Key, new RegExp(`^${STACK}/functions/${lambda.function_name}-[0-9a-f]{16}\\.zip$`));
    const zip = packaged.artifacts.find((artifact) => artifact.key === uri.Key)!.body;
    const files = entries(zip);
    assert.deepEqual(files.map((file) => file.name), lambda.files.map((file) => file.path));
    assert.ok(files.every((file) => file.mode === 0o100644), "made by Unix, mode 0644");
  }
  assert.match(template.Resources.Workflow.Properties.DefinitionUri.Key, new RegExp(`^${STACK}/statemachine-[0-9a-f]{16}\\.asl\\.json$`));
  assert.ok(template.Resources.Workflow.Properties.DefinitionSubstitutions.Step01FunctionArn, "the ARNs are still filled in by CloudFormation");
  assert.match(packaged.template_url, new RegExp(`^https://${ENV.bucket}\\.s3\\.ap-southeast-2\\.amazonaws\\.com/${STACK}/template-[0-9a-f]{16}\\.json$`));
  assert.deepEqual(packageDeployment(workflow, ENV.bucket, "ap-southeast-2").artifacts.map((a) => a.key), packaged.artifacts.map((a) => a.key),
    "the same workflow packages to the same keys");
});

test("a first deployment uploads, creates the stack's change set and executes it once it is ready", async () => {
  const aws = new FakeAws();
  aws.secrets = new Set(["bp-builder/ess", "bp-builder/mailgun"]);
  aws.preparation = [{ status: "CREATE_IN_PROGRESS", execution_status: "UNAVAILABLE" }, { status: "CREATE_COMPLETE", execution_status: "AVAILABLE" }];
  const sleeps: number[] = [];
  const outcome = await startDeployment(aws, bundle(), values(), ENV, { now: () => new Date("2026-10-27T03:00:00Z"), sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(outcome, {
    ok: true,
    deployment: { deployment_id: STACK, stack_name: STACK, state_machine_name: "BP-Upbrains-AmitTransform-ESS-Mailgun", status: "in_progress", started_at: "2026-10-27T03:00:00.000Z" },
  });
  assert.equal(aws.objects.size, bundle().lambdas.length + 2);
  assert.ok([...aws.objects.keys()].every((key) => key.startsWith(`${ENV.bucket}/${STACK}/`)));
  assert.equal(aws.created.length, 1);
  assert.equal(aws.created[0].type, "CREATE");
  assert.equal(aws.created[0].name, "bp-deploy-20261027030000");
  assert.equal(aws.created[0].parameters.UpbrainsFlowId, "flow-123");
  assert.deepEqual(aws.executed, ["bp-deploy-20261027030000"]);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(aws.stacks.get(STACK)!.status, "CREATE_IN_PROGRESS");
});

test("a deployed workflow is updated; the same code and parameters again change nothing", async () => {
  const aws = new FakeAws().stack(STACK, "CREATE_COMPLETE");
  aws.secrets = new Set(["bp-builder/ess", "bp-builder/mailgun"]);
  const updated = await startDeployment(aws, bundle(), values(), ENV, { sleep: async () => {} });
  assert.equal(updated.ok && updated.deployment.status, "in_progress");
  assert.equal(aws.created[0].type, "UPDATE");

  const again = new FakeAws().stack(STACK, "UPDATE_COMPLETE");
  again.secrets = aws.secrets;
  again.preparation = [{ status: "FAILED", execution_status: "UNAVAILABLE", reason: "The submitted information didn't contain changes. Submit different information to create a change set." }];
  const unchanged = await startDeployment(again, bundle(), values(), ENV, { sleep: async () => {} });
  assert.equal(unchanged.ok && unchanged.deployment.status, "succeeded");
  assert.deepEqual(again.executed, []);
  assert.deepEqual(again.changeSets.get(STACK), [], "the empty change set is removed");
});

test("a busy stack, a pending change set or a failed first creation is 409; a missing secret is 412; nothing is uploaded", async () => {
  for (const [status, code] of [["UPDATE_IN_PROGRESS", "in_progress"], ["DELETE_IN_PROGRESS", "in_progress"], ["ROLLBACK_COMPLETE", "delete_first"]]) {
    const aws = new FakeAws().stack(STACK, status);
    const outcome = await startDeployment(aws, bundle(), values(), ENV);
    assert.equal(!outcome.ok && outcome.status, 409, status);
    assert.deepEqual(!outcome.ok && outcome.status === 409 && outcome.details, { deployment_id: STACK, stack_status: status, code });
    assert.equal(aws.objects.size, 0);
  }
  const pending = new FakeAws().stack(STACK, "UPDATE_COMPLETE");
  pending.changeSets.set(STACK, [{ name: "bp-deploy-1", status: "CREATE_IN_PROGRESS", execution_status: "UNAVAILABLE", reason: null, created: "" }]);
  assert.equal((await startDeployment(pending, bundle(), values(), ENV) as { status: number }).status, 409);

  const noSecrets = new FakeAws();
  noSecrets.secrets = new Set(["bp-builder/ess"]);
  const outcome = await startDeployment(noSecrets, bundle(), values(), ENV);
  assert.equal(!outcome.ok && outcome.status, 412);
  assert.deepEqual(!outcome.ok && outcome.details, [{
    code: "missing_secret",
    secret: "bp-builder/mailgun",
    how: 'read -rs VALUE && aws secretsmanager create-secret --name bp-builder/mailgun --secret-string "$VALUE"; unset VALUE',
  }]);
  assert.equal(noSecrets.objects.size, 0);
  assert.equal(noSecrets.created.length, 0);
});

test("a change set CloudFormation cannot prepare is an AWS error with its reason", async () => {
  const aws = new FakeAws();
  aws.secrets = new Set(["bp-builder/ess", "bp-builder/mailgun"]);
  aws.preparation = [{ status: "FAILED", execution_status: "UNAVAILABLE", reason: "Requires capabilities : [CAPABILITY_NAMED_IAM]" }];
  await assert.rejects(startDeployment(aws, bundle(), values(), ENV, { sleep: async () => {} }),
    (error: unknown) => error instanceof AwsError && error.service === "cloudformation" && /CAPABILITY_NAMED_IAM/.test(error.message));
});

test("a change set a status poll executed first is not an error: the deployment goes on", async () => {
  const aws = new FakeAws();
  aws.secrets = new Set(["bp-builder/ess", "bp-builder/mailgun"]);
  aws.failExecute = new AwsError("cloudformation", "InvalidChangeSetStatus", "ChangeSet [bp-deploy-1] cannot be executed in its current execution status of [EXECUTE_IN_PROGRESS]");
  const outcome = await startDeployment(aws, bundle(), values(), ENV, { sleep: async () => {} });
  assert.equal(outcome.ok && outcome.deployment.status, "in_progress");

  const refused = new FakeAws();
  refused.secrets = aws.secrets;
  refused.failExecute = new AwsError("cloudformation", "AccessDenied", "not authorized to perform: cloudformation:ExecuteChangeSet");
  await assert.rejects(startDeployment(refused, bundle(), values(), ENV, { sleep: async () => {} }),
    (error: unknown) => error instanceof AwsError && error.code === "AccessDenied", "any other refusal still fails the request");
});

test("a change set still being prepared after the wait is executed by the next status poll", async () => {
  const aws = new FakeAws();
  aws.secrets = new Set(["bp-builder/ess", "bp-builder/mailgun"]);
  aws.preparation = [{ status: "CREATE_IN_PROGRESS", execution_status: "UNAVAILABLE" }];
  const outcome = await startDeployment(aws, bundle(), values(), ENV, { sleep: async () => {}, wait_ms: 4_000 });
  assert.equal(outcome.ok && outcome.deployment.status, "in_progress");
  assert.deepEqual(aws.executed, []);

  const preparing = await deploymentStatus(aws, STACK);
  assert.equal(preparing?.status, "in_progress");
  assert.deepEqual(aws.executed, []);
  aws.changeSets.get(STACK)![0] = { ...aws.changeSets.get(STACK)![0], status: "CREATE_COMPLETE", execution_status: "AVAILABLE" };
  const ready = await deploymentStatus(aws, STACK);
  assert.equal(ready?.status, "in_progress");
  assert.equal(aws.executed.length, 1);
  assert.equal(aws.stacks.get(STACK)!.status, "CREATE_IN_PROGRESS");
});

test("status: a finished stack gives the state machine, its console link and each function by its state name", () => {
  const arn = "arn:aws:states:ap-southeast-2:803964123922:stateMachine:BP-Upbrains-AmitTransform-ESS-Mailgun";
  const view = deploymentView({
    name: STACK, status: "CREATE_COMPLETE", reason: null,
    outputs: {
      StateMachineArn: { value: arn, description: "Start executions of the workflow here." },
      Step02FunctionName: { value: "bpf73b94-02-AdapterUpbrainsToAmitTransform", description: "02 Adapter Upbrains to AmitTransform" },
      Step01FunctionName: { value: "bpf73b94-01-UpbrainsExtractInvoiceFromPDF", description: "01 Upbrains Extract Invoice From PDF" },
    },
  }, [{ time: "2026-10-27T03:02:00.000Z", resource: STACK, status: "CREATE_COMPLETE", reason: null }], "ap-southeast-2", []);
  assert.equal(view.status, "succeeded");
  assert.equal(view.phase, "done");
  assert.equal(view.state_machine_arn, arn);
  assert.equal(view.console_url, `https://ap-southeast-2.console.aws.amazon.com/states/home?region=ap-southeast-2#/statemachines/view/${arn}`);
  assert.deepEqual(view.functions, [
    { state_name: "01 Upbrains Extract Invoice From PDF", function_name: "bpf73b94-01-UpbrainsExtractInvoiceFromPDF", arn: "arn:aws:lambda:ap-southeast-2:803964123922:function:bpf73b94-01-UpbrainsExtractInvoiceFromPDF" },
    { state_name: "02 Adapter Upbrains to AmitTransform", function_name: "bpf73b94-02-AdapterUpbrainsToAmitTransform", arn: "arn:aws:lambda:ap-southeast-2:803964123922:function:bpf73b94-02-AdapterUpbrainsToAmitTransform" },
  ]);
  assert.equal(view.error, null);
});

test("status: a failed deployment names the resource that failed first; a stack never started or being deleted is said so", () => {
  const events = [
    { time: "4", resource: STACK, status: "ROLLBACK_COMPLETE", reason: null },
    { time: "3", resource: "Step02Function", status: "CREATE_FAILED", reason: "Resource creation cancelled" },
    { time: "2", resource: STACK, status: "CREATE_FAILED", reason: "The following resource(s) failed to create: [Step05FunctionRole]." },
    { time: "1", resource: "Step05FunctionRole", status: "CREATE_FAILED", reason: "User is not authorized to perform: iam:CreateRole" },
  ];
  const failed = deploymentView({ name: STACK, status: "ROLLBACK_COMPLETE", reason: null, outputs: {} }, events, "ap-southeast-2", []);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { message: "User is not authorized to perform: iam:CreateRole", resource: "Step05FunctionRole" });
  assert.equal(failed.events.length, 4);

  const never = deploymentView({ name: STACK, status: "REVIEW_IN_PROGRESS", reason: null, outputs: {} }, [], "ap-southeast-2",
    [{ name: "bp-deploy-1", status: "FAILED", execution_status: "UNAVAILABLE", reason: "Template format error", created: "" }]);
  assert.equal(never.status, "failed");
  assert.deepEqual(never.error, { message: "Template format error", resource: null });

  const building = deploymentView({ name: STACK, status: "CREATE_IN_PROGRESS", reason: null, outputs: {} }, [], "ap-southeast-2", []);
  assert.deepEqual([building.status, building.phase], ["in_progress", "creating_stack"]);
  const deleting = deploymentView({ name: STACK, status: "DELETE_IN_PROGRESS", reason: null, outputs: {} }, [], "ap-southeast-2", []);
  assert.deepEqual([deleting.status, deleting.phase], ["in_progress", "deleting"]);
});

test("deleting: no stack is 404, a busy one 409, otherwise the stack is deleted", async () => {
  assert.deepEqual(await deleteDeployment(new FakeAws(), STACK), { ok: false, status: 404, error: "There is no such deployment." });
  assert.equal((await deleteDeployment(new FakeAws().stack(STACK, "UPDATE_IN_PROGRESS"), STACK) as { status: number }).status, 409);
  const aws = new FakeAws().stack(STACK, "ROLLBACK_COMPLETE");
  assert.deepEqual(await deleteDeployment(aws, STACK), { ok: true, deployment_id: STACK });
  assert.deepEqual(aws.deleted, [STACK]);
  assert.equal(await deploymentStatus(new FakeAws(), STACK), null);
});

test("the stored invoice bucket is supplied by the server, never redirected by the page", () => {
  const resolved = resolveParameters(bundle(), { WorkflowInputBucket: "another-bucket", MailgunTo: "b@example.test" }, ENV);
  assert.ok(resolved.issues.some((issue) => issue.code === "server_parameter" && issue.parameter === "WorkflowInputBucket"));
  assert.equal(resolved.values.WorkflowInputBucket, ENV.bucket);
});
