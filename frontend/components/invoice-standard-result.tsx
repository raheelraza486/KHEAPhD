import type { StandardResult, StandardReview } from "@/lib/checks/types";

const VERDICT: Record<StandardResult["status"], string> = {
  pass: "Compatible",
  fail: "Not compatible",
  unknown: "More information needed",
  not_voting: "No standard verdict",
};
const REVIEW: Record<StandardReview["status"], string> = {
  confirmed: "Confirmed",
  unreviewed: "Not yet reviewed",
  not_assessed: "Catalogue label only — directional review unavailable",
  not_recorded: "No invoice standard recorded",
};
const BASIS: Record<StandardResult["source_basis"], string> = {
  claims: "Directional claims", catalogue: "Catalogue label", none: "No standard recorded",
};
const FLAG: Record<StandardResult["flags"][number], string> = {
  standard_not_recorded: "At least one side has no invoice standard recorded; this check does not decide compatibility.",
  version_differs: "The recorded versions differ; this check does not decide compatibility across these versions.",
  fill_required: "Compatibility requires additional invoice information to be supplied.",
  claims_unreviewed: "Some directional claims have not yet been reviewed. Their review state does not change the compatibility verdict.",
  customization_unconfirmed: "The source's exact specification identifier is not recorded; the target requires a more specific standard.",
  configuration_required: "Set the required request options below for the matched standard to apply.",
};

/** Shared by the compatibility report and composition standard_checks entries. */
export default function InvoiceStandardResult({ result }: { result: StandardResult }) {
  const visual = result.status === "pass" || result.status === "fail" ? result.status : "unknown";
  return <article className={`compat-check-card check-${visual}`}>
    <div className="compat-check-card-head">
      <span className={`compat-status status-${visual}`}>{VERDICT[result.status]}</span>
    </div>
    <h3>Invoice standard compatibility</h3>
    <p>{result.source_standards.map((s) => s.raw).join(", ") || "Not recorded"}
      {" → "}{result.target_standards.map((s) => s.raw).join(", ") || "Not recorded"}</p>
    <small>Check 2.0b · {BASIS[result.source_basis]} → {BASIS[result.target_basis]}</small>
    {result.status === "fail" && <p>The recorded source standards do not overlap with the target's accepted standards.</p>}
    {result.matches.length > 0 && <ul>{result.matches.map((match, index) =>
      <li key={index}>{match.source} → {match.target}: {match.relation.replaceAll("_", " ")}
        {match.note ? ` (${match.note})` : ""}</li>)}</ul>}
    <div className="compat-check-action" aria-label="Standard claim review">
      <strong>Standard claim review</strong>
      <dl>
        <dt>Source{result.review ? ` (${result.review.source.direction})` : ""}</dt>
        <dd>{result.review ? REVIEW[result.review.source.status] : "Review state unavailable in this saved report"}</dd>
        <dt>Target{result.review ? ` (${result.review.target.direction})` : ""}</dt>
        <dd>{result.review ? REVIEW[result.review.target.status] : "Review state unavailable in this saved report"}</dd>
      </dl>
    </div>
    {result.flags.map((flag) => <p key={flag} className="compat-check-action">{FLAG[flag]}</p>)}
    {(result.conditions ?? []).length > 0 && <div className="compat-check-action">
      <strong>Required request settings</strong>
      <ul>{result.conditions.map((item, index) => <li key={index}>
        {item.side === "source" ? "Source" : "Target"} ({item.standard}): <code>{item.condition}</code>
      </li>)}</ul>
    </div>}
  </article>;
}
