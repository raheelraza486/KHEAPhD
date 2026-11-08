// Run against a local Next dev server. Uses an existing Playwright installation; no app dependency is required.
// CATALOGUE_TEST_URL=http://127.0.0.1:3011 PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/catalog-navigation.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { normalizeApiRecord } from "../../lib/types.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.CATALOGUE_TEST_URL || "http://127.0.0.1:3011";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const records = Array.from({ length: 15 }, (_, i) => normalizeApiRecord({
  id: `api-${i}`, api_name: `Invoice ${String(i + 1).padStart(2, "0")} ${i === 1 ? "long API name ".repeat(18) : "API"}`,
  company_name: i < 14 ? "Acme" : "Other", category: "Validation", review_status: "Published", country_region: "Australia",
  api_endpoint: "https://example.test/invoices", documentation_url: "https://example.test/docs",
  description: "Invoice validation documentation. ".repeat(30), input_formats: ["XML"], output_formats: ["JSON"],
  business_rules: Array.from({ length: 20 }, (_, n) => `Rule ${n + 1}: all mandatory invoice fields must be supplied.`),
  updated_at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
}));
const failures = [];
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/apis", route => route.fulfill({ json: { apis: records, mode: "supabase" } }));
    await page.route("**/api/schemas**", route => route.fulfill({ json: { schemas: [], apis: [] } }));
    try {
      await page.goto(`${base}/apis`);
      await page.getByRole("button", { name: records[0].api_name, exact: true }).waitFor();
      await page.getByRole("combobox", { name: /^Company/ }).selectOption("Acme");
      await page.getByRole("combobox", { name: /^Input format/ }).selectOption("XML");
      await page.getByRole("combobox", { name: /^Sort by/ }).selectOption("updated");
      await page.waitForFunction(() => new URLSearchParams(location.search).get("sort") === "updated");
      assert.equal(await page.locator(".catalog-api-link").first().textContent(), records[13].api_name);
      await page.goBack();
      await page.waitForFunction(() => document.querySelector(".catalog-sort-filter select").value === "name");
      assert.equal(await page.locator(".catalog-api-link").first().textContent(), records[0].api_name);
      await page.goForward();
      await page.waitForFunction(() => document.querySelector(".catalog-sort-filter select").value === "updated");
      await page.getByRole("combobox", { name: /^Sort by/ }).selectOption("name");
      const search = page.getByRole("textbox", { name: "Search APIs" });
      const historyBefore = await page.evaluate(() => history.length);
      await search.pressSequentially("Invoice", { delay: 35 });
      await page.waitForFunction(() => new URLSearchParams(location.search).get("q") === "Invoice");
      assert.equal(await page.evaluate(() => history.length), historyBefore + 1, "typing should create one history entry");
      const listUrl = page.url();
      const names = await page.locator(".catalog-api-link").allTextContents();
      assert.equal(names.length, 12);
      await page.getByRole("button", { name: names[0], exact: true }).click();
      await page.waitForFunction(() => document.getElementById("api-detail-heading") === document.activeElement);
      const firstUrl = page.url();
      assert.equal(new URL(firstUrl).searchParams.get("company"), "Acme");
      assert.equal(await page.getByRole("button", { name: /^Previous API:/ }).count(), 0);
      const next = page.getByRole("button", { name: /^Next API:/ });
      assert.equal(await next.getAttribute("aria-label"), `Next API: ${names[1]}`);
      const top = page.getByRole("button", { name: "Back to top of API details" });
      assert.equal(await top.count(), 0, "hidden control is absent from DOM and accessibility tree");
      await page.evaluate(() => window.scrollBy(0, 650));
      await top.waitFor({ state: "visible" });
      const sticky = await page.locator(".api-detail-sticky-header").boundingBox();
      assert.ok(sticky.y >= -1 && sticky.y < 3, `sticky header is at viewport top: ${sticky.y}`);
      if (process.env.CATALOGUE_SCREENSHOTS) {
        await mkdir(process.env.CATALOGUE_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.CATALOGUE_SCREENSHOTS, `api-detail-${viewport.width}.png`) });
      }
      await top.focus();
      await page.keyboard.press("Enter");
      await top.waitFor({ state: "detached" });
      await page.waitForFunction(() => Math.abs(document.getElementById("api-detail").getBoundingClientRect().top) < 2);
      assert.equal(await page.locator("#api-detail-heading").evaluate(el => el === document.activeElement), true);
      await next.focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(id => new URLSearchParams(location.search).get("api") === id, "api-1");
      assert.equal(await page.locator(".api-detail-sticky-header strong").textContent(), names[1]);
      assert.equal(await page.locator("#api-detail-heading").textContent(), names[1]);
      assert.ok(await page.locator(".api-detail-sticky-header strong").evaluate(el => el.scrollWidth > el.clientWidth), "long names truncate");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
      await page.goBack();
      await page.waitForURL(firstUrl);
      assert.equal(await page.locator("#api-detail-heading").textContent(), names[0]);
      await page.goBack();
      await page.waitForURL(listUrl);
      await search.waitFor({ state: "visible" });
      assert.equal(await search.inputValue(), "Invoice");
      assert.equal(await page.getByRole("combobox", { name: /^Company/ }).inputValue(), "Acme");
      assert.deepEqual(await page.locator(".catalog-api-link").allTextContents(), names);
      await page.goBack();
      await page.waitForFunction(() => !new URLSearchParams(location.search).has("q"));
      assert.equal(await search.inputValue(), "");
      assert.equal(await page.getByRole("combobox", { name: /^Input format/ }).inputValue(), "xml");
      await page.goForward();
      await page.waitForURL(listUrl);
      await page.goForward();
      await page.waitForURL(firstUrl);
      await page.goForward();
      await page.waitForFunction(() => new URLSearchParams(location.search).get("api") === "api-1");
      await page.reload();
      await page.getByRole("button", { name: /^Next API:/ }).waitFor();
      assert.equal(await page.locator("#api-detail-heading").textContent(), names[1]);

      // Exercise an actual nested scrolling ancestor; Window must remain untouched.
      await page.evaluate(() => {
        const main = document.getElementById("main-content");
        main.style.height = "75vh";
        main.style.overflowY = "auto";
      });
      await page.getByRole("button", { name: /^Next API:/ }).click();
      await page.waitForFunction(() => new URLSearchParams(location.search).get("api") === "api-2");
      const outerScroll = await page.evaluate(() => window.scrollY);
      await page.evaluate(() => document.getElementById("main-content").scrollTop = 650);
      await top.waitFor({ state: "visible" });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await top.focus();
      await page.keyboard.press("Space");
      await top.waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => window.scrollY), outerScroll, "nested top action must not scroll Window");
      assert.ok(await page.evaluate(() => document.getElementById("main-content").scrollTop < 100));

      await page.goto(`${base}/apis?company=Acme&q=Invoice&sort=name&api=api-13`);
      await page.getByRole("button", { name: /^Previous API:/ }).waitFor();
      assert.equal(await page.getByRole("button", { name: /^Next API:/ }).count(), 0, "last filtered record has no next arrow");
      await page.getByRole("button", { name: "Back to results" }).click();
      await search.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await page.waitForFunction(() => new URLSearchParams(location.search).get("page") === "2");
      await page.getByRole("button", { name: records[12].api_name, exact: true }).click();
      await page.getByRole("button", { name: /^Previous API:/ }).click();
      await page.waitForFunction(() => new URLSearchParams(location.search).get("api") === "api-11");
      await page.getByRole("button", { name: "Back to results" }).click();
      await search.waitFor({ state: "visible" });
      assert.equal(new URL(page.url()).searchParams.get("page"), "2", "detail navigation retains source result page");
      assert.deepEqual(await page.locator(".catalog-api-link").allTextContents(), [records[12].api_name, records[13].api_name]);
      await page.goto(`${base}/apis?category=Validation&country=Australia&status=Published&input=XML&output=JSON&company=Acme&q=Invoice&sort=name`);
      await page.getByRole("button", { name: records[0].api_name, exact: true }).waitFor();
      assert.equal(await page.getByRole("combobox", { name: /^Country/ }).inputValue(), "Australia");
      assert.equal(await page.getByRole("combobox", { name: /^Status/ }).inputValue(), "Published");
      assert.equal(await page.getByRole("combobox", { name: /^Output format/ }).inputValue(), "JSON");
      assert.match(await page.locator(".category-filter-trigger").textContent(), /Validation/);
      await page.getByRole("button", { name: /^Category/ }).click();
      await page.getByRole("button", { name: "Other", exact: true }).click();
      await page.waitForFunction(() => new URLSearchParams(location.search).get("category") === "Other");
      assert.equal(await page.locator(".catalog-api-link").count(), 0);
      await page.goBack();
      await page.getByRole("button", { name: records[0].api_name, exact: true }).waitFor();
      assert.match(await page.locator(".category-filter-trigger").textContent(), /Validation/);
      // First / Last use the filtered page count, preserve URL context and work by keyboard.
      const paginationRecords = Array.from({ length: 43 }, (_, index) => ({
        ...records[0], id: `paged-${index}`, api_name: `Paged ${String(index + 1).padStart(2, "0")} API`, company_name: index < 37 ? "Acme" : "Other",
      }));
      await page.route("**/api/apis", route => route.fulfill({ json: { apis: paginationRecords, mode: "supabase" } }));
      await page.goto(`${base}/apis?company=Acme&q=Paged&sort=name`);
      await page.getByRole("button", { name: "Paged 01 API", exact: true }).waitFor();
      const firstPage = page.getByRole("button", { name: "First page", exact: true });
      const lastPage = page.getByRole("button", { name: "Last page", exact: true });
      assert.deepEqual(await page.locator(".catalog-page-control").allTextContents(), ["", "", "", ""], "navigation uses icons with accessible names");
      assert.equal(await firstPage.isDisabled(), true);
      assert.equal(await lastPage.isDisabled(), false);
      if (process.env.CATALOGUE_SCREENSHOTS) {
        await page.locator(".catalog-pagination").screenshot({ path: path.join(process.env.CATALOGUE_SCREENSHOTS, `pagination-${viewport.width}.png`) });
      }
      await lastPage.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Paged 37 API", exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("page"), "4");
      assert.equal(new URL(page.url()).searchParams.get("company"), "Acme");
      assert.equal(new URL(page.url()).searchParams.get("q"), "Paged");
      assert.equal(new URL(page.url()).searchParams.get("sort"), "name");
      assert.equal(await page.locator(".catalog-api-link").count(), 1);
      assert.equal(await lastPage.isDisabled(), true);
      assert.equal(await firstPage.isDisabled(), false);
      await firstPage.focus();
      await page.keyboard.press("Space");
      await page.getByRole("button", { name: "Paged 01 API", exact: true }).waitFor();
      assert.equal(await page.getByRole("spinbutton", { name: "Page number" }).inputValue(), "1");
      await page.goBack();
      await page.getByRole("button", { name: "Paged 37 API", exact: true }).waitFor();
      await page.goForward();
      await page.getByRole("button", { name: "Paged 01 API", exact: true }).waitFor();
      await search.fill("Paged 37");
      await page.waitForFunction(() => document.querySelectorAll(".catalog-api-link").length === 1);
      assert.equal(await firstPage.isDisabled(), true);
      assert.equal(await lastPage.isDisabled(), true);
      await search.fill("No matching API");
      await page.locator(".catalog-pagination").waitFor({ state: "detached" });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, [], "no browser runtime errors");
      console.log(`PASS ${viewport.width}px: history, filters, search, detail navigation, scroll, keyboard, reduced motion, pagination`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL ${viewport.width}px`, error);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (failures.length) process.exitCode = 1;
