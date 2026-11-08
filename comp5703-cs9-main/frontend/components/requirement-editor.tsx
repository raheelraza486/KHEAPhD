"use client";
import type { Requirement, MatchEntry } from '@/lib/workspace/types';

/** Shared by Discovery review and Workflow creation, with stable IDs on reorder. */
export default function RequirementEditor({ requirements, matches, onChange, disabled = false, workflow = false, review = {} }: {
  requirements: Requirement[]; matches: Record<string, MatchEntry>; onChange: (steps: Requirement[]) => void; disabled?: boolean; workflow?: boolean; review?: Record<string, string[]>;
}) {
  function change(index: number, changes: Partial<Requirement>) {
    onChange(requirements.map((step, i) => i === index ? { ...step, ...changes } : step));
  }
  function move(index: number, direction: number) {
    const next = [...requirements];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next);
  }
  return <div className="requirement-editor">
    {!requirements.length && <p>No requirements yet. Add one below, or edit your task and try again.</p>}
    {requirements.map((step, index) => <fieldset key={step.id} className="requirement-edit-card" disabled={disabled}>
      <legend>{workflow ? 'Step' : 'Requirement'} {index + 1}</legend>
      {review[step.id]?.map((message, i) => <p key={i} className="discovery-inline-warning">{message}</p>)}
      <div className="draft-actions requirement-order">
        <button type="button" className="button secondary" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${index + 1} up`}>↑</button>
        <button type="button" className="button secondary" onClick={() => move(index, 1)} disabled={index === requirements.length - 1} aria-label={`Move ${index + 1} down`}>↓</button>
        <button type="button" className="button secondary" onClick={() => onChange(requirements.filter(item => item.id !== step.id))}>Remove</button>
      </div>
      <div className="requirement-fields">
        <label>What should this API do?<input value={step.task} maxLength={300} onChange={e => change(index, { task: e.target.value, candidate_ids: null })} /></label>
        <label>Category<select value={step.category} onChange={e => change(index, { category: e.target.value as Requirement['category'], candidate_ids: null })}>
          <option>Transformation</option><option>Validation</option><option>Communication</option>
        </select></label>
        {(['input_format', 'output_format', 'rule_set'] as const).map(field => <label key={field}>
          {field === 'input_format' ? 'Input format' : field === 'output_format' ? 'Output format' : 'Rules or standards'}
          <input value={step[field] ?? ''} placeholder="Not specified (optional)" maxLength={100} onChange={e => change(index, { [field]: e.target.value || null, candidate_ids: null })} />
        </label>)}
      </div>
      {workflow && matches[step.id]?.step.candidate_apis.length > 0 && <label className="requirement-candidates">Candidate APIs
        <select value={step.candidate_ids?.length === 1 ? step.candidate_ids[0] : ''} onChange={e => change(index, { candidate_ids: e.target.value ? [e.target.value] : null })}>
          <option value="">Consider all matching APIs</option>
          {matches[step.id].step.candidate_apis.map(api => <option key={api.id} value={api.id}>{api.api_name} — {api.company_name}</option>)}
        </select>
      </label>}
      {workflow && !!matches[step.id]?.rule_review?.length && <details className="discovery-unmatched"><summary>Rule support needs review</summary>
        <p>These APIs are excluded from selection and chains because the requested Australian rule support is not established.</p>
        <ul>{matches[step.id].rule_review!.map(api => <li key={api.id}><a href={`/apis?api=${encodeURIComponent(api.id)}`}>{api.api_name}</a> — {api.status === 'rejected' ? 'conflicting support evidence' : 'support not established'}</li>)}</ul>
      </details>}
    </fieldset>)}
    <button type="button" className="button secondary" disabled={disabled || requirements.length >= 32} onClick={() => onChange([...requirements, { id: crypto.randomUUID(), category: 'Transformation', task: '', input_format: null, output_format: null, rule_set: null, candidate_ids: null }])}>Add {workflow ? 'step' : 'requirement'}</button>
  </div>;
}
