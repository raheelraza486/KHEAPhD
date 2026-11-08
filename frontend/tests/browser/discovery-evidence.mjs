// UI fixtures only. No model calls, catalogue writes, deployment or invoice delivery.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { roleCookie } from './role-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.UI_TEST_URL || 'http://127.0.0.1:3011';
const shots = process.env.UI_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const source = 'Convert PDF to UBL XML, validate using AU rules, then send via Peppol';
const processJson = { version: '1.0', input_text: source, unmatched: [], steps: [
  { order: 1, category: 'Transformation', task: 'Convert PDF to UBL XML', input_format: 'PDF', output_format: 'UBL XML', rule_set: null, candidate_ids: null },
  { order: 2, category: 'Validation', task: 'validate using AU rules', input_format: null, output_format: null, rule_set: 'AU rules', candidate_ids: null },
  { order: 3, category: 'Communication', task: 'send via Peppol', input_format: null, output_format: null, rule_set: null, candidate_ids: null },
] };
let replyProcess = processJson;
let replyReview = [{ message: 'Review the suggested order from your goals.' },
  { order: 2, message: 'The input format was left blank because it was not explicitly stated for this step.' }];
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const context = await browser.newContext();
  await context.addCookies([roleCookie('publisher', base)]);
  await context.route('**/api/notifications**', route => route.fulfill({ json: { notifications: [], unread_count: 0 } }));
  await context.route('**/api/discovery', route => route.fulfill({ json: { process: replyProcess, review: replyReview } }));
  await context.route('**/api/composition?mode=match', route => {
    const input = route.request().postDataJSON();
    return route.fulfill({ json: { catalogue_key: 'fixture', steps: input.steps.map((step, index) => ({ ...step,
      candidate_source: 'keywords', candidate_issue: null, candidate_total_matches: 1, candidate_ids: [ids[index]],
      candidate_apis: [{ id: ids[index], api_name: index === 1 ? 'Supported PINT A-NZ validator' : 'Supported workflow API', company_name: 'Fixture', score: 1, matched_terms: [] }],
    })), rule_review: [[], [{ id: '44444444-4444-4444-8444-444444444444', api_name: 'Generic EN 16931 validator', status: 'unverified' }], []] } });
  });
  let submitted;
  await context.route('**/api/composition', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 422, json: { error: 'Browser fixture stopped before chain execution.' } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(`${base}/discovery`);
    await page.getByRole('textbox', { name: 'Describe the task, from start to finish', exact: false }).fill(source);
    await page.getByRole('button', { name: 'Review my requirements', exact: true }).click();
    await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
    const cards = page.locator('.requirement-edit-card');
    assert.equal(await cards.nth(1).getByRole('textbox', { name: 'Input format', exact: true }).inputValue(), '');
    assert.equal(await cards.nth(1).getByRole('textbox', { name: 'Output format', exact: true }).inputValue(), '');
    await page.getByText('Review the suggested order from your goals.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Move 2 up', exact: true }).click();
    assert.ok(await cards.first().getByText('The input format was left blank because it was not explicitly stated for this step.', { exact: true }).isVisible());
    await page.getByRole('button', { name: 'Move 1 down', exact: true }).click();
    if (shots) await page.locator('.discovery-panel').screenshot({ path: path.join(shots, `discovery-evidence-review-${width}.png`) });
    await cards.nth(1).getByRole('textbox', { name: 'Input format', exact: true }).fill('UBL XML');
    assert.equal(await page.getByText('The input format was left blank because it was not explicitly stated for this step.', { exact: true }).count(), 0);
    await page.locator('.discovery-form-actions').getByRole('button', { name: 'Discover APIs', exact: true }).click();
    await page.getByRole('heading', { name: 'APIs for your requirements', exact: true }).waitFor();
    const validation = page.locator('.requirement-match-group').nth(1);
    assert.ok(await validation.getByRole('heading', { name: 'Rule support needs review', exact: true }).isVisible());
    assert.ok(await validation.locator('aside').getByText('Generic EN 16931 validator', { exact: true }).isVisible());
    assert.equal(await validation.locator(':scope > ul').getByText('Generic EN 16931 validator', { exact: true }).count(), 0);
    if (shots) await page.locator('.discovery-panel').screenshot({ path: path.join(shots, `discovery-evidence-matches-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('.draft-workflow-suggestion').getByRole('button', { name: 'Build a workflow', exact: true }).click();
    await page.waitForURL('**/workflows/create?step=2');
    assert.equal(await page.locator('.requirement-candidates select option').filter({ hasText: 'Generic EN 16931 validator' }).count(), 0);
    await page.getByText('Rule support needs review', { exact: true }).click();
    assert.ok(await page.getByText('Generic EN 16931 validator', { exact: true }).isVisible());
    await page.locator('.discovery-form-actions').getByRole('button', { name: 'Explore API chains', exact: true }).click();
    await page.getByText('Browser fixture stopped before chain execution.', { exact: true }).waitFor();
    assert.equal(submitted.steps[1].input_format, 'UBL XML');
    assert.ok(!JSON.stringify(submitted).includes('44444444-4444-4444-8444-444444444444'));
    assert.ok(!JSON.stringify(submitted).includes('suggested order'));
  }
  const goal = "Can you please list down some possible business processes for the ‘Send an Invoice’ scenario, where the input is in PDF format, validated for the Australian rules, and is sent in UBL XML format via Peppol network.";
  replyProcess = { ...processJson, input_text: goal, steps: processJson.steps.map((step, i) => ({ ...step,
    ...(i === 1 ? { task: 'validated for the Australian rules', rule_set: 'Australian rules' } : {}),
    ...(i === 2 ? { task: 'sent in UBL XML format via Peppol network', input_format: 'UBL XML' } : {}),
  })) };
  replyReview = [{ message: 'Review the suggested order from your goals.' }];
  await page.goto(`${base}/workflows/create`);
  await page.getByRole('textbox', { name: 'Describe the task, from start to finish', exact: false }).fill(goal);
  await page.getByRole('button', { name: 'Review my requirements', exact: true }).click();
  await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
  const goalCards = page.locator('.requirement-edit-card');
  assert.equal(await goalCards.nth(0).getByRole('textbox', { name: 'Input format', exact: true }).getAttribute('value'), 'PDF');
  assert.equal(await goalCards.nth(0).getByRole('textbox', { name: 'Output format', exact: true }).getAttribute('value'), 'UBL XML');
  assert.equal(await goalCards.nth(1).getByRole('textbox', { name: 'Rules or standards', exact: true }).getAttribute('value'), 'Australian rules');
  assert.ok(await goalCards.nth(1).getByPlaceholder('Not specified (optional)').first().isVisible());
  const explore = page.locator('.discovery-form-actions').getByRole('button', { name: 'Explore API chains', exact: true });
  assert.ok(await explore.isEnabled());
  if (shots) await page.locator('.discovery-panel').screenshot({ path: path.join(shots, 'discovery-goal-no-manual-fields.png') });
  await explore.click();
  await page.getByText('Browser fixture stopped before chain execution.', { exact: true }).waitFor();
  assert.equal(submitted.steps[0].output_format, 'UBL XML');
  assert.equal(submitted.steps[1].rule_set, 'Australian rules');
  assert.match(submitted.steps[2].task, /Peppol/);
  assert.deepEqual(errors, []);
  console.log('PASS evidence review on desktop/mobile, source-state lifecycle, separate rule review and Workflow handoff; reported invoice goal submits with no manual field edits and optional blanks; mocked services only.');
} finally { await browser.close(); }
