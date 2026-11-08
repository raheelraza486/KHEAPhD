"use client";

import { invoiceFailureHint } from "@/lib/composition/invoice-run-options";
import { useEffect, useRef, useState } from "react";
import { RECIPIENTS } from "@/components/composed-invoice-workspace";
import {
  DEMO_SELLER_ABN, MAX_RUN_FILE_BYTES, RUNNING, SERVER_FILLED, deleteDeployment, isRecipientParameter, deployParameters, getDeployment, getExecution,
  runOptions, runStates, startDeployment, startExecution, type DeployParameterView, type Deployment, type Execution, type Failure, type RunState,
} from "@/lib/workflow-canvas/deployment";
import styles from "./workflow-canvas.module.css";

/**
 * The Export tab's Deploy to AWS (#135) and Run on AWS sections. The page
 * sends the chain and the visible deploy parameters; the service deploys the
 * same package the ZIP holds, fills in the hidden parameters itself and reads
 * every credential from Secrets Manager. A run's state history colours the
 * canvas, step by step. A deployment can be deleted again from here, which a
 * failed first deployment needs before it can be deployed again.
 */

export interface DeployBundle {
  name: string;
  stack_name?: string;
  parameters?: DeployParameterView[];
  secrets?: Array<{ name: string; apis: string[]; value: string }>;
  files: Array<{ path: string }>;
}

export type DeployView =
  | { status: "unknown" }
  | { status: "unavailable"; message?: string }
  | { status: "none" }
  | { status: "deployment"; deployment: Deployment };

const DEPLOY_POLL_MS = 3000;
const RUN_POLL_MS = 2000;

const PHASE: Record<NonNullable<Deployment["phase"]>, string> = {
  creating_stack: "CloudFormation is creating the functions and the state machine",
  deleting: "CloudFormation is deleting the functions, their roles and the state machine",
  done: "Finished",
};

/** Today in the browser's time zone, as an input date (YYYY-MM-DD). */
function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** A parameter's description as a sentence: capitalised and ending in a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

const UNAVAILABLE = "Deploying from the site is not set up on this server yet. Download the ZIP above and follow its README.";

function failureText(failure: Failure): string {
  switch (failure.kind) {
    case "unavailable": return UNAVAILABLE;
    case "not_configured": return `${failure.message} Download the ZIP above and follow its README.`;
    case "not_found": return "There is no deployment of this workflow yet.";
    case "signed_out": return "Sign in as an administrator to deploy.";
    case "forbidden": return failure.message ?? "Only administrators can deploy from the site.";
    case "recipient_not_allowed": return `${failure.message} Change ${failure.parameters.join(", ")}.`;
    case "rate_limited": return `At most five trial runs a minute, since each one really sends.${failure.retry_after_seconds ? ` Try again in ${failure.retry_after_seconds} second${failure.retry_after_seconds === 1 ? "" : "s"}.` : " Try again shortly."}`;
    case "missing_parameters": return `Fill in ${failure.parameters.join(", ")} first.`;
    case "missing_secrets": return `${failure.message} Missing: ${failure.secrets.map((item) => item.secret).join(", ")}.`;
    case "busy": return failure.code === "delete_first"
      ? "The last deployment of this workflow failed and left a stack behind. Delete it below, then deploy again."
      : "This workflow is already being deployed or deleted; its progress is shown below.";
    default: return failure.message;
  }
}

export default function DeployPanel({
  chainIds, chainStatus, name, bundle, stale, canDeploy, accountEmail, stateNames, onRunStates, onView,
}: {
  chainIds: string[];
  chainStatus: "feasible" | "needs_decision";
  name?: string;
  bundle: DeployBundle | null;
  stale: boolean;
  canDeploy: boolean;
  /** The signed-in admin's address: the one recipient the service always accepts. */
  accountEmail?: string;
  stateNames: string[];
  onRunStates: (states: Record<string, RunState> | null) => void;
  onView?: (view: DeployView) => void;
}) {
  const id = bundle?.stack_name ?? null;
  const parameters = bundle?.parameters ?? [];
  const visible = parameters.filter((parameter) => !parameter.no_echo && parameter.name !== "WorkflowInputBucket");
  const hidden = parameters.filter((parameter) => parameter.no_echo);
  const usesOptions = bundle?.files.some((file) => file.path.endsWith("options.example.json")) ?? false;
  // The B2Brouter sandbox only sends from a company of our account and refuses a reused number or an old date.
  const sendsByB2Brouter = parameters.some((parameter) => parameter.name === "B2BrouterAccount");

  const [values, setValues] = useState<Record<string, string>>({});
  const [view, setView] = useState<DeployView>({ status: "unknown" });
  const [message, setMessage] = useState("");
  const [missingSecrets, setMissingSecrets] = useState<Array<{ secret: string; how?: string }>>([]);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [run, setRun] = useState({
    buyerReference: "CS95-DEMO-REF", paymentTerms: "Payment within 30 days", sellerAbn: "", buyerAbn: "99000000000",
    recipient: RECIPIENTS[0].gln as string, invoiceId: "", issueDate: "", dueDate: "",
  });
  const [execution, setExecution] = useState<{ arn: string; console_url?: string; state: Execution | null } | null>(null);
  const [runMessage, setRunMessage] = useState("");
  const [runStarting, setRunStarting] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const report = (next: DeployView) => { setView(next); onView?.(next); };

  // A recipient left empty is the admin's own address, which the service always accepts.
  useEffect(() => {
    if (!accountEmail) return;
    const recipients = parameters.filter((parameter) => !parameter.no_echo && isRecipientParameter(parameter.name)).map((parameter) => parameter.name);
    if (recipients.length) setValues((current) => ({ ...current, ...Object.fromEntries(recipients.filter((name) => !current[name]).map((name) => [name, accountEmail])) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountEmail, parameters.map((parameter) => parameter.name).join(",")]);

  // Is this workflow (its stack) deployed already? Asked again when the chain changes.
  useEffect(() => {
    setMessage(""); setMissingSecrets([]); setExecution(null); onRunStates(null);
    if (!id || !canDeploy) { report({ status: "unknown" }); return; }
    let current = true;
    void getDeployment(id).then((result) => {
      if (!current) return;
      if (result.ok) report({ status: "deployment", deployment: result.value });
      else report(result.failure.kind === "unavailable" ? { status: "unavailable" } : { status: "none" });
    });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, canDeploy]);

  // Follow a deployment (or a deletion) in progress; a deleted stack is gone, so not_found ends a deletion.
  const deployment = view.status === "deployment" ? view.deployment : null;
  useEffect(() => {
    if (!deployment || deployment.status !== "in_progress") return;
    const timer = window.setTimeout(() => {
      void getDeployment(deployment.deployment_id).then((result) => {
        if (!live.current) return;
        if (result.ok) report({ status: "deployment", deployment: result.value });
        else if (result.failure.kind === "not_found" && deployment.phase === "deleting") {
          report({ status: "none" }); setMessage("Deleted from AWS.");
        } else setMessage(failureText(result.failure));
      });
    }, DEPLOY_POLL_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployment]);

  // Follow a run until it ends, colouring the canvas as each state finishes.
  useEffect(() => {
    if (!execution || (execution.state && execution.state.status !== RUNNING)) return;
    const timer = window.setTimeout(() => {
      void getExecution(execution.arn).then((result) => {
        if (!live.current) return;
        if (!result.ok) { setRunMessage(failureText(result.failure)); return; }
        setExecution((current) => current && current.arn === execution.arn ? { ...current, state: result.value } : current);
        onRunStates(runStates(result.value, stateNames));
      });
    }, execution.state ? RUN_POLL_MS : 600);
    return () => window.clearTimeout(timer);
  }, [execution, stateNames, onRunStates]);

  async function deploy() {
    if (!bundle || !id) return;
    // Empty ones are left out: the service may fill some from its own settings (the Mailgun domain,
    // the B2Brouter account) and answers 400 for one it cannot.
    const { send } = deployParameters(parameters, values);
    setStarting(true); setMessage(""); setMissingSecrets([]);
    const result = await startDeployment({ api_ids: chainIds, status: chainStatus, ...(name ? { name } : {}), parameters: send });
    if (result.ok) {
      // Unchanged code and parameters answer "succeeded" at once, without the state machine: read it back.
      const done = result.value.status === "succeeded" ? await getDeployment(result.value.deployment_id) : null;
      setStarting(false);
      report({ status: "deployment", deployment: done?.ok ? done.value : result.value });
      if (done) setMessage("Nothing changed since the last deployment, so AWS was left as it is.");
      return;
    }
    setStarting(false);
    const failure = result.failure;
    if (failure.kind === "unavailable") report({ status: "unavailable" });
    if (failure.kind === "not_configured") { report({ status: "unavailable", message: failureText(failure) }); return; }
    if (failure.kind === "missing_secrets") setMissingSecrets(failure.secrets);
    if (failure.kind === "busy" && failure.deployment_id) {
      const current = await getDeployment(failure.deployment_id);
      if (current.ok) report({ status: "deployment", deployment: current.value });
    }
    setMessage(failureText(failure));
  }

  async function remove() {
    if (!deployment) return;
    const sure = window.confirm(
      `Delete ${deployment.deployment_id} from AWS? Its Lambda functions, their roles and the state machine are removed, `
      + "including a stack of the same name deployed from CloudShell. Past runs stay in the console's history.",
    );
    if (!sure) return;
    setDeleting(true); setMessage(""); setExecution(null); onRunStates(null);
    const result = await deleteDeployment(deployment.deployment_id);
    setDeleting(false);
    // The stack's own status and events arrive with the next poll.
    if (result.ok) report({ status: "deployment", deployment: { ...deployment, ...result.value, status: "in_progress", phase: "deleting", stack_status: null, events: [], error: null } });
    else if (result.failure.kind === "not_found") report({ status: "none" });
    else setMessage(failureText(result.failure));
  }

  async function startRun() {
    if (!deployment || !file) return;
    if (file.size > MAX_RUN_FILE_BYTES) { setRunMessage("The file exceeds the 4 MB upload limit."); return; }
    setRunStarting(true); setRunMessage(""); onRunStates(null);
    const options = usesOptions ? runOptions({
      buyerReference: run.buyerReference, paymentTerms: run.paymentTerms, sellerAbn: run.sellerAbn, buyerAbn: run.buyerAbn,
      buyerEndpoint: { scheme: "0088", id: run.recipient },
      ...(sendsByB2Brouter ? { invoiceId: run.invoiceId, issueDate: run.issueDate, dueDate: run.dueDate } : {}),
    }) : null;
    const result = await startExecution(deployment.deployment_id, file, options);
    setRunStarting(false);
    if (!result.ok) { setRunMessage(failureText(result.failure)); return; }
    setExecution({ arn: result.value.execution_arn, console_url: result.value.console_url, state: null });
    onRunStates(Object.fromEntries(stateNames.map((state) => [state, "not_run" as RunState])));
  }

  const deployed = deployment?.status === "succeeded";
  const busy = deployment?.status === "in_progress" || starting || deleting;
  const removing = deleting || (deployment?.status === "in_progress" && deployment.phase === "deleting");
  const finished = execution?.state && execution.state.status !== RUNNING ? execution.state : null;
  const failedState = finished?.states.find((state) => state.status === "failed");
  // Inputs the Australian rules need when the invoice does not carry them (see pintAunzMissingData).
  const blankRunFields = [
    ["the buyer reference", run.buyerReference], ["the buyer's ABN", run.buyerAbn], ["the payment terms", run.paymentTerms],
  ].filter(([, value]) => !value.trim()).map(([label]) => label);

  return (
    <>
      <section className={styles.callout} aria-labelledby="deploy-title">
        <h3 id="deploy-title">Deploy to AWS</h3>
        {!canDeploy ? (
          <p className={styles.muted}>Only administrators can deploy from the site. Anyone can download the ZIP above and deploy it in their own AWS account by following its README.</p>
        ) : view.status === "unavailable" ? (
          <p className={styles.muted}>{view.message ?? UNAVAILABLE}</p>
        ) : (
          <>
            <p className={styles.muted}>Creates this workflow in the group&apos;s AWS account (Sydney): its Lambda functions and the state machine, from the same package as the ZIP. It takes one to three minutes.</p>
            {visible.length > 0 && (
              <div className={styles.paramList}>
                {visible.map((parameter) => (
                  <label key={parameter.name} className={styles.field}>
                    <span>{parameter.name}</span>
                    <input
                      value={values[parameter.name] ?? ""}
                      placeholder={parameter.default ?? (SERVER_FILLED.has(parameter.name) ? "Set by the server" : "Required")}
                      onChange={(event) => setValues((current) => ({ ...current, [parameter.name]: event.target.value }))}
                      maxLength={200}
                    />
                    <small>
                      {sentence(parameter.description.replace(/^[^:]+:\s*/, ""))}
                      {parameter.default ? " Left empty, the default is used." : SERVER_FILLED.has(parameter.name) ? " Left empty, the server fills it in from its own settings." : ""}
                      {isRecipientParameter(parameter.name) ? " The site sends only to your own address or one the administrators have allowed." : ""}
                    </small>
                  </label>
                ))}
              </div>
            )}
            {(hidden.length > 0 || (bundle?.secrets ?? []).length > 0) && (
              <ul className={styles.setup}>
                {hidden.map((parameter) => <li key={parameter.name}><code>{parameter.name}</code> is a credential: the server fills it in, the page never sees it.</li>)}
                {(bundle?.secrets ?? []).map((secret) => <li key={secret.name}>Reads <code>{secret.name}</code> from AWS Secrets Manager ({secret.apis.join(", ")}).</li>)}
              </ul>
            )}
            <div className={styles.actions}>
              <button type="button" className="button primary" onClick={() => void deploy()} disabled={!bundle || stale || busy || chainIds.length === 0}>
                {removing ? "Deleting…" : busy ? "Deploying…" : deployed ? "Deploy again" : "Deploy to AWS"}
              </button>
              {deployment && !busy && (
                <button type="button" className="button danger" onClick={() => void remove()}>Delete from AWS</button>
              )}
            </div>
            {missingSecrets.length > 0 && (
              <ul className={styles.setup}>{missingSecrets.map((item) => <li key={item.secret}><code>{item.secret}</code>{item.how ? `: ${item.how}` : ""}</li>)}</ul>
            )}
            {message && <p className={styles.formError} role="alert">{message}</p>}
            {deployment && (
              <div className={styles.deployStatus} role="status" aria-live="polite">
                <p>
                  <span className={`${styles.verdict} ${deployment.status === "succeeded" ? styles.pass : deployment.status === "failed" ? styles.fail : styles.pending}`}>
                    {deployment.status === "succeeded" ? "Deployed" : deployment.status === "failed" ? "Deployment failed" : deployment.phase === "deleting" ? "Deleting" : "Deploying"}
                  </span>
                  {deployment.status === "in_progress" && deployment.phase && <span> {PHASE[deployment.phase]}{deployment.stack_status ? ` (${deployment.stack_status})` : ""}…</span>}
                </p>
                {deployment.error && <p className={styles.formError}>{deployment.error.message}{deployment.error.resource ? ` (${deployment.error.resource})` : ""}</p>}
                {deployment.state_machine_arn && <p className={styles.wrap}><code>{deployment.state_machine_arn}</code></p>}
                {deployment.console_url && <p><a href={deployment.console_url} target="_blank" rel="noopener noreferrer">Open the state machine in the AWS console ↗</a></p>}
                {deployment.status === "succeeded" && (deployment.functions ?? []).length > 0 && (
                  <details>
                    <summary>{deployment.functions!.length} Lambda functions, one per step</summary>
                    <ul className={styles.events}>
                      {deployment.functions!.map((fn) => <li key={fn.arn}>{fn.state_name}: <code>{fn.function_name}</code></li>)}
                    </ul>
                  </details>
                )}
                {(deployment.events ?? []).length > 0 && deployment.status !== "succeeded" && (
                  <ol className={styles.events}>
                    {(deployment.events ?? []).slice(0, 5).map((event, index) => (
                      <li key={`${event.time}-${index}`}><code>{event.resource}</code> {event.status}{event.reason ? `: ${event.reason}` : ""}</li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {canDeploy && deployed && (
        <section className={styles.callout} aria-labelledby="run-title">
          <h3 id="run-title">Run on AWS</h3>
          <p className={styles.muted}>Runs the version last deployed to AWS. After a site update, use Deploy again above to update this workflow before testing. Each step lights up on the canvas as AWS finishes it. A run calls the real APIs and uses the providers&apos; credits.</p>
          <label className={styles.field}>
            <span>Invoice (PDF up to 4 MB; XML or JSON must fit the AWS input limit)</span>
            <input type="file" accept=".pdf,.xml,.json,application/pdf,application/xml,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          {usesOptions && (
            <div className={styles.paramList}>
              <label className={styles.field}><span>Buyer reference</span><input value={run.buyerReference} onChange={(event) => setRun((current) => ({ ...current, buyerReference: event.target.value }))} maxLength={60} /></label>
              <label className={styles.field}><span>Payment terms, if the invoice prints none</span><input value={run.paymentTerms} onChange={(event) => setRun((current) => ({ ...current, paymentTerms: event.target.value }))} maxLength={120} /></label>
              <label className={styles.field}>
                <span>{sendsByB2Brouter ? "Seller's ABN (B2Brouter sends only from a company of our account)" : "Seller's ABN, if the extraction does not read it"}</span>
                <input value={run.sellerAbn} onChange={(event) => setRun((current) => ({ ...current, sellerAbn: event.target.value }))} inputMode="numeric" maxLength={14} placeholder="Read from the invoice" />
                {sendsByB2Brouter && <small>{DEMO_SELLER_ABN} is the demo company CS9 Demo Supplies Pty Ltd, which the client asked us to send from. The PDF must identify that seller too; entering this ABN does not turn another company&apos;s invoice into a demo-company invoice.</small>}
              </label>
              <label className={styles.field}><span>Buyer&apos;s ABN</span><input value={run.buyerAbn} onChange={(event) => setRun((current) => ({ ...current, buyerAbn: event.target.value }))} inputMode="numeric" maxLength={14} /></label>
              <label className={styles.field}>
                <span>Buyer&apos;s electronic address (B2Brouter sandbox recipient)</span>
                <select value={run.recipient} onChange={(event) => setRun((current) => ({ ...current, recipient: event.target.value }))}>
                  {RECIPIENTS.map((recipient) => <option key={recipient.gln} value={recipient.gln}>{recipient.name} · GLN {recipient.gln}</option>)}
                </select>
              </label>
              {sendsByB2Brouter && (
                <>
                  <label className={styles.field}>
                    <span>Invoice number for this send (optional)</span>
                    <input value={run.invoiceId} onChange={(event) => setRun((current) => ({ ...current, invoiceId: event.target.value }))} maxLength={60} placeholder="The number printed on the invoice" />
                    <small>The sandbox takes each number once: to send the same invoice again, give it a new number, such as the printed one with -DEMO3.</small>
                  </label>
                  <label className={styles.field}>
                    <span>Issue date for this send (optional)</span>
                    <input type="date" value={run.issueDate} max={today()} onChange={(event) => setRun((current) => ({ ...current, issueDate: event.target.value }))} />
                    <small>For an agreed sandbox replay, use a date in the account&apos;s open financial year. The printed date stays unchanged by default.</small>
                  </label>
                  <label className={styles.field}>
                    <span>Due date for this sandbox send (optional)</span>
                    <input type="date" value={run.dueDate} min={run.issueDate || undefined} onChange={(event) => setRun((current) => ({ ...current, dueDate: event.target.value }))} />
                    <small>If replacing the issue date makes the original due date too old, replace the due date explicitly as well.</small>
                  </label>
                </>
              )}
              {blankRunFields.length > 0 && (
                <p className={styles.muted} role="note">
                  Left blank: {blankRunFields.join(", ")}. The Australian rules need them; if the PDF does not print them, or the extraction misses them, the run stops before conversion and validation and says what to fill in.
                </p>
              )}
            </div>
          )}
          <button type="button" className="button primary" onClick={() => void startRun()} disabled={!file || runStarting || (execution !== null && !finished)}>
            {runStarting || (execution && !finished) ? "Running…" : "Run on AWS"}
          </button>
          {runMessage && <p className={styles.formError} role="alert">{runMessage}</p>}
          {execution && (
            <div className={styles.deployStatus} role="status" aria-live="polite">
              <p>
                <span className={`${styles.verdict} ${finished ? (finished.status === "SUCCEEDED" ? styles.pass : styles.fail) : styles.pending}`}>
                  {finished ? (finished.status === "SUCCEEDED" ? "Succeeded" : `Ended: ${finished.status.toLowerCase().replace("_", " ")}`) : "Running"}
                </span>
                {!finished && execution.state && <span> {execution.state.states.filter((state) => state.status === "succeeded").length} states done…</span>}
              </p>
              {failedState
                ? <p className={styles.formError}>{failedState.name}: {failedState.error}{failedState.cause ? `. ${failedState.cause}` : ""}</p>
                : finished?.error && (finished.error.error || finished.error.cause) && (
                  <p className={styles.formError}>{finished.error.error}{finished.error.cause ? `. ${finished.error.cause}` : ""}</p>
                )}
              {finished?.error?.cause && invoiceFailureHint(finished.error.cause) && <p>{invoiceFailureHint(finished.error.cause)}</p>}
              {finished?.output_summary && <p>{finished.output_summary}</p>}
              {(execution.state?.console_url ?? execution.console_url) && <p><a href={execution.state?.console_url ?? execution.console_url!} target="_blank" rel="noopener noreferrer">Open this run in the AWS console ↗</a></p>}
            </div>
          )}
        </section>
      )}
    </>
  );
}
