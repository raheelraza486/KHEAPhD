"use client";
import { useEffect, useRef, useState, type DragEvent } from 'react';
import ProductIcon from '@/components/product-icon';
import RequirementEditor from '@/components/requirement-editor';
import { CompositionResults } from '@/components/composition-results';
import useWorkspaceDraft from '@/components/use-workspace-draft';
import { hasCurrentMatches, needsDecomposition, processFor, requirementKey } from '@/lib/workspace/state';
import { planProcess } from '@/lib/composition/compose';
import type { SelectedCompositionChain } from '@/lib/composition/selected-chain';
import type { Workspace, DraftKind } from '@/lib/workspace/types';
import type { DiscoveryMode } from '@/lib/discovery/types';

const modes = {
  text: ['Write it down', 'Describe the task in your own words.'],
  bpmn: ['Upload a diagram', 'A process image or BPMN/XML file.'],
  audio: ['Upload a recording', 'A recording of you explaining the task.'],
};
export function TaskInput({ draft, disabled, fileUrl, onMode, onText, onUpload, onRemove }: {
  draft: Pick<Workspace, 'id' | 'state'>; disabled: boolean; fileUrl?: string; onMode: (mode: DiscoveryMode) => void; onText: (text: string) => void; onUpload: (file: File) => void; onRemove: () => void;
}) {
  const { input } = draft.state;
  const file = input.mode === 'text' ? null : input.files[input.mode];
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState('');
  const dragDepth = useRef(0);
  useEffect(() => {
    dragDepth.current = 0;
    setDragging(false);
    setDropError('');
  }, [draft.id, input.mode, disabled]);
  function dropFile(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    const files = event.dataTransfer.files;
    if (files.length > 1) { setDropError('Choose one file at a time.'); return; }
    if (files[0]) { setDropError(''); onUpload(files[0]); }
  }
  return <>
    <div className="discovery-modes" aria-label="Task input type">
      {(Object.keys(modes) as DiscoveryMode[]).map(mode => <button type="button" key={mode} aria-pressed={input.mode === mode} disabled={disabled} onClick={() => onMode(mode)}>
        <ProductIcon name={mode === 'text' ? 'document' : mode === 'bpmn' ? 'diagram' : 'audio'} />
        <strong>{modes[mode][0]}</strong><span>{modes[mode][1]}</span>
      </button>)}
    </div>
    <div className="discovery-input-form">
      {input.mode === 'text' ? <label><span>Describe the task, from start to finish</span>
        <textarea value={input.text} maxLength={2000} rows={7} onChange={e => onText(e.target.value)} disabled={disabled}
          placeholder="For example: Convert a PDF invoice to XML, check it against Peppol rules, then send it to a customer." />
        <small><span>Add formats, rules or delivery details if you know them.</span><span>{input.text.length}/2000</span></small>
      </label> : <><label className={`discovery-file-field${dragging && !disabled ? ' is-dragging' : ''}`} aria-disabled={disabled}
        onDragEnter={event => {
          event.preventDefault();
          if (disabled || !event.dataTransfer.types.includes('Files')) return;
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={event => {
          event.preventDefault();
          event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
        }}
        onDragLeave={event => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={dropFile}><span>{modes[input.mode][0]}</span>
        <input key={`${draft.id}:${input.mode}:${file?.path ?? ''}`} type="file" disabled={disabled} accept={input.mode === 'bpmn' ? '.bpmn,.xml,image/png,image/jpeg,image/webp' : '.aac,.flac,.mp3,.m4a,.ogg,.wav,.webm,audio/*'}
          onChange={e => { const chosen = e.target.files?.[0]; if (chosen) { setDropError(''); onUpload(chosen); } e.target.value = ''; }} />
        {file && <strong>{file.name}</strong>}
        <span className="discovery-file-prompt">{dragging && !disabled ? 'Drop your file here' : <>Drag a file here or <span>browse files</span></>}</span>
        <small>{input.mode === 'bpmn' ? 'BPMN/XML up to 1 MB; images up to 5 MB.' : 'Recordings up to 10 MB.'}</small>
      </label>{dropError && <p className="discovery-error" role="alert">{dropError}</p>}{file && <div className="discovery-file-actions">
        {fileUrl && <a href={fileUrl} download={file.name}>Download file</a>}
        <button type="button" className="button secondary" disabled={disabled} onClick={onRemove}>Remove file</button>
      </div>}</>}
    </div>
  </>;
}
function related(draft: Workspace) {
  const steps = draft.state.requirements;
  if (steps.length < 2 || planProcess({ steps: steps.map((step, index) => ({ ...step, order: index + 1 })) }).issues.length) return false;
  return steps.some((step, index) => index > 0 && step.input_format && steps[index - 1].output_format?.trim().toLowerCase() === step.input_format.trim().toLowerCase());
}
export default function DraftWorkspace({ kind }: { kind: DraftKind }) {
  const workspace = useWorkspaceDraft(kind);
  const { draft, step, busy, loading } = workspace;
  const labels = ['Describe your task', 'Check requirements', kind === 'discovery' ? 'Discover APIs' : 'Explore API chains'];
  const ready = draft ? hasCurrentMatches(draft) : false;
  const result = draft?.state.evaluation?.result;
  const disabled = busy;
  function runSelectedChain(index: number) {
    if (!draft || !result) return;
    const chain = result.composition.chains[index];
    if (!chain || chain.status !== 'feasible') return;
    const process = processFor(draft.state);
    const selected: SelectedCompositionChain = {
      version: '1.0', process: { ...process, steps: process.steps.map(step => ({ ...step, input_format: step.input_format ?? null, output_format: step.output_format ?? null, rule_set: step.rule_set ?? null, candidate_ids: null })) },
      chain: { ...chain, status: 'feasible' }, apis: chain.api_ids.map((id, index) => {
        const step = result.steps[index];
        const api = step.candidate_apis.find(candidate => candidate.id === id)!;
        return { ...api, api_id: id, step_order: step.order, category: step.category, candidate_source: step.candidate_source, ...(step.system_added ? { system_added: step.system_added } : {}) };
      }),
    };
    workspace.runChain(selected);
  }
  return <main className="discovery-shell" id="main-content">
    <section className="discovery-hero" aria-labelledby="discovery-title">
      <p className="eyebrow">{kind === 'discovery' ? 'API Discovery' : 'Create a workflow'}</p>
      <h1 id="discovery-title">{kind === 'discovery' ? <>Describe your task.<br />Find the APIs to help.</> : <>Bring your APIs<br />into a workflow.</>}</h1>
      <p>{kind === 'discovery' ? 'Describe what you need, review the requirements, then find individual APIs for each one.' : 'Describe what you need, review the steps, then explore API chains with their connections checked.'}</p>
    </section>
    <ol className="discovery-progress" aria-label={`${kind === 'discovery' ? 'Discovery' : 'Workflow'} progress`}>
      {labels.map((label, index) => <li key={label} className={step === index + 1 ? 'is-current' : step > index + 1 ? 'is-complete' : ''}>
        <span>{index + 1}</span><button type="button" aria-current={step === index + 1 ? 'step' : undefined} disabled={!draft || disabled || (index === 1 && needsDecomposition(draft)) || (kind === 'discovery' && index === 2 && !ready) || (kind === 'workflow' && index === 2 && !result)} onClick={() => void workspace.go(index + 1)}>{label}</button>
      </li>)}
    </ol>
    {workspace.error && <div className="discovery-error" role="alert"><p>{workspace.error}</p>
      {workspace.retryOperation && <button type="button" className="button secondary" disabled={busy} onClick={workspace.retryOperation}>Try again</button>}
    </div>}
    {loading && <p role="status">Loading...</p>}
    {draft && !loading && <>
      {step === 1 && <section className="discovery-panel">
        <div className="discovery-panel-heading"><div><p className="eyebrow">Step 1</p><h2>What would you like to do?</h2><p>Write a short description, or share a diagram or recording you already have.</p></div></div>
        <TaskInput draft={draft} disabled={disabled} fileUrl={workspace.fileUrl} onMode={mode => workspace.edit({ input: { ...draft.state.input, mode } })} onText={text => workspace.edit({ input: { ...draft.state.input, text } })} onUpload={file => void workspace.upload(file)} onRemove={workspace.removeFile} />
        <div className="discovery-form-actions">
          {kind === 'workflow' && <button type="button" className="button secondary" disabled={disabled} onClick={workspace.reviewManually}>Enter steps manually</button>}
          <button type="button" className="button primary" disabled={disabled || (draft.state.input.mode === 'text' ? !draft.state.input.text.trim() : !draft.state.input.files[draft.state.input.mode])} onClick={() => void workspace.run('decompose', 2)}>{workspace.running === 'decompose' ? 'Finding requirements…' : 'Review my requirements'}</button>
        </div>
      </section>}
      {step === 2 && <section className="discovery-panel">
        <div className="discovery-panel-heading"><div><p className="eyebrow">Step 2</p><h2>Check your requirements</h2><p>Edit the details, add or remove items, and use the arrows to change their order.</p></div></div>
        {needsDecomposition(draft) && <p className="discovery-inline-warning">Your task changed. Return to Step 1 and review the requirements again before continuing.</p>}
        {draft.state.discovery_review?.source?.map((message, i) => <p key={i} className="discovery-inline-warning">{message}</p>)}
        <p>You do not need to fill every field. Leave unspecified formats blank; the workflow engine handles passing the invoice between steps.</p>
        <RequirementEditor requirements={draft.state.requirements} matches={draft.state.matches} review={draft.state.discovery_review} disabled={disabled} workflow={kind === 'workflow'} onChange={requirements => workspace.edit({ requirements })} />
        {draft.state.unmatched.length > 0 && <div className="discovery-unmatched"><strong>Not recognised — review these details</strong><ul>{draft.state.unmatched.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
        {kind === 'workflow' && <p className="discovery-next-note">The existing engine supports up to four steps in Transformation → Validation → Communication order. It may add a conversion step when necessary.</p>}
        <div className="discovery-form-actions">
          <button className="button secondary" disabled={disabled} type="button" onClick={() => void workspace.go(1)}>Edit task</button>
          {kind === 'workflow' && <button className="button secondary" disabled={disabled || needsDecomposition(draft) || !draft.state.requirements.length || draft.state.requirements.some(step => !step.task.trim())} type="button" onClick={() => void workspace.run('match', 2)}>{workspace.running === 'match' ? 'Finding APIs…' : 'Find candidate APIs'}</button>}
          <button className="button primary" type="button" disabled={disabled || needsDecomposition(draft) || !draft.state.requirements.length || draft.state.requirements.some(step => !step.task.trim())} onClick={() => void workspace.run(kind === 'discovery' ? 'match' : 'evaluate', 3)}>{workspace.running === 'match' ? 'Finding APIs…' : workspace.running === 'evaluate' ? 'Checking API connections…' : kind === 'discovery' ? 'Discover APIs' : 'Explore API chains'}</button>
        </div>
      </section>}
      {kind === 'discovery' && step === 3 && <section className="discovery-panel">
        <div className="discovery-panel-heading"><div><p className="eyebrow">Step 3</p><h2>APIs for your requirements</h2><p>These are individual matches. Their connections have not been checked.</p></div><div className="draft-actions"><button className="button secondary" type="button" disabled={disabled} onClick={() => void workspace.go(1)}>Edit task</button><button className="button secondary" type="button" disabled={disabled} onClick={() => void workspace.go(2)}>Edit requirements</button><button className="button secondary" type="button" disabled={disabled} onClick={() => void workspace.create(undefined, true)}>Start again</button></div></div>
        {!ready && <p>Your requirements have changed. Review them and discover APIs again to see current results.</p>}
        {draft.state.requirements.map((requirement, index) => {
          const match = draft.state.matches[requirement.id];
          if (!match || match.key !== requirementKey(requirement)) return null;
          return <section className="requirement-match-group" key={requirement.id}><p className="eyebrow">Requirement {index + 1} · {requirement.category}</p><h3>{requirement.task}</h3>
            <p>{match.step.candidate_total_matches} matching API{match.step.candidate_total_matches === 1 ? '' : 's'}{match.step.candidate_total_matches > match.step.candidate_apis.length ? ` · showing ${match.step.candidate_apis.length} best matches` : ''}</p>
            {match.step.candidate_apis.length ? <ul>{match.step.candidate_apis.map(api => <li key={api.id}><a href={`/apis?api=${encodeURIComponent(api.id)}`}><strong>{api.api_name}</strong><span>{api.company_name}</span><small>View API →</small></a></li>)}</ul>
              : <p className="discovery-inline-warning">{match.step.candidate_issue === 'insufficient_task_detail' ? 'Add formats, rules or a more specific description to help us find an API.' : 'No API in the current catalogue matches this requirement. Edit it or retry after the catalogue changes.'}</p>}
            {!!match.rule_review?.length && <aside><h4>Rule support needs review</h4><p>These APIs are excluded from matching chains. Their catalogue evidence does not establish the requested Australian rules.</p><ul>{match.rule_review.map(api => <li key={api.id}><a href={`/apis?api=${encodeURIComponent(api.id)}`}><strong>{api.api_name}</strong><small>{api.status === 'rejected' ? 'Conflicting support evidence' : 'Support not established'}</small></a></li>)}</ul></aside>}
          </section>;
        })}
        <div className="discovery-form-actions"><button type="button" className="button secondary" disabled={disabled} onClick={() => void workspace.run('match', 3, true)}>{workspace.running === 'match' ? 'Finding APIs…' : 'Refresh API matches'}</button></div>
        {ready && related(draft) && <aside className="draft-workflow-suggestion"><div><h3>Want to connect these APIs?</h3><p>Copy these requirements into a workflow and check which APIs work together. Leaving this page clears the current API search.</p></div><button type="button" className="button primary" disabled={disabled} onClick={() => void workspace.create(draft.id)}>Build a workflow</button></aside>}
      </section>}
      {kind === 'workflow' && step === 3 && (result ? <CompositionResults result={result} selectedChain={draft.state.selected_chain} onSelect={selected_chain => workspace.edit({ selected_chain })} onRun={runSelectedChain} onRestart={() => void workspace.create(undefined, true)} onEdit={() => void workspace.go(2)} /> : <section className="discovery-panel"><p>The workflow changed. Review the requirements and explore API chains again.</p><div className="draft-actions"><button type="button" className="button primary" onClick={() => void workspace.go(2)}>Edit workflow</button><button type="button" className="button secondary" onClick={() => void workspace.create(undefined, true)}>Start again</button></div></section>)}
    </>}
    {workspace.running && <div className="workspace-utility-links"><button type="button" className="workspace-text-button" onClick={workspace.cancel}>Cancel</button></div>}
  </main>;
}
