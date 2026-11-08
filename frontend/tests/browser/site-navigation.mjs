// Start role-fixture.mjs first. Uses an existing Playwright installation, not an application dependency.
// PLAYWRIGHT_MODULE=/path/to/playwright UI_SCREENSHOTS=/local/output node tests/browser/site-navigation.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { roleCookie } from "./role-fixture.mjs";
import { normalizeApiRecord } from "../../lib/types.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.UI_TEST_URL || "http://127.0.0.1:3011";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const screenshotDir = process.env.UI_SCREENSHOTS;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const records = [
  ["Invoice delivery API", "Northstar", "Communication", "Published", "Australia"],
  ["Invoice validation API", "Clearpath", "Validation", "Published", "United Kingdom"],
  ["PDF to structured data API", "Paperworks", "Transformation", "Published", "Germany"],
  ["Document exchange API", "Northstar", "Communication", "Published", "Australia"],
  ["Business rules API", "Clearpath", "Validation", "Published", "United Kingdom"],
  ["XML mapping API", "Paperworks", "Transformation", "Published", "Germany"],
].map(([api_name, company_name, category, review_status, country_region], index) => normalizeApiRecord({
  id: `example-${index}`, api_name, company_name, category, review_status, country_region,
  api_endpoint: "https://example.test/api", documentation_url: "https://example.test/docs", is_active: true,
  description: "Business document processing with a structured API request and response.",
  input_formats: ["XML"], output_formats: ["JSON"], http_method: "POST", authentication_method: "API key",
  communication_direction: category === "Communication" ? "Send" : "",
  created_by_user: "10000000-0000-4000-8000-000000000001",
}));

async function screenshot(page, name, fullPage = false) {
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage });
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
}

try {
  const page = await browser.newPage({ viewport: { width: 1448, height: 1086 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /hydrat|server rendered HTML/i.test(message.text())) errors.push(message.text()); });
  await page.route(/\/api\/apis(?:\?scope=mine)?$/, (route) => route.fulfill({ json: { apis: records, mode: "supabase" } }));
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { notifications: [], unread_count: 0, next_offset: null } }));
  await page.route("**/api/checks/conflicts", (route) => route.fulfill({ json: { pairs: 0, complete: true } }));
  await page.route("**/api/schemas**", (route) => route.fulfill({ json: { schemas: [], apis: [] } }));

  await page.goto(base);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator(".app-sidebar").count(), 0);
  assert.equal(await page.locator(".landing-start-card").count(), 3);
  assert.equal(await page.locator(".api-category-cell").count(), 4);
  assert.equal(await page.getByRole("link", { name: "Add your API", exact: true }).getAttribute("href"), "/login?next=%2Fsubmit");
  await screenshot(page, "homepage-desktop", true);
  for (const width of [1200, 1024, 820, 768, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    if (width === 390) await screenshot(page, "homepage-mobile", true);
  }
  await page.setViewportSize({ width: 1448, height: 1086 });
  assert.equal(await page.getByRole("search").count(), 0, "homepage does not promise task search in the catalogue");
  assert.equal(await page.getByRole("navigation", { name: "Footer navigation" }).getByRole("link", { name: "Invoice workflows", exact: true }).count(), 0, "signed-out footer matches sidebar workflow visibility");
  await page.getByRole("link", { name: "Browse the API library", exact: true }).click();
  await page.waitForURL(/\/apis$/);
  await page.getByRole("textbox", { name: "Search APIs" }).waitFor();
  const guestLogin = page.locator(".sidebar-account .header-login");
  const loginGeometry = await guestLogin.evaluate((element) => {
    const link = element.getBoundingClientRect();
    const parent = element.parentElement.getBoundingClientRect();
    return { center: link.x + link.width / 2, parentCenter: parent.x + parent.width / 2, width: link.width, parentWidth: parent.width };
  });
  assert.ok(Math.abs(loginGeometry.center - loginGeometry.parentCenter) < 1, "sidebar login is centered");
  assert.ok(Math.abs(loginGeometry.width - loginGeometry.parentWidth) < 1, "sidebar login fills its account row");
  await guestLogin.hover();
  await page.waitForFunction(() => {
    const link = document.querySelector(".sidebar-account .header-login");
    const hover = getComputedStyle(link).getPropertyValue("--sidebar-hover").trim();
    const expected = `rgb(${[1, 3, 5].map((start) => parseInt(hover.slice(start, start + 2), 16)).join(", ")})`;
    return getComputedStyle(link).backgroundColor === expected;
  });
  await screenshot(page, "guest-login-hover");
  await page.getByRole("textbox", { name: "Search APIs" }).fill("Invoice");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("q") === "Invoice");
  assert.equal(await page.getByRole("textbox", { name: "Search APIs" }).inputValue(), "Invoice");
  await page.goto(base);
  await page.locator(".landing-page").waitFor();
  await page.getByRole("link", { name: "Browse Validation APIs" }).click();
  await page.waitForURL(/category=Validation/);
  await page.getByRole("button", { name: "Invoice validation API", exact: true }).waitFor();

  for (const role of ["publisher", "admin", "viewer"]) {
    await page.context().clearCookies();
    await page.context().addCookies([roleCookie(role, base)]);
    await page.goto(`${base}/apis${role === "admin" ? "?status=Published" : ""}`);
    await page.getByRole("button", { name: "Invoice validation API", exact: true }).waitFor();
    assert.equal(await page.locator(".app-sidebar").getAttribute("data-role"), role);
    assert.equal(await page.locator('.sidebar-group-toggle[aria-expanded="true"]').count(), 1);
    assert.equal(await page.locator('.sidebar-navigation a[href="/submit"]').count(), role === "viewer" ? 0 : 1);
    assert.equal(await page.locator('.sidebar-navigation a[href="/compatibility/reviews"]').count(), role === "admin" ? 1 : 0);
    assert.equal(await page.locator('.sidebar-navigation a[href="/apis?scope=mine"]').count(), 0);
    await page.locator('.sidebar-account a[href="/profile"]').waitFor();
    await screenshot(page, `${role}-desktop`);

    // Folding a group changes visibility, not its destinations or permissions.
    const before = await page.locator(".sidebar-navigation a").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    const expanded = page.locator('.sidebar-group-toggle[aria-expanded="true"]');
    await expanded.focus();
    await page.keyboard.press("Space");
    assert.equal(await page.locator('.sidebar-group-toggle[aria-expanded="true"]').count(), 0);
    await screenshot(page, `${role}-collapsed`);
    await page.getByRole("button", { name: "Build a workflow", exact: true }).click();
    assert.equal(await page.locator(".sidebar-navigation").getByRole("link", { name: "Invoice workflows", exact: true }).isVisible(), true);
    await page.getByRole("button", { name: "Find APIs", exact: true }).click();
    assert.equal(await page.locator(".sidebar-navigation").getByRole("link", { name: "Invoice workflows", exact: true }).isVisible(), true, "opening Find APIs keeps Build a workflow open");
    assert.equal(await page.locator('.sidebar-group-toggle[aria-expanded="true"]').count(), 2);
    const publishingGroup = page.getByRole("button", { name: role === "viewer" ? "My APIs" : "Share your API", exact: true });
    await publishingGroup.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator('.sidebar-group-toggle[aria-expanded="true"]').count(), 3);
    await page.keyboard.press("Space");
    assert.equal(await page.locator('.sidebar-group-toggle[aria-expanded="true"]').count(), 2, "keyboard collapse only changes the focused group");
    await page.getByRole("button", { name: "Build a workflow", exact: true }).click();
    assert.equal(await page.locator(".sidebar-navigation").getByRole("link", { name: "Invoice workflows", exact: true }).isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Find APIs", exact: true }).getAttribute("aria-expanded"), "true");
    assert.deepEqual(await page.locator(".sidebar-navigation a").evaluateAll((links) => links.map((link) => link.getAttribute("href"))), before);
    await page.locator('.notification-inbox > summary').click();
    const inbox = await page.locator(".inbox-panel").boundingBox();
    assert.ok(inbox.x >= 248 && inbox.x + inbox.width <= 1448, "inbox opens beside the sidebar without clipping");
    await page.locator('.notification-inbox > summary').click();

    if (role === "admin") {
      await page.getByRole("combobox", { name: /^Status/ }).selectOption("All records");
      await page.locator('.sidebar-navigation a[href="/apis"][aria-current="page"]').waitFor();
      await page.goBack();
      await page.locator('.sidebar-navigation a[href="/apis?status=Published"][aria-current="page"]').waitFor();
      assert.equal(await page.getByRole("button", { name: "Administration", exact: true }).getAttribute("aria-expanded"), "true");
      assert.equal(await page.getByRole("button", { name: "Find APIs", exact: true }).getAttribute("aria-expanded"), "true", "restoring the current group preserves other expanded groups");
    } else {
      await page.goto(`${base}/apis?scope=mine`);
      await page.locator('.sidebar-account a[href="/profile"][aria-current="page"]').waitFor();
      await page.getByRole("heading", { name: "My submissions", exact: true }).waitFor();
    }
    await page.setViewportSize({ width: 1448, height: 560 });
    assert.ok(await page.getByRole("button", { name: "Log out", exact: true }).isVisible());
    const account = await page.locator(".sidebar-account").boundingBox();
    assert.ok(account.y + account.height <= 561, "account remains reachable in short windows");
    for (const width of [1024, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow(page);
      if (width > 820) continue;
      const menu = page.getByRole("button", { name: "Menu", exact: true });
      await menu.focus();
      await page.keyboard.press("Enter");
      const findGroup = page.getByRole("button", { name: "Find APIs", exact: true });
      if (await findGroup.getAttribute("aria-expanded") !== "true") await findGroup.click();
      const buildGroup = page.getByRole("button", { name: "Build a workflow", exact: true });
      if (await buildGroup.getAttribute("aria-expanded") !== "true") await buildGroup.click();
      assert.equal(await findGroup.getAttribute("aria-expanded"), "true", "multiple groups can stay open on mobile");
      assert.ok(await page.locator(".sidebar-navigation").getByRole("link", { name: "All APIs", exact: true }).isVisible());
      assert.ok(await page.getByRole("button", { name: "Log out", exact: true }).isVisible());
      await noOverflow(page);
      if (width === 390) await screenshot(page, `${role}-mobile`);
      await page.keyboard.press("Escape");
      await page.locator(".sidebar-navigation").waitFor({ state: "hidden" });
      assert.equal(await page.locator(".sidebar-navigation").isVisible(), false);
      assert.equal(await menu.evaluate((element) => element === document.activeElement), true);
    }
    await page.setViewportSize({ width: 1448, height: 1086 });
    await page.goto(base);
    const add = page.locator(".landing-publish .landing-card-button");
    assert.equal(await page.getByRole("navigation", { name: "Footer navigation" }).getByRole("link", { name: "Invoice workflows", exact: true }).getAttribute("href"), "/compose/pdf-invoice", "all signed-in roles retain the invoice workflow footer link");
    assert.equal(await add.getAttribute("href"), role === "viewer" ? "/about" : "/submit");
    await page.getByRole("button", { name: "My account", exact: true }).click();
    assert.ok(await page.getByRole("button", { name: "Log out", exact: true }).isVisible());
    const accountGeometry = await page.locator(".landing-account-panel").evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const account = element.querySelector(".header-account").getBoundingClientRect();
      const logout = element.querySelector(".header-logout").getBoundingClientRect();
      const inbox = element.querySelector(".notification-inbox").getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(element).paddingLeft);
      return { panelWidth: panel.width, accountWidth: account.width, logoutWidth: logout.width, inboxWidth: inbox.width, padding };
    });
    assert.ok(accountGeometry.accountWidth >= accountGeometry.panelWidth - accountGeometry.padding * 2 - 3, "account content fills the panel without a blank left column");
    assert.ok(Math.abs(accountGeometry.logoutWidth - accountGeometry.accountWidth) < 1);
    assert.ok(Math.abs(accountGeometry.inboxWidth - accountGeometry.accountWidth) < 1);
    await screenshot(page, `${role}-home-account`);
    if (role === "publisher" && screenshotDir) {
      const panel = await page.locator(".landing-account-panel").boundingBox();
      const toggle = await page.getByRole("button", { name: "My account", exact: true }).boundingBox();
      await page.screenshot({ path: path.join(screenshotDir, "account-menu-detail.png"), clip: { x: panel.x - 8, y: Math.max(0, toggle.y - 8), width: panel.width + 16, height: panel.y + panel.height - Math.max(0, toggle.y - 8) + 8 } });
    }
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const mobilePanel = await page.locator(".landing-account-panel").boundingBox();
      assert.ok(mobilePanel.x >= 0 && mobilePanel.x + mobilePanel.width <= width, "account panel stays within the mobile viewport");
      assert.ok(await page.locator(".landing-account-panel .header-identity").isVisible(), "mobile account identity remains visible");
    }
    await page.setViewportSize({ width: 1448, height: 1086 });
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button", { name: "My account", exact: true }).getAttribute("aria-expanded"), "false");
    assert.ok(await page.getByRole("button", { name: "My account", exact: true }).evaluate((element) => element === document.activeElement));
    await page.keyboard.press("Enter");
    assert.ok(await page.getByRole("button", { name: "Log out", exact: true }).isVisible());
    await page.getByRole("heading", { name: "Choose where to start", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "My account", exact: true }).getAttribute("aria-expanded"), "false");
    console.log(`PASS ${role}: role permissions, accordion, keyboard, mobile menu, inbox, URL selection, account`);
  }
  assert.deepEqual(errors, [], "no browser runtime errors");
  console.log("PASS homepage: real search/category routes, access-aware actions, responsive layout");
} finally { await browser.close(); }
