"use client";

import { useState } from "react";
import type { AppliedChoice, Candidate, ConflictField, SemanticsResult } from "@/lib/checks/types";

export type MappingAnswer = { option: "candidate"; chosen_source_path: string } | { option: "none" | "external" };

/**
 * The field decisions of step 2.2c.
 *
 * Three groups are shown at once, and this is deliberate. A pair whose verdict
 * is `pending_admin` still has fields anyone may answer: one field held for an
 * administrator makes the whole pair wait, but it must not take the other
 * fields away from the user. Rendering by the overall verdict alone would do
 * exactly that.
 *
 * A field the check matched on its own is not asked about at all: it is a
 * determined mapping and appears in the field-by-field review, not here. Only
 * what the check could not settle needs a person. Within that, rule S-8 asks
 * about every ambiguous field (an optional one marked as skippable) but only
 * about required fields it could not find — an optional field with no match is
 * a notice, because skipping it is the same as leaving it unanswered.
 *
 *   waiting   fields the check is asking about — one drop-down each
 *   applied   answers in force; an agreed one can be changed, a settled one is
 *             locked
 *   conflict  fields held for an administrator, read-only
 *
 * The control is a drop-down (`select`) per field, as the client asked for:
 * the candidates the check found, at most eight, plus the two fixed options
 * the manual requires — "None of the above" and "Provided externally".
 */
type Props = {
  semantics: SemanticsResult;
  submitting: boolean;
  previewing: boolean;
  error: string;
  isSignedIn: boolean;
  onPreview: (targetPath: string, answer: MappingAnswer) => Promise<void>;
  onSave: (targetPath: string, answer: MappingAnswer) => Promise<void>;
};

type WaitingField = {
  targetPath: string;
  targetType: string;
  targetFormat: string | null;
  required: boolean;
  candidates: Candidate[];
  reason: "ambiguous" | "not_found";
  stale: StaleReason | null;
};

type StaleReason = "source_schema_changed" | "target_schema_changed" | "format_changed";

const NONE = "__none__";
const EXTERNAL = "__external__";

function metadata(type: string, format: string | null, required: boolean) {
  return [type || "unknown type", format, required ? "required" : "optional"].filter(Boolean).join(" · ");
}

function answerOf(selection: string): MappingAnswer | null {
  if (selection === "") return null;
  if (selection === NONE) return { option: "none" };
  if (selection === EXTERNAL) return { option: "external" };
  return { option: "candidate", chosen_source_path: selection };
}

function selectionOf(item: AppliedChoice): string {
  if (item.option === "candidate") return item.chosen_source_path ?? "";
  return item.option === "external" ? EXTERNAL : NONE;
}

function answerLabel(option: "candidate" | "none" | "external", path: string | null): string {
  if (option === "candidate") return path ?? "a source field";
  return option === "external" ? "Provided externally" : "None of the above";
}

function staleNote(reason: StaleReason): string {
  if (reason === "format_changed") {
    return "Your earlier answer was given while comparing in another format, against a different schema. Answer again for this format.";
  }
  return reason === "source_schema_changed"
    ? "The source schema has changed since your earlier answer, so it no longer applies."
    : "The target schema has changed since your earlier answer, so it no longer applies.";
}

/** The options of one drop-down: the candidates the check found, then the two fixed choices. */
function FieldOptions({ candidates, reason }: { candidates: Candidate[]; reason: WaitingField["reason"] }) {
  return (
    <>
      {candidates.length > 0 && (
        <optgroup label={reason === "not_found" ? "Similar names only (no confirmed match)" : "Possible source fields"}>
          {candidates.map((candidate) => (
            <option key={`${candidate.source_path}-${candidate.unit_id}`} value={candidate.source_path}>
              {candidate.source_path} — {metadata(candidate.source_type, candidate.source_format, candidate.source_required)}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Other">
        <option value={NONE}>None of the above</option>
        <option value={EXTERNAL}>Provided by external lookup or workflow</option>
      </optgroup>
    </>
  );
}

function Actions({
  selection, busy, submitting, previewing, isSignedIn, onPreview, onSave,
}: {
  selection: string; busy: boolean; submitting: boolean; previewing: boolean; isSignedIn: boolean;
  onPreview: () => void; onSave: () => void;
}) {
  return (
    <>
      <div className="compat-mapping-actions">
        <button type="button" className="button secondary" disabled={!selection || busy} onClick={onPreview}>
          {previewing ? "Applying…" : "Apply to preview"}
        </button>
        {isSignedIn && (
          <button type="button" className="button primary" disabled={!selection || busy} onClick={onSave}>
            {submitting ? "Saving…" : "Save decision"}
          </button>
        )}
      </div>
      {!isSignedIn && (
        <p className="compat-mapping-login-note">
          Want to keep this decision? <a href="/login?next=%2Fcompatibility">Log in to save it for this API pair.</a>
        </p>
      )}
    </>
  );
}

function WaitingQuestion({ field, submitting, previewing, isSignedIn, onPreview, onSave }: {
  field: WaitingField; submitting: boolean; previewing: boolean; isSignedIn: boolean;
  onPreview: Props["onPreview"]; onSave: Props["onSave"];
}) {
  const [selection, setSelection] = useState("");
  const busy = submitting || previewing;
  const act = async (mode: "preview" | "save") => {
    const answer = answerOf(selection);
    if (!answer || busy) return;
    if (mode === "preview") await onPreview(field.targetPath, answer);
    else await onSave(field.targetPath, answer);
  };
  const id = `mapping-${field.targetPath}`;
  return (
    <article className="compat-mapping-question">
      <div className="compat-mapping-question-copy">
        <p className="eyebrow">Target field</p>
        <div className="compat-mapping-question-title">
          <code>{field.targetPath}</code>
          <span className={`compat-status ${field.required ? "status-warning" : "status-unknown"}`}>
            {field.required ? "Required" : "Optional — can be skipped"}
          </span>
        </div>
        <p className="compat-field-metadata">{metadata(field.targetType, field.targetFormat, field.required)}</p>
        <p>
          {field.stale
            ? staleNote(field.stale)
            : field.reason === "ambiguous"
              ? "Several source fields remain possible. Choose the one that supplies this target value."
              : field.candidates.length
                ? "No confirmed semantic match was found. The suggestions below are based on name similarity only."
                : "No confirmed semantic match and no similar name was found in the source."}
        </p>
      </div>
      <div className="compat-mapping-control">
        <label htmlFor={id}>How is this field supplied?</label>
        <select id={id} value={selection} disabled={busy} onChange={(event) => setSelection(event.target.value)}>
          <option value="">Choose…</option>
          <FieldOptions candidates={field.candidates} reason={field.reason} />
        </select>
        <Actions
          selection={selection} busy={busy} submitting={submitting} previewing={previewing} isSignedIn={isSignedIn}
          onPreview={() => void act("preview")} onSave={() => void act("save")}
        />
      </div>
    </article>
  );
}

function AppliedDecision({ item, submitting, previewing, isSignedIn, onPreview, onSave }: {
  item: AppliedChoice; submitting: boolean; previewing: boolean; isSignedIn: boolean;
  onPreview: Props["onPreview"]; onSave: Props["onSave"];
}) {
  const [editing, setEditing] = useState(false);
  const [selection, setSelection] = useState(selectionOf(item));
  const busy = submitting || previewing;
  const act = async (mode: "preview" | "save") => {
    const answer = answerOf(selection);
    if (!answer || busy) return;
    if (mode === "preview") await onPreview(item.target_path, answer);
    else await onSave(item.target_path, answer);
  };
  const id = `modify-${item.target_path}`;

  if (item.state === "resolved") {
    return (
      <article className="compat-applied-decision">
        <div>
          <p className="eyebrow">Settled by an administrator</p>
          <code>{item.target_path}</code>
          <strong>{answerLabel(item.option, item.chosen_source_path)}</strong>
        </div>
        <span className="compat-status status-pass">Locked</span>
      </article>
    );
  }

  return (
    <article className="compat-applied-decision">
      <div>
        <p className="eyebrow">Currently applied</p>
        <code>{item.target_path}</code>
        <strong>{answerLabel(item.option, item.chosen_source_path)}</strong>
      </div>
      {!editing ? (
        <button type="button" className="button secondary" onClick={() => setEditing(true)}>Change</button>
      ) : (
        <div className="compat-applied-edit">
          <p>
            Previously chosen: <strong>{answerLabel(item.option, item.chosen_source_path)}</strong>.
            Saving a different answer sends this field to an administrator, and nobody's answer applies until it is settled.
          </p>
          <label htmlFor={id}>How is this field supplied?</label>
          <select id={id} value={selection} disabled={busy} onChange={(event) => setSelection(event.target.value)}>
            {item.option === "candidate" && item.chosen_source_path && (
              <optgroup label="Currently applied">
                <option value={item.chosen_source_path}>{item.chosen_source_path}</option>
              </optgroup>
            )}
            <optgroup label="Other">
              <option value={NONE}>None of the above</option>
              <option value={EXTERNAL}>Provided externally</option>
            </optgroup>
          </select>
          <Actions
            selection={selection} busy={busy} submitting={submitting} previewing={previewing} isSignedIn={isSignedIn}
            onPreview={() => void act("preview")} onSave={() => void act("save")}
          />
          <button type="button" className="compat-text-button" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}
    </article>
  );
}

function ConflictItem({ field }: { field: ConflictField }) {
  return (
    <article className="compat-conflict-item">
      <div className="compat-mapping-question-title">
        <code>{field.target_path}</code>
        <span className="compat-status status-warning">{field.required ? "Required" : "Optional"} · awaiting review</span>
      </div>
      <p>The answers given for this field differ, so none of them applies until it has been reviewed. It cannot be changed here.</p>
      <ul>
        {field.answers.map((answer, index) => (
          <li key={`${answer.source}-${answer.chosen_by ?? index}`}>
            <strong>
              {answer.source === "registry" ? "The registry's automatic match" : answer.source === "admin" ? "An administrator" : "A user"}
            </strong>
            {": "}
            {answerLabel(answer.option, answer.chosen_source_path)}
            {answer.chosen_at && <time dateTime={answer.chosen_at}> · {new Date(answer.chosen_at).toLocaleString()}</time>}
          </li>
        ))}
      </ul>
    </article>
  );
}

export default function CompatibilityMappingReview({
  semantics, submitting, previewing, error, isSignedIn, onPreview, onSave,
}: Props) {
  const staleBy = new Map<string, StaleReason>(semantics.stale_choices.map((item) => [item.target_path, item.reason]));
  // Required first (rule S-8), then by path so the order never wanders.
  const byRequired = (a: WaitingField, b: WaitingField) =>
    Number(b.required) - Number(a.required) || a.targetPath.localeCompare(b.targetPath);
  const waiting: WaitingField[] = [
    ...semantics.ambiguous.map((item) => ({
      targetPath: item.target_path, targetType: item.target_type, targetFormat: item.target_format,
      required: item.required, candidates: item.candidates, reason: "ambiguous" as const,
      stale: staleBy.get(item.target_path) ?? null,
    })),
    ...semantics.not_found
      // An optional field with no match: a notice, not a question (rule S-8).
      .filter((item) => item.required || staleBy.has(item.target_path))
      .map((item) => ({
        targetPath: item.target_path, targetType: item.target_type, targetFormat: item.target_format,
        required: item.required, candidates: item.suggestions, reason: "not_found" as const,
        stale: staleBy.get(item.target_path) ?? null,
      })),
  ].sort(byRequired);
  const optionalWithoutMatch = semantics.not_found.filter((item) => !item.required && !staleBy.has(item.target_path));

  const applied = semantics.applied;
  const conflicts = semantics.conflicts;
  // An answer can become inapplicable for a field this comparison does not
  // have at all — the other format's body is a different shape, so the field
  // is not here to ask about again. Saying so beats letting the answer vanish.
  const waitingPaths = new Set(waiting.map((field) => field.targetPath));
  const orphanedStale = semantics.stale_choices.filter((item) => !waitingPaths.has(item.target_path));
  if (waiting.length === 0 && applied.length === 0 && conflicts.length === 0 && orphanedStale.length === 0 && optionalWithoutMatch.length === 0) return null;

  const total = waiting.length + applied.length + conflicts.length;
  return (
    <section className="field-compare-panel" aria-labelledby="mapping-review-title">
      <div className="field-compare-heading">
        <div>
          <p className="eyebrow">Field decisions</p>
          <h2 id="mapping-review-title">How each target field is supplied</h2>
          <p>Try a decision as a preview, or save it to this API pair when signed in.</p>
        </div>
        <span>{`${total} ${total === 1 ? "field" : "fields"}`}</span>
      </div>

      {error && <p className="compat-file-error" role="alert">{error}</p>}

      {conflicts.length > 0 && (
        <div className="compat-conflict-list">
          <h3>Submitted — awaiting review ({conflicts.length})</h3>
          {conflicts.map((field) => <ConflictItem key={field.target_path} field={field} />)}
        </div>
      )}

      {waiting.length > 0 && (
        <div className="compat-mapping-list">
          <h3>Needs your answer ({waiting.length})</h3>
          {waiting.map((field) => (
            <WaitingQuestion
              key={field.targetPath} field={field} submitting={submitting} previewing={previewing}
              isSignedIn={isSignedIn} onPreview={onPreview} onSave={onSave}
            />
          ))}
        </div>
      )}

      {optionalWithoutMatch.length > 0 && (
        <details className="compat-stale-note">
          <summary>
            <strong>
              {optionalWithoutMatch.length} optional target field{optionalWithoutMatch.length === 1 ? "" : "s"} have no source, and need no decision
            </strong>
          </summary>
          <p>Leaving them unmapped costs nothing: the target does not require them.</p>
          <ul>{optionalWithoutMatch.map((item) => <li key={item.target_path}><code>{item.target_path}</code></li>)}</ul>
        </details>
      )}

      {orphanedStale.length > 0 && (
        <div className="compat-stale-note" role="status">
          <strong>Earlier answers that do not apply here</strong>
          <ul>
            {orphanedStale.map((item) => (
              <li key={`${item.target_path}:${item.reason}`}>
                <code>{item.target_path}</code> — {item.reason === "format_changed"
                  ? "answered while comparing in another format; this format's body does not contain that field"
                  : "the schema changed since it was answered, and the field is no longer part of this comparison"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {applied.length > 0 && (
        <div className="compat-applied-list">
          <h3>Decisions in force ({applied.length})</h3>
          {applied.map((item) => (
            <AppliedDecision
              key={item.target_path} item={item} submitting={submitting} previewing={previewing}
              isSignedIn={isSignedIn} onPreview={onPreview} onSave={onSave}
            />
          ))}
        </div>
      )}
    </section>
  );
}
