// Run against a local app with role-fixture.mjs. External API/Discovery calls are intercepted.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { roleCookie } from "./role-fixture.mjs";
import { normalizeApiRecord } from "../../lib/types.ts";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.UI_TEST_URL || "http://127.0.0.1:3011";
const screenshotDir = process.env.UI_SCREENSHOTS;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const records = [
  normalizeApiRecord({ id: "quote-convert", api_name: "Example API convertToInvoice", company_name: "Example provider", description: "Converts a quotation to an invoice. The invoice starts in DRAFT status.", category: "Transformation", api_endpoint: "https://example.test/documents/{id}/convert/invoice", input_formats: ["null"], output_formats: ["JSON"], authentication_method: "OAuth2", business_rules: ["Only ACCEPTED quotations can be converted; the resulting invoice is DRAFT."], is_active: true }),
  normalizeApiRecord({ id: "check", api_name: "Invoice check", company_name: "Example provider", description: "Checks an invoice.", category: "Validation", input_formats: ["XML"], output_formats: ["JSON"], is_active: true }),
  normalizeApiRecord({ id: "map", api_name: "Invoice mapping", company_name: "Example provider", description: "Maps invoice fields between supported formats.", category: "Transformation", input_formats: ["JSON"], output_formats: ["JSON", "XML"], is_active: true }),
];
const browser = await chromium.launch({ headless: true, channel: "msedge" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().addCookies([roleCookie("publisher", base)]);
  await page.route("**/api/apis", (route) => route.fulfill({ json: { apis: records, mode: "supabase" } }));
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { notifications: [], unread_count: 0, next_offset: null } }));
  await page.route("**/api/schemas**", (route) => route.fulfill({ json: { apis: [], schemas: [] } }));
  await page.goto(`${base}/apis`, { timeout: 60000 });
  await page.getByRole("button", { name: "Invoice check", exact: true }).waitFor();
  for (const width of [1920, 1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const flow of await page.locator(".catalog-format-flow").all()) {
      const geometry = await flow.evaluate((element) => [...element.children].map((child) => ({ top: child.getBoundingClientRect().top, height: child.getBoundingClientRect().height })));
      assert.ok(geometry.every((item) => Math.abs(item.top - geometry[0].top) < 2), "input → output is one line");
    }
    const shortFlow = page.locator("tr").filter({ has: page.getByRole("button", { name: "Invoice check", exact: true }) }).locator(".catalog-format-flow");
    assert.ok(await shortFlow.evaluate((element) => [...element.children].every((child) => child.scrollWidth <= child.clientWidth + 1)), "XML → JSON fits without truncation");
    const bodylessOutput = page.locator("tr").filter({ has: page.getByRole("button", { name: "Example API convertToInvoice", exact: true }) }).locator(".catalog-format-flow > span:last-child");
    assert.ok(await bodylessOutput.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "a long input label must not truncate a short JSON output");
  }
  if (screenshotDir) await page.locator(".catalog-list").screenshot({ path: path.join(screenshotDir, "catalogue-list-inline-formats.png") });
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  const card = page.getByRole("button", { name: "View details for Example API convertToInvoice", exact: true });
  assert.ok(await card.getByText("ID in the URL; no request body", { exact: true }).isVisible());
  assert.ok(await card.getByText(/Only ACCEPTED quotations/).isVisible());
  assert.equal(await card.locator(".api-card-operation").count(), 0, "technical endpoint is reserved for API details");
  for (const width of [1440, 1024, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const shortTitle = page.getByRole("button", { name: "View details for Invoice check", exact: true }).locator(".api-summary-title");
    assert.ok(await shortTitle.evaluate((element) => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 1), "a short card title stays on one line");
    if (screenshotDir && [1440, 390].includes(width)) await page.locator(".result-list").screenshot({ path: path.join(screenshotDir, `catalogue-cards-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await card.click();
  await page.locator("#api-detail-heading").waitFor();
  assert.equal(await page.locator("#api-detail-heading").textContent(), records[0].api_name);

  await page.goto(base);
  await page.getByRole("button", { name: "My account", exact: true }).click();
  assert.ok(await page.getByRole("button", { name: "Log out", exact: true }).isVisible());
  await page.getByRole("button", { name: "My account", exact: true }).click();
  assert.equal(await page.getByRole("search").count(), 0);
  assert.equal(await page.getByRole("link", { name: "Browse the API library", exact: true }).getAttribute("href"), "/apis");
  assert.equal(await page.getByRole("link", { name: "Describe a task to find APIs", exact: true }).getAttribute("href"), "/discovery");
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "homepage-rearranged.png"), fullPage: true });

  await page.route("**/api/discovery", (route) => route.fulfill({ json: {
    requestId: "layout-test", source: { mode: "text" },
    process: { version: "1.0", input_text: "Convert and check an invoice", steps: [{ order: 1, category: "Transformation", task: "Convert the invoice", input_format: "PDF", output_format: "XML", rule_set: null, candidate_ids: null }], unmatched: [] },
  } }));
  await page.goto(`${base}/discovery`, { timeout: 60000 });
  await page.getByRole("heading", { name: /Describe your task/ }).waitFor();
  for (const width of [1440, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.getByRole("tab", { name: /Write it down/ }).isVisible());
    if (screenshotDir && width === 1440) await page.screenshot({ path: path.join(screenshotDir, "discovery-implemented.png"), fullPage: true });
  }
  await page.getByRole("tab", { name: /Upload a diagram/ }).click();
  assert.equal(await page.locator('input[type="file"]').getAttribute("accept"), ".bpmn,.xml,image/png,image/jpeg,image/webp");
  await page.getByRole("tab", { name: /Upload a recording/ }).click();
  assert.match(await page.locator('input[type="file"]').getAttribute("accept"), /audio/);
  await page.getByRole("tab", { name: /Write it down/ }).click();
  await page.getByRole("button", { name: "Try an example", exact: true }).click();
  await page.getByRole("button", { name: "Review my steps", exact: true }).click();
  await page.getByRole("heading", { name: "Does this look like your process?", exact: true }).waitFor();
  assert.ok(await page.getByRole("button", { name: "Find matching APIs", exact: true }).isVisible());
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  assert.ok(await page.getByRole("textbox", { name: /Describe the task/ }).inputValue());
  assert.deepEqual(errors, []);
  console.log("PASS cards, single-line formats and short titles, responsive layout, real detail navigation, homepage/account, Discovery modes and review flow");
} finally { await browser.close(); }
