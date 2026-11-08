"use client";

import { useEffect, useState } from "react";
import type { ApiRecord } from "@/lib/types";
import ApiOverview from "@/components/api-overview";
import {
  apiInformationCoverage,
  catalogueDate,
  publicWebUrl,
  QUALITY_NOTES,
} from "@/lib/api-information";
import type { ApiSchemaAvailability, SchemaAvailabilityResponse } from "@/lib/compatibility/ui-types";
import ApiSchemaPreview from "@/components/api-schema-preview";
import { formatFormatsForDisplay, formatInputFormatsForDisplay } from "@/lib/format-display";

export default function ApiInformation({ record, onCopyEndpoint }: { record: ApiRecord; onCopyEndpoint: () => void }) {
  const [showSchemas, setShowSchemas] = useState(false);
  const [schemaAvailability, setSchemaAvailability] = useState<ApiSchemaAvailability>();
  const [schemaCheckFailed, setSchemaCheckFailed] = useState(false);
  const documentation = publicWebUrl(record.documentation_url);
  const website = publicWebUrl(record.website_url);
  const source = publicWebUrl(record.source_url);
  const authentication = record.authentication_method === "Other" && record.authentication_other
    ? record.authentication_other : record.authentication_method;
  const qualityNote = QUALITY_NOTES[record.data_quality];
  const coverage = apiInformationCoverage(record, schemaAvailability);

  useEffect(() => {
    const controller = new AbortController();
    setSchemaAvailability(undefined);
    setSchemaCheckFailed(false);
    async function checkSchemas() {
      try {
        const response = await fetch(`/api/schemas/availability?api_id=${encodeURIComponent(record.id)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as SchemaAvailabilityResponse & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Schema coverage could not be checked.");
        if (!controller.signal.aborted) {
          setSchemaAvailability(payload.apis.find((api) => api.api_id === record.id) ?? {
            api_id: record.id,
            request_count: 0,
            response_count: 0,
          });
        }
      } catch {
        if (!controller.signal.aborted) setSchemaCheckFailed(true);
      }
    }
    void checkSchemas();
    return () => controller.abort();
  }, [record.id]);

  return <div className="api-information">
    <p className="detail-description">{record.description || "A description has not been recorded for this API."}</p>
    <div className="api-quick-links">
      {documentation && <a className="button primary" href={documentation} target="_blank" rel="noreferrer">Documentation ↗</a>}
      <a className="button secondary" href={`/apis/${encodeURIComponent(record.id)}/schemas`}>Full schema details →</a>
    </div>

    <ApiOverview record={record} />

    <section className="api-info-section" aria-label="API integration requirements">
      <h3><span aria-hidden="true">02</span> Integration</h3>
      <div className="endpoint-box api-info-endpoint">
        <span>HTTP method &amp; endpoint</span>
        <div><strong className={`http-method ${record.http_method ? "" : "unknown"}`}>{record.http_method || "Method not recorded"}</strong><code>{record.api_endpoint || "Endpoint not recorded"}</code></div>
        <button type="button" onClick={onCopyEndpoint} disabled={!record.api_endpoint} aria-label={`Copy endpoint for ${record.api_name}`}>Copy</button>
      </div>
      <div className="api-format-flow" aria-label="Request and response formats">
        <div><span>Input format · catalogue</span><strong>{formatInputFormatsForDisplay(record.input_formats)}</strong></div>
        <span className="api-format-arrow" aria-hidden="true">→</span>
        <div><span>Output format · catalogue</span><strong>{formatFormatsForDisplay(record.output_formats)}</strong></div>
      </div>
      <dl className="api-info-grid">
        <div className="full"><dt>Authentication</dt><dd>{authentication || "Not recorded"}</dd>
          {record.authentication_other && record.authentication_method !== "Other" && <dd className="api-info-prose">{record.authentication_other}</dd>}
          <dd className="api-info-prose">{record.authentication_details || "Credential setup and authentication steps have not been recorded. Check the provider documentation."}</dd>
        </div>
        <div className="full"><dt>Invoice standards</dt><dd>{record.invoice_standard.length ? record.invoice_standard.join(" · ") : "Not recorded"}</dd>
          {record.invoice_standard.length > 0 && <dd className="api-info-caption">{record.invoice_standard_source === "confirmed" ? "Confirmed against provider documentation." : record.invoice_standard_source === "extracted" ? "Detected in the record’s description; not yet confirmed against provider documentation." : "The evidence for these standards has not been recorded."}</dd>}
        </div>
      </dl>
      <p className="api-info-caption">Formats describe the payload, such as JSON or XML. Invoice standards describe the invoice structure, such as UBL or Peppol.</p>
      {(record.instructions || record.business_rules.length > 0) ? <div className="api-guidance">
        {record.instructions && <><h4>Implementation notes</h4><p>{record.instructions}</p></>}
        {record.business_rules.length > 0 && <><h4>Business rules</h4><ul>{record.business_rules.map((rule, i) => <li key={`${rule}-${i}`}>{rule}</li>)}</ul></>}
      </div> : <p className="api-info-caption">Implementation steps and business rules have not been recorded. Use the documentation for setup instructions.</p>}
    </section>

    <section className="api-info-section api-information-coverage" aria-label="API information coverage">
      <div className="api-coverage-heading">
        <div>
          <h3><span aria-hidden="true">03</span> Information coverage</h3>
          <p>Everything this catalogue tracks for this API, including empty values that still need evidence.</p>
        </div>
        <div className="api-coverage-total" aria-label={`${coverage.recorded.length} of ${coverage.items.length} information fields recorded`}>
          <strong>{coverage.recorded.length}</strong><span>of {coverage.items.length} recorded</span>
        </div>
      </div>
      <div className="api-coverage-columns">
        <section className="api-coverage-missing" aria-labelledby="api-missing-information">
          <header><h4 id="api-missing-information">Missing or unconfirmed</h4><span>{coverage.missing.length}</span></header>
          {coverage.missing.length > 0 ? <ul>{coverage.missing.map((item) => <li key={item.key}>
            <div><strong>{item.label}</strong><span className={`api-coverage-source source-${item.source}`}>{item.source === "schema" ? "Documentation / schema" : "Catalogue edit"}</span></div>
            <p>{item.guidance}</p>
          </li>)}</ul> : <p className="api-coverage-empty">No missing catalogue information was found.</p>}
          {schemaCheckFailed && <p className="api-coverage-check-note">Saved request and response schemas could not be checked. Their status remains unknown.</p>}
          {!schemaCheckFailed && coverage.checking.length > 0 && <p className="api-coverage-check-note" role="status">Checking saved request and response schemas…</p>}
        </section>
        <section className="api-coverage-recorded" aria-labelledby="api-recorded-information">
          <header><h4 id="api-recorded-information">Recorded information</h4><span>{coverage.recorded.length}</span></header>
          <dl>{coverage.recorded.map((item) => <div key={item.key}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
        </section>
      </div>
      <p className="api-info-caption">“Not recorded” means the catalogue has no evidence yet; it does not prove that a feature is unsupported or not applicable.</p>
    </section>

    <section className="api-info-section" aria-label="API request and response bodies">
      <h3><span aria-hidden="true">04</span> Request &amp; response bodies</h3>
      <p className="api-info-caption">Inspect saved field names, types, required fields and descriptions. URL parameters and headers may be documented separately by the provider.</p>
      <button className="api-schema-toggle" type="button" aria-expanded={showSchemas} aria-controls="api-schema-preview" onClick={() => setShowSchemas(!showSchemas)}>
        {showSchemas ? "Hide field preview" : "Explore request & response fields"}<span aria-hidden="true">{showSchemas ? "−" : "+"}</span>
      </button>
      <div id="api-schema-preview" hidden={!showSchemas}>{showSchemas && <ApiSchemaPreview key={record.id} apiId={record.id} />}</div>
    </section>

    <section className="api-info-section" aria-label="API sources and freshness">
      <h3><span aria-hidden="true">05</span> Sources &amp; freshness</h3>
      <dl className="api-info-grid">
        <div><dt>Added to catalogue</dt><dd>{catalogueDate(record.created_at)}</dd></div>
        <div><dt>Catalogue updated</dt><dd>{catalogueDate(record.updated_at)}</dd></div>
      </dl>
      <p className="api-info-caption">These dates describe this catalogue record, not the provider’s release schedule or API uptime.</p>
      <ul className="api-source-links">
        {documentation && <li><span>Documentation</span><a href={documentation} target="_blank" rel="noreferrer">{documentation} ↗</a></li>}
        {website && <li><span>Provider website</span><a href={website} target="_blank" rel="noreferrer">{website} ↗</a></li>}
        {source && source !== documentation && <li><span>Original source</span><a href={source} target="_blank" rel="noreferrer">{source} ↗</a></li>}
        {!documentation && !website && !source && <li>No source links have been recorded.</li>}
      </ul>
      {qualityNote && <p className="api-info-note">{qualityNote}</p>}
    </section>
  </div>;
}
