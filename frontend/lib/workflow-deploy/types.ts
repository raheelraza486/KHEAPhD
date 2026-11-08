/**
 * The AWS calls behind one-click deployment (#135), as the deployment and
 * trial-run code sees them. `aws.ts` implements them with the AWS SDK; the
 * tests use an in-memory fake, so nothing here needs AWS to be tested.
 */

export interface StackView {
  name: string;
  /** CloudFormation's stack status, e.g. CREATE_COMPLETE. */
  status: string;
  reason: string | null;
  outputs: Record<string, { value: string; description: string | null }>;
}

export interface StackEventView {
  time: string;
  /** The template's logical id, or the stack's own name for the stack itself. */
  resource: string;
  status: string;
  reason: string | null;
}

export interface ChangeSetView {
  name: string;
  /** CREATE_PENDING, CREATE_IN_PROGRESS, CREATE_COMPLETE, DELETE_*, FAILED. */
  status: string;
  /** AVAILABLE, UNAVAILABLE, EXECUTE_IN_PROGRESS, EXECUTE_COMPLETE, EXECUTE_FAILED, OBSOLETE. */
  execution_status: string;
  reason: string | null;
  created: string;
}

export interface ExecutionDescription {
  /** RUNNING, SUCCEEDED, FAILED, TIMED_OUT, ABORTED, PENDING_REDRIVE. */
  status: string;
  state_machine_arn: string;
  /** The final output, when it succeeded. */
  output: string | null;
  error: string | null;
  cause: string | null;
  started_at: string;
  stopped_at: string | null;
}

/** One Step Functions history event, reduced to what the canvas needs. */
export interface HistoryEventView {
  id: number;
  type: string;
  timestamp: string;
  /** The state, for a StateEntered or StateExited event. */
  state: string | null;
  error: string | null;
  cause: string | null;
}

export interface DeployAws {
  region: string;
  describeStack(name: string): Promise<StackView | null>;
  /** The latest stack events, newest first. */
  stackEvents(name: string, limit: number): Promise<StackEventView[]>;
  listChangeSets(stack: string): Promise<ChangeSetView[]>;
  describeChangeSet(stack: string, name: string): Promise<ChangeSetView>;
  createChangeSet(input: {
    stack: string;
    name: string;
    type: "CREATE" | "UPDATE";
    templateUrl: string;
    parameters: Record<string, string>;
  }): Promise<void>;
  executeChangeSet(stack: string, name: string): Promise<void>;
  deleteChangeSet(stack: string, name: string): Promise<void>;
  deleteStack(name: string): Promise<void>;
  /** Whether the secret exists; its value is never read. */
  secretExists(name: string): Promise<boolean>;
  putObject(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  startExecution(stateMachineArn: string, name: string, input: string): Promise<string>;
  describeExecution(arn: string): Promise<ExecutionDescription | null>;
  /** Reduced history, oldest first; optional validation findings, never raw invoice data. */
  executionHistory(arn: string, includeValidationDetails?: boolean): Promise<HistoryEventView[]>;
  /** The definition the execution ran, as JSON text. */
  executionDefinition(arn: string): Promise<string>;
}

/** An AWS call that failed; the route answers 502 with the service and AWS's own message. */
export class AwsError extends Error {
  readonly service: string;
  readonly code: string;

  constructor(service: string, code: string, message: string) {
    super(message);
    this.name = "AwsError";
    this.service = service;
    this.code = code;
  }
}

/** By its name rather than instanceof, so an error from another copy of this module is recognised too. */
export function isAwsError(error: unknown): error is AwsError {
  return error instanceof Error && error.name === "AwsError" && typeof (error as AwsError).service === "string";
}
