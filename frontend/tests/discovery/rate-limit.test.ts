import assert from "node:assert/strict";
import test from "node:test";
import { createDiscoveryRateLimiter } from "../../lib/discovery/rate-limit.ts";

test("limits each signed-in user independently and recovers after the window", () => {
  const check = createDiscoveryRateLimiter(1_000, 2);
  assert.equal(check("user-a", 1_000), 0);
  assert.equal(check("user-a", 1_100), 0);
  assert.equal(check("user-b", 1_200), 0);
  assert.equal(check("user-a", 1_200), 1);
  assert.equal(check("user-a", 2_001), 0);
});

