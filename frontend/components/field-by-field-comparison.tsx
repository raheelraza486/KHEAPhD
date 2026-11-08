"use client";

import { useId, useState } from "react";
import { isFieldComparisonIssue, type FieldComparisonRow } from "@/lib/compatibility/field-comparison";

const LABEL: Record<FieldComparisonRow["verdict"], string> = {
  exact: "Exact match", mapping: "Needs mapping", blocking: "Incompatible",
  "source-only": "Source only", "target-only": "Target only", information: "Information",
};
const PRIORITY = { blocking: 0, mapping: 1, information: 2, "source-only": 2, "target-only": 2, exact: 3 };
function FieldCell({ field }: { field: FieldComparisonRow["source"] }) {
  return field ? (
    <div className="field-compare-value">
      <code>{field.path}</code>
      <span>{field.type} · {field.required === null ? "requirement unknown" : field.required ? "required" : "optional"}</span>
    </div>
  ) : <div className="field-compare-empty">Not present</div>;
}
function FieldRow({ row }: { row: FieldComparisonRow }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const fieldName = row.target?.path || row.source?.path || "Schema";
  const details = [...row.issues].sort((a, b) =>
    PRIORITY[a.kind === "info" ? "information" : a.kind] - PRIORITY[b.kind === "info" ? "information" : b.kind],
  );
  return (
    <>
      <tr className={`field-row-${row.verdict}`}>
        <td><FieldCell field={row.source} /></td>
        <td>
          <button
            type="button"
            className={`field-verdict field-detail-toggle verdict-${row.verdict}`}
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={`${LABEL[row.verdict]}: ${fieldName}. ${expanded ? "Hide" : "Show"} details`}
            onClick={() => setExpanded((value) => !value)}
          >
            {LABEL[row.verdict]}<span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
          {!expanded && <small className="field-compare-preview">{row.message}</small>}
        </td>
        <td><FieldCell field={row.target} /></td>
      </tr>
      <tr id={detailId} className={`field-detail-row field-row-${row.verdict}`} hidden={!expanded}>
        <td colSpan={3}>
          <div className="field-detail-content">
            <p className="eyebrow">{isFieldComparisonIssue(row) ? "What needs attention" : "Field details"}</p>
            {details.length ? <ul className="field-detail-list">{details.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <strong>{issue.code.replaceAll("_", " ")}</strong>
                <p>{issue.message}</p>
                {issue.suggestion && <p className="field-detail-action"><strong>Recommended action</strong>{issue.suggestion}</p>}
                {issue.match_tier !== undefined && <small>Match tier {issue.match_tier}</small>}
              </li>
            ))}</ul> : <p>{row.message}</p>}
          </div>
        </td>
      </tr>
    </>
  );
}

export default function FieldByFieldComparison({ sourceName, targetName, checked, rows }: {
  sourceName: string; targetName: string; checked: Array<"body" | "parameters">; rows: FieldComparisonRow[];
}) {
  const sortedRows = [...rows].sort((a, b) => PRIORITY[a.verdict] - PRIORITY[b.verdict]);
  const scope = checked.length === 1 && checked[0] === "parameters"
    ? "Target path and query parameters"
    : checked.includes("parameters") ? "Target request body and parameters" : "Target request body";
  return (
    <section className="field-compare-panel" aria-labelledby="field-compare-title">
      <div className="field-compare-heading">
        <div>
          <p className="eyebrow">Field-by-field view</p>
          <h2 id="field-compare-title">Field-by-field comparison</h2>
          <p>{scope}. Issues appear first. Click a status for details and recommended actions.</p>
        </div>
        <span>{rows.length} field pairs</span>
      </div>
      {sortedRows.length ? (
        <div className="field-compare-table-shell">
          <table className="field-compare-table">
            <caption className="sr-only">Field mappings from {sourceName} to {targetName}</caption>
            <thead>
              <tr>
                <th scope="col">{sourceName} · output field</th>
                <th scope="col">Compatibility</th>
                <th scope="col">{targetName} · input field</th>
              </tr>
            </thead>
            <tbody>{sortedRows.map((row) => <FieldRow key={row.id} row={row} />)}</tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state" role="status">
          <strong>No field comparison is available.</strong>
        </div>
      )}
    </section>
  );
}
