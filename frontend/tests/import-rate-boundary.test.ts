import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { APP_ROLES, ADMIN_ROLES, SUBMITTER_ROLES, type AppRole } from "../lib/auth-policy.ts";
import { routeHarness } from "./helpers/route-harness.ts";

const USER_ID = "10000000-0000-4000-8000-000000000001";

function setup(t: TestContext, session?: Record<string, unknown>) {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "test-only";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = previousKey;
  });

  const rateLimitCalls: string[] = [];
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return Response.json(session ? [session] : []);
  });

  const user = {
    id: USER_ID,
    role: "publisher" as AppRole,
    displayName: "Publisher",
    email: "publisher@example.test",
  };
  const load = routeHarness({
    "@/lib/auth": {
      APP_ROLES,
      ADMIN_ROLES,
      SUBMITTER_ROLES,
      getCurrentAppUser: async () => user,
      requireRole: async () => ({ user }),
    },
    "@/lib/mutation-rate-limit": {
      checkMutationRateLimit: (action: string) => {
        rateLimitCalls.push(action);
        return 42;
      },
    },
  });

  return {
    route: load("app/api/import/route.ts"),
    rateLimitCalls,
    fetchCalls: () => fetchCalls,
  };
}

function request(body: Record<string, unknown>) {
  return new Request("https://catalogue.example.test/api/import", {
    method: "POST",
    headers: {
      origin: "https://catalogue.example.test",
      host: "catalogue.example.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("a new import preview is rate-limited before any remote fetch", async (t) => {
  const { route, rateLimitCalls, fetchCalls } = setup(t);
  const response = await route.POST(request({ url: "https://provider.example.test/openapi.json" }));

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "42");
  assert.deepEqual(rateLimitCalls, ["import"]);
  assert.equal(fetchCalls(), 0);
});

test("a one-use preview confirmation does not consume another import slot", async (t) => {
  const { route, rateLimitCalls, fetchCalls } = setup(t);
  const response = await route.POST(request({
    sessionId: "30000000-0000-4000-8000-000000000001",
    selected: [0],
  }));

  assert.equal(response.status, 410);
  assert.deepEqual(rateLimitCalls, []);
  assert.equal(fetchCalls(), 1);
});

test("confirmation rejects a batch larger than 100 before any catalogue write", async (t) => {
  const item = {
    candidate: {},
    row: {},
    predicted_outcome: "insert",
  };
  const session = {
    id: "30000000-0000-4000-8000-000000000001",
    documentation_url: "https://provider.example.test/openapi.json",
    outcome: "previewed",
    created_by_user: USER_ID,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    candidates: JSON.stringify({ items: Array.from({ length: 101 }, () => item) }),
  };
  const { route, rateLimitCalls, fetchCalls } = setup(t, session);
  const response = await route.POST(request({
    sessionId: session.id,
    selected: Array.from({ length: 101 }, (_, index) => index),
  }));
  const body = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.match(body.error, /no more than 100 operations/);
  assert.deepEqual(rateLimitCalls, []);
  assert.equal(fetchCalls(), 1);
});
