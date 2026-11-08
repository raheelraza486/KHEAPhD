/**
 * `DeployAws` with the AWS SDK (#135). Credentials come from the SDK's default
 * chain: on the live site, the ECS task role; nothing here reads a key. Every
 * failed call becomes an `AwsError` carrying the service and AWS's own message.
 */
import "server-only";

import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  ListChangeSetsCommand,
} from "@aws-sdk/client-cloudformation";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  DescribeExecutionCommand,
  DescribeStateMachineForExecutionCommand,
  GetExecutionHistoryCommand,
  SFNClient,
  StartExecutionCommand,
  type HistoryEvent,
} from "@aws-sdk/client-sfn";

import { validationFailureMessage } from "./validation-report.ts";

import { AwsError, isAwsError, type ChangeSetView, type DeployAws, type HistoryEventView } from "./types.ts";

export const DEFAULT_REGION = "ap-southeast-2";
const HISTORY_PAGES = 10;

function iso(value: Date | undefined): string {
  return (value ?? new Date(0)).toISOString();
}

function errorName(error: unknown): string {
  return (error as { name?: string })?.name ?? "Error";
}

async function call<T>(service: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAwsError(error)) throw error;
    throw new AwsError(service, errorName(error), error instanceof Error ? error.message : String(error));
  }
}

/** CloudFormation answers a missing stack with a ValidationError naming it. */
function missingStack(error: unknown): boolean {
  return errorName(error) === "ValidationError" && /does not exist/i.test((error as Error).message ?? "");
}

function changeSetView(item: {
  ChangeSetName?: string; Status?: string; ExecutionStatus?: string; StatusReason?: string; CreationTime?: Date;
}): ChangeSetView {
  return {
    name: item.ChangeSetName ?? "",
    status: item.Status ?? "",
    execution_status: item.ExecutionStatus ?? "",
    reason: item.StatusReason ?? null,
    created: iso(item.CreationTime),
  };
}

/** The state and the error of a history event, from whichever details it carries. */
function historyView(event: HistoryEvent): HistoryEventView {
  const details = Object.entries(event).filter(([key]) => key.endsWith("EventDetails")).map(([, value]) => value as Record<string, unknown>);
  const pick = (key: string) => details.map((detail) => detail?.[key]).find((value) => typeof value === "string") as string | undefined;
  return {
    id: event.id ?? 0,
    type: event.type ?? "",
    timestamp: iso(event.timestamp),
    state: event.stateEnteredEventDetails?.name ?? event.stateExitedEventDetails?.name ?? null,
    error: pick("error") ?? null,
    cause: pick("cause") ?? (event.stateEnteredEventDetails?.name === "Validation failed"
      ? validationFailureMessage(event.stateEnteredEventDetails.input) : null),
  };
}

let shared: DeployAws | undefined;

/** One set of clients for the server's lifetime. */
export function deployAws(): DeployAws {
  shared ??= createDeployAws();
  return shared;
}

export function createDeployAws(region = process.env.AWS_REGION || DEFAULT_REGION): DeployAws {
  const cloudformation = new CloudFormationClient({ region });
  const s3 = new S3Client({ region });
  const secrets = new SecretsManagerClient({ region });
  const sfn = new SFNClient({ region });

  return {
    region,

    describeStack: (name) => call("cloudformation", async () => {
      try {
        const stack = (await cloudformation.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
        if (!stack) return null;
        return {
          name: stack.StackName ?? name,
          status: stack.StackStatus ?? "",
          reason: stack.StackStatusReason ?? null,
          outputs: Object.fromEntries((stack.Outputs ?? []).map((output) => [
            output.OutputKey ?? "",
            { value: output.OutputValue ?? "", description: output.Description ?? null },
          ])),
        };
      } catch (error) {
        if (missingStack(error)) return null;
        throw error;
      }
    }),

    stackEvents: (name, limit) => call("cloudformation", async () => {
      const events = (await cloudformation.send(new DescribeStackEventsCommand({ StackName: name }))).StackEvents ?? [];
      return events.slice(0, limit).map((event) => ({
        time: iso(event.Timestamp),
        resource: event.LogicalResourceId ?? "",
        status: event.ResourceStatus ?? "",
        reason: event.ResourceStatusReason ?? null,
      }));
    }),

    listChangeSets: (stack) => call("cloudformation", async () => {
      try {
        return ((await cloudformation.send(new ListChangeSetsCommand({ StackName: stack }))).Summaries ?? []).map(changeSetView);
      } catch (error) {
        if (missingStack(error)) return [];
        throw error;
      }
    }),

    describeChangeSet: (stack, name) => call("cloudformation", async () =>
      changeSetView(await cloudformation.send(new DescribeChangeSetCommand({ StackName: stack, ChangeSetName: name })))),

    createChangeSet: ({ stack, name, type, templateUrl, parameters }) => call("cloudformation", async () => {
      await cloudformation.send(new CreateChangeSetCommand({
        StackName: stack,
        ChangeSetName: name,
        ChangeSetType: type,
        TemplateURL: templateUrl,
        Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
        // SAM creates one role per function and one for the state machine; the transform is a macro.
        Capabilities: ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"],
        Description: "Deployed from the BP-Builder (#135).",
      }));
    }),

    executeChangeSet: (stack, name) => call("cloudformation", async () => {
      await cloudformation.send(new ExecuteChangeSetCommand({ StackName: stack, ChangeSetName: name }));
    }),

    deleteChangeSet: (stack, name) => call("cloudformation", async () => {
      await cloudformation.send(new DeleteChangeSetCommand({ StackName: stack, ChangeSetName: name }));
    }),

    deleteStack: (name) => call("cloudformation", async () => {
      await cloudformation.send(new DeleteStackCommand({ StackName: name }));
    }),

    secretExists: (name) => call("secretsmanager", async () => {
      try {
        await secrets.send(new DescribeSecretCommand({ SecretId: name }));
        return true;
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return false;
        throw error;
      }
    }),

    putObject: (bucket, key, body, contentType) => call("s3", async () => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "AES256" }));
    }),

    startExecution: (stateMachineArn, name, input) => call("states", async () =>
      (await sfn.send(new StartExecutionCommand({ stateMachineArn, name, input }))).executionArn ?? ""),

    describeExecution: (arn) => call("states", async () => {
      try {
        const execution = await sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
        return {
          status: execution.status ?? "",
          state_machine_arn: execution.stateMachineArn ?? "",
          output: execution.output ?? null,
          error: execution.error ?? null,
          cause: execution.cause ?? null,
          started_at: iso(execution.startDate),
          stopped_at: execution.stopDate ? iso(execution.stopDate) : null,
        };
      } catch (error) {
        if (errorName(error) === "ExecutionDoesNotExist") return null;
        throw error;
      }
    }),

    executionHistory: (arn, includeValidationDetails = false) => call("states", async () => {
      const events: HistoryEventView[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < HISTORY_PAGES; page += 1) {
        // Only fetch state data for a finished validation failure. Reduce it immediately
        // to findings; invoice inputs and extraction results never leave historyView.
        const answer = await sfn.send(new GetExecutionHistoryCommand({ executionArn: arn, maxResults: 1000, includeExecutionData: includeValidationDetails, nextToken }));
        events.push(...(answer.events ?? []).map(historyView));
        nextToken = answer.nextToken;
        if (!nextToken) break;
      }
      return events;
    }),

    executionDefinition: (arn) => call("states", async () =>
      (await sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: arn }))).definition ?? "{}"),
  };
}
