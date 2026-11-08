import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { componentHarness } from "../helpers/component-harness.ts";
import type { CompositionApiResponse } from "../../lib/composition/api-contract.ts";
import { emptyState, type Draft } from '../../lib/workspace/types.ts';

const load = componentHarness();
const TaskInput = load("components/draft-workspace.tsx").TaskInput as ComponentType<{ draft: Draft; disabled: boolean; fileUrl?: string; onMode: () => void; onText: () => void; onUpload: () => void; onRemove: () => void }>;
const CompositionResults = load("components/discovery-workspace.tsx").CompositionResults as ComponentType<{
  result: CompositionApiResponse;
  selectedChain: number | null;
  onSelect: (index: number) => void;
  onRestart: () => void;
}>;
const SiteHeader = load("components/site-header.tsx").default as ComponentType<{
  active: "discovery";
  user: null;
}>;

test("Discovery workspace exposes the three accepted input modes", () => {
  const draft = { id: 'input-draft', state: emptyState() } as Draft;
  const html = renderToStaticMarkup(createElement(TaskInput, { draft, disabled: false, onMode: () => {}, onText: () => {}, onUpload: () => {}, onRemove: () => {} }));
  assert.match(html, /Describe the task/);
  assert.match(html, /aria-pressed="true"[^>]*>.*Write it down/);
  assert.match(html, /Upload a diagram/);
  assert.match(html, /Upload a recording/);
  assert.match(html, /textarea/);
});

test("returning to media input shows the retained file without save-status copy", () => {
  const state = emptyState();
  state.input = { mode: 'bpmn', text: 'Keep my original description', files: { bpmn: { name: 'invoice-process.xml', path: 'private/file', type: 'application/xml', size: 120 } } };
  const html = renderToStaticMarkup(createElement(TaskInput, { draft: { id: 'input-draft', state } as Draft, disabled: false, fileUrl: 'blob:local-file', onMode: () => {}, onText: () => {}, onUpload: () => {}, onRemove: () => {} }));
  assert.match(html, /invoice-process.xml/);
  assert.match(html, /href="blob:local-file" download="invoice-process.xml"/);
  assert.match(html, /Remove file/);
  assert.doesNotMatch(html, /<label\b[^>]*>(?:(?!<\/label>)[\s\S])*<button/);
  assert.doesNotMatch(html, /\/api\/drafts/);
  assert.doesNotMatch(html, /Saved privately|Saving|Draft name/);
});

test('recording input also exposes removal and disables it during processing', () => {
  const state = emptyState();
  state.input = { mode: 'audio', text: '', files: { audio: { name: 'task.wav', path: 'local-audio', type: 'audio/wav', size: 120 } } };
  const html = renderToStaticMarkup(createElement(TaskInput, { draft: { id: 'input-draft', state } as Draft, disabled: true, onMode: () => {}, onText: () => {}, onUpload: () => {}, onRemove: () => {} }));
  assert.match(html, /task.wav/);
  assert.match(html, /<button[^>]+disabled=""[^>]*>Remove file<\/button>/);
});

test("home page exposes Publisher, Discovery and Composition entry points", () => {
  const source = readFileSync(new URL("../../components/home-repository-tools.tsx", import.meta.url), "utf8");
  assert.match(source, /API Publisher/);
  assert.match(source, /API Discovery/);
  assert.match(source, /API Composition/);
  assert.match(source, /login\?next=%2Fdiscovery/);
});

test("primary navigation includes a current Discovery destination", () => {
  const html = renderToStaticMarkup(createElement(SiteHeader, { active: "discovery", user: null }));
  assert.match(html, /href="\/discovery" aria-current="page"/);
});

test("composition results render added steps and select one whole chain", () => {
  const result = {
    version: "1.1",
    requestId: "request-1",
    input_text: "convert and send",
    unmatched: [],
    check_scope: { technical: true, invoice_standard_jurisdiction: false, directional_standard_version: false },
    technical_checks: [],
    standard_checks: [],
    steps: [
      {
        order: 1,
        category: "Transformation",
        task: "extract invoice",
        input_format: "PDF",
        output_format: "JSON",
        rule_set: null,
        candidate_ids: ["extract"],
        candidate_source: "formats",
        candidate_issue: null,
        candidate_total_matches: 1,
        candidate_apis: [{ id: "extract", api_name: "Invoice Extract", company_name: "Example", score: 1, matched_terms: [] }],
        system_added: { original_order: 1, reason: "A second Transformation was added." },
      },
    ],
    composition: {
      plan: [{ order: 1, category: "Transformation", role: "produces", input_from: null, output_used: false }],
      issues: [],
      candidates: { 1: 1 },
      chains: [{ api_ids: ["extract"], links: [], status: "feasible" }],
      counts: { feasible: 1, needs_decision: 0 },
      truncated: false,
    },
  } satisfies CompositionApiResponse;
  const html = renderToStaticMarkup(createElement(CompositionResults, {
    result,
    selectedChain: 0,
    onSelect: () => undefined,
    onRestart: () => undefined,
  }));
  assert.match(html, /Automatically added/);
  assert.match(html, /Invoice Extract/);
  assert.match(html, /Selected API chain/);
  assert.match(html, /Chain 1 · 1 APIs/);
  assert.match(html, /Select a chain/);
  assert.match(html, /Choose an action/);
  assert.match(html, /name="api_ids" value="extract"/);
  assert.match(html, /Save chain<\/button>/);
  assert.match(html, /<details class="discovery-selected-checks discovery-selected-apis">/);
  assert.match(html, /View selected APIs/);
  assert.match(html, /href="\/apis\?api=extract" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /For: extract invoice/);
  assert.ok(html.indexOf('Review compatibility evidence') < html.indexOf('View selected APIs'));
});
