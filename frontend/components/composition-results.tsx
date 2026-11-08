"use client";

import { useMemo } from "react";
import GenerateWorkflowButton from "@/components/generate-workflow-button";
import InvoiceStandardResult from "@/components/invoice-standard-result";
import SaveChainForm from "@/components/save-chain-form";
import type { CompositionApiResponse, CompositionStepView } from "@/lib/composition/api-contract";
import type { Chain, ProcessIssueCode } from "@/lib/composition/types";
import type { DiscoveryProcessJson } from "@/lib/discovery/types";

const CATEGORY_COPY: Record<CompositionStepView["category"], string> = {
  Transformation: "Transform",
  Validation: "Validate",
  Communication: "Communicate",
};

const ISSUE_COPY: Record<ProcessIssueCode, string> = {
  empty_process: "No usable process steps were found.",
  too_many_steps: "This workflow needs more than the four steps currently supported.",
  unknown_category: "A step does not match transformation, validation or communication.",
  order_reversed: "The process steps are not in a supported order.",
  validation_skipped: "The workflow skips a required validation step.",
  duplicate_order: "Two process steps have the same position.",
  unrecognised_format: "One of the requested document formats is not recognised.",
  conversion_unresolved: "No single API, or supported pair of APIs, covers the requested conversion.",
};

const CANDIDATE_ISSUE_COPY: Record<string, string> = {
  insufficient_task_detail: "Add more detail about what this step must do.",
  no_match: "No matching API was found in the current repository.",
  unrecognised_format: "The requested input or output format is not recognised.",
};

function sourceLabel(source: CompositionStepView["candidate_source"]): string {
  if (source === "formats") return "Matched by format";
  if (source === "keywords") return "Matched by task";
  if (source === "discovery") return "Matched by Discovery";
  return "No match";
}

function apiById(steps: CompositionStepView[]) {
  return new Map(steps.flatMap((step) => step.candidate_apis.map((api) => [api.id, api] as const)));
}

function ProcessStepList({ steps, compact = false }: { steps: Array<DiscoveryProcessJson["steps"][number] | CompositionStepView>; compact?: boolean }) {
  return (
    <ol className={`discovery-process-list${compact ? " discovery-process-list-compact" : ""}`}>
      {steps.map((step) => (
        <li key={`${step.order}-${step.task}`}>
          <span className="discovery-step-order">{step.order}</span>
          <div className="discovery-step-body">
            <div className="discovery-step-heading">
              <span className={`discovery-category discovery-category-${step.category.toLowerCase()}`}>
                {CATEGORY_COPY[step.category]}
              </span>
              {"system_added" in step && step.system_added && (
                <span className="discovery-added">Automatically added</span>
              )}
            </div>
            <strong>{step.task}</strong>
            <div className="discovery-step-meta">
              {step.input_format && <span>Input: {step.input_format}</span>}
              {step.output_format && <span>Output: {step.output_format}</span>}
              {step.rule_set && <span>Rules: {step.rule_set}</span>}
            </div>
            {"candidate_source" in step && (
              <div className="discovery-candidate-summary">
                <span>{sourceLabel(step.candidate_source)}</span>
                <span>{step.candidate_total_matches} candidate{step.candidate_total_matches === 1 ? "" : "s"}</span>
                {step.candidate_issue && (
                  <span className="discovery-inline-warning">
                    {CANDIDATE_ISSUE_COPY[step.candidate_issue] ?? "This step needs clarification."}
                  </span>
                )}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ChainCard({
  chain,
  index,
  steps,
  selected,
  onSelect,
}: {
  chain: Chain;
  index: number;
  steps: CompositionStepView[];
  selected: boolean;
  onSelect: () => void;
}) {
  const lookup = useMemo(() => apiById(steps), [steps]);
  return (
    <label className={`discovery-chain-card${selected ? " is-selected" : ""}`}>
      <input type="radio" name="api-chain" checked={selected} onChange={onSelect} />
      <span className="discovery-chain-radio" aria-hidden="true" />
      <span className="discovery-chain-content">
        <span className="discovery-chain-heading">
          <span>
            <strong>Chain {index + 1}</strong>
            <small>{chain.api_ids.length} API{chain.api_ids.length === 1 ? "" : "s"}</small>
          </span>
          <span className={`discovery-chain-status ${chain.status === "feasible" ? "is-feasible" : "needs-decision"}`}>
            {chain.status === "feasible" ? "Checks passed" : "Review needed"}
          </span>
        </span>
        <ol className="discovery-chain-steps">
          {chain.api_ids.map((id, stepIndex) => {
            const api = lookup.get(id);
            const step = steps[stepIndex];
            return (
              <li key={`${id}-${stepIndex}`}>
                <span>{stepIndex + 1}</span>
                <div>
                  <small>{step ? CATEGORY_COPY[step.category] : "API step"}</small>
                  <strong>{api?.api_name ?? id}</strong>
                  <span>{api?.company_name ?? "Provider details unavailable"}</span>
                </div>
              </li>
            );
          })}
        </ol>
        {chain.links.some((link) => link.verdict === "unknown") && (
          <span className="discovery-chain-note">At least one connection needs technical or field-mapping review.</span>
        )}
      </span>
    </label>
  );
}

export function CompositionResults({
  result,
  selectedChain,
  onSelect,
  onRun,
  onRestart,
  onEdit,
}: {
  result: CompositionApiResponse;
  selectedChain: number | null;
  onSelect: (index: number) => void;
  onRun: (index: number) => void;
  onRestart: () => void;
  onEdit?: () => void;
}) {
  const { composition } = result;
  const chosen = selectedChain === null ? null : composition.chains[selectedChain];
  const lookup = useMemo(() => apiById(result.steps), [result.steps]);
  return (
    <section className="discovery-results" aria-labelledby="composition-results-title" aria-live="polite">
      <div className="discovery-panel-heading">
        <div>
          <p className="eyebrow">Composition results</p>
          <h2 id="composition-results-title">Choose a complete API chain</h2>
          <p>Every chain below has passed the available repository checks or is clearly marked for review.</p>
        </div>
      </div>

      <div className="discovery-result-stats" aria-label="Composition result summary">
        <article><strong>{composition.counts.feasible}</strong><span>Checks passed</span></article>
        <article><strong>{composition.counts.needs_decision}</strong><span>Need review</span></article>
        <article><strong>{result.steps.length}</strong><span>Process steps</span></article>
      </div>

      {composition.issues.length > 0 && (
        <div className="discovery-issues" role="alert">
          <strong>The process needs attention</strong>
          <ul>
            {composition.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                {ISSUE_COPY[issue.code] ?? issue.message}
                {issue.step ? ` (step ${issue.step})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="discovery-result-process">
        <summary>View resolved process and candidates</summary>
        <ProcessStepList steps={result.steps} compact />
      </details>

      {composition.chains.length > 0 ? (
        <div className="discovery-results-workspace">
          <div className="discovery-chain-browser">
            <div className="discovery-chain-browser-heading">
              <p className="eyebrow">Step 1</p>
              <h3>Select a chain <span>{composition.chains.length}</span></h3>
              <p id="chain-list-help">Scroll to compare the chains, then select one to continue.</p>
            </div>
            <fieldset className="discovery-chain-list" tabIndex={0} aria-describedby="chain-list-help">
              <legend className="sr-only">Available API chains</legend>
              {composition.chains.map((chain, index) => (
                <ChainCard
                  key={`${chain.api_ids.join("-")}-${index}`}
                  chain={chain}
                  index={index}
                  steps={result.steps}
                  selected={selectedChain === index}
                  onSelect={() => onSelect(index)}
                />
              ))}
            </fieldset>
            {composition.truncated && (
              <p className="discovery-limit-note">More combinations are available. Add detail to your description to narrow the results.</p>
            )}
          </div>

          <aside className="discovery-chain-sidebar" aria-label="Selected chain actions">
            <div className="discovery-chain-browser-heading">
              <p className="eyebrow">Step 2</p>
              <h3>Choose an action</h3>
              <p>{chosen ? 'Continue with the chain you selected.' : 'Select a chain in Step 1 to enable the actions below.'}</p>
            </div>
            <div className="discovery-selection" role="status">
              <div>
                <span>{chosen ? "Selected API chain" : "Choose an API chain"}</span>
                <strong>{chosen ? `Chain ${selectedChain! + 1} · ${chosen.api_ids.length} APIs` : "Select a chain from the list"}</strong>
              </div>
            </div>


            <div className="discovery-chain-actions">
              <section className="discovery-chain-action" aria-labelledby="save-chain-title">
                <h3 id="save-chain-title">Save to My Chains</h3>
                <p>Keep these API steps in your private profile.</p>
                {chosen ? <SaveChainForm key={chosen.api_ids.join(",")} apiIds={chosen.api_ids} />
                  : <button type="button" className="button secondary" disabled>Save chain</button>}
              </section>
              <section className="discovery-chain-action" aria-labelledby="download-workflow-title">
                <h3 id="download-workflow-title">Download a workflow</h3>
                <p>Get a ZIP file for AWS Step Functions, with the workflow definition, API functions and setup instructions.</p>
                <p className="discovery-action-note">Add your credentials and deploy it in your own AWS account. This download does not run the APIs.</p>
                {/* Unnamed, the workflow is named after its companies (BP-Upbrains-AmitTransform-ESS-Mailgun), so two chains deploy side by side. */}
                {chosen ? <GenerateWorkflowButton chain={chosen} />
                  : <button type="button" className="button secondary" disabled>Generate workflow</button>}
              </section>

              <section className="discovery-chain-action" aria-labelledby="canvas-workflow-title">
                <h3 id="canvas-workflow-title">Open on the canvas</h3>
                <p>See this chain as the Step Functions workflow AWS will run, and change its steps by drag and drop.</p>
                <p className="discovery-action-note">The canvas opens in a new tab; this page keeps your results.</p>
                {chosen ? <a className="button secondary" href={`/workflows/canvas?${new URLSearchParams({ api_ids: chosen.api_ids.join(",") })}`} target="_blank" rel="noopener noreferrer">Open on the canvas</a>
                  : <button type="button" className="button secondary" disabled>Open on the canvas</button>}
              </section>

              <section className="discovery-chain-action" aria-labelledby="run-workflow-title">
                <h3 id="run-workflow-title">Run on this platform</h3>
                <p>Check whether this chain can run on this platform. If supported, you can add your data and start the workflow on the next page.</p>
                <p className="discovery-action-note">{chosen?.status === "needs_decision"
                  ? "Review the flagged connections before continuing."
                  : "Only chains with an existing integration can run here."}</p>
                <button type="button" className="button secondary" onClick={() => onRun(selectedChain!)} disabled={!chosen || chosen.status !== "feasible"}>
                  Check run availability
                </button>
              </section>
            </div>
            <div className="draft-actions discovery-result-edit-actions">
              {onEdit && <button type="button" className="button secondary" onClick={onEdit}>Edit workflow</button>}
              <button type="button" className="button secondary" onClick={onRestart}>Start again</button>
            </div>
          </aside>
        </div>
      ) : (
        <div className="discovery-empty-result">
          <strong>No complete chain is available yet.</strong>
          <p>Review the issue or candidate warning above, then edit the workflow and check again.</p>
          <div className="draft-actions"><button type="button" className="button primary" onClick={onEdit ?? onRestart}>Edit workflow</button><button type="button" className="button secondary" onClick={onRestart}>Start again</button></div>
        </div>
      )}

      {chosen && (
        <details className="discovery-selected-checks">
          <summary>Review compatibility evidence for the selected chain</summary>
          <div className="discovery-link-checks">
            {chosen.links.map((link, index) => {
              const sourceApi = lookup.get(link.source_id);
              const targetApi = lookup.get(link.target_id);
              const technical = result.technical_checks.find((check) => check.source_id === link.source_id && check.target_id === link.target_id);
              const standard = result.standard_checks.find((check) => check.source_id === link.source_id && check.target_id === link.target_id);
              return (
                <section key={`${link.source_id}-${link.target_id}-${index}`} className="discovery-link-review">
                  <header>
                    <span>Connection {index + 1}</span>
                    <strong>{sourceApi?.api_name ?? link.source_id} → {targetApi?.api_name ?? link.target_id}</strong>
                  </header>
                  <article className={`discovery-technical-check check-${link.verdict === "pass" ? "pass" : link.verdict === "fail" ? "fail" : "unknown"}`}>
                    <span className={`compat-status status-${link.verdict === "pass" ? "pass" : link.verdict === "fail" ? "fail" : "unknown"}`}>
                      {link.verdict === "pass" ? "Compatible" : link.verdict === "fail" ? "Not compatible" : "More information needed"}
                    </span>
                    <h3>Technical compatibility</h3>
                    {technical?.missing_sides.length ? (
                      <p>Missing schema evidence: {technical.missing_sides.map((side) => side.replaceAll("_", " ")).join(", ")}.</p>
                    ) : (
                      <p>{technical?.blocking_checks.length ? `Blocked by checks ${technical.blocking_checks.join(", ")}.` : "The available technical checks did not find a blocking mismatch."}</p>
                    )}
                  </article>
                  {standard ? <InvoiceStandardResult result={standard} /> : (
                    <article className="discovery-technical-check check-unknown">
                      <span className="compat-status status-unknown">No standard verdict</span>
                      <h3>Invoice standard compatibility</h3>
                      <p>No standard comparison was returned for this connection.</p>
                    </article>
                  )}
                </section>
              );
            })}
          </div>
        </details>
      )}
      {chosen && <details className="discovery-selected-checks discovery-selected-apis">
        <summary>View selected APIs <span>({chosen.api_ids.length})</span></summary>
        <p>Review the APIs in this chain. Open a listing to see its full details in the library.</p>
        <ol className="selected-api-previews">
          {chosen.api_ids.map((id, index) => {
            const api = lookup.get(id);
            const step = result.steps[index];
            return <li key={`${id}-${index}`}>
              <a href={`/apis?api=${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${api?.api_name ?? 'API'} in the API library (opens in a new tab)`}>
                <span className="selected-api-preview-step">{index + 1}{step ? ` · ${CATEGORY_COPY[step.category]}` : ''}</span>
                <strong>{api?.api_name ?? 'API details'}</strong>
                <span>{api?.company_name || 'Provider not recorded'}</span>
                {step && <small>For: {step.task}</small>}
                <span className="selected-api-preview-link">Open in API library <span aria-hidden="true">↗</span><small>Opens in a new tab</small></span>
              </a>
            </li>;
          })}
        </ol>
      </details>}
    </section>
  );
}

