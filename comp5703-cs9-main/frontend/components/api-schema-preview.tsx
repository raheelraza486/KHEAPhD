"use client";

import { useEffect, useState } from "react";
import type { ApiSchemasEntry, ApiSchemasResponse } from "@/lib/compatibility/ui-types";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; api: ApiSchemasEntry | null };

export default function ApiSchemaPreview({ apiId }: { apiId: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    async function fetchSchemas() {
      try {
        const response = await fetch(`/api/schemas?api_id=${encodeURIComponent(apiId)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as ApiSchemasResponse & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Saved fields could not be loaded.");
        if (!controller.signal.aborted) setLoad({ state: "ready", api: payload.apis.find(api => api.api_id === apiId) ?? null });
      } catch (cause) {
        if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "Saved fields could not be loaded." });
      }
    }
    void fetchSchemas();
    return () => controller.abort();
  }, [apiId, attempt]);

  if (load.state === "loading") return <p className="api-info-caption" role="status">Loading request and response fields…</p>;
  if (load.state === "error") return <div className="api-schema-message" role="alert"><p>{load.message}</p><button className="text-button" type="button" onClick={() => setAttempt(attempt + 1)}>Retry loading fields</button></div>;
  if (!load.api) return <p className="api-info-caption">This API is no longer available in the catalogue.</p>;

  const { api } = load;
  return <div className="api-schema-preview">
    {(["request", "response"] as const).map(direction => {
      const schemas = api.schemas.filter(schema => schema.direction === direction);
      return <section key={direction} aria-label={`${direction === "request" ? "Request" : "Response"} body schemas`}>
        <h4>{direction === "request" ? "Request body" : "Response body"}<span>{schemas.length} {schemas.length === 1 ? "schema" : "schemas"}</span></h4>
        {!schemas.length && <p className="api-info-caption">No {direction} body schema is saved. This does not establish whether the API {direction === "request" ? "needs" : "returns"} a body; check the documentation.</p>}
        {schemas.map(schema => <details key={schema.id} className="api-schema-card" open={schemas.length === 1}>
          <summary><strong>{direction === "response" ? `${schema.status_code || "Unspecified status"} · ` : ""}{schema.media_type || "Media type not recorded"}</strong><span>{schema.fields.length} {schema.fields.length === 1 ? "field" : "fields"}</span></summary>
          <p className="api-info-caption">{schema.origin === "extracted" ? "Extracted from documentation" : "Uploaded schema"} · Required: {schema.fields.filter(field => field.is_required).length}</p>
          {schema.warnings.length > 0 && <p className="api-info-note">{schema.warnings.length} extraction {schema.warnings.length === 1 ? "note" : "notes"}. Review the full schema for limitations.</p>}
          {schema.fields.length ? <ul className="api-field-list">{schema.fields.slice(0, 8).map((field, i) => <li key={`${field.path}-${i}`}>
            <div><code>{field.path || "(body)"}</code><span className={`api-field-required ${field.is_required ? "required" : ""}`}>{field.is_required ? "Required" : "Optional"}</span></div>
            <span className="api-field-type">{field.json_type}{field.format ? ` · ${field.format}` : ""}{field.is_array_item ? " · Array item" : ""}</span>
            {field.description && <p>{field.description}</p>}
            {field.enum_values?.length ? <p>Allowed values: {field.enum_values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(", ")}</p> : null}
          </li>)}</ul> : <p className="api-info-caption">No individual fields were extracted. The raw schema may still describe this body.</p>}
          {schema.fields.length > 8 && <p className="api-info-caption">Showing 8 of {schema.fields.length} fields.</p>}
        </details>)}
      </section>;
    })}
    <a className="api-schema-full-link" href={`/apis/${encodeURIComponent(apiId)}/schemas`}>Open all fields, descriptions &amp; raw schemas →</a>
  </div>;
}
