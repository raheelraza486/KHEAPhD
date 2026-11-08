import { parseProcessJson } from '../composition/process-format.ts';
import type { Draft, DraftEdits, DraftState, Requirement } from './types.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requirementKey(step: Requirement): string {
  return JSON.stringify([step.category, step.task.trim(), step.input_format?.trim() || null, step.output_format?.trim() || null, step.rule_set?.trim() || null, step.candidate_ids]);
}
export function inputKey(input: DraftState['input']): string {
  return JSON.stringify([input.mode, input.mode === 'text' ? input.text.trim() : input.files[input.mode]?.path ?? null]);
}
export function processFor(state: DraftState, useMatches = false) {
  const text = state.input.mode === 'text' ? state.input.text : state.analysed_text;
  return { version: '1.0' as const, input_text: text?.trim() || 'Manually reviewed workflow', unmatched: state.unmatched,
    steps: state.requirements.map(({ id, ...step }, i) => {
      // Individual keyword matches may list only generators for "Create UBL".
      // A format goal must remain open to the engine's extractor + converter
      // expansion unless the user explicitly selected its starting APIs.
      const conversion = step.category === 'Transformation' && !!step.input_format && !!step.output_format;
      return { ...step, order: i + 1,
        candidate_ids: useMatches && !conversion ? (step.candidate_ids ?? state.matches[id]?.step.candidate_apis.map(api => api.id) ?? null) : step.candidate_ids };
    }) };
}
export function evaluationKey(state: DraftState): string {
  return JSON.stringify(state.requirements.map(step => [step.id, requirementKey(step), state.matches[step.id]?.catalogue_key, state.matches[step.id]?.step.candidate_apis.map(api => api.id)]));
}
export function editsFor(draft: Pick<Draft, 'title' | 'state'>): DraftEdits {
  return { title: draft.title, input: { mode: draft.state.input.mode, text: draft.state.input.text }, requirements: draft.state.requirements, selected_chain: draft.state.selected_chain };
}
/** Whitelist editable fields. Clients cannot inject cached results, file paths or ownership. */
export function applyEdits(draft: Pick<Draft, 'title' | 'state' | 'kind'>, value: unknown): Pick<Draft, 'title' | 'state'> {
  if (!value || typeof value !== 'object') throw new Error('Invalid draft edits.');
  const edits = value as DraftEdits;
  if (typeof edits.title !== 'string' || edits.title.length > 120 || !edits.input || !['text', 'bpmn', 'audio'].includes(edits.input.mode)
    || typeof edits.input.text !== 'string' || edits.input.text.length > 2000 || !Array.isArray(edits.requirements) || edits.requirements.length > 32) throw new Error('Invalid draft edits.');
  const ids = edits.requirements.map(step => step?.id);
  if (ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(ids).size !== ids.length) throw new Error('Requirements need unique IDs.');
  const state: DraftState = { ...draft.state, input: { ...draft.state.input, mode: edits.input.mode, text: edits.input.text }, requirements: edits.requirements };
  // An unfinished field is still a saveable draft; execution validates it strictly.
  const draftProcess = processFor(state);
  const parsed = parseProcessJson({ ...draftProcess, steps: draftProcess.steps.map(step => ({ ...step, task: step.task.trim() || 'Unfinished requirement',
    input_format: step.input_format?.trim() || null, output_format: step.output_format?.trim() || null, rule_set: step.rule_set?.trim() || null })) });
  if (!parsed.ok) throw new Error(parsed.errors.map(error => `${error.path}: ${error.message}`).join(' '));
  state.requirements = parsed.process.steps.map((step, i) => ({ id: ids[i], category: step.category, task: edits.requirements[i].task,
    input_format: edits.requirements[i].input_format ?? null, output_format: edits.requirements[i].output_format ?? null, rule_set: edits.requirements[i].rule_set ?? null,
    candidate_ids: step.candidate_ids ? [...step.candidate_ids] : null }));
  state.matches = Object.fromEntries(state.requirements.flatMap(step => {
    const match = draft.state.matches[step.id];
    const old = draft.state.requirements.find(item => item.id === step.id);
    return match && old && requirementKey({ ...old, candidate_ids: null }) === requirementKey({ ...step, candidate_ids: null }) ? [[step.id, match]] : [];
  }));
  const changedInput = inputKey(state.input) !== inputKey(draft.state.input);
  state.discovery_review = changedInput ? undefined : Object.fromEntries(Object.entries(draft.state.discovery_review ?? {}).filter(([id]) => {
    if (id === 'source') return true;
    const old = draft.state.requirements.find(step => step.id === id);
    const current = state.requirements.find(step => step.id === id);
    return old && current && requirementKey(old) === requirementKey(current);
  }));
  // Keep the reviewed requirements visible when editing the source, but no old results.
  if (changedInput) {
    state.matches = {};
    state.decomposed_key = draft.kind === 'workflow' ? draft.state.decomposed_key ?? inputKey(draft.state.input) : null;
  }
  if (changedInput || evaluationKey(state) !== evaluationKey(draft.state)) {
    state.evaluation = null;
    state.selected_chain = null;
  } else {
    const selected = edits.selected_chain;
    if (selected !== null && (!Number.isInteger(selected) || !state.evaluation?.result.composition.chains[selected])) throw new Error('Invalid selected chain.');
    state.selected_chain = selected;
  }
  return { title: edits.title, state };
}
export function needsDecomposition(draft: Pick<Draft, 'state' | 'kind'>): boolean {
  // Existing manually reviewed Workflows have no extraction key. Preserve their
  // steps; changing text or media records the previous key and requires analysis.
  if (draft.kind === 'workflow' && draft.state.decomposed_key === null) return false;
  return draft.state.decomposed_key !== inputKey(draft.state.input);
}
export function hasCurrentMatches(draft: Pick<Draft, 'state' | 'kind'>): boolean {
  return !needsDecomposition(draft) && draft.state.requirements.length > 0 && draft.state.requirements.every(step => draft.state.matches[step.id]?.key === requirementKey(step));
}
