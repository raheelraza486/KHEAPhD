// Local browser fixture only. Deferred fetches deliberately ignore AbortSignal to test stale replies.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { roleCookie } from './role-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.UI_TEST_URL || 'http://127.0.0.1:3011';
const screenshots = process.env.UI_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  await context.addCookies([roleCookie('publisher', base)]);
  await context.route('**/api/notifications**', route => route.fulfill({ json: { notifications: [], unread_count: 0 } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch;
    window.pdfRuns = [];
    window.fetch = (input, init) => {
      if (input !== '/api/composed/pdf-invoice') return original(input, init);
      return new Promise((resolve, reject) => window.pdfRuns.push({ resolve, reject, signal: init.signal, form: init.body }));
    };
  });
  await page.goto(`${base}/compose/pdf-invoice`);
  const submit = page.locator('.composed-actions button[type=submit]');
  const cancel = page.getByRole('button', { name: 'Cancel workflow', exact: true });
  const picker = page.locator('.composed-pdf-upload input');
  const reference = page.getByRole('textbox', { name: 'Buyer reference', exact: true });
  await picker.setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic') });
  await reference.fill('SYNTHETIC-CANCEL-REF');
  assert.equal(await cancel.count(), 0);

  await submit.click();
  await page.waitForFunction(() => window.pdfRuns.length === 1);
  assert.ok(await cancel.isVisible());
  assert.ok(await picker.isDisabled());
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await cancel.isVisible());
    if (screenshots) await page.locator('.composed-actions').screenshot({ path: path.join(screenshots, `pdf-cancel-running-${width}.png`) });
  }
  await cancel.click();
  await page.getByRole('status').filter({ hasText: 'Workflow cancelled.' }).waitFor();
  assert.equal(await page.evaluate(() => window.pdfRuns[0].signal.aborted), true);
  assert.equal(await cancel.count(), 0);
  assert.ok(await submit.isEnabled());
  assert.ok(await picker.isEnabled());
  assert.equal(await reference.inputValue(), 'SYNTHETIC-CANCEL-REF');
  assert.equal(await page.locator('.composed-pdf-upload strong').innerText(), 'synthetic.pdf');

  await submit.click();
  await page.waitForFunction(() => window.pdfRuns.length === 2);
  await page.evaluate(() => window.pdfRuns[0].resolve(Response.json({ error: 'Stale first-run error' }, { status: 422 })));
  await page.waitForTimeout(100);
  assert.ok(await cancel.isVisible());
  assert.ok(await submit.isDisabled());
  assert.equal(await page.getByText('Stale first-run error', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('status').filter({ hasText: 'Workflow cancelled.' }).count(), 0);
  assert.equal(await page.evaluate(() => window.pdfRuns[1].signal.aborted), false);
  await page.evaluate(() => window.pdfRuns[1].resolve(Response.json({ error: 'Second-run fixture error' }, { status: 422 })));
  await page.getByText('Second-run fixture error', { exact: true }).waitFor();
  assert.equal(await cancel.count(), 0);
  assert.ok(await submit.isEnabled());

  await submit.click();
  await page.waitForFunction(() => window.pdfRuns.length === 3);
  await cancel.click();
  assert.equal(await page.evaluate(() => window.pdfRuns[2].signal.aborted), true);
  assert.deepEqual(errors, []);
  console.log('PASS PDF cancellation: Cancel visible on desktop/mobile, request aborted, file/form retained, immediate retry, stale reply ignored, normal failure retained, repeated cancellation; no provider calls.');
} finally {
  await browser.close();
}
