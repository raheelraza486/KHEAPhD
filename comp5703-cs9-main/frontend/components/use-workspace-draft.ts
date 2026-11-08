"use client";
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useWorkspaceMemory } from '@/components/workspace-memory-provider';
import { applyEdits, editsFor, evaluationKey, hasCurrentMatches, inputKey, needsDecomposition, processFor, requirementKey } from '@/lib/workspace/state';
import type { DraftEdits, DraftKind, MatchEntry } from '@/lib/workspace/types';
import type { DiscoveryProcessJson } from '@/lib/discovery/types';
import type { CompositionStepView } from '@/lib/composition/api-contract';

export function workspaceUrl(kind: DraftKind, step = 1) {
  return `${kind === 'discovery' ? '/discovery' : '/workflows/create'}?step=${step}`;
}
async function requestJson(url: string, init: RequestInit, signal: AbortSignal) {
  const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(100_000)]), cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The request failed. Please retry.');
  return body;
}

/** Inputs, original File objects and results exist only in the active page flow. */
export default function useWorkspaceDraft(kind: DraftKind) {
  const memory = useWorkspaceMemory();
  const draft = memory.workspace?.kind === kind ? memory.workspace : null;
  const router = useRouter();
  const query = useSearchParams();
  const requested = Number(query.get('step'));
  const step = draft && [1, 2, 3].includes(requested) && requested <= draft.reached ? requested : 1;
  const [error, setError] = useState('');
  const [running, setRunning] = useState<'decompose' | 'match' | 'evaluate' | null>(null);
  const operation = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const lastRun = useRef<{ action: 'decompose' | 'match' | 'evaluate'; nextStep: number; force: boolean } | null>(null);
  const active = useRef(draft); active.current = draft;
  const busy = running !== null;
  const file = draft && draft.state.input.mode !== 'text' ? draft.files[draft.state.input.mode] : undefined;
  const [fileUrl, setFileUrl] = useState<string>();
  useEffect(() => {
    if (!file) { setFileUrl(undefined); return; }
    const url = URL.createObjectURL(file); setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    setError(''); setRunning(null); lastRun.current = null;
    return () => { sequence.current++; operation.current?.abort(); };
  }, [draft?.id]);
  useEffect(() => {
    if (draft && (query.get('step') !== String(step) || query.has('draft') || query.has('view'))) router.replace(workspaceUrl(kind, step), { scroll: false });
  }, [draft?.id, kind, step, query, router]);

  function edit(changes: Partial<DraftEdits>) {
    if (!draft || busy) return;
    memory.update(draft.id, value => ({ ...value, ...applyEdits(value, { ...editsFor(value), ...changes }), revision: value.revision + 1 }));
    setError('');
  }
  function go(stage: number) {
    if (!draft || busy) return;
    memory.update(draft.id, value => ({ ...value, reached: Math.max(value.reached, stage) }));
    router.push(workspaceUrl(kind, stage), { scroll: true });
  }
  function create(source?: string, restart = false) {
    if (!draft || busy || (restart && !window.confirm('Start again with empty inputs?'))) return;
    if (source) { memory.buildWorkflow(draft); return; }
    memory.reset(kind); router.push(workspaceUrl(kind), { scroll: true });
  }
  function reviewManually() {
    if (!draft || busy || kind !== 'workflow') return;
    memory.update(draft.id, value => ({ ...value, reached: Math.max(2, value.reached), revision: value.revision + 1,
      state: { ...value.state, decomposed_key: inputKey(value.state.input), matches: {}, evaluation: null, selected_chain: null } }));
    router.push(workspaceUrl(kind, 2), { scroll: true });
  }
  function upload(chosen: File) {
    if (!draft || busy || draft.state.input.mode === 'text') return;
    const mode = draft.state.input.mode;
    const supported = mode === 'bpmn'
      ? /\.(bpmn|xml)$/i.test(chosen.name) || /^image\/(png|jpeg|webp)$/i.test(chosen.type)
      : /^audio\/(aac|x-aac|flac|x-flac|mp3|mp4|mpeg|ogg|wav|x-wav|webm|x-m4a)$/i.test(chosen.type);
    if (!supported) {
      setError(mode === 'bpmn' ? 'Choose a PNG, JPEG or WebP image, or a .bpmn/.xml file.' : 'Choose an AAC, FLAC, MP3, M4A, OGG, WAV or WebM recording.');
      return;
    }
    const maximum = mode === 'audio' ? 10 : /\.(bpmn|xml)$/i.test(chosen.name) ? 1 : 5;
    if (!chosen.size || chosen.size > maximum * 1024 * 1024) { setError(`Choose a non-empty file up to ${maximum} MB.`); return; }
    const metadata = { name: chosen.name, type: chosen.type, size: chosen.size, path: crypto.randomUUID() };
    memory.update(draft.id, value => ({ ...value, revision: value.revision + 1, files: { ...value.files, [mode]: chosen }, state: {
      ...value.state, input: { ...value.state.input, files: { ...value.state.input.files, [mode]: metadata } },
      decomposed_key: '', matches: {}, evaluation: null, selected_chain: null,
    } }));
    setError('');
  }
  function removeFile() {
    if (!draft || busy || draft.state.input.mode === 'text') return;
    const mode = draft.state.input.mode;
    memory.update(draft.id, value => {
      const files = { ...value.files }, metadata = { ...value.state.input.files };
      delete files[mode]; delete metadata[mode];
      return { ...value, revision: value.revision + 1, reached: 1, files, state: {
        ...value.state, input: { ...value.state.input, files: metadata }, analysed_text: undefined,
        decomposed_key: '', requirements: [], unmatched: [], matches: {}, discovery_review: undefined, evaluation: null, selected_chain: null, link_cache: {},
      } };
    });
    lastRun.current = null;
    setError('');
  }
  async function run(action: 'decompose' | 'match' | 'evaluate', nextStep: number, force = false) {
    const snapshot = active.current;
    if (!snapshot) return;
    if (!force && ((action === 'decompose' && !needsDecomposition(snapshot) && snapshot.state.requirements.length > 0)
      || (action === 'match' && hasCurrentMatches(snapshot))
      || (action === 'evaluate' && !needsDecomposition(snapshot) && snapshot.state.evaluation?.key === evaluationKey(snapshot.state)))) { go(nextStep); return; }
    lastRun.current = { action, nextStep, force };
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    const token = ++sequence.current;
    setError(''); setRunning(action);
    try {
      if (action !== 'decompose' && needsDecomposition(snapshot)) throw new Error('Your task changed. Review its requirements before continuing.');
      let state = snapshot.state;
      if (action === 'decompose') {
        const input = state.input;
        let init: RequestInit;
        if (input.mode === 'text') init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'text', text: input.text }) };
        else {
          const original = snapshot.files[input.mode];
          if (!original) throw new Error('Choose a diagram or recording first.');
          const form = new FormData(); form.set('mode', input.mode); form.set('file', original);
          init = { method: 'POST', body: form };
        }
        const { process, review = [] } = await requestJson('/api/discovery', init, controller.signal) as { process: DiscoveryProcessJson; review?: { order?: number; message: string }[] };
        const requirements = process.steps.map(({ order: _order, ...requirement }) => ({ ...requirement, id: crypto.randomUUID() }));
        const discovery_review: Record<string, string[]> = {};
        for (const note of review) {
          const id = note.order ? requirements[note.order - 1]?.id : 'source';
          if (id) (discovery_review[id] ??= []).push(note.message);
        }
        state = { ...state, decomposed_key: inputKey(input), analysed_text: process.input_text, requirements, discovery_review,
          unmatched: process.unmatched, matches: {}, evaluation: null, selected_chain: null };
      } else if (action === 'match') {
        const affected = state.requirements.filter(requirement => force || state.matches[requirement.id]?.key !== requirementKey(requirement));
        const result = await requestJson('/api/composition?mode=match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(processFor({ ...state, requirements: affected })) }, controller.signal) as { steps: CompositionStepView[]; catalogue_key: string; rule_review?: MatchEntry['rule_review'][] };
        const matches: Record<string, MatchEntry> = { ...state.matches };
        affected.forEach((requirement, index) => { matches[requirement.id] = { key: requirementKey(requirement), catalogue_key: result.catalogue_key, step: { ...result.steps[index], order: state.requirements.findIndex(item => item.id === requirement.id) + 1 }, rule_review: result.rule_review?.[index] }; });
        state = { ...state, matches, evaluation: null, selected_chain: null };
      } else {
        const result = await requestJson('/api/composition', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(processFor(state, true)) }, controller.signal);
        state = { ...state, evaluation: { key: evaluationKey(state), result }, selected_chain: null };
      }
      if (token !== sequence.current || controller.signal.aborted || !memory.isCurrent(snapshot.id, snapshot.revision)) return;
      memory.update(snapshot.id, value => value.revision === snapshot.revision ? { ...value, state, revision: value.revision + 1, reached: Math.max(value.reached, nextStep) } : value);
      router.push(workspaceUrl(kind, nextStep), { scroll: true });
    } catch (caught) {
      if (token === sequence.current && active.current?.id === snapshot.id) setError(controller.signal.aborted ? 'Cancelled. Your inputs are still available on this page.' : caught instanceof Error ? caught.message : 'The operation failed. Please retry.');
    } finally { if (token === sequence.current) { setRunning(null); operation.current = null; } }
  }
  return { draft, step, busy, loading: !draft, error, running, fileUrl, edit, go, create, reviewManually, run, upload, removeFile,
    retryOperation: lastRun.current ? () => { const last = lastRun.current; if (last) void run(last.action, last.nextStep, last.force); } : null,
    cancel: () => operation.current?.abort(), clearError: () => setError(''), runChain: memory.runChain };
}
