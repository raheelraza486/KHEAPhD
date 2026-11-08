import assert from "node:assert/strict";
import test from "node:test";
import { APP_ROLES, type AppRole } from "../lib/auth-policy.ts";
import { notificationDestination, notificationTitle, type ApiNotification } from "../lib/notifications.ts";
import { routeHarness } from "./helpers/route-harness.ts";

const mine = "10000000-0000-4000-8000-000000000001";
const theirs = "10000000-0000-4000-8000-000000000002";
function setup(signedIn = true, role: AppRole = "publisher") {
  const rows = Array.from({ length: 24 }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    recipient_user_id: index === 23 ? theirs : mine,
    api_id: `api-${index}`, api_name: `API ${index}`, created_at: "2026-09-10T00:00:00Z", read_at: null as string | null,
    kind: role === "admin" ? "new_submission" : "api_verified",
  }));
  // Settlement notices (migration 0035) live in their own table; the inbox
  // reads both and shows one list.
  const settlements: Record<string, unknown>[] = [];
  let fail = false;
  let missingKind = false;
  let missingSettlements = false;
  let bearer = "";
  const db = {
    from(table: string) {
      assert.ok(table === "api_notifications" || table === "check_notification", `unexpected table ${table}`);
      const source = table === "check_notification" ? settlements : rows;
      const filters: [string, unknown][] = [];
      let range = [0, 100];
      let head = false;
      let single = false;
      let update: Record<string, unknown> | null = null;
      let fields: string[] = [];
      const query = {
        select(selected: string, options?: { head?: boolean }) { fields = selected.split(","); head = Boolean(options?.head); return query; },
        eq(key: string, value: unknown) { filters.push([key, value]); return query; },
        is(key: string, value: unknown) { filters.push([key, value]); return query; },
        order() { return query; },
        range(start: number, end: number) { range = [start, end]; return query; },
        returns() { return query; },
        update(values: Record<string, unknown>) { assert.deepEqual(Object.keys(values), ["read_at"]); update = values; return query; },
        maybeSingle() { single = true; return query; },
        then(resolve: (result: unknown) => unknown) {
          assert.ok(filters.some(([key, value]) => key === "recipient_user_id" && value === mine), "every query must filter by the authenticated recipient");
          if (table === "check_notification" && missingSettlements) {
            return Promise.resolve(resolve({ error: { code: "42P01", message: "relation check_notification does not exist" }, count: null, data: null }));
          }
          const matches = (source as Record<string, unknown>[]).filter((row) => filters.every(([key, value]) => row[key] === value));
          if (!fail && update) matches.forEach((row) => Object.assign(row, update));
          const data = matches.map((row) => Object.fromEntries(fields.map((key) => [key, row[key]])));
          return Promise.resolve(resolve({ error: fail ? { message: "Database unavailable" }
            : missingKind && fields.includes("kind") ? { code: "42703", message: "column api_notifications.kind does not exist" } : null,
            count: matches.length, data: head ? null : single ? data[0] ?? null : data.slice(range[0], range[1] + 1) }));
        },
      };
      return query;
    },
  };
  const load = routeHarness({
    "@/lib/auth": { APP_ROLES, requireRole: async () => signedIn
      ? { user: { id: mine, role } }
      : { response: Response.json({}, { status: 401 }) } },
    "@/lib/supabase/server": { createSupabaseServerClient: async () => db,
      createSupabaseBearerClient: (token: string) => { bearer = token; return db; } },
  });
  return {
    route: load("app/api/notifications/route.ts"), rows, settlements,
    fail: () => { fail = true; },
    legacy: () => { missingKind = true; },
    withoutSettlementsTable: () => { missingSettlements = true; },
    bearer: () => bearer,
  };
}

function request(method = "GET", body?: unknown, query = "") {
  return new Request(`https://catalogue.example.test/api/notifications${query}`, {
    method, headers: { origin: "https://catalogue.example.test", host: "catalogue.example.test", authorization: "Bearer test.jwt" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("inbox counts all unread items, paginates, and forwards the authenticated session", async () => {
  const { route, bearer } = setup();
  const first = await route.GET(request());
  const page = await first.json();
  assert.equal(page.unread_count, 23);
  assert.equal(page.notifications.length, 20);
  assert.equal(page.notifications[0].kind, "api_verified");
  assert.equal(page.submission_notifications_available, true);
  assert.equal(page.next_offset, 20);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  assert.equal(bearer(), "test.jwt");
  const next = await (await route.GET(request("GET", undefined, "?offset=20"))).json();
  assert.equal(next.notifications.length, 3);
  assert.equal(next.next_offset, null);
});

for (const role of ["publisher", "admin"] as const) {
  test(`legacy inbox remains readable for ${role} while new submission notifications are not installed`, async () => {
    const { route, rows, legacy } = setup(true, role);
    legacy();
    const response = await route.GET(request());
    const page = await response.json();
    assert.equal(response.status, 200);
    assert.equal(page.submission_notifications_available, false);
    assert.equal(page.notifications.length, 20);
    assert.equal(page.next_offset, 20);
    assert.equal(page.unread_count, 23);
    assert.ok(page.notifications.every((item: { kind: string }) => item.kind === "api_verified"));
    assert.equal((await route.PATCH(request("PATCH", { id: rows[0].id }))).status, 200);
    assert.equal((await route.PATCH(request("PATCH", { id: rows[23].id }))).status, 404);
  });
}

test("admin inbox returns new submissions and only marks the recipient's notifications read", async () => {
  const { route, rows } = setup(true, "admin");
  const page = await (await route.GET(request())).json();
  assert.equal(page.notifications[0].kind, "new_submission");
  assert.equal(page.unread_count, 23);
  assert.equal(notificationDestination(page.notifications[0], "admin"), `/apis?api=${page.notifications[0].api_id}`);
  assert.equal((await route.PATCH(request("PATCH", { id: rows[0].id }))).status, 200);
  assert.equal((await route.PATCH(request("PATCH", { id: rows[23].id }))).status, 404);
  assert.equal((await (await route.GET(request())).json()).unread_count, 22);
});

test("read updates are idempotent, ignore forged recipient fields, and refuse other users' notifications", async () => {
  const { route, rows } = setup();
  assert.equal((await route.PATCH(request("PATCH", { id: rows[0].id, recipient_user_id: theirs }))).status, 200);
  const readAt = rows[0].read_at;
  assert.ok(readAt);
  assert.equal((await route.PATCH(request("PATCH", { id: rows[0].id }))).status, 200);
  assert.equal(rows[0].read_at, readAt);
  assert.equal((await route.PATCH(request("PATCH", { id: rows[23].id }))).status, 404);
  assert.equal(rows[23].read_at, null);
  assert.equal((await (await route.GET(request())).json()).unread_count, 22);
});

test("a user can mark every unread inbox notification as read in one request", async () => {
  const { route, rows } = setup();
  const response = await route.PATCH(request("PATCH", { action: "mark_all_read", recipient_user_id: theirs }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.updated_count, 23);
  assert.ok(rows.slice(0, 23).every((row) => row.read_at));
  assert.equal(rows[23].read_at, null);
  assert.equal((await (await route.GET(request())).json()).unread_count, 0);
  const repeated = await route.PATCH(request("PATCH", { action: "mark_all_read" }));
  assert.deepEqual(await repeated.json(), { ok: true, updated_count: 0 });
});

test("an admin can mark every submission notification as read", async () => {
  const { route, rows } = setup(true, "admin");
  const response = await route.PATCH(request("PATCH", { action: "mark_all_read" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, updated_count: 23 });
  assert.ok(rows.slice(0, 23).every((row) => row.read_at));
  assert.equal(rows[23].read_at, null);
});

test("inbox authentication, origin, payload and page validation fail closed", async () => {
  const anonymous = setup(false).route;
  assert.equal((await anonymous.GET(request())).status, 401);
  assert.equal((await anonymous.PATCH(request("PATCH", { id: mine }))).status, 401);
  const { route } = setup();
  assert.equal((await route.PATCH(new Request("https://catalogue.example.test/api/notifications", { method: "PATCH", body: "{}" }))).status, 403);
  assert.equal((await route.PATCH(request("PATCH", { id: "invalid" }))).status, 400);
  assert.equal((await route.PATCH(request("PATCH", { action: "delete_all" }))).status, 400);
  assert.equal((await route.PATCH(request("PATCH", { id: "x".repeat(2_000) }))).status, 413);
  assert.equal((await route.GET(request("GET", undefined, "?offset=-1"))).status, 400);
});

test("inbox failures are recoverable errors rather than an empty successful inbox", async () => {
  const { route, fail } = setup();
  fail();
  assert.equal((await route.GET(request())).status, 503);
  assert.equal((await route.PATCH(request("PATCH", { id: mine }))).status, 503);
});

test("verification notifications keep opening the owned API after it returns to awaiting verification", () => {
  const destination = new URL(notificationDestination({ api_id: mine, kind: "api_verified" }), "https://catalogue.example.test");
  assert.equal(destination.pathname, "/profile");
  assert.equal(destination.searchParams.get("view"), "submissions");
  assert.equal(destination.searchParams.has("status"), false);
  assert.equal(destination.searchParams.get("api"), mine);
  assert.equal(notificationDestination({ api_id: null, kind: "api_verified" }), "/profile?view=submissions");
});

test("new submission links select the API without ownership or status filters, including after verification", () => {
  assert.equal(notificationDestination({ api_id: mine, kind: "new_submission" }, "admin"), `/apis?api=${mine}`);
  assert.equal(notificationDestination({ api_id: null, kind: "new_submission" }, "admin"), "/apis");
  assert.equal(notificationDestination({ api_id: mine, kind: "api_verified" }, "admin"), `/apis?api=${mine}`);
  assert.equal(notificationDestination({ api_id: null, kind: "api_verified" }, "admin"), "/apis");
});

test("feedback and resubmission notifications take each role to the affected record", () => {
  assert.equal(notificationDestination({ api_id: mine, kind: "changes_requested" }, "publisher"), `/profile?view=submissions&api=${mine}`);
  assert.equal(notificationDestination({ api_id: mine, kind: "api_updated" }, "admin"), `/apis?api=${mine}`);
  assert.equal(notificationTitle({api_name:"Invoice API",kind:"changes_requested"}),"Changes requested: Invoice API");
  assert.equal(notificationTitle({api_name:"Invoice API",kind:"api_updated"}),"API updated: Invoice API");
});

test("the inbox shows settlements beside submission notices, and survives a deployment without migration 0035", async () => {
  const { route, settlements } = setup();
  settlements.push({
    id: "30000000-0000-4000-8000-000000000001",
    recipient_user_id: mine,
    source_api_id: "40000000-0000-4000-8000-000000000001",
    target_api_id: "40000000-0000-4000-8000-000000000002",
    source_api_name: "Source API", target_api_name: "Target API",
    target_path: "dueDate", option: "candidate", chosen_source_path: "issueDate",
    // Newer than every submission notice, so it heads the merged list.
    created_at: "2026-09-19T00:00:00Z", read_at: null,
  });
  const body = await (await route.GET(request())).json() as { notifications: ApiNotification[]; unread_count: number };
  assert.equal(body.notifications[0].kind, "conflict_settled");
  assert.equal(body.unread_count, 24, "unread counts both tables");
  assert.match(notificationTitle(body.notifications[0]), /dueDate now uses issueDate/);
  assert.equal(
    notificationDestination(body.notifications[0]),
    "/compatibility?source=40000000-0000-4000-8000-000000000001&target=40000000-0000-4000-8000-000000000002",
  );

  const older = setup();
  older.withoutSettlementsTable();
  const legacy = await (await older.route.GET(request())).json() as { notifications: unknown[]; unread_count: number };
  assert.equal(legacy.unread_count, 23, "a missing settlements table is not a failure");
  assert.equal(legacy.notifications.length, 20);
});
