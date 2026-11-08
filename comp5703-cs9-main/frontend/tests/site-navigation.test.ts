import assert from "node:assert/strict";
import { test } from "node:test";
import { siteNavigation } from "../lib/site-navigation.ts";

test("grouping keeps each role's existing destinations without granting Viewer publishing access", () => {
  const common = ["/apis", "/discovery", "/compatibility", "/workflows/canvas"];
  const personal = ["/compatibility/decisions", "/compose/pdf-invoice", "/workflows/create"];
  for (const [role, expected] of [
    [null, common],
    ["viewer", [...common, ...personal]],
    ["publisher", [...common, ...personal, "/submit"]],
    ["admin", [...common, "/submit", "/compose/pdf-invoice", "/workflows/create", "/apis?status=Published", "/compatibility/decisions", "/compatibility/reviews"]],
  ] as const) {
    const groups = siteNavigation(role, "apis", "all");
    const actual = groups.flatMap((group) => group.items.map((item) => item.href));
    assert.deepEqual(actual.sort(), [...expected].sort(), String(role));
    assert.equal(new Set(actual).size, actual.length, "no duplicate destinations");
    if (role) {
      const decisionGroups = siteNavigation(role, "decisions", "all");
      assert.equal(decisionGroups.find((group) => group.items.some((item) => item.active))?.id, "publish", "field decisions belong to the publishing group");
    }
  }
});

test("verification views select their own group instead of All APIs", () => {
  for (const [role, view, href, groupId] of [
    ["admin", "awaiting", "/apis?status=Published", "manage"],
    ["admin", "all", "/apis", "discover"],
  ] as const) {
    const groups = siteNavigation(role, "apis", view);
    assert.deepEqual(groups.flatMap((group) => group.items.filter((item) => item.active).map((item) => item.href)), [href]);
    assert.equal(groups.find((group) => group.items.some((item) => item.active))?.id, groupId);
  }
});
