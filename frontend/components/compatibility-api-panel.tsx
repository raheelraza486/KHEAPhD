"use client";

import { useState } from "react";
import type { ApiRecord } from "@/lib/types";
import type { ApiSchemaAvailability, ApiSchemaRecord, SchemaInputMode } from "@/lib/compatibility/ui-types";
import type { ParsedSchemaInput } from "@/lib/compatibility/schema-file";
import { EMPTY_FILTERS, apiCountryOptions, comparisonApiName, filterApis, formatHint, operationLabel, operationSelectorNote, selectedFormats, sharesEndpointWith } from "@/lib/compatibility/selection";
import CountryRegionLabel from "@/components/country-region-label";
import { schemaSourceLink } from "@/lib/compatibility/schema-selection";
import { formatFormatsForDisplay, formatInputFormatsForDisplay } from "@/lib/format-display";

export interface LocalSchemaState {
  file: File | null;
  choices: ParsedSchemaInput[];
  choiceId: string;
  busy: boolean;
  error: string;
  mediaType: string;
}

export interface RemoteSchemaState {
  url: string;
  choices: ParsedSchemaInput[];
  choiceId: string;
  busy: boolean;
  error: string;
}

interface Props {
  side: "source" | "target";
  apis: ApiRecord[];
  availability: ReadonlyMap<string, ApiSchemaAvailability>;
  apiId: string;
  onApi: (id: string) => void;
  mode: SchemaInputMode;
  onMode: (mode: SchemaInputMode) => void;
  schemas: ApiSchemaRecord[];
  schemaId: string;
  onSchema: (id: string) => void;
  schemasLoading: boolean;
  schemaError: string;
  onRetry: () => void;
  upload: LocalSchemaState;
  onUpload: (file: File | null) => void;
  onChoice: (id: string) => void;
  onMediaType: (value: string) => void;
  remote: RemoteSchemaState;
  onRemoteUrl: (value: string) => void;
  onRemoteLoad: () => void;
  onRemoteChoice: (id: string) => void;
  disabled: boolean;
  sourceId?: string;
  sourceFormats?: string[];
  allowMismatch?: boolean;
  onAllowMismatch?: (allow: boolean) => void;
}

export default function CompatibilityApiPanel(props: Props) {
  const { side, apis, apiId, onApi, mode, onMode, schemas, schemaId, onSchema, upload, remote, disabled } = props;
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const isSource = side === "source";
  const selected = apis.find((api) => api.id === apiId);
  const countFor = (id: string) => isSource ? props.availability.get(id)?.response_count : props.availability.get(id)?.request_count;
  const filtered = filterApis(apis, filters).sort((left, right) => Number((countFor(right.id) ?? 0) > 0) - Number((countFor(left.id) ?? 0) > 0));
  const selectedOutside = selected && !filtered.some((api) => api.id === apiId);
  const countries = apiCountryOptions(apis);
  const categoryOrder = ["Transformation", "Validation", "Communication", "Other"];
  const categories = [...new Set(apis.map((api) => api.category).filter(Boolean))].sort((a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b));
  const uploadChoice = upload.choices.find((item) => item.id === upload.choiceId);
  const remoteChoice = remote.choices.find((item) => item.id === remote.choiceId);
  const choice = mode === "url" ? remoteChoice : uploadChoice;
  const savedSchema = mode === "published" ? schemas.find((schema) => schema.id === schemaId) : undefined;
  const sourceLink = schemaSourceLink(savedSchema?.source_url ?? "");
  const mediaType = mode === "published" ? savedSchema?.media_type : choice?.mediaType || (mode === "upload" ? upload.mediaType : undefined);
  const formats = selectedFormats(mode, mediaType, selected ? isSource ? selected.output_formats : selected.input_formats : []);
  const hint = !isSource && props.sourceId && selected ? formatHint(props.sourceFormats ?? [], formats) : null;
  const hintEnabled = !isSource && Boolean(props.sourceId) && mode === "published";
  const activeFilter = Object.values(filters).some(Boolean);
  const nameCounts = new Map<string, number>();
  for (const api of apis) {
    const name = comparisonApiName(api).toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  function unavailableReason(api: ApiRecord) {
    if (!isSource && api.id === props.sourceId) return "Already selected as source";
    // A saved representation can correct stale catalogue format tags. Until
    // its media type is loaded, do not disable it using those older tags.
    const requestCount = props.availability.get(api.id)?.request_count;
    const candidate = hintEnabled && requestCount === 0 ? formatHint(props.sourceFormats ?? [], api.input_formats) : null;
    return candidate?.status === "incompatible" && !props.allowMismatch ? "Format mismatch" : "";
  }
  const availableApis = filtered.filter((api) => !unavailableReason(api));
  const unavailableGroups = ["Format mismatch", "Already selected as source"].map((reason) => ({ reason, apis: filtered.filter((api) => unavailableReason(api) === reason) }));
  function option(api: ApiRecord) {
    const reason = unavailableReason(api);
    const name = comparisonApiName(api);
    const duplicateName = (nameCounts.get(name.toLowerCase()) ?? 0) > 1;
    return <option key={api.id} value={api.id} disabled={Boolean(reason)} title={reason || undefined}>
      {name}{duplicateName ? ` · ${api.company_name}` : ""}
    </option>;
  }
  const localFilePanel = <div className="compat-local-schema compat-local-schema-direct">
    <div className="compat-local-intro">
      <strong>{isSource ? "Upload the source OpenAPI file" : "Upload the target OpenAPI file"}</strong>
      <span>{isSource ? "Choose the response that provides data." : "Choose the request that receives data."}</span>
    </div>
    <label className={`compat-upload${disabled ? " disabled" : ""}`}><input key={upload.file?.name ?? "empty"} aria-label={`${isSource ? "Source" : "Target"} OpenAPI file`} className="compat-upload-input" type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" onChange={(e) => props.onUpload(e.target.files?.[0] ?? null)} disabled={disabled} /><span className="compat-upload-button">Choose file</span><span className={`compat-upload-filename${upload.file ? " selected" : ""}`}>{upload.file?.name || "No file selected"}</span></label>
    <div className="compat-filter-summary"><span className="compat-help">Used only for this comparison. It is not saved and does not create a submission.</span>{upload.file && <button type="button" className="compat-text-button" onClick={() => props.onUpload(null)} disabled={disabled}>Remove file</button>}</div>
    {upload.busy && <p className="compat-help" role="status">Reading schema choices…</p>}
    {upload.error && <p className="compat-file-error" role="alert">{upload.error}</p>}
    {upload.choices.length > 0 && <label className="compat-field"><span>{isSource ? "Operation / response / format" : "Operation / request / format"}</span><select value={upload.choiceId} onChange={(e) => props.onChoice(e.target.value)} disabled={disabled}>
      <option value="">Choose the operation to compare</option>{upload.choices.map((item) => <option key={item.id} value={item.id}>{item.operationLabel}</option>)}
    </select></label>}
    {choice && !choice.mediaType && <label className="compat-field"><span>Data format used by this operation</span><select value={upload.mediaType} onChange={(e) => props.onMediaType(e.target.value)} disabled={disabled}>
      <option value="">Not specified · format check unavailable</option><option value="application/json">JSON</option><option value="application/xml">XML</option><option value="text/csv">CSV</option><option value="application/pdf">PDF</option><option value="application/edifact">EDIFACT</option>
    </select></label>}
    {choice?.warnings?.map((warning, index) => <p className="compat-schema-note" key={index}>{warning}</p>)}
  </div>;
  return <section className="compat-api-panel" aria-labelledby={`${side}-api-title`}>
    <div className="compat-panel-heading">
      <div><p className="eyebrow">{isSource ? "01 · Source" : "02 · Target"}</p><h2 id={`${side}-api-title`}>{isSource ? "API output" : "API input"}</h2>
        <p>{isSource ? "Choose the response that provides your data." : "Choose the request that receives the data."}</p></div>
      <span className="compat-direction-mark" aria-hidden="true">{isSource ? "OUT" : "IN"}</span>
    </div>
    <div className="compat-input-modes" role="tablist" aria-label={`${isSource ? "Source" : "Target"} input method`}>
      <button type="button" role="tab" aria-selected={mode === "url"} onClick={() => onMode("url")} disabled={disabled}>OpenAPI URL</button>
      <button type="button" role="tab" aria-selected={mode === "published"} onClick={() => onMode("published")} disabled={disabled}>Saved API</button>
      <button type="button" role="tab" aria-selected={mode === "upload"} onClick={() => onMode("upload")} disabled={disabled}>Upload file</button>
    </div>

    {mode === "url" ? <div className="compat-remote-schema">
      <label className="compat-field"><span>{isSource ? "Source API link" : "Target API link"}</span>
        <div className="compat-url-entry"><input type="url" placeholder="https://provider.example/openapi.json" value={remote.url} onChange={(event) => props.onRemoteUrl(event.target.value)} disabled={disabled || remote.busy} /><button className="button secondary" type="button" onClick={props.onRemoteLoad} disabled={disabled || remote.busy || !remote.url.trim()}>{remote.busy ? "Reading…" : "Read link"}</button></div>
      </label>
      <p className="compat-help">The definition is used for this comparison only and is not saved.</p>
      {remote.error && <p className="compat-file-error" role="alert">{remote.error}</p>}
      {remote.choices.length > 0 && <label className="compat-field"><span>{isSource ? "Operation / response / format" : "Operation / request / format"}</span><select value={remote.choiceId} onChange={(event) => props.onRemoteChoice(event.target.value)} disabled={disabled}>
        <option value="">Choose the operation to compare</option>{remote.choices.map((item) => <option key={item.id} value={item.id}>{item.operationLabel}</option>)}
      </select></label>}
      {remoteChoice && <div className="compat-definition-ready"><span aria-hidden="true">✓</span><strong>Definition ready</strong><small>{remoteChoice.mediaType || "Format not declared"}</small></div>}
      {remoteChoice?.warnings?.map((warning, index) => <p className="compat-schema-note" key={index}>{warning}</p>)}
    </div> : mode === "upload" ? localFilePanel : <>
      <div className="compat-api-filters" role="group" aria-label={`${isSource ? "Source" : "Target"} API filters`}>
        <label className="compat-field compat-search"><span>Search APIs</span><input type="search" placeholder="API name, supplier or endpoint" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} disabled={disabled} /></label>
        <label className="compat-field"><span>Country / region</span><select value={filters.country} onChange={(e) => setFilters({ ...filters, country: e.target.value })} disabled={disabled}>
          <option value="">All countries / regions</option>{countries.map((country) => <option key={country}>{country}</option>)}
        </select></label>
        <label className="compat-field"><span>Category</span><select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })} disabled={disabled}>
          <option value="">All categories</option>{categories.map((category) => <option key={category}>{category}</option>)}
        </select></label>
        <div className="compat-filter-summary"><span aria-live="polite">{filtered.length} of {apis.length} APIs</span>{activeFilter && <button className="compat-text-button" type="button" onClick={() => setFilters(EMPTY_FILTERS)} disabled={disabled}>Clear filters</button>}</div>
      </div>
      <label className="compat-field compat-api-select"><span>{isSource ? "Source API" : "Target API"}</span>
        <select value={apiId} onChange={(e) => onApi(e.target.value)} disabled={disabled}>
          <option value="">Choose an API</option>
          {selectedOutside && <optgroup label="Current selection · outside filters">{option(selected)}</optgroup>}
          {availableApis.map(option)}
          {unavailableGroups.filter((group) => group.apis.length).map((group) => <optgroup key={group.reason} label={group.reason}>{group.apis.map(option)}</optgroup>)}
        </select>
      </label>
      {!disabled && !filtered.length && <p className="compat-help" role="status">No APIs match these filters. Try another country, category or search.</p>}
      {selectedOutside && <p className="compat-help">Your selected API is outside the current filters.</p>}
      {!isSource && <div className="compat-selection-help">
        <label className="compat-toggle"><input type="checkbox" checked={props.allowMismatch ?? false} onChange={(e) => props.onAllowMismatch?.(e.target.checked)} disabled={disabled} /><span>Allow format mismatches for comparison</span></label>
        <p className="compat-help">Greyed-out options are unavailable. Field compatibility is checked after selection.</p>
        {hint && <div className={`compat-format-hint hint-${hint.status}`}><strong>{hint.label}</strong><span>{hint.reason}</span></div>}
      </div>}
      {selected && <div className="compat-api-summary">
        <div className="compat-api-summary-top"><div><strong>{comparisonApiName(selected)}</strong><span>{selected.company_name}</span></div><span className="pill tone-teal">{selected.category}</span></div>
        <code title={selected.api_endpoint}>{operationLabel(selected)}</code>
        {(() => {
          // A service that answers several operations at one address has to say
          // which one this record is; an endpoint on its own does not. Five DIAN
          // records share a single address, and without this they read as the
          // same thing.
          const shared = sharesEndpointWith(selected, apis);
          if (shared.length === 0) return null;
          const selector = operationSelectorNote(selected);
          const others = shared.map((api) => comparisonApiName(api)).join(", ");
          return selector
            ? <p className="compat-help">
                Shares this address with {shared.length === 1 ? "1 other record" : `${shared.length} other records`} ({others}).
                This one is <strong><code>{selector.name}={selector.value}</code></strong>.
              </p>
            : <p className="compat-help">
                Shares this address and method with {shared.length === 1 ? "1 other record" : `${shared.length} other records`} ({others}),
                and nothing is recorded about what tells them apart.
              </p>;
        })()}
        <dl><div><dt>{isSource ? "Output format" : "Input format"} · {mediaType ? "selected schema" : mode === "published" ? "catalogue" : "local file"}</dt><dd>{isSource ? formatFormatsForDisplay(formats) : formatInputFormatsForDisplay(formats)}</dd></div>
          <div><dt>Country / region</dt><dd><CountryRegionLabel record={selected} /></dd></div></dl>
        {/^https?:\/\//i.test(selected.documentation_url) && <a className="compat-doc-link" href={selected.documentation_url} target="_blank" rel="noopener noreferrer">View supplier documentation ↗</a>}
      </div>}
      {selected && <div className="compat-published-schema">
        {props.schemasLoading ? <p className="compat-help" role="status">Loading saved schemas…</p> : props.schemaError ? <div className="compat-schema-note" role="alert"><strong>Saved schemas unavailable</strong><span>{props.schemaError}</span><button type="button" className="compat-text-button" onClick={props.onRetry} disabled={disabled}>Retry loading schemas</button></div> : schemas.length ? <label className="compat-field"><span>{isSource ? "Response schema" : "Request schema"}</span><select value={schemaId} onChange={(e) => onSchema(e.target.value)} disabled={disabled}>
          <option value="">Automatic schema selection</option>
          {schemas.map((schema) => <option key={schema.id} value={schema.id}>{schema.direction === "response" ? `${schema.status_code || "default"} response` : "Request"} · {schema.media_type} · {schema.fields.length} fields · {schema.origin}</option>)}
        </select></label> : <div className="compat-schema-note"><strong>No saved {isSource ? "response" : "request"} schema</strong><span>Choose another API, check formats only, or use a local file.</span></div>}
        {sourceLink && <a className="compat-doc-link" href={sourceLink} target="_blank" rel="noopener noreferrer">View saved schema source ↗</a>}
        {savedSchema?.warnings.map((warning, index) => <p className="compat-help" key={index}>{warning}</p>)}
      </div>}
    </>}
  </section>;
}
