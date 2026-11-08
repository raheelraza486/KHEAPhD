import assert from 'node:assert/strict';
import test from 'node:test';
import { routeHarness } from './helpers/route-harness.ts';
import { applyEdits, editsFor, hasCurrentMatches, inputKey, requirementKey, needsDecomposition, processFor } from '../lib/workspace/state.ts';
import { emptyState, type Workspace, type Requirement } from '../lib/workspace/types.ts';

const requirement = (task = 'generate JSON invoice', category: Requirement['category'] = 'Transformation'): Requirement => ({ id: crypto.randomUUID(), category, task, input_format: null, output_format: null, rule_set: null, candidate_ids: null });
function workspace(kind: Workspace['kind'] = 'discovery'): Workspace {
  return { id: crypto.randomUUID(), kind, revision: 0, title: '', state: emptyState(), files: {}, reached: 1 };
}

test('source-review notes follow stable IDs on reorder and clear when the user edits that requirement', () => {
  const value = workspace();
  value.state.requirements = [requirement(), requirement('validate invoice', 'Validation')];
  const [a, b] = value.state.requirements;
  value.state.discovery_review = { [a.id]: ['Suggested conversion'], [b.id]: ['Input format left blank'], source: ['Suggested order'] };
  const reordered = applyEdits(value, { ...editsFor(value), requirements: [b, a] });
  assert.deepEqual(reordered.state.discovery_review, value.state.discovery_review);
  const edited = applyEdits(value, { ...editsFor(value), requirements: [{ ...a, task: 'My reviewed task' }, b] });
  assert.equal(edited.state.discovery_review?.[a.id], undefined);
  assert.deepEqual(edited.state.discovery_review?.[b.id], ['Input format left blank']);
  const changed = applyEdits(value, { ...editsFor(value), input: { mode: 'text', text: 'A new source' } });
  assert.equal(changed.state.discovery_review, undefined);
  assert.ok(!JSON.stringify(processFor(value.state)).includes('Suggested conversion'));
});
test('local edits keep unfinished inputs, invalidate affected results and preserve matches on reorder', () => {
  const value = workspace(); value.state.requirements = [requirement(), requirement('validate JSON invoice', 'Validation')];
  value.state.decomposed_key = inputKey(value.state.input);
  for (const step of value.state.requirements) value.state.matches[step.id] = { key: requirementKey(step), catalogue_key: 'catalogue', step: { ...step, order: 1, candidate_source: 'keywords', candidate_issue: null, candidate_total_matches: 0, candidate_apis: [] } };
  assert.equal(hasCurrentMatches(value), true);
  const reordered = applyEdits(value, { ...editsFor(value), requirements: [...value.state.requirements].reverse() });
  assert.deepEqual(reordered.state.matches, value.state.matches);
  const edited = applyEdits(value, { ...editsFor(value), requirements: value.state.requirements.map((step, i) => i ? step : { ...step, task: '' }) });
  assert.equal(edited.state.requirements[0].task, '');
  assert.equal(Object.keys(edited.state.matches).length, 1);
  const sourceEdit = { ...value, ...applyEdits(value, { ...editsFor(value), input: { mode: 'text', text: 'new task' } }) };
  assert.equal(hasCurrentMatches(sourceEdit), false);
  assert.equal(sourceEdit.state.requirements.length, 2);
  const typing = applyEdits(value, { ...editsFor(value), requirements: value.state.requirements.map((step, i) => i ? step : { ...step, input_format: 'UBL ' }) });
  assert.equal(typing.state.requirements[0].input_format, 'UBL ');
});
test('Workflow source edits require analysis and never reuse an old evaluation', () => {
  const value = workspace('workflow'); value.state.input.text = 'Previously reviewed task'; value.state.requirements = [requirement()];
  assert.equal(needsDecomposition(value), false);
  const changed = { ...value, ...applyEdits(value, { ...editsFor(value), input: { mode: 'text', text: 'A new task' } }) };
  assert.equal(needsDecomposition(changed), true);
  assert.equal(changed.state.evaluation, null);
  const media = { ...value.state, analysed_text: 'Task extracted from a diagram', input: { ...value.state.input, mode: 'bpmn' as const } };
  assert.equal(processFor(media).input_text, 'Task extracted from a diagram');
});

test('individual matches do not become hard API selections for a conversion goal', () => {
  const state = emptyState();
  const step = { ...requirement('Create UBL Invoice'), input_format: 'PDF', output_format: 'UBL XML' };
  const generator = crypto.randomUUID();
  state.requirements = [step];
  state.matches[step.id] = { key: requirementKey(step), catalogue_key: 'catalogue', step: {
    ...step, order: 1, candidate_source: 'keywords', candidate_issue: null, candidate_total_matches: 1,
    candidate_apis: [{ id: generator, api_name: 'Generate UBL invoice from JSON', company_name: 'Example', score: 1, matched_terms: [] }],
  } };
  // Composition must still be able to discover the PDF extractor before the generator.
  assert.equal(processFor(state, true).steps[0].candidate_ids, null);
  step.candidate_ids = [generator];
  assert.deepEqual(processFor(state, true).steps[0].candidate_ids, [generator]);
  step.candidate_ids = [];
  assert.deepEqual(processFor(state, true).steps[0].candidate_ids, []);
  step.candidate_ids = null;
  step.input_format = '';
  assert.deepEqual(processFor(state, true).steps[0].candidate_ids, [generator]);
});
test('retired draft endpoints cannot restore or persist inputs, files or model results', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Draft retirement must not contact storage'); });
  const load = routeHarness({});
  for (const [file, methods] of [
    ['app/api/drafts/route.ts', ['GET', 'POST']], ['app/api/drafts/[id]/route.ts', ['GET', 'PATCH']],
    ['app/api/drafts/[id]/file/route.ts', ['GET', 'PUT']], ['app/api/drafts/[id]/run/route.ts', ['POST']],
  ] as const) {
    const route = load(file);
    for (const method of methods) {
      const response = await route[method](new Request('https://app.test/api/drafts', { method }));
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match((await response.json()).error, /temporary session/);
    }
  }
});
