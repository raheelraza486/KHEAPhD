"use client";

import { useState } from "react";

type SpreadsheetUpdateRow = {
  source_row: number;
  api_id: string;
  api_name: string;
  field: string;
  proposed_value: string;
  evidence: string;
  evidence_url: string;
  note: string;
};

type InvalidRow = {
  source_row: number;
  api_id: string;
  field: string;
  error: string;
};

type Preview = {
  ready: true;
  plan_token: string;
  row_count: number;
  api_count: number;
  changed_row_count: number;
  unchanged_row_count: number;
  field_counts: Record<string, number>;
  sample: Array<{
    id: string;
    api_name: string;
    company_name: string;
    fields: string[];
    changes: Record<string, string | string[]>;
  }>;
};

type ErrorPayload = {
  error?: string;
  invalid_count?: number;
  invalid?: InvalidRow[];
};

const HEADER_ALIASES = {
  apiId: ["API ID"],
  apiName: ["API / Operation Name"],
  field: ["Supabase Column"],
  proposedValue: ["Proposed Value"],
  evidence: ["Evidence"],
  officialUrl: ["Official Documentation URL"],
  sourceUrl: ["Source URL"],
  note: ["Notes"],
} as const;

function cellText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u0000/g, "").trim();
}

function findColumn(headers: string[], aliases: readonly string[], required = false) {
  const index = aliases.map((alias) => headers.indexOf(alias)).find((candidate) => candidate >= 0) ?? -1;
  if (required && index < 0) throw new Error(`Missing spreadsheet column: ${aliases[0]}.`);
  return index;
}

function isMetadataHeader(row: unknown[]) {
  const headers = row.map(cellText);
  return HEADER_ALIASES.apiId.some((label) => headers.includes(label))
    && HEADER_ALIASES.field.some((label) => headers.includes(label))
    && HEADER_ALIASES.proposedValue.some((label) => headers.includes(label));
}

export function rowsFromMetadataWorksheet(table: unknown[][]): SpreadsheetUpdateRow[] {
  const headerIndex = table.findIndex(isMetadataHeader);
  if (headerIndex < 0) {
    throw new Error("Could not find the required metadata table header.");
  }
  const headers = table[headerIndex].map(cellText);
  const apiId = findColumn(headers, HEADER_ALIASES.apiId, true);
  const apiName = findColumn(headers, HEADER_ALIASES.apiName);
  const field = findColumn(headers, HEADER_ALIASES.field, true);
  const proposedValue = findColumn(headers, HEADER_ALIASES.proposedValue, true);
  const evidence = findColumn(headers, HEADER_ALIASES.evidence, true);
  const officialUrl = findColumn(headers, HEADER_ALIASES.officialUrl);
  const sourceUrl = findColumn(headers, HEADER_ALIASES.sourceUrl);
  const note = findColumn(headers, HEADER_ALIASES.note);
  if (officialUrl < 0 && sourceUrl < 0) {
    throw new Error("The spreadsheet is missing an official evidence URL column.");
  }

  const rows = table.slice(headerIndex + 1).flatMap((row, offset) => {
    const values = row.map(cellText);
    if (![apiId, field, proposedValue, evidence].some((index) => values[index])) return [];
    return [{
      source_row: headerIndex + offset + 2,
      api_id: values[apiId] ?? "",
      api_name: apiName >= 0 ? values[apiName] ?? "" : "",
      field: values[field] ?? "",
      proposed_value: values[proposedValue] ?? "",
      evidence: values[evidence] ?? "",
      evidence_url: (officialUrl >= 0 ? values[officialUrl] : "")
        || (sourceUrl >= 0 ? values[sourceUrl] : ""),
      note: note >= 0 ? values[note] ?? "" : "",
    }];
  });
  if (rows.length === 0) throw new Error("The spreadsheet contains no metadata update rows.");
  if (rows.length > 2_000) throw new Error("A spreadsheet may contain at most 2,000 update rows.");
  return rows;
}

async function responsePayload(response: Response) {
  return await response.json().catch(() => ({ error: "The server returned an unreadable response." })) as ErrorPayload & Partial<Preview>;
}

export default function AdminMetadataBulkUpdate({
  onCommitted,
}: {
  onCommitted?: () => void | Promise<void>;
}) {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<SpreadsheetUpdateRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [invalidRows, setInvalidRows] = useState<InvalidRow[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState<"parse" | "preview" | "commit" | "">("");

  async function selectFile(file: File | undefined) {
    setFileName(file?.name ?? "");
    setRows([]);
    setPreview(null);
    setInvalidRows([]);
    setError("");
    setSuccess("");
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) {
      setError("Choose an .xls or .xlsx workbook.");
      return;
    }
    if (file.size > 10_000_000) {
      setError("The workbook must be 10 MB or smaller.");
      return;
    }
    setBusy("parse");
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      let table: unknown[][] | null = null;
      for (const worksheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[worksheetName];
        if (!worksheet?.["!ref"]) continue;
        const candidate = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
          header: 1,
          defval: "",
          raw: false,
          range: 0,
          // Keep blank worksheet rows so validation reports real Excel row numbers.
          blankrows: true,
        }) as unknown[][];
        if (candidate.some(isMetadataHeader)) {
          table = candidate;
          break;
        }
      }
      if (!table) throw new Error("No worksheet contains the metadata table header.");
      setRows(rowsFromMetadataWorksheet(table));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The workbook could not be read.");
    } finally {
      setBusy("");
    }
  }

  async function requestPreview() {
    if (rows.length === 0 || busy) return;
    setBusy("preview");
    setPreview(null);
    setInvalidRows([]);
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/apis", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview_metadata_bulk", rows }),
      });
      const payload = await responsePayload(response);
      if (!response.ok || !payload.ready || !payload.plan_token) {
        setInvalidRows(payload.invalid ?? []);
        throw new Error(payload.error || "The spreadsheet could not be previewed.");
      }
      setPreview(payload as Preview);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The spreadsheet could not be previewed.");
    } finally {
      setBusy("");
    }
  }

  async function commitUpdate() {
    if (!preview || busy) return;
    setBusy("commit");
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/apis", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commit_metadata_bulk",
          rows,
          plan_token: preview.plan_token,
        }),
      });
      const payload = await responsePayload(response) as ErrorPayload & { updated_count?: number };
      if (!response.ok) throw new Error(payload.error || "The spreadsheet update failed.");
      setSuccess(`${payload.updated_count ?? preview.api_count} APIs were updated. Metadata curation did not mark them Verified.`);
      setPreview(null);
      await onCommitted?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The spreadsheet update failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <details className="admin-metadata-bulk">
      <summary>Bulk update API metadata</summary>
      <div className="admin-metadata-bulk-body">
        <p>Upload the completed metadata workbook. Preview checks every row against the current API IDs. Apply overwrites only the listed fields; it never marks an API Verified, and an existing verification is cleared if a verified field changes.</p>
        <p>For list fields, put one value on each line. Enter <code>[]</code> to clear a list; a blank cell does not clear it. Do not enter <code>null</code> or join values with commas. Commas within a business-rule sentence are allowed.</p>
        <div className="admin-metadata-bulk-actions">
          <label className="button secondary metadata-file-button">
            <span>{busy === "parse" ? "Reading workbook…" : "Choose .xls or .xlsx"}</span>
            <input
              type="file"
              accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={Boolean(busy)}
              onChange={(event) => void selectFile(event.target.files?.[0])}
            />
          </label>
          {fileName && <span className="metadata-file-name">Workbook selected · {rows.length || "—"} rows</span>}
          <button className="button secondary" type="button" disabled={rows.length === 0 || Boolean(busy)} onClick={() => void requestPreview()}>
            {busy === "preview" ? "Checking…" : "Preview update"}
          </button>
        </div>

        {error && <p className="repository-alert" role="alert">{error}</p>}
        {success && <p className="metadata-bulk-success" role="status">{success}</p>}
        {invalidRows.length > 0 && <div className="metadata-bulk-errors">
          <strong>{invalidRows.length} shown validation issue{invalidRows.length === 1 ? "" : "s"}</strong>
          <ul>{invalidRows.slice(0, 20).map((item, index) => <li key={`${item.source_row}-${item.field}-${index}`}>Row {item.source_row}{item.field ? ` (${item.field})` : ""}: {item.error}</li>)}</ul>
        </div>}

        {preview && <div className="metadata-bulk-preview">
          <div className="metadata-bulk-summary" aria-label="Bulk update preview summary">
            <span><strong>{preview.row_count}</strong> spreadsheet rows</span>
            <span><strong>{preview.api_count}</strong> APIs</span>
            <span><strong>{preview.changed_row_count}</strong> changed values</span>
            <span><strong>{preview.unchanged_row_count}</strong> already matched</span>
          </div>
          <p><strong>Fields:</strong> {Object.entries(preview.field_counts).map(([field, count]) => `${field} (${count})`).join(", ")}</p>
          <div className="metadata-bulk-sample">
            <strong>First {preview.sample.length} APIs in this update</strong>
            <ul>{preview.sample.map((item) => <li key={item.id}>{item.company_name} · {item.api_name}: {item.fields.map((field) => Array.isArray(item.changes[field]) && item.changes[field].length === 0 ? `${field} (clear list)` : field).join(", ")}</li>)}</ul>
          </div>
          <p className="metadata-bulk-warning">Applying is one database transaction. If any API changed after this preview, nothing is written and a new preview is required.</p>
          <button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => void commitUpdate()}>
            {busy === "commit" ? "Applying update…" : `Apply to ${preview.api_count} APIs`}
          </button>
        </div>}
      </div>
    </details>
  );
}
