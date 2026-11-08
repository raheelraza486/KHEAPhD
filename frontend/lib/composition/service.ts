import { runChecks } from "../checks/run.ts";
import type { SupabaseConfig } from "../checks/store.ts";
import { createHash } from "node:crypto";
import type { LinkCache } from "../workspace/types.ts";
import { compositionResponse, type CompositionStandardCheck, type CompositionTechnicalCheck } from "./api-contract.ts";
import { loadCompositionCatalogue, loadCompositionSides, loadInvoiceStandardCapabilities } from "./catalogue.ts";
import { composeChains, hasInput, hasOutput, planProcess } from "./compose.ts";
import { parseProcessJson } from "./process-format.ts";
import { narrowProcessCandidates, type CandidateNarrowingResult } from "./task-candidates.ts";
import { expandTransformations, hasTransformationGoal, transformationCandidateIds } from "./transformation-expansion.ts";
type Parsed = Extract<ReturnType<typeof parseProcessJson>, { ok: true }>;
export async function loadMatchingContext(config: SupabaseConfig) {
  const catalogue = await loadCompositionCatalogue(config);
  const standardData = await loadInvoiceStandardCapabilities(config);
  const confirmedLabels = new Map<string, string[]>();
  const capabilitiesById = new Map<string, typeof standardData.rows>();
  for (const row of standardData.rows) {
    const capabilities = capabilitiesById.get(row.api_id) ?? [];
    capabilities.push(row);
    capabilitiesById.set(row.api_id, capabilities);
    if (row.status !== "confirmed" || !/^https?:\/\/\S+$/i.test(row.evidence_url)) continue;
    const labels = confirmedLabels.get(row.api_id) ?? [];
    labels.push(`${row.standard} ${row.version}`);
    confirmedLabels.set(row.api_id, labels);
  }
  const searchableCatalogue = catalogue.map((api) => ({
    ...api,
    invoice_standard: [...new Set([...(api.invoice_standard ?? []), ...(confirmedLabels.get(api.id) ?? [])])],
    standard_capabilities: capabilitiesById.get(api.id) ?? [],
  }));
  return { catalogue, searchableCatalogue, standardData, capabilitiesById };
}
export type MatchingContext = Awaited<ReturnType<typeof loadMatchingContext>>;
/** The original engine, shared by the legacy route and persisted workflow evaluation. */
export async function evaluateComposition(parsed: Parsed, config: SupabaseConfig, signedIn: boolean, requestId: string,
  options: { context?: MatchingContext; linkCache?: LinkCache; cached?: { evidence_key?: string; result: ReturnType<typeof compositionResponse> }; onEvidence?: (key: string) => void; progress?: (stage: string, message: string) => void } = {}) {
  if (planProcess(parsed.process).issues.length > 0) {
    const narrowed: CandidateNarrowingResult = {
      process: { steps: parsed.process.steps.map(step => ({ ...step, candidate_ids: [] })) },
      steps: parsed.process.steps.map(step => ({ order: step.order, source: "none", matches: [], total_matches: 0, issue: null })),
    };
    return compositionResponse(requestId, parsed.input_text, parsed.unmatched, narrowed, [], composeChains(narrowed.process, [], () => "pass"));
  }
  const { catalogue, searchableCatalogue, standardData, capabilitiesById } = options.context ?? await loadMatchingContext(config);
  options.progress?.("matching", "Resolving candidate APIs for workflow steps...");
  const initial = narrowProcessCandidates(parsed.process, searchableCatalogue);
  const ids = [...new Set([...initial.process.steps.flatMap((step) => step.candidate_ids ?? []),
    ...transformationCandidateIds(parsed.process, searchableCatalogue)])];
  options.progress?.("compatibility", "Loading schema evidence and checking API connections...");
  const loaded = await loadCompositionSides(config, catalogue, ids, signedIn, parsed.process.steps.some(hasTransformationGoal));
  const { formatAliases, choicesByPair } = loaded;
  // Check 2.0b reads the same directional claims (#42).
  const sides = loaded.sides.map((side) => ({ ...side, standard_claims: capabilitiesById.get(side.api.id) ?? [] }));
  const resolved = expandTransformations(parsed.process, initial, searchableCatalogue, sides, formatAliases);
  const { narrowed } = resolved;
  const evidenceKey = createHash('sha256').update(JSON.stringify(['evaluation-v1', parsed.process, searchableCatalogue, standardData.available, sides, formatAliases, [...choicesByPair]])).digest('hex');
  options.onEvidence?.(evidenceKey);
  if (options.cached?.evidence_key === evidenceKey) {
    options.progress?.('cached', 'Reusing the evaluation; the workflow and repository evidence are unchanged.');
    return options.cached.result;
  }
  const standardChecks = new Map<string, CompositionStandardCheck>();
  const technicalChecks = new Map<string, CompositionTechnicalCheck>();
  options.progress?.("chains", "Exploring API chains with the available compatibility evidence...");
  const composition = resolved.issues.length ? {
    ...composeChains(narrowed.process, [], () => "pass"), issues: resolved.issues,
  } : composeChains(narrowed.process, sides, (source, target, context) => {
    const key = `${source.api.id}->${target.api.id}`;
    config.signal?.throwIfAborted();
    const rules = narrowed.process.steps.filter(step => step.candidate_ids?.includes(source.api.id) || step.candidate_ids?.includes(target.api.id) || step.category === 'Validation').map(step => step.rule_set);
    const cacheKey = createHash("sha256").update(JSON.stringify(["checks-v1", source, target, formatAliases, choicesByPair.get(key) ?? [], context.validated_between, rules])).digest("hex");
    const cached = options.linkCache?.[cacheKey];
    if (cached) {
      technicalChecks.set(key, cached.technical);
      if (cached.standard) standardChecks.set(key, cached.standard);
      return cached.verdict;
    }
    const report = runChecks({
      source, target, formatAliases, choices: choicesByPair.get(key) ?? [], validatedBetween: context.validated_between,
    });
    const result = report.overall;
    const standard = report.check2.standard;
    // Use the same Check 2.0b result that contributed to the overall verdict.
    // Claim review is informational and cannot downgrade a compatible link.
    if (standard) standardChecks.set(key, {
      source_id: source.api.id, target_id: target.api.id, ...standard,
    });
    const missing_sides: CompositionTechnicalCheck["missing_sides"] = [];
    if (!hasOutput(source)) missing_sides.push("source_output");
    if (!hasInput(target)) missing_sides.push("target_input");
    const incomplete = (result.overall === "fail" && result.blocking_reason === "insufficient_info")
      || (result.overall === "pass" && missing_sides.length > 0);
    const technical = incomplete ? "unknown" : result.overall;
    technicalChecks.set(key, {
      source_id: source.api.id, target_id: target.api.id, status: technical,
      blocking_reason: technical === "unknown" ? "insufficient_info" : result.blocking_reason,
      blocking_checks: result.blocking_checks, reason_codes: result.reason_codes, missing_sides,
      // Preserve #107's fields for existing results-page consumers.
      standard_flags: standard?.flags ?? [], standard_conditions: standard?.conditions ?? [],
    });
    if (options.linkCache) options.linkCache[cacheKey] = { verdict: technical, technical: technicalChecks.get(key)!, ...(standardChecks.has(key) ? { standard: standardChecks.get(key)! } : {}) };
    return technical;
  }, { includeIncompleteSides: true });
  return compositionResponse(requestId, parsed.input_text, parsed.unmatched, narrowed, catalogue, composition,
    [...standardChecks.values()], standardData.available, [...technicalChecks.values()], resolved.added);
}
