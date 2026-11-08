"use client";

import { useCallback, useEffect, useState } from "react";
import type { CheckReport, ConflictField } from "@/lib/checks/types";

/**
 * Pending review — the fields an administrator has to decide (Compatibility
 * Check Manual 10.25, chapter 12 item L4).
 *
 * When users disagree about which source field supplies a target field — or
 * when a saved answer disagrees with the match the registry now produces —
 * nothing is applied and the pair waits here. An administrator's answer is
 * final: it overrides both the users' answers and the automatic match, until
 * another administrator answers again.
 *
 * The list comes from the checks themselves rather than from the answer table,
 * because a disagreement with the registry cannot be seen in the table (see
 * lib/checks/conflicts.ts). Opening a pair loads its full report, so the
 * context an administrator judges by — the other answers, who gave them, what
 * the alternatives were, which schemas were compared — is the same report the
 * users saw.
 */
const NONE = "__none__";
const EXTERNAL = "__external__";

type ConflictItem = {
  source_api_id: string;
  target_api_id: string;
  source_api_name: string;
  target_api_name: string;
  target_path: string;
  required: boolean;
  answers: Array<ConflictField["answers"][number] & { chosen_by_name?: string | null }>;
  candidates?: string[];
  last_chosen_at: string | null;
};

type PairGroup = {
  key: string;
  source_api_id: string;
  target_api_id: string;
  source_api_name: string;
  target_api_name: string;
  fields: ConflictItem[];
  last_chosen_at: string | null;
};

function group(items: readonly ConflictItem[]): PairGroup[] {
  const byPair = new Map<string, PairGroup>();
  for (const item of items) {
    const key = `${item.source_api_id}|${item.target_api_id}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.fields.push(item);
      if ((item.last_chosen_at ?? "") > (existing.last_chosen_at ?? "")) existing.last_chosen_at = item.last_chosen_at;
      continue;
    }
    byPair.set(key, {
      key,
      source_api_id: item.source_api_id,
      target_api_id: item.target_api_id,
      source_api_name: item.source_api_name || item.source_api_id,
      target_api_name: item.target_api_name || item.target_api_id,
      fields: [item],
      last_chosen_at: item.last_chosen_at,
    });
  }
  return [...byPair.values()].sort((a, b) => (b.last_chosen_at ?? "").localeCompare(a.last_chosen_at ?? ""));
}

function answerLabel(option: "candidate" | "none" | "external", path: string | null): string {
  if (option === "candidate") return path ?? "a source field";
  return option === "external" ? "Provided externally" : "None of the above";
}

function who(answer: { source: "user" | "admin" | "registry"; chosen_by_name?: string | null }): string {
  if (answer.source === "registry") return "The registry's automatic match";
  if (answer.chosen_by_name) return answer.chosen_by_name;
  return answer.source === "admin" ? "An administrator" : "A user";
}

/**
 * Everything the check would have offered for this field, so a settlement is
 * not limited to the answers already given: the right source field may be one
 * nobody picked. The list comes with the work list, because the report of a
 * pair in conflict no longer carries the field's candidates.
 */
function choicesFor(field: ConflictItem): string[] {
  const paths = new Set<string>(field.candidates ?? []);
  for (const answer of field.answers) if (answer.option === "candidate" && answer.chosen_source_path) paths.add(answer.chosen_source_path);
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function Settlement({ pair, field, busy, onSettle }: {
  pair: PairGroup;
  field: ConflictItem;
  busy: boolean;
  onSettle: (field: ConflictItem, selection: string, note: string) => Promise<void>;
}) {
  const [selection, setSelection] = useState("");
  const [note, setNote] = useState("");
  const id = `settle-${pair.key}-${field.target_path}`;
  return (
    <article className="review-field">
      <div className="review-field-head">
        <code>{field.target_path}</code>
        <span className={`compat-status ${field.required ? "status-warning" : "status-unknown"}`}>
          {field.required ? "Required" : "Optional"}
        </span>
      </div>
      <ul className="review-answers">
        {field.answers.map((answer, index) => (
          <li key={`${answer.source}-${answer.chosen_by ?? index}`}>
            <strong>{who(answer)}</strong>: {answerLabel(answer.option, answer.chosen_source_path)}
            {answer.chosen_at && <time dateTime={answer.chosen_at}> · {new Date(answer.chosen_at).toLocaleString()}</time>}
          </li>
        ))}
      </ul>
      <div className="review-settle">
        <label htmlFor={id}>Settle this field as</label>
        <select id={id} value={selection} disabled={busy} onChange={(event) => setSelection(event.target.value)}>
          <option value="">Choose…</option>
          {choicesFor(field).length > 0 && (
            <optgroup label="Source fields">
              {choicesFor(field).map((path) => (
                <option key={path} value={path}>{path}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Other">
            <option value={NONE}>None of the above</option>
            <option value={EXTERNAL}>Provided externally</option>
          </optgroup>
        </select>
        <input
          type="text" value={note} disabled={busy} maxLength={1000}
          placeholder="Why (optional) — kept with the settlement"
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="button" className="button primary" disabled={!selection || busy}
          onClick={() => void onSettle(field, selection, note)}
        >
          {busy ? "Saving…" : "Settle"}
        </button>
        <p>The people who answered are told the outcome. A settlement can only be changed by another settlement.</p>
      </div>
    </article>
  );
}

export default function AdminReviewWorkspace() {
  const [items, setItems] = useState<ConflictItem[]>([]);
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openPair, setOpenPair] = useState<string | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [reportError, setReportError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/checks/conflicts${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const payload = (await response.json()) as { conflicts?: ConflictItem[]; complete?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error || "The work list could not be loaded.");
      setItems(payload.conflicts ?? []);
      setComplete(payload.complete !== false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The work list could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function openPairReport(pair: PairGroup) {
    if (openPair === pair.key) { setOpenPair(null); return; }
    setOpenPair(pair.key);
    setReport(null);
    setReportError("");
    try {
      const query = new URLSearchParams({ source_id: pair.source_api_id, target_id: pair.target_api_id });
      const response = await fetch(`/api/checks?${query}`, { cache: "no-store" });
      const payload = (await response.json()) as { report?: CheckReport; error?: string };
      if (!response.ok || !payload.report) throw new Error(payload.error || "The report for this pair could not be loaded.");
      setReport(payload.report);
    } catch (cause) {
      setReportError(cause instanceof Error ? cause.message : "The report for this pair could not be loaded.");
    }
  }

  async function settle(pair: PairGroup, field: ConflictItem, selection: string, note: string) {
    setBusy(true);
    setError("");
    try {
      const body = selection === NONE
        ? { option: "none" as const }
        : selection === EXTERNAL
          ? { option: "external" as const }
          : { option: "candidate" as const, chosen_source_path: selection };
      const response = await fetch("/api/checks/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_id: pair.source_api_id,
          target_id: pair.target_api_id,
          target_path: field.target_path,
          note,
          ...body,
        }),
      });
      const payload = (await response.json()) as { report?: CheckReport; error?: string };
      if (!response.ok || !payload.report) throw new Error(payload.error || "The settlement could not be saved.");
      setReport(payload.report);
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The settlement could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const pairs = group(items);

  return (
    <main className="app-shell" id="main-content">
      <section className="workspace">
        <header className="compatibility-page-header">
          <div>
            <p className="eyebrow">Pending review</p>
            <h1>Fields waiting<br />for your decision.</h1>
            <p className="intro-copy">
              Users disagreed about which source field supplies a target field, or a saved answer disagrees with the
              match the registry now produces. Nothing is applied until you settle it, and your answer is final.
            </p>
          </div>
          <button type="button" className="button secondary" disabled={loading} onClick={() => void load(true)}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </header>

        {error && <p className="compat-inline-error" role="alert">{error}</p>}
        {!complete && (
          <p className="compat-schema-note" role="status">
            More pairs have saved answers than can be checked in one request, so this list may be incomplete.
          </p>
        )}
        {!loading && pairs.length === 0 && !error && (
          <section className="compat-empty-result">
            <span aria-hidden="true">✓</span>
            <div><h2>Nothing is waiting</h2><p>Every field that users answered either agrees or has been settled.</p></div>
          </section>
        )}

        <div className="review-list">
          {pairs.map((pair) => (
            <section key={pair.key} className="review-pair">
              <button type="button" className="review-pair-head" aria-expanded={openPair === pair.key} onClick={() => void openPairReport(pair)}>
                <div>
                  <strong>{pair.source_api_name} → {pair.target_api_name}</strong>
                  <span>
                    {pair.fields.length} {pair.fields.length === 1 ? "field" : "fields"} in conflict
                    {pair.last_chosen_at && ` · last answered ${new Date(pair.last_chosen_at).toLocaleString()}`}
                  </span>
                </div>
                <span aria-hidden="true">{openPair === pair.key ? "−" : "+"}</span>
              </button>
              {openPair === pair.key && (
                <div className="review-pair-body">
                  {reportError && <p className="compat-inline-error" role="alert">{reportError}</p>}
                  {!report && !reportError && <p role="status">Loading the report for this pair…</p>}
                  {report && (
                    <p className="review-context">
                      Compared in <strong>{report.check1.format_selected ?? "no common format"}</strong>
                      {report.check2.schema.source_schema_used && (
                        <> · source {report.check2.schema.source_schema_used.status_code ?? "default"} response
                          {report.check2.schema.source_schema_used.media_type ? ` (${report.check2.schema.source_schema_used.media_type})` : ""}</>
                      )}
                      {report.check2.schema.flags.includes("schema_unverified") && " · schemas not manually verified"}
                    </p>
                  )}
                  {pair.fields.map((field) => (
                    <Settlement
                      key={field.target_path}
                      pair={pair}
                      field={field}
                      busy={busy}
                      onSettle={(item, selection, note) => settle(pair, item, selection, note)}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
