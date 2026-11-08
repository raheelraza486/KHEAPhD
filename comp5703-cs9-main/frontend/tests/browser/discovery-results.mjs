// Isolated browser regression. Real matching/model boundaries have separate route tests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { roleCookie } from './role-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.UI_TEST_URL || 'http://127.0.0.1:3013';
const screenshots = process.env.UI_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const ids = ['974405cd-82b2-4e76-a628-278a56ac4e9a', '17455a7a-f107-4180-a907-0f8879bcd746', '10feb4e1-16d8-4f67-8463-99d44565580d', '08885479-e750-4a42-99d6-b4d32ad62983'];
const descriptions = [
  ['Transformation', 'Extract invoice data', 'PDF', 'JSON', 'Upbrains Extract Invoice From PDF', 'Upbrains'],
  ['Transformation', 'Convert the invoice', 'JSON', 'XML', 'AmitTransform Convert to UBL XML', 'AmitTransform'],
  ['Validation', 'Check invoice rules', 'XML', 'XML', 'ESS SmartDocFlow Validate Invoice', 'EB Software Services (ESS)'],
  ['Communication', 'Send the invoice', 'XML', 'JSON', 'Mailgun Send Message API', 'Mailgun'],
];
const steps = descriptions.map(([category, task, input_format, output_format, api_name, company_name], index) => ({
  order: index + 1, category, task, input_format, output_format, rule_set: null, candidate_ids: [ids[index]], candidate_source: 'formats', candidate_issue: null, candidate_total_matches: index ? 1 : 30,
  candidate_apis: index ? [{ id: ids[index], api_name, company_name, score: 1, matched_terms: [] }] : Array.from({ length: 30 }, (_, option) => ({ id: option ? `extraction-option-${option}` : ids[0], api_name: option ? `Invoice extraction option ${option + 1}` : api_name, company_name, score: 1, matched_terms: [] })),
}));
const processJson = { version: '1.0', input_text: 'Convert a PDF invoice to XML, validate it and send it by email.', unmatched: [], steps: steps.map(({ order, category, task, input_format, output_format, rule_set }) => ({ order, category, task, input_format, output_format, rule_set, candidate_ids: null })) };
const chains = Array.from({ length: 30 }, (_, index) => ({ api_ids: [index ? `extraction-option-${index}` : ids[0], ...ids.slice(1)], links: [], status: index < 2 ? 'feasible' : 'needs_decision' }));
const result = { version: '1.1', requestId: 'browser-fixture', input_text: processJson.input_text, unmatched: [], steps, check_scope: { technical: true, invoice_standard_jurisdiction: false, directional_standard_version: false }, technical_checks: [], standard_checks: [], composition: { plan: [], issues: [], candidates: {}, chains, counts: { feasible: 2, needs_decision: 28 }, truncated: false } };
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies([roleCookie('publisher', base)]);
  const page = await context.newPage();
  const errors = [], generated = [], matches = [], models = [];
  let evaluations = 0, draftRequests = 0, failModel = false, holdModel = false, releaseModel;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/notifications**', route => route.fulfill({ json: { notifications: [], unread_count: 0 } }));
  await context.route('**/api/drafts**', route => { draftRequests++; return route.fulfill({ status: 410, json: { error: 'Draft routes must not be used.' } }); });
  await context.route('**/api/discovery', async route => {
    let mode, inputText;
    if (route.request().headers()['content-type'].includes('application/json')) { const input = route.request().postDataJSON(); mode = input.mode; inputText = input.text; }
    else { const form = await new Request(route.request().url(), { method: 'POST', headers: { 'Content-Type': route.request().headers()['content-type'] }, body: route.request().postDataBuffer() }).formData(); mode = form.get('mode'); assert.ok(form.get('file').size > 0); inputText = 'Task extracted from media'; }
    models.push({ mode, text: inputText });
    if (holdModel) { holdModel = false; await new Promise(resolve => { releaseModel = resolve; }); }
    if (failModel) { failModel = false; return route.fulfill({ status: 503, json: { error: 'Test provider error. Retry is safe.' } }); }
    await route.fulfill({ json: { process: { ...processJson, input_text: inputText }, source: { mode } } }).catch(() => {});
  });
  await context.route('**/api/composition?mode=match', route => {
    const input = route.request().postDataJSON(); matches.push(input);
    return route.fulfill({ json: { catalogue_key: 'fixture-catalogue', steps: input.steps.map((step, index) => ({ ...steps[processJson.steps.findIndex(item => item.task === step.task)] || steps[index], ...step, candidate_ids: steps[index].candidate_ids })) } });
  });
  await context.route('**/api/composition', route => { evaluations++; return route.fulfill({ json: result }); });
  await context.route('**/api/composition/workflow', route => { generated.push(route.request().postDataJSON()); return route.fulfill({ status: 422, json: { error: 'Test download response; no workflow deployed.' } }); });
  const task = page.getByRole('textbox', { name: 'Describe the task, from start to finish', exact: false });
  const progress = page.locator('.discovery-progress');
  async function start(kind = 'workflow', text = processJson.input_text) {
    await page.goto(`${base}/${kind === 'workflow' ? 'workflows/create' : 'discovery'}`, { timeout: 60000 });
    await task.waitFor();
    assert.equal(await task.inputValue(), '', 'normal entry is always empty');
    await task.fill(text);
    await page.getByRole('button', { name: 'Review my requirements', exact: true }).click();
    await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
  }
  async function showResults() {
    await start();
    await page.locator('.discovery-form-actions').getByRole('button', { name: 'Explore API chains', exact: true }).click();
    await page.getByRole('heading', { name: 'Choose a complete API chain', exact: true }).waitFor();
  }
  // Old draft IDs and final-step URLs cannot restore server-side work.
  await page.goto(`${base}/discovery?draft=11111111-1111-4111-8111-111111111111&step=3`);
  await page.waitForURL('**/discovery?step=1'); await task.waitFor(); assert.equal(await task.inputValue(), '');
  await page.goto(`${base}/workflows/create`); await task.waitFor(); await task.fill('Manually reviewed invoice steps');
  await page.getByRole('button', { name: 'Enter steps manually', exact: true }).click();
  await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add step', exact: true }).click();
  await page.getByRole('textbox', { name: 'What should this API do?', exact: true }).fill('Convert invoice JSON to XML');
  assert.ok(await page.locator('.discovery-form-actions').getByRole('button', { name: 'Explore API chains', exact: true }).isEnabled());
  assert.equal(models.length, 0, 'manual workflow review remains available without a model call');
  await showResults();
  const list = page.getByRole('group', { name: 'Available API chains', exact: true });
  const generate = page.getByRole('button', { name: 'Generate workflow', exact: true });
  const run = page.getByRole('button', { name: 'Check run availability', exact: true });
  assert.ok(await generate.isDisabled());
  await page.getByRole('radio').first().check();
  const preview = page.locator('.discovery-selected-apis');
  assert.equal(await preview.getAttribute('open'), null);
  await preview.locator('summary').click();
  assert.equal(await preview.getByRole('link').count(), 4);
  assert.equal(await preview.getByRole('link').first().getAttribute('href'), `/apis?api=${ids[0]}`);
  const popupPromise = page.waitForEvent('popup'); await preview.getByRole('link').first().click(); const popup = await popupPromise;
  await popup.waitForURL(`**/apis?api=${ids[0]}`); await popup.close();
  assert.equal(await preview.count(), 1, `opening an API tab must retain the original flow: ${page.url()} ${await page.locator('main').innerText()}`);
  await preview.locator('summary').click();
  for (const selector of ['.discovery-chain-browser', '.discovery-chain-sidebar']) assert.equal(await page.locator(selector).evaluate(element => parseFloat(getComputedStyle(element).borderTopWidth) > 0), true);
  for (const width of [1920, 1440, 1100, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await list.evaluate(element => { element.scrollTop = 0; element.scrollIntoView({ block: 'start' }); });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `fits ${width}px`);
    assert.ok(await list.evaluate(element => element.scrollHeight > element.clientHeight * 3));
    const before = await generate.boundingBox(), windowBefore = await page.evaluate(() => scrollY), bounds = await list.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, Math.max(120, bounds.y + Math.min(150, bounds.height / 2)));
    await page.mouse.wheel(0, 500); await page.waitForFunction(() => document.querySelector('.discovery-chain-list').scrollTop > 100);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - windowBefore) < 2);
    assert.ok(Math.abs((await generate.boundingBox()).y - before.y) < 2, 'actions stay outside scrolling list');
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('radio').first().focus();
  for (let i = 1; i < 30; i++) await page.keyboard.press('ArrowDown');
  assert.ok(await page.getByRole('radio').last().isChecked()); assert.ok(await run.isDisabled());
  await generate.click(); await page.getByRole('alert').filter({ hasText: 'Test download response' }).waitFor();
  assert.deepEqual(generated[0].api_ids, chains[29].api_ids);
  await page.getByRole('radio').first().check();
  // Backward/Forward navigation keeps this flow, with no repeated model/evaluation calls.
  const beforeModel = models.length, beforeEval = evaluations;
  await page.getByRole('button', { name: 'Edit workflow', exact: true }).click();
  await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
  await page.goBack(); await page.getByRole('heading', { name: 'Choose a complete API chain', exact: true }).waitFor();
  assert.ok(await page.getByRole('radio').first().isChecked());
  await page.goForward(); await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  assert.equal(await task.inputValue(), processJson.input_text);
  await page.getByRole('button', { name: 'Review my requirements', exact: true }).click();
  await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
  await page.locator('.discovery-form-actions').getByRole('button', { name: 'Explore API chains', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose a complete API chain', exact: true }).waitFor();
  assert.equal(models.length, beforeModel); assert.equal(evaluations, beforeEval);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'memory-workflow-results.png'), fullPage: true });
  // Execution handoff stays functional without putting the input/chain in sessionStorage.
  await run.click(); await page.waitForURL('**/compose/run');
  await page.getByRole('heading', { name: 'Review the selected API chain', exact: true }).waitFor();
  assert.equal(await page.locator('main').getByRole('link', { name: 'Continue to execution', exact: true }).getAttribute('href'), '/compose/pdf-invoice');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('bp-builder:selected-chain:v1')), null);
  await page.reload(); await page.getByRole('heading', { name: 'No selected chain', exact: true }).waitFor();
  await showResults(); await page.reload(); await page.waitForURL('**/workflows/create?step=1'); await task.waitFor(); assert.equal(await task.inputValue(), '');
  // Partial matching and independent results, then one-time Discovery -> Workflow transfer.
  await start('discovery'); await page.locator('.discovery-form-actions').getByRole('button', { name: 'Discover APIs', exact: true }).click();
  await page.getByRole('heading', { name: 'APIs for your requirements', exact: true }).waitFor(); assert.equal(await page.locator('.requirement-match-group').count(), 4);
  await page.getByRole('button', { name: 'Edit requirements', exact: true }).click();
  await page.getByRole('textbox', { name: 'What should this API do?', exact: true }).first().fill('Revised invoice extraction');
  await page.locator('.discovery-form-actions').getByRole('button', { name: 'Discover APIs', exact: true }).click();
  await page.getByRole('heading', { name: 'APIs for your requirements', exact: true }).waitFor(); assert.equal(matches.at(-1).steps.length, 1);
  await page.locator('main').getByRole('button', { name: 'Build a workflow', exact: true }).click();
  await page.waitForURL('**/workflows/create?step=2'); await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'What should this API do?', exact: true }).first().inputValue(), 'Revised invoice extraction');
  await page.goBack(); await page.waitForURL('**/discovery?step=1'); await task.waitFor(); assert.equal(await task.inputValue(), '');
  // Files never upload to storage; original bytes remain available only until refresh.
  for (const kind of ['discovery', 'workflow']) for (const [name, mode, mimeType, filename] of [['Upload a diagram', 'bpmn', 'image/png', 'flow.png'], ['Upload a recording', 'audio', 'audio/wav', 'task.wav']]) {
    await page.goto(`${base}/${kind === 'workflow' ? 'workflows/create' : 'discovery'}`); await task.waitFor(); await task.fill('Keep my text tab');
    await page.getByRole('button', { name: new RegExp(name) }).click(); const count = models.length;
    await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType, buffer: Buffer.from('fixture media bytes') });
    await page.getByText(filename, { exact: true }).waitFor(); assert.equal(models.length, count);
    const zone = page.locator('.discovery-file-field');
    const transfer = await page.evaluateHandle(({ filename, mimeType }) => {
      const data = new DataTransfer(); data.items.add(new File(['dropped media bytes'], filename, { type: mimeType })); return data;
    }, { filename, mimeType });
    await zone.dispatchEvent('dragenter', { dataTransfer: transfer });
    assert.match(await zone.getAttribute('class'), /is-dragging/);
    // Entering and leaving a child must keep the drop highlight visible.
    await zone.locator('strong').dispatchEvent('dragenter', { dataTransfer: transfer });
    await zone.locator('strong').dispatchEvent('dragleave', { dataTransfer: transfer });
    assert.match(await zone.getAttribute('class'), /is-dragging/);
    assert.equal(await zone.evaluate((element, dataTransfer) => !element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })), transfer), true);
    await zone.locator('strong').dispatchEvent('drop', { dataTransfer: transfer });
    assert.doesNotMatch(await zone.getAttribute('class'), /is-dragging/);
    await transfer.dispose();
    const download = page.getByRole('link', { name: 'Download file', exact: true });
    const droppedUrl = await download.getAttribute('href');
    assert.equal(await page.evaluate(async url => (await fetch(url)).text(), droppedUrl), 'dropped media bytes');
    // Drop events bypass the native picker filter, so reject unsupported files.
    for (const [type, size, message] of [['text/plain', 20, /Choose a/], [mimeType, (mode === 'bpmn' ? 5 : 10) * 1024 * 1024 + 1, /non-empty file/]]) {
      const rejected = await page.evaluateHandle(({ type, size }) => {
        const data = new DataTransfer(); data.items.add(new File([new Uint8Array(size)], 'invalid.txt', { type })); return data;
      }, { type, size });
      await zone.dispatchEvent('drop', { dataTransfer: rejected }); await rejected.dispose();
      await page.getByRole('alert').filter({ hasText: message }).waitFor();
      assert.equal(await download.getAttribute('href'), droppedUrl, 'invalid drop retains the current file');
    }
    const multiple = await page.evaluateHandle(() => {
      const data = new DataTransfer(); for (const name of ['first.png', 'second.png']) data.items.add(new File(['image'], name, { type: 'image/png' })); return data;
    });
    await zone.dispatchEvent('drop', { dataTransfer: multiple }); await multiple.dispose();
    await page.getByRole('alert').filter({ hasText: 'Choose one file at a time.' }).waitFor();
    assert.equal(await download.getAttribute('href'), droppedUrl);
    // Browsing still works after failed drops and clears the local error.
    await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType, buffer: Buffer.from('fixture media bytes') });
    await page.locator('main').getByRole('alert').waitFor({ state: 'hidden' });
    if (kind === 'workflow' && mode === 'bpmn') {
      const longName = `diagram-${'long_filename_'.repeat(18)}.png`;
      await page.locator('input[type=file]').setInputFiles({ name: longName, mimeType, buffer: Buffer.from('long filename fixture') });
      await page.getByText(longName, { exact: true }).waitFor();
      for (const width of [375, 1100]) {
        await page.setViewportSize({ width, height: 1100 });
        assert.ok(await zone.locator('strong').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'long filenames wrap inside the drop zone');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'upload layout fits the viewport');
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `diagram-upload-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType, buffer: Buffer.from('fixture media bytes') });
      await page.getByText(filename, { exact: true }).waitFor();
    }
    assert.match(await page.getByRole('link', { name: 'Download file', exact: true }).getAttribute('href'), /^blob:/);
    await page.getByRole('button', { name: 'Review my requirements', exact: true }).click(); await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
    assert.equal(models.at(-1).mode, mode);
    await page.locator('.discovery-form-actions').getByRole('button', { name: kind === 'workflow' ? 'Explore API chains' : 'Discover APIs', exact: true }).click();
    await page.getByRole('heading', { name: kind === 'workflow' ? 'Choose a complete API chain' : 'APIs for your requirements', exact: true }).waitFor();
    await progress.getByRole('button', { name: 'Describe your task', exact: true }).click(); await page.getByText(filename, { exact: true }).waitFor();
    const oldUrl = await page.getByRole('link', { name: 'Download file', exact: true }).getAttribute('href');
    await page.getByRole('button', { name: 'Remove file', exact: true }).click();
    assert.equal(await page.getByText(filename, { exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Download file', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Remove file', exact: true }).count(), 0);
    assert.ok(await page.getByRole('button', { name: 'Review my requirements', exact: true }).isDisabled());
    assert.ok(await progress.getByRole('button', { name: 'Check requirements', exact: true }).isDisabled());
    assert.ok(await progress.getByRole('button', { name: kind === 'workflow' ? 'Explore API chains' : 'Discover APIs', exact: true }).isDisabled());
    assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, oldUrl), true, 'removed file object URL is revoked');
    await page.getByRole('button', { name: /Write it down/ }).click(); assert.equal(await task.inputValue(), 'Keep my text tab');
    await page.getByRole('button', { name: new RegExp(name) }).click(); assert.equal(await page.getByText(filename, { exact: true }).count(), 0);
    // The same file can be selected again; a soft exit and browser Back clear it.
    await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType, buffer: Buffer.from('fixture media bytes') });
    await page.getByText(filename, { exact: true }).waitFor();
    await page.locator('.sidebar-navigation').getByRole('link', { name: 'How it works', exact: true }).click(); await page.waitForURL('**/about');
    await page.goBack(); await task.waitFor(); assert.equal(await task.inputValue(), '');
    await page.getByRole('button', { name: new RegExp(name) }).click(); assert.equal(await page.getByText(filename, { exact: true }).count(), 0);
    await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType, buffer: Buffer.from('fixture media bytes') });
    await page.getByText(filename, { exact: true }).waitFor();
    await page.reload(); await task.waitFor(); assert.equal(await task.inputValue(), '');
    await page.getByRole('button', { name: new RegExp(name) }).click(); assert.equal(await page.getByText(filename, { exact: true }).count(), 0);
  }
  // Fail/retry and cancellation keep inputs in the current page only.
  await page.goto(`${base}/discovery`); await task.waitFor(); await task.fill('Retry my task'); failModel = true;
  await page.getByRole('button', { name: 'Review my requirements', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Test provider error' }).waitFor(); assert.equal(await task.inputValue(), 'Retry my task');
  await page.getByRole('button', { name: 'Try again', exact: true }).click(); await page.getByRole('heading', { name: 'Check your requirements', exact: true }).waitFor();
  // A soft route exit clears inputs even if Next restores the prior page on Back.
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await page.locator('.sidebar-navigation').getByRole('link', { name: 'How it works', exact: true }).click(); await page.waitForURL('**/about');
  await page.goBack(); await task.waitFor(); assert.equal(await task.inputValue(), '');
  // A late response cannot revive work after leaving the feature.
  await task.fill('Wait for a model response'); holdModel = true;
  await page.getByRole('button', { name: 'Review my requirements', exact: true }).click();
  await page.getByRole('button', { name: 'Finding requirements…', exact: true }).waitFor();
  await page.locator('.sidebar-navigation').getByRole('link', { name: 'How it works', exact: true }).click(); await page.waitForURL('**/about'); releaseModel();
  await page.goBack(); await task.waitFor(); assert.equal(await task.inputValue(), '');
  // Start again clears this session after confirmation, and old step URLs stay empty.
  await showResults(); page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Start again', exact: true }).click(); assert.ok(await list.isVisible());
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Start again', exact: true }).click(); await task.waitFor(); assert.equal(await task.inputValue(), '');
  await page.goBack(); await page.waitForURL('**/workflows/create?step=1'); assert.equal(await task.inputValue(), '');
  await task.fill('A tab-only input'); const newPage = await context.newPage(); await newPage.goto(`${base}/workflows/create?step=3`); await newPage.waitForURL('**/workflows/create?step=1');
  assert.equal(await newPage.getByRole('textbox', { name: 'Describe the task, from start to finish', exact: false }).inputValue(), ''); await newPage.close();
  await page.close(); const reopened = await context.newPage(); await reopened.goto(`${base}/workflows/create`); await reopened.getByRole('textbox', { name: 'Describe the task, from start to finish', exact: false }).waitFor(); assert.equal(await reopened.getByRole('textbox', { name: 'Describe the task, from start to finish', exact: false }).inputValue(), '');
  assert.equal(await reopened.evaluate(() => Object.keys(localStorage).filter(key => /draft|workspace|discovery|chain/i.test(key)).length + Object.keys(sessionStorage).filter(key => /draft|workspace|discovery|chain/i.test(key)).length), 0);
  assert.equal(draftRequests, 0, 'no persisted-draft endpoint was contacted'); assert.deepEqual(errors, []);
  console.log('PASS memory-only Discovery/Workflow: Back/Forward retention, refresh/exit/reopen/tab isolation, local file retention, no draft/storage calls, incremental matching, model retry, stale-response rejection, execution handoff, 30-chain scrolling and six responsive widths');
} finally { await browser.close(); }
