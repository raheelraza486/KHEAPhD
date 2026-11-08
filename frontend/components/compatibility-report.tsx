"use client";

import CompatibilityFieldReview from "@/components/compatibility-field-review";
import CompatibilityMappingReview, { type MappingAnswer } from "@/components/compatibility-mapping-review";
import CompatibilityConnectionPotential from "@/components/compatibility-connection-potential";
import InvoiceStandardResult from "@/components/invoice-standard-result";
import { assessConnectionPotential } from "@/lib/compatibility/connection-potential";
import type { ApiSchemaField } from "@/lib/compatibility/ui-types";
import type { CheckReport, ReasonCode, Verdict } from "@/lib/checks/types";

type Props = { report: CheckReport; sourceFields: readonly ApiSchemaField[]; targetFields: readonly ApiSchemaField[]; submittingAnswer: boolean; previewingAnswer: boolean; answerError: string; isSignedIn: boolean; isPreview: boolean; onPreview: (targetPath: string, answer: MappingAnswer) => Promise<void>; onSave: (targetPath: string, answer: MappingAnswer) => Promise<void> };
type DisplayStatus = "pass" | "warning" | "fail" | "unknown";

const REASON_COPY: Record<ReasonCode, string> = { source_no_format: "The source does not declare a recognised output format.", target_no_format: "The target does not declare a recognised input format.", source_no_output_schema: "A usable source response schema is unavailable.", source_no_output_body: "The source operation does not return an output body.", target_no_input_schema: "A target request schema or parameter definition is unavailable.", schema_unsupported_shape: "The selected schema uses an unsupported top-level shape.", field_type_unknown: "One or more mapped fields do not declare their type.", shape_unsupported: "The mapped fields use incompatible or unsupported structures.", shape_transformation_required: "The fields correspond, but their containers differ (for example a list where the target takes one object): a transformation step is needed between these two APIs before the value can be passed.", required_field_uncovered: "A required target field does not have a confirmed source.", operation_category_unknown: "The operation category is missing or outside the current supported sequence.", operation_sequence_reversed: "The selected APIs reverse the current supported operation sequence.", operation_sequence_skips_validation: "A Transformation cannot send straight to a Communication API; a Validation step must come between them.", operation_sequence_repeats_stage: "Two Validation APIs, or two Communication APIs, cannot follow each other in one process; only a Transformation may follow a Transformation (extraction, then conversion).", value_constraint_incompatible: "The source may produce values that the target does not accept.", value_constraint_unknown: "Whether the target accepts the source's values cannot be settled from the records: the source declares neither its possible values nor a format that decides it.", invoice_standard_mismatch: "The source writes invoices to a standard the target does not accept (for example XRechnung into a Peppol BIS Billing 3.0 validator).", invoice_standard_unconfirmed: "The source is only known to follow EN 16931; the target requires a specific version of it (such as Peppol BIS Billing 3.0), and which specification identifier the source writes is not recorded." };

function visualStatus(verdict: Verdict): DisplayStatus { return verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "unknown"; }
function verdictLabel(verdict: Verdict) { return verdict === "pass" ? "Passed" : verdict === "fail" ? "Failed" : verdict === "unknown" ? "More information needed" : "Not applicable"; }
function CheckCard({ title, status, label, children }: { title: string; status: Verdict; label?: string; children: React.ReactNode }) { const display = visualStatus(status); return <article className={`compat-check-card check-${display}`}><div className="compat-check-card-head"><span className="compat-check-icon" aria-hidden="true">{status === "pass" ? "✓" : status === "fail" ? "×" : "?"}</span><span className={`compat-status status-${display}`}>{label ?? verdictLabel(status)}</span></div><h3>{title}</h3>{children}</article>; }
function overallPresentation(report: CheckReport): { title: string; status: DisplayStatus; description: string } { if (report.overall.overall === "pending_user") return { title: "Field selection required", status: "warning", description: "One or more required target fields still need a decision." }; if (report.overall.overall === "pending_admin") return { title: "Awaiting review", status: "warning", description: "Answers given for the same field differ, so none of them applies until the field has been reviewed." }; if (report.overall.overall === "pass") return { title: "Compatible", status: "pass", description: "All implemented checks that apply to this pair passed." }; if (report.overall.blocking_reason === "insufficient_info") return { title: "Compatibility not verified", status: "unknown", description: "The available information is not sufficient to verify this API connection." }; return { title: "Not compatible", status: "fail", description: "One or more checks identified an incompatible requirement." }; }
/** The mappings 2.3 judged impossible — the fields that actually fail the pair. */
function incompatibleConversions(types: CheckReport["check2"]["types"]) {
  if (!types || types.status !== "fail") return [];
  return types.conversions.filter((conversion) => conversion.kind === "incompatible");
}

/**
 * Check 2.2 records why two mapped fields still need looking at as a short
 * code; the page has to say it in words. An unknown code is printed as it
 * stands rather than swallowed, so a new one is visible instead of silent.
 */
const NOTE_COPY: Record<string, string> = {
  whole_document: "Both sides exchange the whole invoice file, so it is handed over as it is; no field-by-field mapping is needed.",
  encode_base64: "The file is sent base64-encoded inside the target's JSON request.",
  decode_base64: "The file arrives base64-encoded and is decoded before it is sent on.",
  encode_byte_array: "The file is sent as a JSON array of integer byte values from 0 to 255.",
  decode_byte_array: "The file is reconstructed from its JSON byte array before it is sent on.",
  representation_differs: "Both sides hold the same thing but may write it differently — a code against a name, or another format. A transformation step may need to rewrite the value; this does not decide the verdict.",
  shape_differs: "The two sides nest this value differently, so the structures have to be aligned before the values can be compared.",
};
function noteText(note: string) { return NOTE_COPY[note] ?? note; }

function authText(method: string | null, details: string | null) { return `${method || "Not recorded"}${details?.trim() ? `: ${details.trim()}` : ""}`; }

export default function CompatibilityReport({ report, sourceFields, targetFields, submittingAnswer, previewingAnswer, answerError, isSignedIn, isPreview, onPreview, onSave }: Props) {
  const overall = overallPresentation(report), semantics = report.check2.semantics, types = report.check2.types, required = report.check2.required;
  const connection = assessConnectionPotential(report, sourceFields, targetFields);
  const unresolvedCount = report.overall.overall === "pending_user" ? (semantics?.ambiguous.length ?? 0) + (semantics?.not_found.length ?? 0) : 0;
  const check3Waiting = report.check3.flags.includes("check3_waiting_for_semantics");
  const check3NeedsMapping = !check3Waiting && report.check3.flags.includes("value_mapping_required");
  const check3NeedsRuntime = !check3Waiting && report.check3.flags.includes("runtime_validation_required");
  return <section className="compat-results" aria-live="polite">
    <div className={`compat-overall overall-${overall.status}`}><div><p className="eyebrow">Repository compatibility report</p><h2>{overall.title}</h2><p>{overall.description}</p>{report.overall.blocking_checks.length > 0 && <p><strong>Blocking checks:</strong> {report.overall.blocking_checks.join(", ")}</p>}</div><dl className="compat-issue-counts" aria-label="Compatibility report counts"><div className="count-blocking"><dt>{report.overall.blocking_checks.length}</dt><dd>Blocking</dd></div><div className="count-mapping"><dt>{unresolvedCount}</dt><dd>Selections</dd></div><div className="count-info"><dt>{semantics?.mappings.length ?? 0}</dt><dd>Mapped</dd></div></dl></div>
    {isPreview && <div className="compat-preview-note" role="status"><strong>Preview result</strong><span>These field decisions are temporary and have not been saved.</span></div>}
    <CompatibilityConnectionPotential assessment={connection} />
    {report.overall.overall === "fail" && (report.overall.reason_codes.length > 0 || report.check1.status === "fail" || incompatibleConversions(types).length > 0) && (
      <div className="compat-report-reasons" role="status">
        <strong>Why this result was blocked</strong>
        <ul>
          {report.check1.status === "fail" && (
            <li key="no-common-format">
              No format in common: the source outputs {report.check1.source_formats.join(", ") || "nothing recognised"},
              {" "}the target accepts {report.check1.target_formats.join(", ") || "nothing recognised"}.
            </li>
          )}
          {incompatibleConversions(types).length > 0 && (
            <li key="type-incompatible">
              {incompatibleConversions(types).length} required field{incompatibleConversions(types).length === 1 ? " has a value type" : "s have value types"} the target cannot accept:{" "}
              {incompatibleConversions(types).map((conversion) => `${conversion.target_path} (${conversion.source_type} → ${conversion.target_type})`).join("; ")}.
            </li>
          )}
          {report.overall.reason_codes.map((code) => <li key={code}>{REASON_COPY[code]}</li>)}
        </ul>
      </div>
    )}
    <div className="compat-check-grid">
      {report.check2.standard && <InvoiceStandardResult result={report.check2.standard} />}
      <CheckCard title="Operation logic" status={report.check0.status}><p>{report.check0.source_category ?? "Unknown"} → {report.check0.target_category ?? "Unknown"}</p><small>Current sequence: {report.check0.sequence.join(" → ")}</small>{report.check0.flags.includes("same_operation_category") && <p className="compat-check-action">Both APIs belong to the same operation category.</p>}{report.check0.flags.includes("validated_in_between") && <p className="compat-check-action">A Validation step of the same process stands between these APIs.</p>}</CheckCard>
      <CheckCard title="Format compatibility" status={report.check1.status}><p>{report.check1.source_formats.join(", ") || "Unspecified"} → {report.check1.target_formats.join(", ") || "Unspecified"}</p><small>{report.check1.common_formats.length ? `Common formats: ${report.check1.common_formats.join(", ")}` : "No common recognised format was identified."}</small>{report.check1.flags.includes("input_in_parameters") && <p className="compat-check-action">The target input is supplied through path or query parameters.</p>}{report.check1.unrecognised_values.length > 0 && <p className="compat-check-action"><strong>Not registered as format values:</strong> {report.check1.unrecognised_values.join(", ")}. They are reported, never guessed at.</p>}</CheckCard>
      <CheckCard title="Schema compatibility" status={required?.status ?? types?.status ?? report.check2.schema.status}><p>{semantics ? `${semantics.mappings.length} confirmed field mapping${semantics.mappings.length === 1 ? "" : "s"}.` : "Field semantics could not be checked."}</p><small><strong>Source authentication:</strong> {authText(report.check2.auth.source_auth.method, report.check2.auth.source_auth.details)}<br /><strong>Target authentication:</strong> {authText(report.check2.auth.target_auth.method, report.check2.auth.target_auth.details)}<br /><strong>Credentials:</strong> {report.check2.auth.credential_sets} set{report.check2.auth.credential_sets === 1 ? "" : "s"}</small>{report.check2.auth.auth_requires_prior_call && <p className="compat-check-action">The target's credential must first be obtained from another call.</p>}{report.check1.format_selected && <p className="compat-check-action"><strong>Compared in:</strong> {report.check1.format_selected}</p>}{report.check2.schema.source_schema_used && <p className="compat-check-action"><strong>Source schema used:</strong> {report.check2.schema.source_schema_used.status_code ?? "default"} response{report.check2.schema.source_schema_used.media_type ? ` (${report.check2.schema.source_schema_used.media_type})` : ""}</p>}{report.check2.schema.target_schema_used?.media_type && <p className="compat-check-action"><strong>Target schema used:</strong> {report.check2.schema.target_schema_used.media_type}</p>}{report.check2.schema.flags.includes("no_schema_for_format") && <p className="compat-check-action">No schema is stored for the selected format on this side; the other formats offered above may have one.</p>}{report.check2.schema.source_schema_alternatives.length > 0 && <p className="compat-check-action"><strong>Alternative responses:</strong> {report.check2.schema.source_schema_alternatives.map((item) => `${item.status_code ?? "default"}${item.media_type ? ` (${item.media_type})` : ""}`).join(", ")}</p>}{report.check2.schema.flags.includes("thin_schema") && <p className="compat-check-action">Limited schema evidence: this comparison uses two or fewer fields.</p>}{report.check2.schema.flags.includes("schema_unverified") && <p className="compat-check-action">The recorded schema has not been manually verified.</p>}</CheckCard>
      <CheckCard title="Value and constraint compatibility" status={report.check3.status} label={check3Waiting ? "Waiting" : undefined}><p>{check3Waiting ? "Field mappings must be completed before value constraints can be checked." : report.check3.status === "not_voting" ? "No relevant declared value constraints were available." : `${report.check3.issues.length + report.check3.representation_differs.length} value or constraint finding${report.check3.issues.length + report.check3.representation_differs.length === 1 ? "" : "s"}.`}</p>{report.check3.issues.map((issue) => <p key={`${issue.target_path}:${issue.source_path}:${issue.kind}`} className="compat-check-action"><strong>{issue.target_path}</strong>: {issue.message}</p>)}{report.check3.representation_differs.map((item) => <p key={`${item.target_path}:${item.source_path}`} className="compat-check-action"><strong>{item.source_path} → {item.target_path}</strong>: {noteText(item.note)}</p>)}{check3NeedsMapping && <p className="compat-check-unavailable">A transformation step between the two APIs must rewrite the values listed above; the check does not collect value mappings.</p>}{check3NeedsRuntime && <p className="compat-check-unavailable">The records declare nothing that settles the conditions above; only a call with real values can.</p>}</CheckCard>
    </div>
    {types && types.conversions.some((conversion) => conversion.kind === "lossless" || conversion.kind === "conditional") && (
      <div className="compat-report-reasons" role="status">
        <strong>Values must be converted on the way</strong>
        <ul>
          {types.conversions.filter((conversion) => conversion.kind === "lossless" || conversion.kind === "conditional").map((conversion) => (
            <li key={`${conversion.target_path}:${conversion.source_path}`}>
              <code>{conversion.source_path}</code> → <code>{conversion.target_path}</code>: {conversion.source_type} → {conversion.target_type}
              {conversion.kind === "conditional" ? ` (only when ${conversion.condition || "the value allows it"})` : " (no loss)"}
            </li>
          ))}
        </ul>
      </div>
    )}
    {required && required.uncovered.length > 0 && (
      <div className="compat-report-reasons" role="alert">
        <strong>Required target fields with no source</strong>
        <ul>{required.uncovered.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        <p>Mark a field as provided externally if the value comes from somewhere other than this source.</p>
      </div>
    )}
    {required && required.external_inputs.length > 0 && (
      <div className="compat-report-reasons" role="status">
        <strong>Provided externally</strong>
        <ul>{required.external_inputs.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        <p>These values are supplied outside this pair and are not counted against it.</p>
      </div>
    )}
    {semantics && semantics.excluded.some((item) => item.reason === "envelope") && (
      <details className="compat-report-reasons">
        <summary><strong>{semantics.excluded.filter((item) => item.reason === "envelope").length} envelope field{semantics.excluded.filter((item) => item.reason === "envelope").length === 1 ? "" : "s"} were not matched</strong></summary>
        <p>Protocol headers, software identifiers, paging and result structures are supplied by the integration layer, so they take no part in the comparison.</p>
        <ul>{semantics.excluded.filter((item) => item.reason === "envelope").map((item) => <li key={item.path}><code>{item.path}</code></li>)}</ul>
      </details>
    )}
    {semantics && semantics.excluded.some((item) => item.reason === "constant") && (
      <details className="compat-report-reasons">
        <summary><strong>{semantics.excluded.filter((item) => item.reason === "constant").length} constant field{semantics.excluded.filter((item) => item.reason === "constant").length === 1 ? "" : "s"} need no source</strong></summary>
        <p>Each of these fields admits exactly one value, so the caller writes it in; no field of the source API has to supply it.</p>
        <ul>{semantics.excluded.filter((item) => item.reason === "constant").map((item) => <li key={item.path}><code>{item.path}</code></li>)}</ul>
      </details>
    )}
    {required?.flags.includes("required_info_missing") && <div className="compat-report-reasons" role="status"><strong>Required-field information is limited</strong><p>The target API has no required fields marked, and that all-optional result has not yet been confirmed from its definition.</p></div>}
    {required?.flags.includes("source_field_optional") && <div className="compat-report-reasons" role="status"><strong>Runtime checks recommended</strong><ul>{required.source_optional_pairs.map((item) => <li key={`${item.target_path}:${item.source_path}`}>{item.source_path} may be omitted before supplying {item.target_path}.</li>)}</ul></div>}
    {semantics && <CompatibilityFieldReview report={report} />}
    {semantics && <CompatibilityMappingReview semantics={semantics} submitting={submittingAnswer} previewing={previewingAnswer} error={answerError} isSignedIn={isSignedIn} onPreview={onPreview} onSave={onSave} />}
  </section>;
}
