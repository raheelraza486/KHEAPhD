"use client";

import { useEffect, useState } from "react";
import {
  getExecutionAvailability,
  type ExecutionAvailability,
} from "@/lib/composition/execution-registry";
import {
  type SelectedCompositionChain,
} from "@/lib/composition/selected-chain";
import { useWorkspaceMemory } from '@/components/workspace-memory-provider';

type RunState =
  | { status: "loading" }
  | { status: "missing" }
  | {
      status: "ready";
      selected: SelectedCompositionChain;
      availability: ExecutionAvailability;
    };

export default function CompositionRunWorkspace() {
  const { selected: memorySelection } = useWorkspaceMemory();
  const [state, setState] = useState<RunState>({ status: "loading" });

  useEffect(() => {
    const selected = memorySelection;
    if (!selected) {
      setState({ status: "missing" });
      return;
    }

    setState({
      status: "ready",
      selected,
      availability: getExecutionAvailability(selected),
    });
  }, [memorySelection]);

  if (state.status === "loading") {
    return (
      <main className="composition-run-page" id="main-content">
        <section className="composition-run-hero">
          <p className="bp-eyebrow">Composition Run</p>
          <h1>Loading selected chain</h1>
          <p>Checking the selected chain and its execution availability.</p>
        </section>
      </main>
    );
  }

  if (state.status === "missing") {
    return (
      <main className="composition-run-page" id="main-content">
        <section className="composition-run-hero">
          <p className="bp-eyebrow">Composition Run</p>
          <h1>No selected chain</h1>
          <p>
            Select a feasible chain in Create a workflow before opening the execution
            workspace.
          </p>
          <a className="button primary" href="/workflows/create">
            Create a workflow
          </a>
        </section>
      </main>
    );
  }

  const { selected, availability } = state;

  return (
    <main className="composition-run-page" id="main-content">
      <section className="composition-run-hero" aria-labelledby="composition-run-title">
        <p className="bp-eyebrow">Composition Run</p>
        <h1 id="composition-run-title">Review the selected API chain</h1>
        <p>
          Your workflow selected this complete feasible chain. Execution is offered
          only when an integration is registered for the exact API sequence.
        </p>
      </section>

      <div className="composition-run-layout">
        <section className="composition-run-panel" aria-labelledby="selected-chain-title">
          <header className="composition-run-panel-head">
            <div>
              <span className="bp-chain-status is-feasible">Feasible</span>
              <h2 id="selected-chain-title">Selected chain</h2>
            </div>
            <strong>{selected.apis.length} APIs</strong>
          </header>

          <ol className="composition-run-chain">
            {selected.apis.map((api, index) => (
              <li key={`${api.api_id}-${index}`}>
                <span className="bp-chain-step-number">{index + 1}</span>
                <div>
                  <small>{api.category || "Process step"}</small>
                  <strong>{api.api_name}</strong>
                  <p>{api.company_name || `Repository ID: ${api.api_id}`}</p>
                  <code>{api.api_id}</code>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <aside className="composition-run-panel" aria-labelledby="execution-title">
          <header className="composition-run-panel-head">
            <div>
              <span
                className={`composition-run-availability is-${availability.status}`}
              >
                {availability.status === "available"
                  ? "Execution available"
                  : "integration_unavailable"}
              </span>
              <h2 id="execution-title">Execution availability</h2>
            </div>
          </header>

          <h3>{availability.label}</h3>
          <p>{availability.description}</p>

          {availability.status === "available" ? (
            <>
              <dl className="composition-run-details">
                <div>
                  <dt>Registered integration</dt>
                  <dd>{availability.integration}</dd>
                </div>
                <div>
                  <dt>Existing endpoint</dt>
                  <dd><code>{availability.endpoint}</code></dd>
                </div>
              </dl>
              <a className="button primary" href={availability.workflowHref}>
                Continue to execution
              </a>
              <p className="composition-run-note">
                The existing workflow performs the real request. Composition Run
                does not simulate or pre-create an execution result.
              </p>
            </>
          ) : (
            <>
              <p className="composition-run-note">
                No provider call has been made and no execution result has been
                created for this chain.
              </p>
              <a className="button secondary" href="/workflows/create">
                Create another workflow
              </a>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
