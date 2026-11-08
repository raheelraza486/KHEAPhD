import type { ApiRecord } from "@/lib/types";
import { ACCESS_LABELS } from "@/lib/api-information";
import { countryRegionEvidence } from "@/lib/country-region";

export default function ApiOverview({ record }: { record: ApiRecord }) {
  const region = countryRegionEvidence(record);
  const direction = record.communication_direction;
  const clients = record.client_types.map((value) => value.trim()).filter(Boolean);
  const accessNote = record.access_scope === "public"
    ? "Publicly offered does not mean anonymous or free access. Check the provider’s registration and authentication requirements."
    : record.access_scope === "restricted"
      ? "The provider lists this API for restricted or internal use. Contact the provider to establish whether access is available to you."
      : "Provider access has not been confirmed. Check the provider’s documentation for eligibility, registration and authentication requirements.";

  return <section className="api-overview" aria-label="API overview">
    <h3>At a glance</h3>
    <div className="api-overview-body">
      <dl className="api-overview-location">
        <dt>Country / region</dt>
        <dd>
          <span className={`api-overview-place${region.source === "unknown" ? " is-unknown" : ""}`}>{region.label}</span>
          {region.source === "inferred" && <span className="api-overview-evidence">Suggested location</span>}
        </dd>
      </dl>
      <p className="api-overview-location-note">{region.source === "inferred"
        ? "Service coverage not confirmed."
        : region.source === "recorded"
          ? "Check documentation for supported markets."
          : "Service coverage is unknown."}</p>

      <dl className="api-overview-facts">
        <div>
          <dt>Provider access</dt>
          <dd>
            <span className={record.access_scope === "unknown" ? "is-unknown" : undefined}>{ACCESS_LABELS[record.access_scope] ?? ACCESS_LABELS.unknown}</span>
            {record.access_scope === "public" && <small>Sign-up or fees may apply.</small>}
            {record.access_scope === "restricted" && <small>Contact provider for access.</small>}
          </dd>
        </div>
        {record.category === "Communication" && <div>
          <dt>Direction</dt>
          <dd className={!direction || direction === "Unspecified" ? "is-unknown" : undefined}>{direction || "Unspecified"}</dd>
        </div>}
        {record.network && <div><dt>Network</dt><dd>{record.network}</dd></div>}
        <div>
          <dt>Client / interface type</dt>
          <dd className={clients.length ? undefined : "is-unknown"}>{clients.length ? clients.join(" · ") : "Not recorded"}</dd>
        </div>
      </dl>
    </div>
    <details className="api-overview-notes">
      <summary>Source &amp; access notes<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary>
      <dl>
        <div><dt>Location source</dt><dd>{region.note}</dd></div>
        <div><dt>Access requirements</dt><dd>{accessNote}</dd></div>
      </dl>
    </details>
  </section>;
}
