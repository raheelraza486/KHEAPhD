/**
 * Where each field of a step's request comes from, for the canvas's Step tab:
 * the document from an earlier state, a fixed value, a deploy-time parameter,
 * a Secrets Manager secret, or nothing (an optional field that is not sent).
 * It reads only what the generator returned (the call plan, the environment
 * and the stored request's fields), so it shows what the Lambda will send.
 */
import type { AslDefinition, WorkflowLambdaView } from "./graph.ts";

export type InputSource = "document" | "fixed" | "parameter" | "secret" | "not_sent" | "no_schema";

export interface StepInput {
  field: string;
  source: InputSource;
  detail: string;
}

/** The state whose result a task reads through its InputPath ("$.completed" → the state that wrote "completed"). */
export function producerOf(definition: AslDefinition, stateName: string): string | null {
  const path = definition.States[stateName]?.InputPath;
  if (typeof path !== "string" || !path.startsWith("$.")) return null;
  const key = path.slice(2).split(".")[0];
  for (const [name, state] of Object.entries(definition.States)) {
    if (state.ResultPath === `$.${key}`) return name;
    const selector = state.ResultSelector;
    if (state.ResultPath === "$" && selector && typeof selector === "object" && !Array.isArray(selector) && key in selector) return name;
  }
  return null;
}

/** `{"from":"${MailgunFrom}"}` → [["from", "MailgunFrom"]]. */
function settingParameters(requestFields: string | undefined): Array<[string, string]> {
  return [...(requestFields ?? "").matchAll(/"([^"]+)":"\$\{([A-Za-z0-9]+)\}"/g)].map((match) => [match[1], match[2]]);
}

export function stepInputs(lambda: WorkflowLambdaView, definition: AslDefinition, stateName: string): StepInput[] {
  const plan = lambda.call;
  if (!plan) return [];
  const rows: StepInput[] = [];
  const producer = producerOf(definition, stateName);
  const from = producer ? `the document from ${producer}` : "the execution input (the invoice you start the run with)";

  const documentField = plan.request.kind === "body" ? "(request body)" : plan.request.field ?? "(request body)";
  const how = { body: "as the raw body", file: "as a file in a multipart form", base64: "base64-encoded", json: "as JSON" }[plan.request.kind];
  rows.push({ field: documentField, source: "document", detail: `${from}, ${how}` });

  for (const [field, value] of Object.entries(plan.request.fixed)) {
    rows.push({ field, source: "fixed", detail: `always ${JSON.stringify(value)}` });
  }
  const settings = new Map(settingParameters(lambda.environment.REQUEST_FIELDS));
  for (const field of plan.request.required) {
    const parameter = settings.get(field);
    rows.push({ field, source: "parameter", detail: parameter ? `deploy parameter ${parameter}` : "set REQUEST_FIELDS when deploying" });
  }
  for (const match of (lambda.environment.API_ENDPOINT ?? "").matchAll(/\$\{([A-Za-z0-9]+)\}/g)) {
    rows.push({ field: "endpoint address", source: "parameter", detail: `deploy parameter ${match[1]}` });
  }
  if (lambda.secret) {
    const header = lambda.environment.API_KEY_HEADER ?? "Authorization";
    rows.push({ field: header, source: "secret", detail: `Secrets Manager secret ${lambda.secret}, read when the function runs` });
  }

  if (!plan.from_schema.request) {
    rows.push({ field: "(no stored request schema)", source: "no_schema", detail: "the document is sent as the JSON body, which is a guess" });
  } else {
    // The optional fields the function leaves out, once each ("bcc" and "bcc[]" are one field), in one row.
    const used = new Set([documentField, ...Object.keys(plan.request.fixed), ...plan.request.required]);
    const skipped = [...new Set((lambda.request_fields ?? []).filter((field) => !field.required && !used.has(field.name)).map((field) => field.name))];
    if (skipped.length) {
      const shown = skipped.slice(0, 6).join(", ");
      rows.push({
        field: `${skipped.length} optional field${skipped.length === 1 ? "" : "s"}`, source: "not_sent",
        detail: `not sent: ${shown}${skipped.length > 6 ? ` and ${skipped.length - 6} more` : ""}`,
      });
    }
  }
  return rows;
}
