import assert from "node:assert/strict";
import test from "node:test";

import { defaultRecipient } from "../lib/default-recipient.ts";

test("an administrator starts with the first allowed recipient; others with their own address", () => {
  const admin = { email: "admin@example.com", role: "admin" as const };
  const publisher = { email: "pat@example.test", role: "publisher" as const };
  assert.equal(defaultRecipient(admin, " me@example.test , client@example.test"), "me@example.test");
  assert.equal(defaultRecipient(admin, ""), "admin@example.com", "no allow-list: the account's own address");
  assert.equal(defaultRecipient(admin, undefined), "admin@example.com");
  assert.equal(defaultRecipient(publisher, "me@example.test"), "pat@example.test", "a non-admin never gets someone else's address");
  assert.equal(defaultRecipient(null, "me@example.test"), "");
});
