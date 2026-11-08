"use client";

import { useEffect, useState } from "react";
import CompatibilityFormatPicker from "@/components/compatibility-format-picker";
import CompatibilityApiPanel from "@/components/compatibility-api-panel";
import CompatibilityReport from "@/components/compatibility-report";
import BackToTop from "@/components/back-to-top";

import type { MappingAnswer } from "@/components/compatibility-mapping-review";
import type { CheckReport } from "@/lib/checks/types";
import { inspectSchemaFile, type ParsedSchemaInput } from "@/lib/compatibility/schema-file";
import { comparisonApiName, formatHint, selectedFormats } from "@/lib/compatibility/selection";
import { comparisonReadySchemas, defaultApiPair } from "@/lib/compatibility/schema-selection";
import type { ApiRecord } from "@/lib/types";
import type { ApiSchemaAvailability, ApiSchemaField, ApiSchemaRecord, ApiSchemasResponse, SchemaInputMode } from "@/lib/compatibility/ui-types";
import { formatFormatsForDisplay, formatInputFormatsForDisplay } from "@/lib/format-display";

type StorageMode = "dataset" | "supabase";
type ApiPayload = {
  apis?: ApiRecord[];
  availability?: ApiSchemaAvailability[];
  mode?: StorageMode;
};
function useSavedSchemas(apiId: string, side: "source" | "target") {
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<{ apiId: string; schemas: ApiSchemaRecord[]; selectedId: string; loading: boolean; error: string }>({ apiId: "", schemas: [], selectedId: "", loading: false, error: "" });
  useEffect(() => {
    if (!apiId) return;
    const controller = new AbortController();
    setData((previous) => ({ ...previous, apiId, schemas: [], selectedId: "", loading: true, error: "" }));
    fetch(`/api/schemas?${new URLSearchParams({ api_id: apiId })}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Retry, use a local file, or continue with recorded formats.");
        return await response.json() as ApiSchemasResponse;
      }).then((payload) => {
        if (controller.signal.aborted) return;
        const schemas = comparisonReadySchemas(
          payload.apis.find((entry) => entry.api_id === apiId)?.schemas ?? [],
          side === "source" ? "response" : "request",
        );
        setData({ apiId, schemas, selectedId: "", loading: false, error: "" });
      }).catch((error) => {
        if (!controller.signal.aborted) setData({ apiId, schemas: [], selectedId: "", loading: false, error: error instanceof Error ? error.message : "Schemas could not be loaded." });
      });
    return () => controller.abort();
  }, [apiId, side, retry]);
  const current = apiId && data.apiId === apiId ? data : { schemas: [], selectedId: "", loading: Boolean(apiId), error: "" };
  return { ...current, selected: current.schemas.find((schema) => schema.id === current.selectedId),
    select: (id: string) => setData((previous) => ({ ...previous, selectedId: id })),
    retry: () => setRetry((value) => value + 1) };
}

function useLocalSchema(side: "source" | "target") {
  const [file, setFile] = useState<File | null>(null);
  const [mediaType, setMediaType] = useState("");
  const [data, setData] = useState<{ file: File | null; choices: ParsedSchemaInput[]; choiceId: string; busy: boolean; error: string }>({ file: null, choices: [], choiceId: "", busy: false, error: "" });
  useEffect(() => {
    if (!file) return;
    let active = true;
    setData({ file, choices: [], choiceId: "", busy: true, error: "" });
    inspectSchemaFile(file, side).then((choices) => {
      if (active) setData({ file, choices, choiceId: choices.length === 1 ? choices[0].id : "", busy: false, error: "" });
    }).catch((error) => {
      if (active) setData({ file, choices: [], choiceId: "", busy: false, error: error instanceof Error ? error.message : "The schema file could not be read." });
    });
    return () => { active = false; };
  }, [file, side]);
  const current = file && data.file === file ? data : { file, choices: [], choiceId: "", busy: Boolean(file), error: "" };
  return { ...current, mediaType, selected: current.choices.find((choice) => choice.id === current.choiceId),
    setFile: (value: File | null) => { setFile(value); setMediaType(""); },
    select: (id: string) => { setData((previous) => ({ ...previous, choiceId: id })); setMediaType(""); },
    setMediaType };
}

function useRemoteSchema(side: "source" | "target") {
  const [url, setUrlState] = useState("");
  const [choices, setChoices] = useState<ParsedSchemaInput[]>([]);
  const [choiceId, setChoiceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const nextUrl = url.trim();
    if (!nextUrl || busy) return;
    setBusy(true); setError(""); setChoices([]); setChoiceId("");
    try {
      const response = await fetch("/api/compatibility/schema-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: nextUrl, side }),
      });
      const payload = await response.json() as { choices?: ParsedSchemaInput[]; error?: string };
      if (!response.ok || !payload.choices) throw new Error(payload.error || "The OpenAPI link could not be read.");
      setChoices(payload.choices);
      setChoiceId(payload.choices.length === 1 ? payload.choices[0].id : "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The OpenAPI link could not be read.");
    } finally {
      setBusy(false);
    }
  }

  return {
    url, choices, choiceId, busy, error,
    selected: choices.find((choice) => choice.id === choiceId),
    setUrl: (value: string) => { setUrlState(value); setChoices([]); setChoiceId(""); setError(""); },
    select: setChoiceId,
    load,
  };
}

export default function CompatibilityWorkspace({ isSignedIn }: { isSignedIn: boolean }) {
  const [apis, setApis] = useState<ApiRecord[]>([]);
  const [availability, setAvailability] = useState<ReadonlyMap<string, ApiSchemaAvailability>>(new Map());
  const [storageMode, setStorageMode] = useState<StorageMode>("dataset");
  const [loading, setLoading] = useState(true), [catalogError, setCatalogError] = useState(""), [catalogRetry, setCatalogRetry] = useState(0);
  const [sourceId, setSourceId] = useState(""), [targetId, setTargetId] = useState("");
  const [sourceMode, setSourceMode] = useState<SchemaInputMode>("url"), [targetMode, setTargetMode] = useState<SchemaInputMode>("url");
  const [allowMismatch, setAllowMismatch] = useState(false);
  const sourceSchemas = useSavedSchemas(sourceId, "source"), targetSchemas = useSavedSchemas(targetId, "target");
  const sourceUpload = useLocalSchema("source"), targetUpload = useLocalSchema("target");
  const sourceRemote = useRemoteSchema("source"), targetRemote = useRemoteSchema("target");
  const [running, setRunning] = useState(false);
  /** Fields of the schemas an ad-hoc check compared; saved sides carry their own. */
  const [adhocFields, setAdhocFields] = useState<{ source: ApiSchemaField[]; target: ApiSchemaField[] } | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [runError, setRunError] = useState("");
  const [answerError, setAnswerError] =  useState("");
  const [submittingAnswer, setSubmittingAnswer] =  useState(false);
  const [previewingAnswer, setPreviewingAnswer] = useState(false);
  const [previewChoices, setPreviewChoices] = useState<Array<{ targetPath: string; answer: MappingAnswer }>>([]);
  const [isPreviewReport, setIsPreviewReport] = useState(false);
  /**
   * The format the comparison is made in. Null means the engine's default;
   * once a report exists the picker offers what the two APIs declare. Every
   * later call carries it, so an answer is recorded against the schema the
   * user was actually looking at.
   */
  const [format, setFormat] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setCatalogError("");
    fetch("/api/compatibility/apis", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("The comparison-ready API catalogue could not be loaded.");
      return await response.json() as ApiPayload;
    }).then((payload) => {
      if (controller.signal.aborted) return;
      const records = payload.apis ?? [];
      const byApi = new Map((payload.availability ?? []).map((entry) => [entry.api_id, entry]));
      const defaults = defaultApiPair(records, byApi);
      setApis(records); setAvailability(byApi); setStorageMode(payload.mode ?? "dataset"); setLoading(false);
      // A link from an inbox notice or from My field decisions names the pair
      // it is about; opening it should land on that pair, not on the default.
      const asked = new URLSearchParams(window.location.search);
      const named = (key: "source" | "target") => {
        const id = asked.get(key) ?? "";
        return records.some((record) => record.id === id) ? id : "";
      };
      const wantedSource = named("source");
      const wantedTarget = named("target");
      if (wantedSource || wantedTarget) {
        setSourceMode("published"); setTargetMode("published");
      }
      setSourceId((previous) => wantedSource || previous || defaults.sourceId);
      setTargetId((previous) => wantedTarget || previous || defaults.targetId);
    }).catch((error) => {
      if (!controller.signal.aborted) { setCatalogError(error instanceof Error ? error.message : "The API catalogue could not be loaded."); setLoading(false); }
    });
    return () => controller.abort();
  }, [catalogRetry]);

  const source = apis.find((api) => api.id === sourceId), target = apis.find((api) => api.id === targetId);
  const sourceInput = sourceMode === "url" ? sourceRemote.selected : sourceMode === "published" ? { schema: sourceSchemas.selected?.raw } : sourceUpload.selected;
  const targetInput = targetMode === "url" ? targetRemote.selected : targetMode === "published" ? { schema: targetSchemas.selected?.raw, parameters: undefined } : targetUpload.selected;
  const sourceFormats = selectedFormats(sourceMode, sourceMode === "url" ? sourceRemote.selected?.mediaType : sourceMode === "published" ? sourceSchemas.selected?.media_type : sourceUpload.selected?.mediaType || sourceUpload.mediaType, source?.output_formats ?? []);
  const targetFormats = selectedFormats(targetMode, targetMode === "url" ? targetRemote.selected?.mediaType : targetMode === "published" ? targetSchemas.selected?.media_type : targetUpload.selected?.mediaType || targetUpload.mediaType, target?.input_formats ?? []);
  const sourceName = sourceMode === "url"
    ? sourceRemote.selected ? new URL(sourceRemote.url).hostname : ""
    : sourceMode === "upload" ? sourceUpload.selected ? sourceUpload.file?.name ?? "Uploaded source" : ""
      : source ? comparisonApiName(source) : "";
  const targetName = targetMode === "url"
    ? targetRemote.selected ? new URL(targetRemote.url).hostname : ""
    : targetMode === "upload" ? targetUpload.selected ? targetUpload.file?.name ?? "Uploaded target" : ""
      : target ? comparisonApiName(target) : "";
  const pairHint = formatHint(sourceFormats, targetFormats);
  const usesRepositoryReport = sourceMode === "published" &&  targetMode === "published" &&  storageMode === "supabase";
  const previewPending = (sourceMode === "url"  ? sourceRemote.busy  : sourceMode === "published"  ? sourceSchemas.loading  : sourceUpload.busy) || (targetMode === "url"  ? targetRemote.busy  : targetMode === "published"  ? targetSchemas.loading  : targetUpload.busy);
  /* * Wait for the selected inputs to finish loading before comparison.
  * Saved API comparisons must not run before their schema selectors are ready,
  * otherwise the request can omit the selected schema IDs and fall back to the
  * engine's automatic schema choice.
   */
  const pending = previewPending;
  const hasSourceSchema = sourceInput?.schema !== undefined;
  const hasTargetSchema = targetInput?.schema !== undefined || Boolean(targetInput?.parameters?.length);
  const partial = !hasSourceSchema || !hasTargetSchema;
  const selectionError = sourceMode === "url" && sourceRemote.url.trim() && (!sourceRemote.selected || sourceRemote.error) ? "Read a valid source OpenAPI link and choose its response."
    : targetMode === "url" && targetRemote.url.trim() && (!targetRemote.selected || targetRemote.error) ? "Read a valid target OpenAPI link and choose its request."
      : sourceMode === "published" && targetMode === "published" && sourceId && sourceId === targetId ? "Choose two different APIs."
    : sourceMode === "upload" && sourceUpload.file && (!sourceUpload.selected || sourceUpload.error) ? "Choose a valid source operation from the uploaded file."
      : targetMode === "upload" && targetUpload.file && (!targetUpload.selected || targetUpload.error) ? "Choose a valid target operation from the uploaded file."
        : !usesRepositoryReport && sourceMode === "published" &&  targetMode === "published" && source && target && pairHint.status === "incompatible" && !allowMismatch ? "These formats do not overlap. Choose another target or allow format mismatches to inspect the result." : "";
  function resetResult() { setAdhocFields(null); setReport(null); setRunError(""); setAnswerError("");setPreviewChoices([]); setIsPreviewReport(false); setFormat(null);}
  function selectApi(side: "source" | "target", id: string) {
    if (side === "source") { setSourceId(id); sourceUpload.setFile(null); }
    else { setTargetId(id); targetUpload.setFile(null); }
    resetResult();
  }
  
  /** What the server needs to read one side: a saved record, a link with the chosen operation, or the uploaded text. */
  async function sideBody(side: "source" | "target"): Promise<Record<string, unknown>> {
    const mode = side === "source" ? sourceMode : targetMode;
    const remote = side === "source" ? sourceRemote : targetRemote;
    const upload = side === "source" ? sourceUpload : targetUpload;
    if (mode === "published") { const schemas = side === "source" ? sourceSchemas : targetSchemas; return { api_id: side === "source" ? sourceId : targetId, schema_id: schemas.selectedId || undefined, }; }
    const chosen = mode === "url" ? remote.selected : upload.selected;
    const operation = (() => {
      try {
        const parts = JSON.parse(chosen?.id ?? "") as unknown;
        return Array.isArray(parts) && typeof parts[0] === "string" && typeof parts[1] === "string" ? { method: parts[0], path: parts[1] } : undefined;
      } catch { return undefined; }
    })();
    if (mode === "url") return { url: remote.url.trim(), operation };
    const text = await upload.file!.text();
    if (chosen?.id === "schema-fragment") return { text, direction: side === "source" ? "response" : "request", media_type: upload.mediaType || undefined };
    return { text, operation };
  }

  async function runChecks(chosenFormat: string | null = format) {
    if ( !sourceName || !targetName || selectionError || running || pending ) { return;}
    setRunning(true); setRunError(""); setAnswerError(""); setAdhocFields(null); setReport(null);setPreviewChoices([]); setIsPreviewReport(false);
     try {
       /** Two saved APIs go to /api/checks; a link, an upload or one JSON
        * Schema on either side goes to /api/checks/adhoc (#33). Both return
        * the same CheckReport. */
       if (usesRepositoryReport) { 
        const query = new URLSearchParams({ source_id: sourceId, target_id: targetId, });
        if (sourceSchemas.selectedId) {query.set("source_schema_id", sourceSchemas.selectedId);}
        if (targetSchemas.selectedId) {query.set("target_schema_id", targetSchemas.selectedId);}
        if (chosenFormat) query.set("format", chosenFormat);
        const response = await fetch( `/api/checks?${query.toString()}`, { cache: "no-store", },);
        const payload = (await response.json()) as { report?: CheckReport; requestId?: string; error?: string; };
      
       if (!response.ok || !payload.report) {
         throw new Error( payload.error || "The repository compatibility report could not be generated.", ); }
       setReport(payload.report);setIsPreviewReport(false);
       // Follow the engine: it settles the default when the page chose nothing.
       setFormat(payload.report.check1.format_selected);
       return;}

      // Every other combination — an OpenAPI link, an uploaded document, a
      // schema, or one of those against a saved record — goes through the
      // same engine on the server (#33). Answers cannot be saved for a side
      // that is not in the catalogue, so the report is shown as a preview.
      if (storageMode !== "supabase") throw new Error("Comparing links, uploads or saved APIs needs the live repository; the static dataset cannot be compared.");
      const response = await fetch("/api/checks/adhoc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: await sideBody("source"), target: await sideBody("target"), format: chosenFormat ?? undefined }),
      });
      const payload = (await response.json()) as { report?: CheckReport; fields?: { source: ApiSchemaField[]; target: ApiSchemaField[] }; error?: string };
      if (!response.ok || !payload.report) throw new Error(payload.error || "The compatibility report could not be generated.");
      setAdhocFields(payload.fields ?? { source: [], target: [] });
      setReport(payload.report); setIsPreviewReport(true);
      setFormat(payload.report.check1.format_selected);
    }  catch (error) { setRunError( error instanceof Error ? error.message : "The compatibility check could not be completed. Try again.", );} finally { setRunning(false);}
  }
  
  async function previewMappingAnswer(targetPath: string, answer: MappingAnswer): Promise<void> {
    if (previewingAnswer || submittingAnswer || !usesRepositoryReport) return;
    const nextChoices = [...previewChoices.filter((item) => item.targetPath !== targetPath), { targetPath, answer }];
    setPreviewingAnswer(true);
    setAnswerError("");
    try {
      const response = await fetch("/api/checks/preview-answers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choices: nextChoices.map((item) => ({
            source_id: sourceId,
            target_id: targetId,
            source_schema_id: sourceSchemas.selectedId || undefined,
            target_schema_id: targetSchemas.selectedId || undefined,
            format,
            target_path: item.targetPath,
            option: item.answer.option,
            ...(item.answer.option === "candidate" ? { chosen_source_path: item.answer.chosen_source_path } : {}),
          })),
        }),
      });
      const payload = await response.json() as { report?: CheckReport; requestId?: string; error?: string };
      if (!response.ok || !payload.report) throw new Error(payload.error || "The preview could not be generated.");setPreviewChoices(nextChoices);setReport(payload.report);setIsPreviewReport(true);
    } catch (error) {setAnswerError(error instanceof Error ? error.message : "The preview could not be generated.");} finally {setPreviewingAnswer(false);}}

  async function submitMappingAnswer(targetPath: string, answer: MappingAnswer): Promise<void> {
  if (submittingAnswer || !usesRepositoryReport) {
    return;
  }

  setSubmittingAnswer(true);
  setAnswerError("");

  try {
    const response = await fetch("/api/checks/answers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_id: sourceId,
        target_id: targetId,
        source_schema_id: sourceSchemas.selectedId || undefined,
        target_schema_id: targetSchemas.selectedId || undefined,
        format,
        target_path: targetPath,
        option: answer.option,
        ...(answer.option === "candidate" ? { chosen_source_path: answer.chosen_source_path } : {}),
      }),
    });

    const payload = (await response.json()) as {
      report?: CheckReport;
      requestId?: string;
      error?: string;
    };

    if (!response.ok || !payload.report) {
      /*
       * A 409 commonly means another answer changed the field state
       * or the field is now waiting for an administrator. Reload the
       * formal report so the page displays the current state.
       */
      if (response.status === 409) {
        const query = new URLSearchParams({
          source_id: sourceId,
          target_id: targetId,

        });
        if (format) query.set("format", format);
        if (sourceSchemas.selectedId) {query.set("source_schema_id", sourceSchemas.selectedId);}
        if (targetSchemas.selectedId) {query.set("target_schema_id", targetSchemas.selectedId);}
        const refreshResponse = await fetch(`/api/checks?${query.toString()}`, {
          cache: "no-store",
        });

        const refreshPayload = (await refreshResponse.json()) as { report?: CheckReport };

        if (refreshResponse.ok && refreshPayload.report) {
          setReport(refreshPayload.report);
        }
      }

      throw new Error(payload.error || "The field selection could not be saved.");
    }
    setPreviewChoices((current) => current.filter((item) => item.targetPath !== targetPath));
    setReport(payload.report);
    setIsPreviewReport(false);
  } catch (error) {
    setAnswerError(error instanceof Error ? error.message : "The field selection could not be saved.");
  } finally {
    setSubmittingAnswer(false);
  }
}

  // Link and local-file comparisons do not depend on the repository catalogue.
  // Keep those controls usable while the catalogue is loading or unavailable.
  const disabled = running || submittingAnswer || previewingAnswer;

  return <main className="app-shell compatibility-shell" id="main-content"><section className="workspace compatibility-workspace">
    <BackToTop targetId="main-content" focusId="compatibility-title" label="Back to top of compatibility check" />
    <header className="compatibility-page-header"><div><p className="eyebrow">Compatibility workspace</p><h1 id="compatibility-title" tabIndex={-1}>Compare two APIs<br />from their definitions.</h1><p className="intro-copy">Paste OpenAPI URLs, select repository definitions, or upload local files for this comparison only.</p></div>
      <span className={`connection-state ${storageMode === "supabase" ? "connected" : ""}`}><i aria-hidden="true" />{loading ? "Loading catalogue" : storageMode === "supabase" ? "Comparison-ready repository" : "Static dataset"}</span>
    </header>
    <div className="compat-prototype-note" role="note"><strong>Response → Request</strong><span>Compare the source output with the target input. The saved API list includes only operations with both request and response schemas. A link or an uploaded file goes through the same checks as a saved API; its field decisions are not saved.</span></div>
    {catalogError && <div className="compat-load-error" role="alert"><span>{catalogError}</span><button type="button" className="button secondary" onClick={() => setCatalogRetry((value) => value + 1)}>Retry catalogue</button></div>}
    {!loading && !catalogError && !apis.length && <p className="compat-schema-note">No APIs with both saved request and response schemas are available yet.</p>}
    <div className="compat-pair-grid">
      <CompatibilityApiPanel side="source" apis={apis} availability={availability} apiId={sourceId} onApi={(id) => selectApi("source", id)} mode={sourceMode} onMode={(mode) => { setSourceMode(mode); resetResult(); }}
        schemas={sourceSchemas.schemas} schemaId={sourceSchemas.selectedId} onSchema={(id) => { sourceSchemas.select(id); resetResult(); }} schemasLoading={sourceSchemas.loading} schemaError={sourceSchemas.error} onRetry={() => { sourceSchemas.retry(); resetResult(); }}
        upload={sourceUpload} onUpload={(file) => { sourceUpload.setFile(file); resetResult(); }} onChoice={(id) => { sourceUpload.select(id); resetResult(); }} onMediaType={(value) => { sourceUpload.setMediaType(value); resetResult(); }}
        remote={sourceRemote} onRemoteUrl={(value) => { sourceRemote.setUrl(value); resetResult(); }} onRemoteLoad={() => { void sourceRemote.load(); resetResult(); }} onRemoteChoice={(id) => { sourceRemote.select(id); resetResult(); }} disabled={disabled} />
      <div className="compat-pair-arrow" aria-label="Source response is compared with target request"><span aria-hidden="true">→</span></div>
      <CompatibilityApiPanel side="target" apis={apis} availability={availability} apiId={targetId} onApi={(id) => selectApi("target", id)} mode={targetMode} onMode={(mode) => { setTargetMode(mode); resetResult(); }}
        schemas={targetSchemas.schemas} schemaId={targetSchemas.selectedId} onSchema={(id) => { targetSchemas.select(id); resetResult(); }} schemasLoading={targetSchemas.loading} schemaError={targetSchemas.error} onRetry={() => { targetSchemas.retry(); resetResult(); }}
        upload={targetUpload} onUpload={(file) => { targetUpload.setFile(file); resetResult(); }} onChoice={(id) => { targetUpload.select(id); resetResult(); }} onMediaType={(value) => { targetUpload.setMediaType(value); resetResult(); }} disabled={disabled}
        remote={targetRemote} onRemoteUrl={(value) => { targetRemote.setUrl(value); resetResult(); }} onRemoteLoad={() => { void targetRemote.load(); resetResult(); }} onRemoteChoice={(id) => { targetRemote.select(id); resetResult(); }}
        sourceId={sourceId} sourceFormats={sourceFormats} allowMismatch={allowMismatch} onAllowMismatch={(value) => { setAllowMismatch(value); resetResult(); }} />
    </div>
    <div className="compat-run-bar"><div><strong>{sourceName && targetName ? usesRepositoryReport ? "Ready to run the repository report" : partial ? "Start with the available information" : "Ready to compare" : "Choose your source and target"}</strong>
      <span>{sourceName && targetName ? usesRepositoryReport ? "Ready to run the repository report" : partial ? "Missing schemas will be marked as unavailable. Recorded formats can still be checked." : `Report on the documents given: ${formatFormatsForDisplay(sourceFormats,"unspecified format",)} → ${formatInputFormatsForDisplay(targetFormats,"unspecified format",)} (field decisions cannot be saved for a side that is not in the catalogue)` : "Paste links, choose saved APIs, or upload files for each side."}</span>
      {selectionError && <p className="compat-inline-error">{selectionError}</p>}{runError && <p className="compat-inline-error" role="alert">{runError}</p>}</div>
      <button className="button primary" type="button" onClick={() => void runChecks()} disabled={disabled || pending || !sourceName || !targetName || Boolean(selectionError)}>{running ? "Comparing…" : "Compare APIs"}</button>
    </div>
    {report && <CompatibilityFormatPicker
      options={report.check1.format_options}
      selected={report.check1.format_selected}
      disabled={disabled}
      inputInParameters={report.check1.flags.includes("input_in_parameters")}
      onChange={(next) => { setFormat(next); void runChecks(next); }}
    />}
    {!report && !running && <section className="compat-empty-result"><span aria-hidden="true">⇄</span><div><h2>Your comparison will appear here</h2><p>See the overall result, then review matching fields, required mappings and missing information.</p></div></section>}
    {running && <div className="compat-running" role="status"><span aria-hidden="true" /><strong>Comparing APIs…</strong><p>Checking the selected source output and target input.</p></div>}
    {report && <CompatibilityReport
      report={report}
      sourceFields={adhocFields?.source ?? sourceSchemas.schemas.find((schema) => schema.id === report.check2.schema.source_schema_used?.schema_id)?.fields ?? []}
      targetFields={adhocFields?.target ?? targetSchemas.schemas.find((schema) => schema.id === report.check2.schema.target_schema_used?.schema_id)?.fields ?? []}
      submittingAnswer={submittingAnswer} previewingAnswer={previewingAnswer} answerError={answerError}
      isSignedIn={isSignedIn} isPreview={isPreviewReport} onPreview={previewMappingAnswer} onSave={submitMappingAnswer}
    />}
    {report && !running && <section className="compat-compose-cta" aria-label="Composed API">
      <div><p className="eyebrow">Composed API</p><h2>Send an invoice through three APIs run as one</h2><p>beliq generates a Peppol BIS Billing 3.0 invoice, the Peppol Validator checks it, and only a valid invoice is sent through B2Brouter (sandbox).</p></div>
      <a className="button primary" href="/compose/peppol-invoice">Generate, validate and send</a>
    </section>}
  </section></main>;
}
