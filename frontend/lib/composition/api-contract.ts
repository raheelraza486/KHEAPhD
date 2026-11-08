import type { CompositionResult, LinkVerdict, ProcessStep } from "./types.ts";
import type { OverallResult, StandardResult } from "../checks/types.ts";
import type { CandidateNarrowingResult, CandidateStepResult } from "./task-candidates.ts";
import type { CompositionApi } from "./catalogue.ts";
import type { AddedTransformation } from "./transformation-expansion.ts";

export interface CompositionCandidateView {
  id: string;
  api_name: string;
  company_name: string;
  score: number;
  matched_terms: string[];
}

export interface CompositionStepView extends ProcessStep {
  system_added?: { original_order: number; reason: string };
  candidate_source: CandidateStepResult["source"];
  candidate_issue: CandidateStepResult["issue"];
  candidate_total_matches: number;
  candidate_apis: CompositionCandidateView[];
}

export interface CompositionTechnicalCheck {
  source_id: string;
  target_id: string;
  status: LinkVerdict;
  blocking_reason: OverallResult["blocking_reason"];
  blocking_checks: string[];
  reason_codes: OverallResult["reason_codes"];
  missing_sides: Array<"source_output" | "target_input">;
  /** Check 2.0b's flags for this link (`claims_unreviewed`, `configuration_required`, …); since 14 October 2026. */
  standard_flags: StandardResult["flags"];
  /** Request options a side must set for the matched standard to apply; empty when none. */
  standard_conditions: StandardResult["conditions"];
}

/** Check 2.0b verbatim, with informational review states separate from its verdict. */
export type CompositionStandardCheck = { source_id: string; target_id: string } & StandardResult;

/** Stable JSON contract for the results page. */
export interface CompositionApiResponse {
  version: "1.1";
  requestId: string;
  input_text: string;
  unmatched: string[];
  /** Current compatibility checks include Check 2.0b; jurisdiction compliance is not checked. */
  check_scope: { technical: true; invoice_standard_jurisdiction: false; directional_standard_version: boolean };
  technical_checks: CompositionTechnicalCheck[];
  standard_checks: CompositionStandardCheck[];
  steps: CompositionStepView[];
  composition: CompositionResult;
}

export function compositionResponse(
  requestId: string,
  inputText: string,
  unmatched: string[],
  narrowed: CandidateNarrowingResult,
  catalogue: readonly CompositionApi[],
  composition: CompositionResult,
  standardChecks: CompositionStandardCheck[] = [],
  standardDataAvailable = false,
  technicalChecks: CompositionTechnicalCheck[] = [],
  addedTransformations: readonly AddedTransformation[] = [],
): CompositionApiResponse {
  const byId = new Map(catalogue.map((api) => [api.id, api]));
  return {
    version: "1.1",
    requestId,
    input_text: inputText,
    unmatched,
    check_scope: { technical: true, invoice_standard_jurisdiction: false, directional_standard_version: standardDataAvailable },
    technical_checks: technicalChecks,
    standard_checks: standardChecks,
    steps: narrowed.process.steps.map((step, index) => {
      const result = narrowed.steps[index];
      const added = addedTransformations.find(({ order }) => order === step.order);
      return {
        ...step,
        ...(added ? { system_added: { original_order: added.original_order, reason: added.reason } } : {}),
        candidate_source: result.source,
        candidate_issue: result.issue,
        candidate_total_matches: result.total_matches,
        candidate_apis: result.matches.flatMap((match) => {
          const api = byId.get(match.id);
          return api ? [{
            id: match.id,
            api_name: api.api_name,
            company_name: api.company_name,
            score: match.score,
            matched_terms: match.matched_terms,
          }] : [];
        }),
      };
    }),
    composition,
  };
}
