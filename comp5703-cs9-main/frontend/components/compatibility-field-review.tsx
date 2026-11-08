"use client";

import { useEffect, useMemo, useState } from "react";
import type { CheckReport, Conversion } from "@/lib/checks/types";

type FieldFilter = "all" | "confirmed" | "blocking" | "needs_review" | "conflict" | "excluded";
type FieldGroup = Exclude<FieldFilter, "all">;
type FieldStatus = "mapped" | "type_incompatible" | "type_undetermined" | "external" | "no_source" | "required_selection" | "optional_review" | "conflict" | "stale" | "excluded";

type FieldValue = {
  path: string;
  type: string;
  format: string | null;
  required: boolean | null;
};

type ReviewRow = {
  id: string;
  group: FieldGroup;
  status: FieldStatus;
  source: FieldValue | null;
  target: FieldValue | null;
  title: string;
  detail: string;
  evidence: string[];
  conversion: Conversion | null;
};

const FILTERS: Array<{ value: FieldFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "confirmed", label: "Confirmed" },
  { value: "blocking", label: "Blocking" },
  { value: "needs_review", label: "Needs review" },
  { value: "conflict", label: "Conflict" },
  { value: "excluded", label: "Excluded" },
];

const STATUS_LABEL: Record<FieldStatus, string> = {
  mapped: "Mapped",
  type_incompatible: "Types cannot convert",
  type_undetermined: "Type not determined",
  external: "External input",
  no_source: "No source",
  required_selection: "Required selection",
  optional_review: "Optional review",
  conflict: "Awaiting review",
  stale: "Schema changed",
  excluded: "Excluded",
};

const EMPTY_COPY: Record<FieldFilter, { title: string; detail: string }> = {
  all: { title: "No field-level results are available.", detail: "The report does not contain semantic field results for this API pair." },
  confirmed: { title: "No fields have a confirmed handling decision.", detail: "Choose another filter to review unresolved or excluded fields." },
  blocking: { title: "No field is blocking this comparison.", detail: "Nothing here has a value type the target cannot accept." },
  needs_review: { title: "No fields currently need review.", detail: "There are no unresolved or stale field decisions in this report." },
  conflict: { title: "No field decision is waiting to be reviewed.", detail: "Every answer given for this pair either agrees or has been settled." },
  excluded: { title: "No fields were excluded.", detail: "The semantic check excluded no envelope field and no constant." },
};

function field(path: string, type = "unknown", format: string | null = null, required: boolean | null = null): FieldValue {
  return { path, type, format, required };
}

function fieldMetadata(value: FieldValue): string {
  return [value.type, value.format, value.required === null ? "requirement unknown" : value.required ? "required" : "optional"].filter(Boolean).join(" · ");
}

function FieldCell({ value, empty }: { value: FieldValue | null; empty: string }) {
  if (!value) return <div className="field-compare-empty">{empty}</div>;
  return <div className="field-compare-value"><code>{value.path}</code><span>{fieldMetadata(value)}</span></div>;
}

function buildRows(report: CheckReport): ReviewRow[] {
  const semantics = report.check2.semantics;
  if (!semantics) return [];

  const conversions = new Map((report.check2.types?.conversions ?? []).map((item) => [`${item.target_path}\u0000${item.source_path}`, item]));
  const requiredCoverage = new Map((report.check2.required?.required_fields ?? []).map((item) => [item.target_path, item]));
  const stalePaths = new Set(semantics.stale_choices.map((item) => item.target_path));
  const rows: ReviewRow[] = [];

  for (const mapping of semantics.mappings) {
    const conversion = conversions.get(`${mapping.target_path}\u0000${mapping.source_path}`) ?? null;
    const coverage = requiredCoverage.get(mapping.target_path);
    // 2.3 keeps one verdict for the whole check, so the pair can fail without
    // naming a field. The per-field conversion says which ones actually did
    // it, and a required field whose types cannot convert is the reason the
    // pair fails — it must not read as settled.
    const blocking = coverage !== undefined && conversion !== null
      && (conversion.kind === "incompatible" || conversion.kind === "undetermined" || conversion.kind === "shape");
    const blockingStatus: FieldStatus = conversion?.kind === "incompatible" ? "type_incompatible" : "type_undetermined";
    rows.push({
      id: `mapped:${mapping.target_path}:${mapping.source_path}`,
      group: blocking ? "blocking" : "confirmed",
      status: blocking ? blockingStatus : "mapped",
      source: field(mapping.source_path, conversion?.source_type),
      target: field(mapping.target_path, conversion?.target_type, null, coverage ? true : null),
      title: blocking
        ? conversion?.kind === "incompatible"
          ? "These fields mean the same thing, but their value types cannot be converted"
          : conversion?.kind === "shape"
            ? "These fields mean the same thing, but their container shapes differ and shape alignment is not implemented"
            : "These fields mean the same thing, but one side declares no value type"
        : mapping.origin === "auto" ? "Automatically matched" : "User-confirmed mapping",
      detail: conversion ? `${conversion.source_type} → ${conversion.target_type}${conversion.kind === "conditional" && conversion.condition ? `; requires ${conversion.condition}` : ""}${blocking ? " — this required field is why the comparison does not pass" : ""}` : "The report confirms that these fields represent the same value.",
      evidence: mapping.notes,
      conversion,
    });
  }

  for (const item of semantics.ambiguous) {
    const stale = stalePaths.has(item.target_path);
    rows.push({
      id: `ambiguous:${item.target_path}`,
      group: "needs_review",
      status: stale ? "stale" : item.required ? "required_selection" : "optional_review",
      source: null,
      target: field(item.target_path, item.target_type, item.target_format, item.required),
      title: stale ? "Previous decision is stale" : "Multiple possible source fields",
      detail: stale ? "The source or target schema changed. Review this field again." : item.required ? "Choose a source field or another handling option before a verdict can be produced." : "This field is optional and may be skipped.",
      evidence: item.candidates.map((candidate) => `${candidate.source_path}: ${candidate.basis}`),
      conversion: null,
    });
  }

  for (const item of semantics.not_found) {
    const stale = stalePaths.has(item.target_path);
    rows.push({
      id: `not-found:${item.target_path}`,
      group: "needs_review",
      status: stale ? "stale" : item.required ? "required_selection" : "optional_review",
      source: null,
      target: field(item.target_path, item.target_type, item.target_format, item.required),
      title: stale ? "Previous decision is stale" : "No confirmed semantic match",
      detail: item.suggestions.length > 0 ? "The suggestions below are based only on name similarity and are not confirmed mappings." : item.required ? "Choose how this required target field will be supplied." : "No action is required for this optional field.",
      evidence: item.suggestions.map((candidate) => `${candidate.source_path}: ${candidate.basis}`),
      conversion: null,
    });
  }

  for (const item of semantics.applied) {
    if (item.option === "candidate") continue;
    const coverage = requiredCoverage.get(item.target_path);
    rows.push({
      id: `applied:${item.target_path}:${item.option}`,
      group: "confirmed",
      status: item.option === "external" ? "external" : "no_source",
      source: null,
      target: field(item.target_path, "unknown", null, coverage ? true : null),
      title: item.state === "resolved" ? "Administrator decision" : "Current decision",
      detail: item.option === "external" ? "This value will be supplied outside the source API response." : "No source field has been selected for this target field.",
      evidence: [item.state === "resolved" ? "This administrator decision is locked." : "An agreed user decision is currently applied."],
      conversion: null,
    });
  }

  for (const item of semantics.conflicts) {
    rows.push({
      id: `conflict:${item.target_path}`,
      group: "conflict",
      status: "conflict",
      source: null,
      target: field(item.target_path, "unknown", null, item.required),
      title: "Conflicting field decisions",
      detail: "The answers given for this field differ, so none of them applies until it has been reviewed.",
      evidence: item.answers.map((answer) => {
        const decision = answer.option === "candidate" ? answer.chosen_source_path ?? "Candidate field" : answer.option === "external" ? "Provided externally" : "None of the above";
        return `${answer.source}: ${decision}${answer.chosen_by ? ` by ${answer.chosen_by}` : ""}${answer.chosen_at ? ` at ${answer.chosen_at}` : ""}`;
      }),
      conversion: null,
    });
  }

  for (const item of semantics.excluded) {
    rows.push({
      id: `excluded:${item.path}`,
      group: "excluded",
      status: "excluded",
      source: null,
      target: field(item.path),
      title: item.reason === "constant" ? "Excluded constant" : "Excluded envelope field",
      detail: item.reason === "constant"
        ? "This field admits exactly one value; the caller writes it in, so no source field is needed."
        : "This protocol or envelope field is outside the business-field comparison.",
      evidence: [],
      conversion: null,
    });
  }

  return rows;
}

function ReviewRowView({ row }: { row: ReviewRow }) {
  const [expanded, setExpanded] = useState(false);
  const sourceEmpty = row.status === "external" ? "Provided externally" : row.status === "no_source" ? "No source selected" : "Not confirmed";

  return <>
    <tr className={`report-field-row report-field-${row.status}`}>
      <td><FieldCell value={row.source} empty={sourceEmpty} /></td>
      <td>
        <button type="button" className={`report-field-status report-status-${row.status}`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span>{STATUS_LABEL[row.status]}</span><i aria-hidden="true">{expanded ? "−" : "+"}</i>
        </button>
        <small className="field-compare-preview">{row.status === "mapped" ? row.title : row.detail}</small>
      </td>
      <td><FieldCell value={row.target} empty="Not applicable" /></td>
    </tr>
    <tr className={`field-detail-row report-field-${row.status}`} hidden={!expanded}>
      <td colSpan={3}>
        <div className="field-detail-content">
          <p className="eyebrow">Field details</p>
          <h3>{row.title}</h3>
          <p>{row.detail}</p>
          {row.group === "confirmed" && row.evidence.length > 0 && <ul className="field-detail-list">{row.evidence.map((item, index) => <li key={`${row.id}:${index}`}>{item}</li>)}</ul>}
          {row.group === "needs_review" && <p className="field-detail-action"><strong>Next step</strong>Review the available options in Field mapping decisions below.</p>}
          {row.conversion?.kind === "conditional" && row.conversion.condition && <p className="field-detail-action"><strong>Runtime condition</strong>{row.conversion.condition}</p>}
        </div>
      </td>
    </tr>
  </>;
}

export default function CompatibilityFieldReview({ report }: { report: CheckReport }) {
  const rows = useMemo(() => buildRows(report), [report]);

  const counts: Record<FieldFilter, number> = useMemo(() => ({
    all: rows.length,
    confirmed: rows.filter((row) => row.group === "confirmed").length,
    blocking: rows.filter((row) => row.group === "blocking").length,
    needs_review: rows.filter((row) => row.group === "needs_review").length,
    conflict: rows.filter((row) => row.group === "conflict").length,
    excluded: rows.filter((row) => row.group === "excluded").length,
  }), [rows]);

  const suggestedFilter: FieldFilter = counts.blocking > 0 ? "blocking"
    : report.overall.overall === "pending_user" && counts.needs_review > 0 ? "needs_review" : report.overall.overall === "pending_admin" && counts.conflict > 0 ? "conflict" : counts.confirmed > 0 ? "confirmed" : counts.needs_review > 0 ? "needs_review" : "all";
  const [filter, setFilter] = useState<FieldFilter>(suggestedFilter);
  useEffect(() => { setFilter(suggestedFilter); }, [report.source.id, report.target.id]);
  useEffect(() => {if (filter !== "all" && counts[filter] === 0) setFilter(suggestedFilter);}, [counts, filter, suggestedFilter]);

  const visibleRows =
    filter === "all"
      ? rows
      : rows.filter((row) => row.group === filter);

  const optionalReviewCount = rows.filter(
    (row) => row.status === "optional_review",
  ).length;

  const empty = EMPTY_COPY[filter];

  return (
    <section
      className="field-compare-panel report-field-review"
      aria-labelledby="report-field-review-title"
    >
      <div className="report-field-toolbar">
        <div>
          <h2 id="report-field-review-title">Field-by-field review</h2>
          <p>Automatic matches and field decisions for the selected API pair.</p>
        </div>
        <span>{rows.length} {rows.length === 1 ? "field" : "fields"}</span>
      </div>

      <div className="report-field-filters" role="group" aria-label="Filter field review"> {FILTERS.map((item) => (<button key={item.value} type="button" className={filter === item.value ? "active" : ""} data-empty={counts[item.value] === 0} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}> {item.label}<span>{counts[item.value]}</span></button> ))}
      </div>
      {visibleRows.length > 0 ? (
        <div className="field-compare-table-shell">
          <table className="field-compare-table">
            <caption className="sr-only">
              Field-level compatibility report from {report.source.name} to{" "}
              {report.target.name}
            </caption>

            <thead>
              <tr>
                <th scope="col">
                  {report.source.name} · output field
                </th>
                <th scope="col">Field status</th>
                <th scope="col">
                  {report.target.name} · input field
                </th>
              </tr>
            </thead>

            <tbody>
              {visibleRows.map((row) => (
                <ReviewRowView key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className="empty-state report-field-empty"
          role="status"
        >
          <strong>{empty.title}</strong>
          <p>{empty.detail}</p>
        </div>
      )}
    </section>
  );
}