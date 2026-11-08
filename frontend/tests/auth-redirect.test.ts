import assert from "node:assert/strict";
import test from "node:test";
import { safeInternalPath } from "../lib/auth-redirect.ts";

test("post-login redirects keep local paths and query strings", () => {
  assert.equal(safeInternalPath("/submit?from=login"), "/submit?from=login");
  assert.equal(safeInternalPath("/#submit-api"), "/#submit-api");
});

test("post-login redirects reject external and scheme-relative targets", () => {
  assert.equal(safeInternalPath("https://example.com/admin"), "/apis");
  assert.equal(safeInternalPath("//example.com/admin"), "/apis");
  assert.equal(safeInternalPath("/\\example.com/admin"), "/apis");
});

test("post-login redirects use the supplied fallback when absent", () => {
  assert.equal(safeInternalPath(undefined, "/"), "/");
});
