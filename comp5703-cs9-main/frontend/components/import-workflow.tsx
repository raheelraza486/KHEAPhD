"use client";

import { useEffect, useRef, useState } from "react";
import type { PredictedOutcome } from "@/lib/import/merge";
import { MAX_CONFIRM_OPERATIONS } from "@/lib/import/import-safety";
import type { ApiCategory, CommunicationDirection } from "@/lib/types";
import {
  classifyPreviewCandidates,
  isNewPreviewCandidate,
  isSupportedDocumentUrl,
  isUnreadableDocumentResponse,
  selectablePreviewIndexes,
} from "@/lib/import/preview-ui";

type PreviewCandidate = {
  index: number;
  api_name: string;
  api_endpoint: string;
  http_method: string;
  data_quality: string;
  category: ApiCategory;
  communication_direction: CommunicationDirection | "";
  predicted_outcome: PredictedOutcome;
  warnings: string[];
};

type PreviewResponse = {
  sessionId: string;
  documentation_url: string;
  info_title: string;
  info_version: string | null;
  warnings: string[];
  excluded_count?: number;
  candidates: PreviewCandidate[];
};

type Summary = {
  inserted: number;
  skipped: number;
  conflicted: number;
  failed: number;
  details: { index: number; api_name: string; action: string; reason?: string }[];
};

type Stage =
  | { name: "idle" }
  | { name: "previewing" }
  | { name: "preview"; data: PreviewResponse; selected: Set<number> }
  | { name: "confirming"; data: PreviewResponse; selected: Set<number> }
  | { name: "done"; summary: Summary };

type ImportAlert = {
  tone: "error" | "warning";
  eyebrow: string;
  title: string;
  message: string;
  detail?: string;
  actionLabel: string;
  focusTarget: "url" | "preview";
};

function detailActionLabel(action: string): string {
  if (action === "audit_warning") return "Audit warning";
  if (action === "conflict") return "Not added";
  if (action === "failed") return "Failed";
  return action;
}

const categoryTone: Record<ApiCategory, string> = {
  Communication: "tone-teal",
  Transformation: "tone-blue",
  Validation: "tone-amber",
  Other: "tone-purple",
};

function previewCategoryLabel(candidate: PreviewCandidate) {
  if (candidate.category === "Other") return "Other · review";
  if (candidate.category !== "Communication") return candidate.category;
  const direction = candidate.communication_direction === "Send and receive"
    ? "Send & receive"
    : candidate.communication_direction || "Unspecified";
  return `Communication · ${direction}`;
}

// All text here is React-rendered, so it is escaped by default. No field from
// a fetched document is ever passed to dangerouslySetInnerHTML.
type ImportWorkflowProps = {
  submittedBy: string;
  embedded?: boolean;
  initialUrl?: string;
  onImportComplete?: (inserted: number) => void;
};

export default function ImportWorkflow({
  submittedBy,
  embedded = false,
  initialUrl = "",
  onImportComplete,
}: ImportWorkflowProps) {
  const [url, setUrl] = useState(initialUrl);
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [error, setError] = useState("");
  const [importAlert, setImportAlert] = useState<ImportAlert | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const alertDialogRef = useRef<HTMLElement>(null);
  const alertActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!importAlert) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => alertActionRef.current?.focus());

    function handleAlertKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setImportAlert(null);
        return;
      }
      if (event.key !== "Tab" || !alertDialogRef.current) return;
      const focusable = [...alertDialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const focusIsOutside = !alertDialogRef.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleAlertKeys);
    return () => {
      document.removeEventListener("keydown", handleAlertKeys);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => {
        if (importAlert.focusTarget === "url") {
          urlInputRef.current?.focus();
          urlInputRef.current?.select();
        } else if (previewHeadingRef.current) {
          previewHeadingRef.current.focus();
        } else if (previousFocus?.isConnected) {
          previousFocus.focus();
        }
      });
    };
  }, [importAlert]);

  function dismissImportAlert() {
    setImportAlert(null);
  }

  async function runPreview(event: React.FormEvent) {
    event.preventDefault();
    const documentUrl = url.trim();
    if (!isSupportedDocumentUrl(documentUrl)) {
      setStage({ name: "idle" });
      setError("");
      setImportAlert({
        tone: "error",
        eyebrow: "Import error",
        title: "Check the document link",
        message: "Enter a complete public URL beginning with http:// or https://.",
        detail: "The link should point directly to an OpenAPI JSON or YAML document.",
        actionLabel: "Check the link",
        focusTarget: "url",
      });
      return;
    }
    setError("");
    setStage({ name: "previewing" });
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: documentUrl }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStage({ name: "idle" });
        if (isUnreadableDocumentResponse(res.status)) {
          setImportAlert({
            tone: "error",
            eyebrow: "Import error",
            title: "We couldn’t read that link",
            message: payload.error ?? "The document could not be read.",
            detail: "Check that the URL is correct, publicly accessible, and points directly to a document, then try again.",
            actionLabel: "Check the link",
            focusTarget: "url",
          });
        } else {
          setImportAlert({
            tone: "error",
            eyebrow: "Import error",
            title: "Preview could not be created",
            message: payload.error ?? "The import service could not complete the request.",
            detail: "Nothing was imported. Please try again shortly.",
            actionLabel: "Dismiss",
            focusTarget: "url",
          });
        }
        return;
      }
      if (payload.refused) {
        setStage({ name: "idle" });
        setImportAlert({
          tone: "error",
          eyebrow: "Unsupported document",
          title: "Unsupported document format",
          message: payload.message ?? "This document format cannot be imported.",
          detail: payload.detected_format
            ? `Detected format: ${payload.detected_format}. Please provide an OpenAPI 3.x JSON or YAML document.`
            : "Please provide an OpenAPI 3.x JSON or YAML document.",
          actionLabel: "Choose another link",
          focusTarget: "url",
        });
        return;
      }
      if (payload.unchanged) {
        setStage({ name: "idle" });
        setImportAlert({
          tone: "warning",
          eyebrow: "Nothing to import",
          title: "Everything in this document is already imported",
          message: payload.message ?? "The document has not changed since it was last imported.",
          detail: "No catalogue records were changed.",
          actionLabel: "Try another link",
          focusTarget: "url",
        });
        return;
      }
      const candidates = Array.isArray(payload.candidates)
        ? payload.candidates as PreviewCandidate[]
        : [];
      const candidateState = classifyPreviewCandidates(candidates);
      if (candidateState === "none") {
        const excludedCount = typeof payload.excluded_count === "number"
          ? payload.excluded_count
          : 0;
        setStage({ name: "idle" });
        setImportAlert({
          tone: excludedCount > 0 ? "warning" : "error",
          eyebrow: excludedCount > 0 ? "Nothing in catalogue scope" : "Import error",
          title: excludedCount > 0
            ? "All operations were excluded by the catalogue rule"
            : "No importable operations found",
          message: excludedCount > 0
            ? `${excludedCount} operation${excludedCount === 1 ? " was" : "s were"} outside the e-invoicing catalogue scope.`
            : "The document could be read, but it does not contain any OpenAPI operations to import.",
          detail: excludedCount > 0
            ? "No catalogue records were created."
            : "Check that the link points to the intended OpenAPI 3.x document.",
          actionLabel: "Check the link",
          focusTarget: "url",
        });
        return;
      }
      const previewData: PreviewResponse = { ...payload, candidates };
      // A preview is reviewable evidence, not consent to bulk insert. Start
      // empty so the submitter must deliberately choose every operation.
      const selected = new Set<number>();
      setStage({ name: "preview", data: previewData, selected });
      if (candidateState === "all_existing") {
        const exactDuplicates = candidates.filter(
          (candidate) => candidate.predicted_outcome === "duplicate",
        ).length;
        const changedExisting = candidates.length - exactDuplicates;
        setImportAlert({
          tone: "warning",
          eyebrow: "Nothing to import",
          title: "Everything in this document is already imported",
          message: changedExisting === 0
            ? candidates.length === 1
              ? "The operation in this document is an exact duplicate of an existing import."
              : `All ${candidates.length} operations are exact duplicates of existing imports.`
            : exactDuplicates === 0
              ? candidates.length === 1
                ? "The operation in this document is already imported. Its document changes will be ignored."
                : `All ${candidates.length} operations are already imported and contain document changes that will be ignored.`
              : `All ${candidates.length} operations are already imported. ${exactDuplicates} are exact duplicates and ${changedExisting} contain document changes that will be ignored.`,
          detail: "Nothing was selected or changed. This import only adds new operations; existing database records remain untouched and visible in the preview.",
          actionLabel: "Review the preview",
          focusTarget: "preview",
        });
      }
    } catch {
      setStage({ name: "idle" });
      setImportAlert({
        tone: "error",
        eyebrow: "Import error",
        title: "Preview could not be created",
        message: "The request could not be completed.",
        detail: "Nothing was imported. Check your connection and try again shortly.",
        actionLabel: "Dismiss",
        focusTarget: "url",
      });
    }
  }

  async function runConfirm() {
    if (stage.name !== "preview") return;
    const { data } = stage;
    const allowedIndexes = new Set(selectablePreviewIndexes(data.candidates));
    const selected = new Set([...stage.selected].filter((index) => allowedIndexes.has(index)));
    if (selected.size === 0) return;
    setError("");
    setStage({ name: "confirming", data, selected });
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: data.sessionId, selected: [...selected] }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStage({ name: "preview", data, selected });
        setError(payload.error ?? "The import could not be completed.");
        return;
      }
      const summary = payload.summary as Summary;
      setStage({ name: "done", summary });
      onImportComplete?.(summary.inserted);
    } catch {
      setStage({ name: "preview", data, selected });
      setError("The request could not be completed.");
    }
  }

  function toggle(index: number) {
    if (stage.name !== "preview") return;
    const candidate = stage.data.candidates.find((item) => item.index === index);
    if (!candidate || !isNewPreviewCandidate(candidate)) return;
    const next = new Set(stage.selected);
    if (next.has(index)) next.delete(index);
    else {
      if (next.size >= MAX_CONFIRM_OPERATIONS) {
        setError(`Select no more than ${MAX_CONFIRM_OPERATIONS} operations in one import.`);
        return;
      }
      next.add(index);
    }
    setError("");
    setStage({ ...stage, selected: next });
  }

  function selectAll() {
    if (stage.name !== "preview") return;
    const selectable = selectablePreviewIndexes(stage.data.candidates);
    const selected = new Set(selectable.slice(0, MAX_CONFIRM_OPERATIONS));
    setError(selectable.length > MAX_CONFIRM_OPERATIONS
      ? `Only the first ${MAX_CONFIRM_OPERATIONS} new operations were selected. Import the remainder in another batch.`
      : "");
    setStage({ ...stage, selected });
  }

  function deselectAll() {
    if (stage.name !== "preview") return;
    setError("");
    setStage({ ...stage, selected: new Set<number>() });
  }

  function reset() {
    setStage({ name: "idle" });
    setUrl("");
    setError("");
    setImportAlert(null);
  }

  const previewCounts =
    stage.name === "preview" || stage.name === "confirming"
      ? {
          newOperations: stage.data.candidates.filter(isNewPreviewCandidate).length,
          existing: stage.data.candidates.filter(
            (candidate) => !isNewPreviewCandidate(candidate),
          ).length,
        }
      : null;

  return (
    <section
      className={`import-workflow${embedded ? " embedded" : ""}`}
      id="submit-api"
      aria-labelledby="submit-title"
    >
      <p className="eyebrow">OpenAPI import</p>
      {embedded
        ? <h2 className="import-workflow-title" id="submit-title">Submit an API by link</h2>
        : <h1 className="import-workflow-title" id="submit-title">Submit an API by link</h1>}
      <p className="import-lead">
        Paste the link to an OpenAPI document. The service reads it, lists the operations it
        describes, and lets you choose which to add before anything is saved.
      </p>

      <form className="import-url-form" onSubmit={runPreview} noValidate>
        <label htmlFor="import-url">OpenAPI document URL</label>
        <div className="import-url-row">
          <input
            ref={urlInputRef}
            id="import-url"
            type="url"
            required
            placeholder="https://api.example.gov/openapi.json"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={stage.name === "previewing"}
          />
          <button type="submit" className="button primary" disabled={stage.name === "previewing"}>
            {stage.name === "previewing" ? "Reading…" : "Preview"}
          </button>
        </div>
        <small>OpenAPI 3.x and Swagger 2.0 documents are imported, including a definition embedded in a provider's Markdown page. WSDL is recognised but not yet imported.</small>
      </form>

      {error && !importAlert && <p className="form-error" role="alert">{error}</p>}

      {(stage.name === "preview" || stage.name === "confirming") && previewCounts && (
        <div className="import-preview">
          <div className="import-preview-head">
            <div>
              <h2 ref={previewHeadingRef} tabIndex={-1}>{stage.data.info_title || "Document"}</h2>
              <p className="import-preview-meta">
                {stage.data.candidates.length} operations in catalogue scope
                {(stage.data.excluded_count ?? 0) > 0
                  ? ` · ${stage.data.excluded_count} excluded`
                  : ""}
                {stage.data.info_version ? ` · document version ${stage.data.info_version}` : ""}
              </p>
              <p className="import-preview-url">{stage.data.documentation_url}</p>
            </div>
            <div className="import-preview-counts" aria-live="polite" aria-atomic="true">
              <span className="import-selected-count">
                {stage.selected.size} of {previewCounts.newOperations} new selected
              </span>
              {previewCounts.existing > 0 && (
                <span className="import-existing-count">
                  {previewCounts.existing} already imported — locked
                </span>
              )}
            </div>
          </div>

          {stage.data.warnings.length > 0 && (
            <ul className="import-doc-warnings" aria-label="Document notes">
              {stage.data.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}

          <div
            className="import-selection-toolbar"
            role="group"
            aria-label="Preview selection controls"
          >
            <p id="existing-selection-note">
              Nothing is selected automatically. Choose up to {MAX_CONFIRM_OPERATIONS} new operations.
              Already imported operations are locked; exact duplicates are skipped and document changes are ignored.
            </p>
            <div className="import-selection-actions">
              <button
                type="button"
                className="button secondary"
                onClick={selectAll}
                aria-describedby="existing-selection-note"
                disabled={
                  stage.name === "confirming" ||
                  previewCounts.newOperations === 0 ||
                  stage.selected.size === previewCounts.newOperations
                }
              >
                Select all
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={deselectAll}
                disabled={stage.name === "confirming" || stage.selected.size === 0}
              >
                Deselect all
              </button>
            </div>
          </div>

          <p className="import-classification-note">
            General scope rules admit only e-invoicing operations classified as Communication, Transformation or Validation; reviewed provider rules apply additional exact exclusions. Communication direction is inferred from clear sending or receiving language, never from the HTTP method alone.
          </p>

          <p className="import-table-scroll-hint" id="import-table-scroll-hint">On smaller screens, scroll horizontally to see all columns.</p>
          <div className="import-table-shell" tabIndex={0} role="region" aria-label="Operations available to import" aria-describedby="import-table-scroll-hint">
            <table className="import-table">
              <colgroup>
                <col className="import-col-select" />
                <col className="import-col-operation" />
                <col className="import-col-method" />
                <col className="import-col-endpoint" />
                <col className="import-col-category" />
                <col className="import-col-outcome" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Import</th>
                  <th scope="col">Operation</th>
                  <th scope="col">Method</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Proposed category</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {stage.data.candidates.map((c) => {
                  const isNew = isNewPreviewCandidate(c);
                  const isDuplicate = c.predicted_outcome === "duplicate";
                  return (
                    <tr
                      key={c.index}
                      className={
                        isDuplicate
                          ? "preview-duplicate"
                          : !isNew
                            ? "preview-existing"
                            : stage.selected.has(c.index)
                            ? ""
                            : "row-unselected"
                      }
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={
                            isDuplicate
                              ? `${c.api_name} is an exact duplicate and will be skipped`
                              : !isNew
                                ? `${c.api_name} is already imported and document changes will be ignored`
                                : `Import ${c.api_name}`
                          }
                          aria-describedby={!isNew ? "existing-selection-note" : undefined}
                          checked={isNew && stage.selected.has(c.index)}
                          onChange={() => toggle(c.index)}
                          disabled={stage.name === "confirming" || !isNew}
                        />
                      </td>
                      <td>
                        <strong>{c.api_name}</strong>
                        {c.data_quality !== "ok" && <small className="row-flag">{c.data_quality}</small>}
                        {c.warnings.map((w) => <small key={w}>{w}</small>)}
                      </td>
                      <td><code>{c.http_method}</code></td>
                      <td className="import-endpoint">{c.api_endpoint || "— no endpoint —"}</td>
                      <td>
                        {isNew ? (
                          <span
                            className={`pill ${categoryTone[c.category]}`}
                            title={c.category === "Other"
                              ? "No single high-confidence category signal was found in this operation."
                              : c.category === "Communication" && c.communication_direction === "Unspecified"
                                ? "Communication was identified, but the document does not clearly state a sending or receiving direction."
                              : "Automatically classified from this OpenAPI operation."}
                          >
                            {previewCategoryLabel(c)}
                          </span>
                        ) : (
                          <span className="import-category-unchanged">Unchanged</span>
                        )}
                      </td>
                      <td>
                        <span className={`row-status ${isNew ? "insert" : isDuplicate ? "duplicate" : "existing"}`}>
                          {isNew
                            ? "new"
                            : isDuplicate
                              ? "exact duplicate — skipped"
                              : "already imported — changes ignored"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="import-confirm-bar">
            <div className="actor-field signed-in-actor">
              <span>Submitting as</span>
              <strong>{submittedBy}</strong>
              <small>This import will be signed with your logged-in account.</small>
            </div>
            <div className="import-confirm-actions">
              <button type="button" className="button secondary" onClick={reset} disabled={stage.name === "confirming"}>
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                onClick={runConfirm}
                disabled={
                  stage.name === "confirming" ||
                  stage.selected.size === 0
                }
              >
                {stage.name === "confirming" ? "Importing…" : `Import ${stage.selected.size} selected`}
              </button>
            </div>
          </div>
        </div>
      )}

      {stage.name === "done" && (
        <div className="import-complete" aria-live="polite">
          <span className="completion-mark" aria-hidden="true">✓</span>
          <h2>{stage.summary.inserted > 0 ? "Import finished" : "Nothing new was added"}</h2>
          <div className="import-added-total">
            <strong>{stage.summary.inserted}</strong>
            <span>{stage.summary.inserted === 1 ? "API submitted" : "APIs submitted"}</span>
          </div>
          <p className="import-unchanged-note">Existing catalogue records were not changed. New submissions are publicly listed as Awaiting verification until an administrator records an official-source check.</p>
          {stage.summary.failed > 0 && (
            <p className="import-failed-note" role="alert">
              {stage.summary.failed} selected {stage.summary.failed === 1 ? "operation could" : "operations could"} not be added.
            </p>
          )}
          {stage.summary.details.length > 0 && (
            <ul className="import-detail-list" aria-label="Import details">
              {stage.summary.details.map((d) => (
                <li key={`${d.index}-${d.action}`}>
                  <span className={`row-status ${d.action}`}>{detailActionLabel(d.action)}</span> {d.api_name}
                  {d.reason === "name_taken" && " — an API with this name already exists"}
                  {d.reason === "audit_not_recorded" && " — added, but its audit history could not be recorded"}
                  {d.reason === "session_not_finalised" && " — import completed, but its session details could not be finalised"}
                </li>
              ))}
            </ul>
          )}
          <div className="completion-actions">
            <button type="button" className="button secondary" onClick={reset}>Submit another</button>
            <a className="button primary" href="/profile?view=submissions">Track my submissions</a>
          </div>
        </div>
      )}

      {importAlert && (
        <div
          className="modal-backdrop import-alert-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dismissImportAlert();
          }}
        >
          <section
            ref={alertDialogRef}
            className={`modal import-alert-modal ${importAlert.tone}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="import-alert-title"
            aria-describedby={
              importAlert.detail
                ? "import-alert-description import-alert-detail"
                : "import-alert-description"
            }
          >
            <div className="modal-heading">
              <div>
                <p className={`eyebrow ${importAlert.tone === "error" ? "danger-eyebrow" : ""}`}>
                  {importAlert.eyebrow}
                </p>
                <h2 id="import-alert-title">{importAlert.title}</h2>
              </div>
              <button
                type="button"
                aria-label="Close import message"
                onClick={dismissImportAlert}
              >
                ×
              </button>
            </div>
            <p className="modal-copy" id="import-alert-description">{importAlert.message}</p>
            {importAlert.detail && (
              <p className="import-alert-detail" id="import-alert-detail">{importAlert.detail}</p>
            )}
            <div className="import-alert-actions">
              <button
                ref={alertActionRef}
                type="button"
                className="button primary"
                onClick={dismissImportAlert}
              >
                {importAlert.actionLabel}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
