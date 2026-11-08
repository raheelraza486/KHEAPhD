import assert from "node:assert/strict";
import test from "node:test";
import { createMutationRateLimiter, type MutationAction } from "../lib/mutation-rate-limit.ts";

const admin = { id: "admin-a", role: "admin" as const };
const publisher = { id: "publisher-a", role: "publisher" as const };
const adminActions: MutationAction[] = ["upload", "edit", "verification"];

for (const action of adminActions) {
  test(`admin ${action} allows 120 requests per minute`, () => {
    const check = createMutationRateLimiter();
    for (let index = 0; index < 120; index += 1) {
      assert.equal(check(action, admin, "shared-ip", 0), 0);
    }
    assert.equal(check(action, admin, "shared-ip", 0), 60);
    assert.equal(check(action, admin, "shared-ip", 60_000), 0);
  });
}

test("each action has its own admin quota", () => {
  const check = createMutationRateLimiter();
  for (const action of adminActions) {
    for (let index = 0; index < 120; index += 1) assert.equal(check(action, admin, "shared-ip", 0), 0);
    assert.equal(check(action, admin, "shared-ip", 0), 60);
  }
});

test("admin quotas follow the account and are independent of shared or changing IPs", () => {
  const check = createMutationRateLimiter();
  for (let index = 0; index < 120; index += 1) check("edit", admin, "shared-ip", 0);
  assert.equal(check("edit", admin, "different-ip", 0), 60);
  assert.equal(check("edit", { ...admin, id: "admin-b" }, "shared-ip", 0), 0);
});

test("publisher submission quotas remain at 10 requests per hour per IP", () => {
  const check = createMutationRateLimiter();
  for (let index = 0; index < 10; index += 1) assert.equal(check("upload", publisher, "shared-ip", 0), 0);
  assert.equal(check("upload", publisher, "shared-ip", 0), 3_600);
  assert.equal(check("upload", { ...publisher, id: "publisher-b" }, "shared-ip", 0), 3_600);
  assert.equal(check("upload", publisher, "different-ip", 0), 0);
  assert.equal(check("upload", publisher, "shared-ip", 3_600_000), 0);
});

for (const user of [admin, publisher]) {
  test(`${user.role} can start five imports per minute`, () => {
    const check = createMutationRateLimiter();
    for (let index = 0; index < 5; index += 1) {
      assert.equal(check("import", user, `ip-${index}`, 0), 0);
    }
    assert.equal(check("import", user, "another-ip", 0), 60);
    assert.equal(check("import", user, "another-ip", 60_000), 0);
  });
}

test("import quotas are isolated by authenticated account, not IP address", () => {
  const check = createMutationRateLimiter();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(check("import", publisher, "shared-ip", 0), 0);
  }
  assert.equal(check("import", publisher, "different-ip", 0), 60);
  assert.equal(check("import", { ...publisher, id: "publisher-b" }, "shared-ip", 0), 0);
});

test("admin activity cannot exhaust a publisher's quota on the same IP", () => {
  const check = createMutationRateLimiter();
  for (let index = 0; index < 120; index += 1) check("upload", admin, "shared-ip", 0);
  for (let index = 0; index < 10; index += 1) assert.equal(check("upload", publisher, "shared-ip", 0), 0);
  assert.equal(check("upload", publisher, "shared-ip", 0), 3_600);
  assert.equal(check("upload", { ...admin, id: "admin-b" }, "shared-ip", 0), 0);
});

test("rejected retries do not extend the admin or publisher waiting period", () => {
  for (const [user, maxRequests, windowMs] of [[admin, 120, 60_000], [publisher, 10, 3_600_000]] as const) {
    const check = createMutationRateLimiter();
    for (let index = 0; index < maxRequests; index += 1) check("upload", user, "ip", 0);
    assert.equal(check("upload", user, "ip", windowMs / 2), windowMs / 2_000);
    assert.equal(check("upload", user, "ip", windowMs - 999), 1);
    assert.equal(check("upload", user, "ip", windowMs), 0);
  }
});

test("the rolling window frees only expired requests", () => {
  const check = createMutationRateLimiter();
  assert.equal(check("edit", admin, "ip", 0), 0);
  for (let index = 0; index < 119; index += 1) check("edit", admin, "ip", 10_000);
  assert.equal(check("edit", admin, "ip", 59_999), 1);
  assert.equal(check("edit", admin, "ip", 60_000), 0);
  assert.equal(check("edit", admin, "ip", 60_000), 10);
  assert.equal(check("edit", admin, "ip", 70_000), 0);
});

test("regular admin work continues across an hour without a cumulative cap", () => {
  const check = createMutationRateLimiter();
  for (let index = 0; index < 400; index += 1) {
    for (const action of adminActions) assert.equal(check(action, admin, "ip", index * 10_000), 0);
  }
});
