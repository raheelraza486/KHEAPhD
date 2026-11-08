// Upload interaction regression; the processing endpoint is intercepted before any provider call.
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
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  let release, entered, hold = true;
  const requestEntered = new Promise(resolve => { entered = resolve; });
  await context.route('**/api/composed/pdf-invoice', async route => {
    const request = route.request();
    const form = await new Request(request.url(), {
      method: 'POST', headers: { 'Content-Type': request.headers()['content-type'] }, body: request.postDataBuffer(),
    }).formData();
    const file = form.get('file');
    requests.push({ name: file.name, type: file.type, text: await file.text() });
    if (hold) await new Promise(resolve => { release = resolve; entered(); });
    await route.fulfill({ status: 422, json: { error: 'Upload verified by browser fixture.', failed_step: 1, steps: [] } });
  });
  await page.goto(`${base}/compose/pdf-invoice`);
  const zone = page.locator('.composed-pdf-upload');
  const picker = zone.locator('input[type=file]');
  const submit = page.getByRole('button', { name: 'Extract, convert, validate and send', exact: true });
  const alert = page.locator('#pdf-invoice-file-error');
  await zone.waitFor();
  assert.ok(await submit.isDisabled());
  const transfer = specs => page.evaluateHandle(specs => {
    const data = new DataTransfer();
    for (const spec of specs) data.items.add(new File([spec.size === undefined ? spec.text : new Uint8Array(spec.size)], spec.name, { type: spec.type }));
    return data;
  }, specs);
  const invoice = { name: `invoice-${'long_filename_'.repeat(16)}.pdf`, type: 'application/pdf', text: '%PDF-1.4 dropped invoice bytes' };
  const data = await transfer([invoice]);
  await zone.dispatchEvent('dragenter', { dataTransfer: data });
  assert.match(await zone.getAttribute('class'), /is-dragging/);
  await zone.locator('.composed-pdf-prompt').dispatchEvent('dragenter', { dataTransfer: data });
  await zone.locator('.composed-pdf-prompt').dispatchEvent('dragleave', { dataTransfer: data });
  assert.match(await zone.getAttribute('class'), /is-dragging/, 'moving over a child retains the highlight');
  assert.equal(await zone.evaluate((element, dataTransfer) => !element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })), data), true);
  await zone.dispatchEvent('dragleave', { dataTransfer: data });
  assert.doesNotMatch(await zone.getAttribute('class'), /is-dragging/);
  await zone.dispatchEvent('dragenter', { dataTransfer: data });
  await zone.locator('.composed-pdf-prompt').dispatchEvent('drop', { dataTransfer: data });
  await zone.locator('strong').getByText(invoice.name, { exact: true }).waitFor();
  assert.doesNotMatch(await zone.getAttribute('class'), /is-dragging/);
  assert.ok(await submit.isEnabled());
  assert.ok(await page.locator('form.composed-form').evaluate(form => form.checkValidity()), 'a dropped file satisfies form validation');
  for (const width of [375, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await zone.locator('strong').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'long filename wraps');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page fits the viewport');
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `pdf-invoice-upload-${width}.png`), fullPage: true });
  }
  for (const [files, message] of [
    [[{ name: 'image.png', type: 'image/png', text: 'image' }], 'Choose a PDF invoice.'],
    [[{ name: 'empty.pdf', type: 'application/pdf', text: '' }], 'Choose a non-empty PDF invoice.'],
    [[{ name: 'large.pdf', type: 'application/pdf', size: 4 * 1024 * 1024 + 1 }], 'The file is larger than 4 MB.'],
    [[invoice, invoice], 'Choose one PDF invoice at a time.'],
  ]) {
    const invalid = await transfer(files);
    await zone.dispatchEvent('drop', { dataTransfer: invalid }); await invalid.dispose();
    await alert.getByText(message, { exact: true }).waitFor();
    assert.equal(await zone.locator('strong').innerText(), invoice.name, 'invalid drop retains the chosen file');
    assert.ok(await submit.isDisabled());
  }
  await zone.dispatchEvent('drop', { dataTransfer: data });
  await alert.waitFor({ state: 'hidden' });
  await submit.click();
  await requestEntered;
  assert.deepEqual(requests, [invoice]);
  assert.ok(await picker.isDisabled());
  const replacement = await transfer([{ ...invoice, name: 'replacement.pdf', text: '%PDF-1.4 replacement' }]);
  await zone.dispatchEvent('dragenter', { dataTransfer: replacement });
  assert.doesNotMatch(await zone.getAttribute('class'), /is-dragging/);
  await zone.dispatchEvent('drop', { dataTransfer: replacement }); await replacement.dispose();
  assert.equal(await zone.locator('strong').innerText(), invoice.name, 'processing cannot replace the submitted file');
  hold = false; release();
  await page.getByText('Upload verified by browser fixture.', { exact: true }).waitFor();
  // Native browsing and selecting the same file again continue to work after drops.
  const browsed = { name: 'browsed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 browsed invoice bytes') };
  const chooser = page.waitForEvent('filechooser');
  await zone.locator('.composed-pdf-prompt > span').click();
  await (await chooser).setFiles(browsed);
  await zone.locator('strong').getByText(browsed.name, { exact: true }).waitFor();
  await picker.setInputFiles(browsed);
  await submit.click();
  await page.getByText('Upload verified by browser fixture.', { exact: true }).waitFor();
  assert.deepEqual(requests[1], { name: browsed.name, type: browsed.mimeType, text: browsed.buffer.toString() });
  await data.dispose();
  assert.deepEqual(errors, []);
  console.log('PASS PDF upload: drag highlight, nested targets, drop submission bytes, picker/reselection, invalid/empty/oversized/multiple files, processing lock, mobile/desktop long filenames; processing mocked.');
} finally {
  await browser.close();
}
