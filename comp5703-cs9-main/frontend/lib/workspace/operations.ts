import { createHash } from 'node:crypto';
import type { MatchingContext } from '../composition/service.ts';
import { narrowProcessCandidates } from '../composition/task-candidates.ts';
import type { DraftState, MatchEntry } from './types.ts';
import { requirementKey } from './state.ts';

/** Individual catalogue matching only. No model, chain generation or writes. */
export function matchRequirements(state: DraftState, context: MatchingContext): Record<string, MatchEntry> {
  const catalogueKey = createHash('sha256').update(JSON.stringify(context.searchableCatalogue)).digest('hex');
  const byId = new Map(context.catalogue.map(api => [api.id, api]));
  return Object.fromEntries(state.requirements.map((requirement, index) => {
    const key = requirementKey(requirement);
    const old = state.matches[requirement.id];
    if (old?.key === key && old.catalogue_key === catalogueKey) return [requirement.id, { ...old, step: { ...old.step, order: index + 1 } }];
    const { id: _id, ...fields } = requirement;
    const narrowed = narrowProcessCandidates({ steps: [{ ...fields, order: index + 1 }] }, context.searchableCatalogue);
    const result = narrowed.steps[0];
    return [requirement.id, { key, catalogue_key: catalogueKey,
      ...(result.rule_review ? { rule_review: result.rule_review.flatMap(entry => {
        const api = byId.get(entry.id);
        return api ? [{ ...entry, api_name: api.api_name }] : [];
      }) } : {}), step: { ...narrowed.process.steps[0],
      candidate_source: result.source, candidate_issue: result.issue, candidate_total_matches: result.total_matches,
      candidate_apis: result.matches.flatMap(match => {
        const api = byId.get(match.id);
        return api ? [{ ...match, api_name: api.api_name, company_name: api.company_name }] : [];
      }),
    } }];
  }));
}
