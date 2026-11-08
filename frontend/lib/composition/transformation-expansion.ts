import { commonFormats, normaliseFormats } from "../checks/check1-format.ts";
import { effectiveFormats } from "../checks/documents.ts";
import type { ApiSideInput, FormatAliasRow } from "../checks/types.ts";
import { hasUblOutputClaim } from "./invoice-standard-capabilities.ts";
import { meetsOutputConstraints, type CandidateApi, type CandidateNarrowingResult, type CandidateStepResult } from "./task-candidates.ts";
import { MAX_STEPS, type BusinessProcess, type ProcessIssue, type ProcessStep } from "./types.ts";

export interface AddedTransformation {
  order: number;
  original_order: number;
  reason: string;
}

export function hasTransformationGoal(step: ProcessStep): boolean {
  return step.category === "Transformation" && !!step.input_format && !!step.output_format
    && step.candidate_ids?.length !== 0;
}

/** Include format candidates in the existing bulk schema read, even after a keyword miss. */
export function transformationCandidateIds(process: BusinessProcess, catalogue: readonly CandidateApi[]): string[] {
  return process.steps.some(hasTransformationGoal) ? catalogue.filter((api) =>
    api.category === "Transformation" && api.is_active !== false && !api.duplicate_of,
  ).map((api) => api.id) : [];
}

function formatCandidate(order: number, ids: string[]): CandidateStepResult {
  return { order, source: "formats", matches: ids.map((id) => ({ id, score: 0, matched_terms: [] })),
    total_matches: ids.length, issue: ids.length ? null : "no_match" };
}

/** XML syntax alone is not evidence of UBL output. JSON may carry UBL in its xml field. */
function declaresUblOutput(api: CandidateApi, output: readonly string[]): boolean {
  if (output.includes("UBL")) return true;
  if (!output.includes("XML")) return false;
  const description = [api.api_name, api.official_api_name, api.description, api.instructions]
    .filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return /\b(?:to|into|outputs?|generat(?:e|es|ed|ing))\s+(?:an?\s+)?UBL(?:\s+XML)?\b/i.test(description);
}

function outputsUbl(api: CandidateApi, output: readonly string[]): boolean {
  return declaresUblOutput(api, output)
    || (output.includes("XML") && hasUblOutputClaim(api.id, api.standard_capabilities ?? []));
}

/** Expand a goal into two format segments. Existing pair checks still decide feasibility. */
export function expandTransformations(
  process: BusinessProcess,
  narrowed: CandidateNarrowingResult,
  catalogue: readonly CandidateApi[],
  sides: readonly ApiSideInput[],
  aliases: readonly FormatAliasRow[],
): { narrowed: CandidateNarrowingResult; added: AddedTransformation[]; issues: ProcessIssue[] } {
  const byId = new Map(catalogue.filter((api) => api.is_active !== false && !api.duplicate_of).map((api) => [api.id, api]));
  const conversions = sides.flatMap((side) => {
    const api = byId.get(side.api.id);
    return api?.category === "Transformation" ? [{ api,
      input: effectiveFormats(side, "input", aliases).formats,
      output: effectiveFormats(side, "output", aliases).formats,
    }] : [];
  }).sort((a, b) => a.api.api_name.localeCompare(b.api.api_name) || a.api.id.localeCompare(b.api.id));
  const steps: ProcessStep[] = [];
  const results: CandidateStepResult[] = [];
  const added: AddedTransformation[] = [];
  const issues: ProcessIssue[] = [];

  const append = (step: ProcessStep, result: CandidateStepResult) => {
    const order = steps.length + 1;
    steps.push({ ...step, order });
    results.push({ ...result, order });
  };
  for (const [index, step] of process.steps.entries()) {
    const original = narrowed.process.steps[index];
    const result = narrowed.steps[index];
    if (!hasTransformationGoal(step)) { append(original, result); continue; }
    const input = normaliseFormats([step.input_format!], aliases).formats[0];
    const output = normaliseFormats([step.output_format!], aliases).formats[0];
    if (!input || !output) {
      const unknown = [!input && `input format "${step.input_format}"`, !output && `output format "${step.output_format}"`]
        .filter(Boolean).join(" and ");
      issues.push({ code: "unrecognised_format", step: step.order,
        message: `Unrecognised ${unknown}. Conversion coverage cannot be checked. Use a recognised format name.` });
      append({ ...original, candidate_ids: [] }, { ...formatCandidate(step.order, []), issue: "unrecognised_format" });
      continue;
    }
    const starts = conversions.filter(({ api, input: formats }) =>
      (!step.candidate_ids || step.candidate_ids.includes(api.id)) && commonFormats([input], formats).length > 0);
    const finishes = conversions.filter(({ api, output: formats }) => meetsOutputConstraints(step, api)
      && (output === "UBL" ? outputsUbl(api, formats) : commonFormats(formats, [output]).length > 0));
    const finishingIds = new Set(finishes.map(({ api }) => api.id));
    const direct = starts.filter(({ api }) => finishingIds.has(api.id)).map(({ api }) => api.id);
    const pairs = starts.flatMap((first) => finishes.filter((second) => first.api.id !== second.api.id
      && commonFormats(first.output, second.input).length > 0).map((second) => [first.api.id, second.api.id] as const));
    const explicitDirect = starts.some(({ api, output: formats }) => finishingIds.has(api.id)
      && (output !== "UBL" || declaresUblOutput(api, formats)));
    // Output claims nominate candidates; they do not prove a complete direct
    // conversion (e.g. XML/hybrid PDF support is not ordinary PDF extraction).
    if (direct.length && (explicitDirect || !pairs.length)) {
      const matches = result.matches.filter(({ id }) => direct.includes(id));
      const rankedIds = new Set(matches.map(({ id }) => id));
      const additional = formatCandidate(step.order, direct.filter((id) => !rankedIds.has(id)));
      // Keep keyword ranking, but do not lose a documented generator merely
      // because its name did not match the requested conversion action.
      const found = additional.matches.length ? {
        ...formatCandidate(step.order, direct), matches: [...matches, ...additional.matches],
      } : { ...result, matches, total_matches: direct.length, issue: null };
      append({ ...original, candidate_ids: found.matches.map(({ id }) => id) }, found);
      continue;
    }
    if (!pairs.length) {
      issues.push({ code: "conversion_unresolved", step: step.order,
        message: `No documented single API or two-API conversion covers ${step.input_format} to ${step.output_format}.` });
      append({ ...original, candidate_ids: [] }, formatCandidate(step.order, []));
      continue;
    }
    if (process.steps.length + added.length + 1 > MAX_STEPS) {
      issues.push({ code: "too_many_steps", step: step.order,
        message: `Splitting step ${step.order} requires more than ${MAX_STEPS} steps. Describe a shorter process.` });
      append({ ...original, candidate_ids: [] }, formatCandidate(step.order, []));
      continue;
    }
    const firstIds = [...new Set(pairs.map(([first]) => first))];
    const secondIds = [...new Set(pairs.map(([, second]) => second))];
    const intermediate = [...new Set(starts.filter(({ api }) => firstIds.includes(api.id)).flatMap((first) =>
      finishes.filter(({ api }) => secondIds.includes(api.id)).flatMap((second) => commonFormats(first.output, second.input))))];
    const middleFormat = intermediate.length === 1 ? intermediate[0] : null;
    const firstTask = input === "PDF" || input === "Images" ? `Extract invoice data from ${step.input_format}`
      : `Convert ${step.input_format} to intermediate invoice data`;
    append({ ...step, task: firstTask, output_format: middleFormat,
      rule_set: null, candidate_ids: firstIds }, formatCandidate(step.order, firstIds));
    append({ ...step, task: `Convert invoice data to ${step.output_format}`, input_format: middleFormat,
      candidate_ids: secondIds }, formatCandidate(step.order, secondIds));
    added.push({ order: steps.length, original_order: step.order,
      reason: `No single candidate explicitly documents ${step.input_format} to ${step.output_format}; a second Transformation was added.` });
  }
  return { narrowed: { process: { steps }, steps: results }, added, issues };
}
