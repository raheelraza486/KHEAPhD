// Start the isolated role-fixture app first. This deliberately delays hydration scripts.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { roleCookie } from "./role-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.UI_TEST_URL || "http://127.0.0.1:3013";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat|server rendered HTML/i.test(message.text())) errors.push(message.text());
  });
  await page.context().addCookies([roleCookie("publisher", base)]);
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { notifications: [], unread_count: 0 } }));
  let releaseScripts;
  const scriptsReady = new Promise((resolve) => { releaseScripts = resolve; });
  await page.route(/\/_next\/static\/.*\.js(?:\?|$)/, async (route) => {
    await scriptsReady;
    await route.continue();
  });
  await page.goto(base, { waitUntil: "commit", timeout: 60000 });
  const toggle = page.getByRole("button", { name: "My account", exact: true });
  try {
    await toggle.waitFor();
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false", "clicking before hydration cannot mutate native details state");
    assert.equal(await page.locator(".landing-account-menu").getAttribute("open"), null);
    assert.equal(await page.locator(".landing-account-panel").isVisible(), false);
  } finally { releaseScripts(); }
  await page.waitForLoadState("networkidle");
  await toggle.click();
  await page.locator(".landing-account-panel").waitFor({ state: "visible" });
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await page.reload();
  await page.waitForLoadState("networkidle");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "reload starts from the same closed state as the server");
  await toggle.click();
  await page.getByRole("button", { name: "Log out", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.deepEqual(errors, []);
  console.log("PASS account interaction before hydration, normal opening, reload, Escape and no hydration warnings");
} finally { await browser.close(); }
