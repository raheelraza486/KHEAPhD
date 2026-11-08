import type { ConnectionPotential } from "@/lib/compatibility/connection-potential";

const KIND_LABEL: Record<ConnectionPotential["potentialKind"], string> = {
  direct: "Direct",
  transformation: "Transformation",
  enrichment: "External enrichment",
  incompatible: "No path",
};

export default function CompatibilityConnectionPotential({ assessment }: { assessment: ConnectionPotential }) {
  return (
    <section className={`compat-connection-potential connection-${assessment.potentialKind}`} aria-labelledby="connection-potential-title">
      <div className="compat-connection-heading">
        <div>
          <p className="eyebrow">Connection readiness</p>
          <h2 id="connection-potential-title">{assessment.directLabel}</h2>
          <p>{assessment.summary}</p>
        </div>
        <div className="compat-connection-verdicts">
          <span><small>Direct compatibility</small><strong>{assessment.directLabel}</strong></span>
          <span><small>Connection potential</small><strong>{assessment.potentialLabel}</strong></span>
        </div>
      </div>

      {assessment.resolutions.length > 0 && (
        <div className="compat-connection-paths">
          {assessment.resolutions.map((resolution) => (
            <article key={`${resolution.targetPath}:${resolution.kind}`} className={`compat-connection-path path-${resolution.kind}`}>
              <div className="compat-connection-path-head">
                <code>{resolution.targetPath}</code>
                <span>{resolution.kind === "derived" ? "Derived" : resolution.kind === "enrichment" ? "Enrichment required" : resolution.kind === "transformation" ? "Conversion required" : KIND_LABEL.incompatible}</span>
              </div>
              <strong>{resolution.title}</strong>
              <p>{resolution.detail}</p>
              <ol className="compat-flow" aria-label={`Proposed connection steps for ${resolution.targetPath}`}>
                {resolution.steps.map((step, index) => (
                  <li key={`${step}:${index}`}>
                    <span>{step}</span>
                    {index < resolution.steps.length - 1 && <i aria-hidden="true">→</i>}
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
