import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ADMIN_ROLES, SUBMITTER_ROLES, type AppRole } from "../lib/auth-policy.ts";
import { routeHarness } from "./helpers/route-harness.ts";

const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const apiId = "20000000-0000-4000-8000-000000000001";
const claimId = "30000000-0000-4000-8000-000000000001";

function setup(t: TestContext, role: AppRole = "publisher", createdBy = owner) {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = "https://database.example.test";
  process.env.SUPABASE_SECRET_KEY = "test-only";
  t.after(() => {
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = oldKey;
  });
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://database.example.test");
    if (url.pathname.endsWith("/apis")) return Response.json([{
      id: apiId, created_by_user: createdBy, is_active: true, duplicate_of: null,
    }]);
    if (init.method === "POST" || init.method === "PATCH") {
      const saved = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push({ method: init.method, body: saved });
      return Response.json([{ id: claimId, ...saved }]);
    }
    return Response.json([]);
  });
  const user = { id: owner, role, displayName: "Tester", email: "tester@example.test" };
  const route = routeHarness({ "@/lib/auth": {
    ADMIN_ROLES, SUBMITTER_ROLES,
    requireRole: async (_request: Request, allowed: readonly AppRole[]) =>
      allowed.includes(user.role) ? { user } : { response: Response.json({}, { status: 403 }) },
  } })("app/api/invoice-standard-capabilities/route.ts");
  return { route, writes };
}

function request(method: string, body: unknown) {
  return new Request("https://catalogue.example.test/api/invoice-standard-capabilities", {
    method,
    headers: { host: "catalogue.example.test", origin: "https://catalogue.example.test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const claim = {
  api_id: apiId, direction: "output", standard: "XRechnung", version: "3.0",
  evidence_url: "https://provider.example/spec", status: "confirmed", reviewed_by: owner,
};

test("a publisher's manual entry is always reported, even if it claims confirmation", async (t) => {
  const { route, writes } = setup(t);
  const response = await route.POST(request("POST", claim));
  assert.equal(response.status, 201);
  assert.equal(writes[0].body.status, "reported");
  assert.equal(writes[0].body.submitted_by, owner);
  assert.equal("reviewed_by" in writes[0].body, false);
  assert.equal((await response.json()).usable_for_matching, false);
});

test("a publisher cannot claim another publisher's API or confirm any claim", async (t) => {
  const { route, writes } = setup(t, "publisher", other);
  assert.equal((await route.POST(request("POST", claim))).status, 403);
  assert.equal((await route.PATCH(request("PATCH", { id: claimId, decision: "confirmed", evidence_url: claim.evidence_url }))).status, 403);
  assert.equal(writes.length, 0);
});

test("admin review requires a source, and only a reported claim can be confirmed", async (t) => {
  const { route, writes } = setup(t, "admin", other);
  assert.equal((await route.PATCH(request("PATCH", { id: claimId, decision: "confirmed" }))).status, 400);
  const response = await route.PATCH(request("PATCH", { id: claimId, decision: "confirmed", evidence_url: "https://provider.example/spec" }));
  assert.equal(response.status, 200);
  assert.equal(writes[0].body.status, "confirmed");
  assert.equal(writes[0].body.reviewed_by, owner);
  assert.equal((await response.json()).usable_for_matching, true);
});
