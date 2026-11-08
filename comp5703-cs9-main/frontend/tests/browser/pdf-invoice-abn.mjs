// Synthetic responses only; this browser test never calls an invoice provider.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { roleCookie } from './role-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.UI_TEST_URL || 'http://127.0.0.1:3011';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const context = await browser.newContext();
  await context.addCookies([roleCookie('publisher', base)]);
  await context.route('**/api/notifications**', route => route.fulfill({ json: { notifications: [], unread_count: 0 } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch;
    window.sellerAbnRuns = [];
    window.fetch = (input, init) => {
      if (input !== '/api/composed/pdf-invoice') return original(input, init);
      window.sellerAbnRuns.push(init.body.get('seller_abn'));
      return Promise.resolve(Response.json({ reason: 'extraction_unusable', failed_step: 1,
        error: 'Confirm the unlabelled number in the seller block.',
        seller_abn_suggestion: { value: '47555222000', page: 1 },
      }, { status: 422 }));
    };
  });
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/compose/pdf-invoice`);
    const abn = page.getByRole('textbox', { name: "Seller's ABN (optional confirmation)", exact: true });
    assert.equal(await abn.inputValue(), '');
    await page.locator('.composed-pdf-upload input').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic') });
    const submit = page.locator('.composed-actions button[type=submit]');
    await submit.click();
    await page.getByRole('button', { name: 'Use 47555222000 from PDF page 1', exact: true }).click();
    assert.equal(await abn.inputValue(), '47555222000');
    assert.equal(await page.evaluate(() => window.sellerAbnRuns.length), 1, 'Confirmation must not silently start a provider run');
    assert.equal(await page.locator('.composed-pdf-upload strong').innerText(), 'synthetic.pdf');
    await submit.click();
    await page.getByText('Confirm the unlabelled number in the seller block.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.sellerAbnRuns[1]), '47555222000');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  assert.deepEqual(errors, []);
  console.log('PASS seller ABN confirmation on desktop/mobile: optional input, one-click reuse, no typing, no automatic resubmission, file retained, confirmed value submitted; no provider calls.');
} finally {
  await browser.close();
}
