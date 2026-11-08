import {
  AwsError,
  type ChangeSetView,
  type DeployAws,
  type ExecutionDescription,
  type HistoryEventView,
  type StackEventView,
  type StackView,
} from "../../lib/workflow-deploy/types.ts";

/** AWS in memory: stacks, change sets, secrets, S3 objects and executions, with every call recorded. */
export class FakeAws implements DeployAws {
  region = "ap-southeast-2";
  stacks = new Map<string, StackView>();
  changeSets = new Map<string, ChangeSetView[]>();
  events = new Map<string, StackEventView[]>();
  secrets = new Set<string>();
  objects = new Map<string, { body: Uint8Array; content_type: string }>();
  created: Array<{ stack: string; name: string; type: "CREATE" | "UPDATE"; templateUrl: string; parameters: Record<string, string> }> = [];
  executed: string[] = [];
  deleted: string[] = [];
  started: Array<{ machine: string; name: string; input: string }> = [];
  executions = new Map<string, { description: ExecutionDescription; history: HistoryEventView[]; definition: string }>();
  /** What describeChangeSet answers, one per call; the last one repeats. */
  preparation: Array<Pick<ChangeSetView, "status" | "execution_status"> & { reason?: string }> = [{ status: "CREATE_COMPLETE", execution_status: "AVAILABLE" }];
  /** Thrown by the next putObject, to test a refused upload. */
  failUpload: AwsError | null = null;
  /** Thrown by executeChangeSet, to test a change set another request executed first. */
  failExecute: AwsError | null = null;

  stack(name: string, status: string, outputs: StackView["outputs"] = {}) {
    this.stacks.set(name, { name, status, reason: null, outputs });
    return this;
  }

  async describeStack(name: string) {
    return this.stacks.get(name) ?? null;
  }

  async stackEvents(name: string, limit: number) {
    return (this.events.get(name) ?? []).slice(0, limit);
  }

  async listChangeSets(stack: string) {
    return [...(this.changeSets.get(stack) ?? [])];
  }

  async describeChangeSet(stack: string, name: string) {
    const next = this.preparation.length > 1 ? this.preparation.shift()! : this.preparation[0];
    const sets = this.changeSets.get(stack) ?? [];
    const set = sets.find((item) => item.name === name);
    if (!set) throw new AwsError("cloudformation", "ChangeSetNotFoundException", `${name} does not exist`);
    Object.assign(set, { status: next.status, execution_status: next.execution_status, reason: next.reason ?? null });
    return { ...set };
  }

  async createChangeSet(input: { stack: string; name: string; type: "CREATE" | "UPDATE"; templateUrl: string; parameters: Record<string, string> }) {
    this.created.push(input);
    if (input.type === "CREATE" && !this.stacks.has(input.stack)) this.stack(input.stack, "REVIEW_IN_PROGRESS");
    const sets = this.changeSets.get(input.stack) ?? [];
    sets.push({ name: input.name, status: "CREATE_PENDING", execution_status: "UNAVAILABLE", reason: null, created: new Date().toISOString() });
    this.changeSets.set(input.stack, sets);
  }

  async executeChangeSet(stack: string, name: string) {
    if (this.failExecute) throw this.failExecute;
    this.executed.push(name);
    const view = this.stacks.get(stack)!;
    view.status = view.status === "REVIEW_IN_PROGRESS" ? "CREATE_IN_PROGRESS" : "UPDATE_IN_PROGRESS";
    this.changeSets.set(stack, []);
  }

  async deleteChangeSet(stack: string, name: string) {
    this.changeSets.set(stack, (this.changeSets.get(stack) ?? []).filter((set) => set.name !== name));
  }

  async deleteStack(name: string) {
    this.deleted.push(name);
    this.stacks.get(name)!.status = "DELETE_IN_PROGRESS";
  }

  async secretExists(name: string) {
    return this.secrets.has(name);
  }

  async putObject(bucket: string, key: string, body: Uint8Array, contentType: string) {
    if (this.failUpload) throw this.failUpload;
    this.objects.set(`${bucket}/${key}`, { body, content_type: contentType });
  }

  async startExecution(machine: string, name: string, input: string) {
    this.started.push({ machine, name, input });
    return `${machine.replace(":stateMachine:", ":execution:")}:${name}`;
  }

  async describeExecution(arn: string) {
    return this.executions.get(arn)?.description ?? null;
  }

  async executionHistory(arn: string) {
    return this.executions.get(arn)?.history ?? [];
  }

  async executionDefinition(arn: string) {
    return this.executions.get(arn)?.definition ?? "{}";
  }
}
