// Run against the local application. Uses the existing external Playwright installation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.UI_TEST_URL || "http://127.0.0.1:3011";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
try {
  for (const viewport of [{ width: 1440, height: 600 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/compatibility/apis", (route) => route.fulfill({ json: { apis: [], availability: [], mode: "supabase" } }));
    await page.goto(`${base}/compatibility`);
    const top = page.getByRole("button", { name: "Back to top of compatibility check" });
    assert.equal(await top.count(), 0);
    await page.evaluate(() => window.scrollTo(0, 700));
    await top.waitFor({ state: "visible" });
    await top.focus();
    await page.keyboard.press("Space");
    await top.waitFor({ state: "detached" });
    assert.ok(await page.locator("#compatibility-title").evaluate((element) => element === document.activeElement));
    await page.waitForFunction(() => Math.abs(document.getElementById("main-content").getBoundingClientRect().top) < 2);

    // A nested scrolling page must move its own contents, without scrolling Window.
    await page.evaluate(() => {
      const main = document.getElementById("main-content");
      main.style.height = "400px";
      main.style.overflowY = "auto";
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => document.getElementById("main-content").scrollTop = 500);
    await top.waitFor({ state: "visible" });
    const windowScroll = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => {
      const main = document.getElementById("main-content");
      const nativeScrollTo = main.scrollTo.bind(main);
      main.scrollTo = (options) => { main.dataset.scrollBehavior = options.behavior; nativeScrollTo(options); };
    });
    await top.focus();
    await page.keyboard.press("Enter");
    await top.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.scrollY), windowScroll);
    assert.equal(await page.locator("#main-content").evaluate((element) => element.scrollTop), 0);
    assert.equal(await page.locator("#main-content").getAttribute("data-scroll-behavior"), "instant");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}px: compatibility back-to-top, keyboard, focus, nested container, reduced motion`);
    await page.close();
  }
} finally { await browser.close(); }
