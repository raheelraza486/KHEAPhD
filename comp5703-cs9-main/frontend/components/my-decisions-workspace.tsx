"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * What the signed-in person has decided, across every API pair they answered
 * for.
 *
 * Answering happens field by field inside one comparison, so without this page
 * the only way to find an earlier answer is to remember which two APIs it was
 * about. Each row says what was answered, and what became of it: applied,
 * waiting for an administrator, settled by one, or no longer in force.
 */
type Decision = {
  source_api_id: string;
  target_api_id: string;
  source_api_name: string;
  target_api_name: string;
  target_path: string;
  option: "candidate" | "none" | "external";
  chosen_source_path: string | null;
  chosen_at: string | null;
  state: "applied" | "awaiting_review" | "settled" | "superseded";
  applied_answer: { option: string; chosen_source_path: string | null } | null;
};

const STATE_LABEL: Record<Decision["state"], string> = {
  applied: "Applied",
  awaiting_review: "Submitted — awaiting review",
  settled: "Settled by an administrator",
  superseded: "No longer applied",
};

const STATE_DETAIL: Record<Decision["state"], string> = {
  applied: "Everyone who answered this field chose the same thing, so it is in force for this pair.",
  awaiting_review: "Another answer differs from yours. Nothing is applied until an administrator decides, and the field cannot be changed meanwhile.",
  settled: "An administrator decided this field. Their answer overrides everyone's, and only another administrator can change it.",
  superseded: "This answer is not in force: a newer answer, or a change to one of the schemas, replaced it.",
};

function answerLabel(option: string, path: string | null): string {
  if (option === "candidate") return path ?? "a source field";
  return option === "external" ? "Provided externally" : "None of the above";
}

export default function MyDecisionsWorkspace() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/checks/decisions", { cache: "no-store" });
      const payload = (await response.json()) as { decisions?: Decision[]; complete?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error || "Your decisions could not be loaded.");
      setDecisions(payload.decisions ?? []);
      setComplete(payload.complete !== false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your decisions could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const awaiting = decisions.filter((item) => item.state === "awaiting_review").length;

  return (
    <main className="app-shell" id="main-content">
      <section className="workspace">
        <header className="compatibility-page-header">
          <div>
            <p className="eyebrow">My field decisions</p>
            <h1>What you decided,<br />and what became of it.</h1>
            <p className="intro-copy">
              Every field decision you saved while comparing two APIs. A decision applies to the pair it was made on;
              when someone else answers the same field differently, an administrator decides between them.
            </p>
          </div>
          <button type="button" className="button secondary" disabled={loading} onClick={() => void load()}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </header>

        {error && <p className="compat-inline-error" role="alert">{error}</p>}
        {!complete && (
          <p className="compat-schema-note" role="status">
            You have answered for more API pairs than can be checked in one request; the newest are shown.
          </p>
        )}
        {awaiting > 0 && (
          <p className="compat-schema-note" role="status">
            {awaiting} {awaiting === 1 ? "decision is" : "decisions are"} waiting for an administrator.
          </p>
        )}

        {!loading && decisions.length === 0 && !error && (
          <section className="compat-empty-result">
            <span aria-hidden="true">⇄</span>
            <div>
              <h2>You have not saved any field decisions yet</h2>
              <p>Compare two APIs, and when the check asks how a field is supplied, save your answer. It will appear here.</p>
            </div>
          </section>
        )}

        <div className="decision-list">
          {decisions.map((item) => (
            <article key={`${item.source_api_id}:${item.target_api_id}:${item.target_path}`} className="decision-row">
              <div className="decision-row-main">
                <p className="eyebrow">{item.source_api_name} → {item.target_api_name}</p>
                <code>{item.target_path}</code>
                <p>
                  You chose <strong>{answerLabel(item.option, item.chosen_source_path)}</strong>
                  {item.chosen_at && <> on <time dateTime={item.chosen_at}>{new Date(item.chosen_at).toLocaleString()}</time></>}.
                </p>
                {item.applied_answer && item.state !== "applied" && (
                  <p>In force: <strong>{answerLabel(item.applied_answer.option, item.applied_answer.chosen_source_path)}</strong>.</p>
                )}
                <p className="decision-row-detail">{STATE_DETAIL[item.state]}</p>
              </div>
              <div className="decision-row-side">
                <span className={`compat-status decision-state-${item.state}`}>{STATE_LABEL[item.state]}</span>
                <a className="button secondary" href={`/compatibility?source=${item.source_api_id}&target=${item.target_api_id}`}>
                  Open the comparison
                </a>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
