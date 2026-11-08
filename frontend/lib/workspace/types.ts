import type { CompositionApiResponse, CompositionStepView } from '../composition/api-contract.ts';
import type { ProcessStep, LinkVerdict } from '../composition/types.ts';
import type { DiscoveryMode } from '../discovery/types.ts';

export type DraftKind = 'discovery' | 'workflow';
export type Requirement = Omit<ProcessStep, 'order' | 'candidate_ids'> & { id: string; candidate_ids: string[] | null };
export type DraftInput = { mode: DiscoveryMode; text: string; files: Partial<Record<'bpmn' | 'audio', DraftFile>> };
export type DraftFile = { path: string; name: string; type: string; size: number };
export type MatchEntry = { key: string; catalogue_key: string; step: CompositionStepView; rule_review?: { id: string; api_name: string; status: "unverified" | "rejected" }[] };
export type LinkCache = Record<string, { verdict: LinkVerdict; technical: CompositionApiResponse['technical_checks'][number]; standard?: CompositionApiResponse['standard_checks'][number] }>;
export type DraftState = {
  input: DraftInput;
  decomposed_key: string | null;
  /** Model's description for diagram/audio input; separate from the user's text tab. */
  analysed_text?: string;
  discovery_review?: Record<string, string[]>;
  requirements: Requirement[];
  unmatched: string[];
  matches: Record<string, MatchEntry>;
  evaluation: { key: string; evidence_key?: string; result: CompositionApiResponse } | null;
  link_cache: LinkCache;
  selected_chain: number | null;
};
export type Draft = { id: string; owner_id: string; kind: DraftKind; source_discovery_id: string | null; revision: number; title: string; state: DraftState; created_at: string; updated_at: string };
/** Browser-memory workspace. Never written to a database or browser storage. */
export type Workspace = Pick<Draft, 'id' | 'kind' | 'revision' | 'title' | 'state'> & {
  reached: number;
  files: Partial<Record<'bpmn' | 'audio', File>>;
};
export type DraftSummary = Pick<Draft, 'id' | 'kind' | 'source_discovery_id' | 'revision' | 'title' | 'updated_at'>;
export type DraftEdits = { title: string; input: Pick<DraftInput, 'mode' | 'text'>; requirements: Requirement[]; selected_chain: number | null };
export type ProgressEvent = { stage?: string; message?: string; draft?: Draft; error?: string; status?: number };

export function emptyState(): DraftState {
  return { input: { mode: 'text', text: '', files: {} }, decomposed_key: null, requirements: [], unmatched: [], matches: {}, evaluation: null, link_cache: {}, selected_chain: null };
}
