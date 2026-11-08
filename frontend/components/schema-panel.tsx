"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./schema-panel.module.css";
import { publicWebUrl } from "@/lib/api-information";

type Field = {
  path: string;
  json_type: string;
  format: string | null;
  is_required: boolean;
  is_array_item: boolean;
  enum_values: unknown[] | null;
  description: string;
};

type Schema = {
  id: string;
  direction: "request" | "response";
  media_type: string;
  status_code: string | null;
  origin: "extracted" | "uploaded";
  source_url: string;
  created_by: string;
  created_at: string;
  warnings: string[];
  fields: Field[];
  raw?: unknown;
};

type ApiSchemas = {
  api_id: string;
  api_name: string;
  company_name: string;
  can_upload: boolean;
  can_fetch: boolean;
  schemas: Schema[];
};

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "missing" }
  | { state: "ready"; api: ApiSchemas };

type Operation = { path: string; method: string };

function sideLabel(schema: Pick<Schema, "direction" | "status_code">): string {
  return schema.direction === "request" ? "Request" : `Response ${schema.status_code ?? ""}`.trim();
}

export default function SchemaPanel({ apiId, signedIn }: { apiId: string; signedIn: boolean }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/schemas?api_id=${encodeURIComponent(apiId)}`, { cache: "no-store" });
      const data = (await res.json()) as { apis?: ApiSchemas[]; error?: string };
      if (!res.ok) {
        setLoad({ state: "error", message: data.error ?? "Schemas could not be loaded." });
      } else if (!data.apis?.[0]) {
        setLoad({ state: "missing" });
      } else {
        setLoad({ state: "ready", api: data.apis[0] });
      }
    } catch {
      setLoad({ state: "error", message: "Schemas could not be loaded." });
    }
  }, [apiId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (load.state === "loading") return <p className={styles.shell}>Loading schemas…</p>;
  if (load.state === "error") return <div className={styles.shell}><p className="form-error" role="alert">{load.message}</p><button className="button secondary" type="button" onClick={() => void refresh()}>Retry loading schemas</button></div>;
  if (load.state === "missing") {
    return (
      <div className={styles.shell}>
        <p className="form-error">This API is not in the catalogue.</p>
        <a className="button secondary" href="/apis">Back to all APIs</a>
      </div>
    );
  }

  const { api } = load;
  return (
    <div className={styles.shell}>
      <header className={styles.head}>
        <p className="eyebrow">API schemas</p>
        <h1>{api.api_name}</h1>
        <p className={styles.muted}>{api.company_name}</p>
        <a className={styles.back} href={`/apis?api=${encodeURIComponent(api.api_id)}`}>← Back to this API</a>
      </header>

      <section aria-labelledby="schemas-title">
        <h2 id="schemas-title" className={styles.sectionTitle}>
          What this API accepts and returns
        </h2>
        <p className={styles.muted}>Saved request and response body definitions, including field descriptions and constraints. Check the provider documentation for URL parameters, headers and any responses not shown here.</p>
        {api.schemas.length === 0 ? (
          <div className={styles.empty}>
            <p>
              No body schema is available for this API yet. Check its provider documentation for exact request and response requirements.
            </p>
            {api.can_fetch ? <FetchFromDocumentation apiId={api.api_id} onDone={refresh} /> : null}
          </div>
        ) : (
          api.schemas.map((schema) => <SchemaCard key={schema.id} schema={schema} open={api.schemas.length <= 2} />)
        )}
      </section>

      {api.can_upload ? (
        <UploadForm apiId={api.api_id} onSaved={refresh} />
      ) : (
        <p className={styles.muted}>
          {signedIn
            ? "Only the person who submitted this API, or an administrator, can upload a schema for it."
            : <>
                <a href={`/login?next=${encodeURIComponent(`/apis/${api.api_id}/schemas`)}`}>Sign in</a>
                {" "}to upload a schema for an API you submitted.
              </>}
        </p>
      )}
    </div>
  );
}

const SKIP_LABELS: Record<string, string> = {
  has_schemas: "already had schemas",
  not_in_document: "no longer in the document",
  ambiguous_operation: "match more than one documented operation",
  no_schema_stated: "state no schema",
  not_yours: "belong to someone else",
};

function FetchFromDocumentation({ apiId, onDone }: { apiId: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/schemas/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_id: apiId }),
      });
      const data = (await res.json()) as {
        error?: string; filled?: number; schemas?: number; this_api?: string;
        skipped?: Record<string, number>;
      };
      if (!res.ok) {
        setMessage({ tone: "error", text: data.error ?? "The documentation could not be read." });
        return;
      }
      const others = Object.entries(data.skipped ?? {})
        .filter(([, n]) => n > 0)
        .map(([reason, n]) => `${n} ${SKIP_LABELS[reason] ?? reason}`);
      const self = data.this_api === "filled"
        ? "This API now has its schemas."
        : `This API was not filled: it ${SKIP_LABELS[data.this_api ?? ""] ?? "could not be matched"}.`;
      setMessage({
        tone: data.this_api === "filled" ? "ok" : "error",
        text: `${self} ${data.filled ?? 0} API${data.filled === 1 ? "" : "s"} from the same document filled`
          + (others.length ? `; others skipped: ${others.join(", ")}.` : "."),
      });
      await onDone();
    } catch {
      setMessage({ tone: "error", text: "The documentation could not be read." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.fetch}>
      <button className="button secondary" type="button" onClick={run} disabled={busy}>
        {busy ? "Reading the documentation…" : "Fetch schemas from its documentation"}
      </button>
      <span className={styles.muted}>
        Also fills other APIs linked to the same document that have none yet. Ambiguous matches are skipped.
      </span>
      {message ? (
        <p className={message.tone === "error" ? "form-error" : styles.ok} role="status">{message.text}</p>
      ) : null}
    </div>
  );
}

function SchemaCard({ schema, open }: { schema: Schema; open: boolean }) {
  const source = publicWebUrl(schema.source_url);
  return (
    <details className={styles.card} open={open}>
      <summary>
        <strong>{sideLabel(schema)}</strong>
        <span className={styles.muted}>{schema.media_type}</span>
        <span className={styles.muted}>{schema.fields.length} {schema.fields.length === 1 ? "field" : "fields"}</span>
        <span className={schema.origin === "extracted" ? styles.fromDoc : styles.fromUpload}>
          {schema.origin === "extracted" ? "From documentation" : `Uploaded by ${schema.created_by}`}
        </span>
      </summary>
      {schema.origin === "extracted" && source ? (
        <p className={styles.source}>
          Source: <a href={source} rel="noreferrer" target="_blank">{source}</a>
        </p>
      ) : null}
      {schema.warnings.length > 0 ? (
        <ul className={styles.warnings}>
          {schema.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      ) : null}
      <div className={styles.tableShell}>
        <table className={styles.table}>
          <thead>
            <tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Description</th><th scope="col">Allowed values</th></tr>
          </thead>
          <tbody>
            {schema.fields.map((f) => (
              <tr key={f.path}>
                <td><code>{f.path || "(body)"}</code></td>
                <td>{f.json_type}{f.format ? <span className={styles.muted}> · {f.format}</span> : null}{f.is_array_item && <span className={styles.muted}> · Array item</span>}</td>
                <td>{f.is_required ? "Yes" : "No"}</td>
                <td className={styles.description}>{f.description || "Not described"}</td>
                <td className={styles.muted}>{f.enum_values?.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(", ") || "Not specified"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {schema.fields.length === 0 && <p className={styles.source}>No individual fields were extracted. Inspect the raw schema for the body definition.</p>}
      </div>
      {schema.raw !== undefined && schema.raw !== null && <details className={styles.raw}>
        <summary>View raw JSON schema</summary>
        <p className={styles.muted}>The saved schema contains the available constraints and any examples supplied in that schema.</p>
        <pre tabIndex={0} aria-label={`${sideLabel(schema)} raw JSON schema`}><code>{JSON.stringify(schema.raw, null, 2)}</code></pre>
      </details>}
    </details>
  );
}

function UploadForm({ apiId, onSaved }: { apiId: string; onSaved: () => Promise<void> }) {
  const [kind, setKind] = useState<"openapi" | "schema">("openapi");
  const [text, setText] = useState("");
  const [direction, setDirection] = useState<"request" | "response">("request");
  const [status, setStatus] = useState("200");
  const [mediaType, setMediaType] = useState("application/json");
  const [operations, setOperations] = useState<Operation[]>([]);
  const [operation, setOperation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  function readFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === "string" ? reader.result : "");
      setOperations([]);
      setOperation("");
    };
    reader.readAsText(file);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const chosen = operations.find((o) => `${o.method} ${o.path}` === operation);
    const body = kind === "openapi"
      ? { api_id: apiId, kind, text, ...(chosen ? { operation: chosen } : {}) }
      : { api_id: apiId, kind, text, direction, media_type: mediaType, ...(direction === "response" ? { status_code: status } : {}) };
    try {
      const res = await fetch("/api/schemas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        error?: string; operations?: Operation[]; schemas?: number; fields?: number; replaced?: number; warning?: string;
      };
      if (!res.ok) {
        if (data.operations?.length) setOperations(data.operations);
        setMessage({ tone: "error", text: data.error ?? "The schema could not be saved." });
        return;
      }
      setMessage({
        tone: "ok",
        text: `Saved ${data.schemas} schema${data.schemas === 1 ? "" : "s"} with ${data.fields} fields`
          + (data.replaced ? `, replacing ${data.replaced} earlier upload${data.replaced === 1 ? "" : "s"}.` : ".")
          + (data.warning ? ` ${data.warning}` : ""),
      });
      setText("");
      setOperations([]);
      setOperation("");
      await onSaved();
    } catch {
      setMessage({ tone: "error", text: "The schema could not be saved." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.upload} aria-labelledby="upload-title">
      <h2 id="upload-title" className={styles.sectionTitle}>Upload a schema</h2>
      <p className={styles.muted}>
        For an API whose documentation cannot be fetched. A schema taken from the documentation is never replaced by an upload.
        {" "}Changing a schema returns the API to awaiting verification.
      </p>
      <form onSubmit={submit}>
        <fieldset className={styles.choice}>
          <legend>What are you uploading?</legend>
          <label><input type="radio" checked={kind === "openapi"} onChange={() => setKind("openapi")} /> An OpenAPI 3 document</label>
          <label><input type="radio" checked={kind === "schema"} onChange={() => setKind("schema")} /> One JSON Schema</label>
        </fieldset>

        {kind === "schema" ? (
          <div className={styles.row}>
            <label>
              Side
              <select value={direction} onChange={(e) => setDirection(e.target.value as "request" | "response")}>
                <option value="request">Request</option>
                <option value="response">Response</option>
              </select>
            </label>
            {direction === "response" ? (
              <label>Status <input value={status} onChange={(e) => setStatus(e.target.value)} size={6} /></label>
            ) : null}
            <label>Media type <input value={mediaType} onChange={(e) => setMediaType(e.target.value)} /></label>
          </div>
        ) : null}

        {operations.length > 0 ? (
          <label className={styles.block}>
            Which operation is this API?
            <select value={operation} onChange={(e) => setOperation(e.target.value)} required>
              <option value="">Choose…</option>
              {operations.map((o) => {
                const key = `${o.method} ${o.path}`;
                return <option key={key} value={key}>{key}</option>;
              })}
            </select>
          </label>
        ) : null}

        <label className={styles.block}>
          {kind === "openapi" ? "Document (JSON or YAML)" : "Schema (JSON or YAML)"}
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setOperations([]); setOperation(""); }}
            rows={12}
            spellCheck={false}
            required
          />
        </label>
        <label className={styles.block}>
          Or choose a file
          <input type="file" accept=".json,.yaml,.yml,application/json,text/yaml" onChange={(e) => readFile(e.target.files?.[0])} />
        </label>

        {message ? (
          <p className={message.tone === "error" ? "form-error" : styles.ok} role="status">{message.text}</p>
        ) : null}
        <button className="button primary" type="submit" disabled={busy || text.trim() === ""}>
          {busy ? "Saving…" : "Upload schema"}
        </button>
      </form>
    </section>
  );
}
