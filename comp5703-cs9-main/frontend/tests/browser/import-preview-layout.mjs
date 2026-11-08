// Run against a local app using role-fixture.mjs; this test intercepts import previews and never confirms an import.
// IMPORT_TEST_URL=http://127.0.0.1:3011 PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/import-preview-layout.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { roleCookie } from "./role-fixture.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.IMPORT_TEST_URL || "http://127.0.0.1:3011";
const screenshotDir = process.env.IMPORT_SCREENSHOTS;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const preview = {
  sessionId: "local-layout-preview", documentation_url: "https://example.test/openapi.json", info_title: "Example API", info_version: "2.0",
  warnings: [], excluded_count: 0,
  candidates: Array.from({ length: 9 }, (_, index) => ({ index,
    api_name: `Example API ${["createDocument", "getDocument", "convertToInvoice", "sendInvoice", "receiveInvoice", "validateInvoice", "mapInvoice", "sendAndReceive", "otherOperation"][index]}`,
    api_endpoint: `https://example.test/api/v2/documents/{id}/${"detailed-operation-path/".repeat(3)}${index}`,
    http_method: "POST", data_quality: "ok", category: index === 3 || index === 7 ? "Communication" : "Transformation",
    communication_direction: index === 7 ? "Send and receive" : index === 3 ? "Unspecified" : "",
    predicted_outcome: index === 0 ? "duplicate" : index === 1 ? "conflict" : "insert", warnings: [],
  })),
};
const browser = await chromium.launch({ headless: true, channel: "msedge" });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().addCookies([roleCookie("publisher", base)]);
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { notifications: [], unread_count: 0, next_offset: null } }));
  await page.route("**/api/import", (route) => {
    assert.equal(route.request().method(), "POST", "only the preview request is made");
    return route.fulfill({ json: preview });
  });
  await page.goto(`${base}/submit`);
  await page.getByLabel("OpenAPI document URL", { exact: true }).fill(preview.documentation_url);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("columnheader", { name: "Proposed category", exact: true }).waitFor();

  let wideWorkspace;
  for (const width of [2048, 1920, 1440, 1024, 820, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1080 });
    const geometry = await page.evaluate(() => {
      const table = document.querySelector(".import-table");
      const shell = document.querySelector(".import-table-shell");
      const category = table.querySelector("th:nth-child(5)");
      const range = document.createRange();
      range.selectNodeContents(table.querySelector(".import-category-unchanged"));
      return { viewport: innerWidth, document: document.documentElement.scrollWidth,
        workspace: document.querySelector(".submit-workspace").getBoundingClientRect().width,
        categoryWidth: category.getBoundingClientRect().width, categoryHeight: category.getBoundingClientRect().height,
        unchangedHeight: range.getBoundingClientRect().height,
        shellWidth: shell.clientWidth, tableWidth: table.getBoundingClientRect().width };
    });
    assert.ok(geometry.categoryWidth >= 220, `category is readable at ${width}px`);
    assert.ok(geometry.categoryHeight < 65, "column header is never squeezed into vertical text");
    assert.ok(geometry.unchangedHeight < 30, "Unchanged stays on one line");
    assert.ok(geometry.document <= geometry.viewport, "only the table can scroll horizontally");
    if (width === 1920) { wideWorkspace = geometry.workspace; assert.ok(geometry.tableWidth <= geometry.shellWidth + 2); }
    if (width === 1440) assert.ok(geometry.workspace < wideWorkspace, "workspace follows available screen width");
    if (width <= 1024) assert.ok(geometry.tableWidth > geometry.shellWidth, "narrow viewports keep column widths and scroll");
    await page.locator(".import-table-shell").evaluate((shell) => shell.scrollLeft = shell.scrollWidth);
    assert.ok(await page.getByRole("columnheader", { name: "Outcome", exact: true }).isVisible());
    await page.locator(".import-table-shell").evaluate((shell) => shell.scrollLeft = 0);
    if (screenshotDir && [1920, 1440, 390].includes(width)) {
      await page.locator(".import-preview").screenshot({ path: path.join(screenshotDir, `import-preview-${width}.png`) });
    }
    console.log(`PASS ${width}px: category ${Math.round(geometry.categoryWidth)}px, workspace ${Math.round(geometry.workspace)}px, contained scrolling`);
  }
  assert.equal(await page.getByRole("checkbox").count(), 9);
  assert.equal(await page.getByRole("checkbox").nth(0).isDisabled(), true);
  assert.equal(await page.getByRole("checkbox").nth(1).isDisabled(), true);
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 7);
  assert.equal(await page.getByRole("button", { name: "Import 7 selected", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Deselect all", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS selection behavior: existing imports stay locked, select/deselect counts unchanged; no writes confirmed");
} finally { await browser.close(); }
