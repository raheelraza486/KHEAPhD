import { test } from "node:test";
import assert from "node:assert/strict";
import { routeHarness } from "../helpers/route-harness.ts";

// A tiny PostgREST stand-in: six tables in memory, GET with eq./in. filters,
// POST appends to check_choice. Enough to run the real routes end to end.

const SRC = "11111111-1111-4111-8111-111111111111";
const TGT = "22222222-2222-4222-8222-222222222222";
const SRC_SCHEMA = "81111111-1111-4111-8111-111111111111";
const TGT_SCHEMA = "82222222-2222-4222-8222-222222222222";
const SRC_ALT_SCHEMA = "83333333-3333-4333-8333-333333333333";
const TGT_ALT_SCHEMA = "84444444-4444-4444-8444-444444444444";
const SRC_REQUEST_SCHEMA = "85555555-5555-4555-8555-555555555555";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function field(schema_id: string, path: string, json_type: string, is_required: boolean, format: string | null = null) {
  const leaf = path.split(".").at(-1)!.replace(/\[\]$/, "");
  return { schema_id, path, leaf_name: leaf, leaf_name_norm: leaf.toLowerCase().replace(/[^a-z0-9]/g, ""), json_type, format, is_required, is_array_item: false, depth: path.split(".").length - 1, enum_values: null, description: null };
}

function makeDb() {
  const tables: Record<string, Record<string, unknown>[]> = {
    apis: [
      { id: SRC, api_name: "Source", company_name: "Vendor A", category: "Validation", api_endpoint: null, http_method: "GET", input_formats: [], output_formats: ["JSON"], authentication_method: "Token", authentication_details: "", is_active: true, duplicate_of: null },
      { id: TGT, api_name: "Target", company_name: "Vendor B", category: "Communication", api_endpoint: null, http_method: "POST", input_formats: ["JSON"], output_formats: ["JSON"], authentication_method: "API Key", authentication_details: "", is_active: true, duplicate_of: null },
    ],
    format_alias: [{ alias: "JSON", canonical: "JSON" }],
    api_schema: [
      { id: SRC_SCHEMA, api_id: SRC, direction: "response", status_code: "200", media_type: "application/json", raw: { type: "object" }, verified_by: "r", content_hash: "src-v1" },
      { id: TGT_SCHEMA, api_id: TGT, direction: "request", status_code: null, media_type: "application/json", raw: { type: "object" }, verified_by: "r", content_hash: "tgt-v1" },
      { id: SRC_ALT_SCHEMA, api_id: SRC, direction: "response", status_code: "201", media_type: "application/json", raw: { type: "object" }, verified_by: "r", content_hash: "src-v2" },
      { id: TGT_ALT_SCHEMA, api_id: TGT, direction: "request", status_code: null, media_type: "application/json", raw: { type: "object" }, verified_by: "r", content_hash: "tgt-v2" },
      { id: SRC_REQUEST_SCHEMA, api_id: SRC, direction: "request", status_code: null, media_type: "application/json", raw: { type: "object" }, verified_by: "r", content_hash: "src-request-v1" },
    ],
    api_schema_field: [
      field(SRC_SCHEMA, "invoiceNumber", "string", true), field(SRC_SCHEMA, "issueDate", "string", true, "date"), field(SRC_SCHEMA, "totalAmount", "number", true),
      field(TGT_SCHEMA, "invoiceNumber", "string", true), field(TGT_SCHEMA, "dueDate", "string", true),
      field(SRC_ALT_SCHEMA, "selectedInvoice", "string", true), field(SRC_ALT_SCHEMA, "selectedDate", "string", true, "date"),
      field(TGT_ALT_SCHEMA, "selectedInvoice", "string", true), field(TGT_ALT_SCHEMA, "selectedDueDate", "string", true),
      field(SRC_REQUEST_SCHEMA, "wrongDirection", "string", true),
    ],
    api_parameter: [],
    check_choice: [] as Record<string, unknown>[],
    check_notification: [] as Record<string, unknown>[],
    v_check_choice_current: [] as Record<string, unknown>[],
  };
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url);
    const table = u.pathname.replace("/rest/v1/", "");
    if (init?.method === "POST") {
      // Route the insert by table: the settlement notices of 0035 are written
      // to check_notification, and must not land in the answer history.
      const target = (tables[table] ??= []);
      const payload = JSON.parse(String(init.body)) as unknown;
      const inserted = (Array.isArray(payload) ? payload : [payload]).map((row, index) => ({
        id: `${table}-${target.length + index + 1}`,
        chosen_at: new Date(2026, 8, 17, 0, target.length + index).toISOString(),
        created_at: new Date(2026, 8, 17, 0, target.length + index).toISOString(),
        ...(row as Record<string, unknown>),
      }));
      target.push(...inserted);
      return new Response(JSON.stringify(inserted), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    let rows = tables[table] ?? [];
    for (const [k, v] of u.searchParams) {
      if (["select", "limit", "offset", "order"].includes(k)) continue;
      if (v.startsWith("eq.")) rows = rows.filter((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith("in.(")) {
        const set = new Set(v.slice(4, -1).split(","));
        rows = rows.filter((r) => set.has(String(r[k])));
      }
    }
    const offset = Number(u.searchParams.get("offset") ?? 0);
    return new Response(JSON.stringify(rows.slice(offset, offset + 1000)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { tables, fetchImpl };
}

function withDb<T>(db: ReturnType<typeof makeDb>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = db.fetchImpl as typeof fetch;
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function authAs(id: string, role: "viewer" | "admin") {
  const user = { id, role, email: `${id}@x`, displayName: id };
  return {
    APP_ROLES: ["viewer", "publisher", "admin"],
    ADMIN_ROLES: ["admin"],
    getCurrentAppUser: async () => user,
    requireRole: async (_request: Request, allowed: readonly string[]) =>
      allowed.includes(role) ? { user } : { response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) },
  };
}

/** Nobody signed in: the report shows the check's own result, not other people's answers. */
const GUEST = {
  APP_ROLES: ["viewer", "publisher", "admin"],
  ADMIN_ROLES: ["admin"],
  getCurrentAppUser: async () => null,
  requireRole: async () => ({ response: new Response(JSON.stringify({ error: "sign in" }), { status: 401 }) }),
};

const HOST = "catalogue.example.test";
const post = (path: string, body: unknown) =>
  new Request(`https://${HOST}${path}`, { method: "POST", headers: { origin: `https://${HOST}`, host: HOST, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => new Request(`https://${HOST}${path}`, { headers: { host: HOST } });

test("GET /api/checks returns the report; validation and missing records are answered honestly", async () => {
  const db = makeDb();
  const route = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/route.ts");
  await withDb(db, async () => {
    const bad = await route.GET(get("/api/checks?source_id=x&target_id=y"));
    assert.equal(bad.status, 400);
    const missing = await route.GET(get(`/api/checks?source_id=${SRC}&target_id=33333333-3333-4333-8333-333333333333`));
    assert.equal(missing.status, 404);
    const ok = await route.GET(get(`/api/checks?source_id=${SRC}&target_id=${TGT}`));
    assert.equal(ok.status, 200);
    const { report } = (await ok.json()) as { report: { overall: { overall: string }; check2: { semantics: { not_found: { target_path: string }[] } } } };
    assert.equal(report.overall.overall, "pending_user");
    assert.deepEqual(report.check2.semantics.not_found.map((n) => n.target_path), ["dueDate"]);
  });
});

test("GET /api/checks uses the explicitly selected source and target schemas", async () => {
  const db = makeDb();
  const route = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/route.ts");
  await withDb(db, async () => {
    const response = await route.GET(
      get(`/api/checks?source_id=${SRC}&target_id=${TGT}&source_schema_id=${SRC_ALT_SCHEMA}&target_schema_id=${TGT_ALT_SCHEMA}`),
    );
    const payload = await response.json() as {
      report?: {
        check2: {
          schema: {
            source_schema_used: { schema_id: string } | null;
            target_schema_used: { schema_id: string } | null;
          };
          semantics: {
            not_found: Array<{ target_path: string; suggestions: Array<{ source_path: string }> }>;
          } | null;
        };
      };
      error?: string;
    };
    assert.equal(response.status, 200, payload.error);
    assert.equal(payload.report?.check2.schema.source_schema_used?.schema_id, SRC_ALT_SCHEMA);
    assert.equal(payload.report?.check2.schema.target_schema_used?.schema_id, TGT_ALT_SCHEMA);
    assert.deepEqual(payload.report?.check2.semantics?.not_found.map((item) => item.target_path).sort(), ["selectedDueDate", "selectedInvoice"].sort(),);
    assert.equal(JSON.stringify(payload.report).includes("dueDate"), false, "the unselected target schema must not participate");
  });
});

test("GET /api/checks rejects schemas from the wrong API or direction", async () => {
  const db = makeDb();
  const route = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/route.ts");
  await withDb(db, async () => {
    const wrongOwner = await route.GET(get(`/api/checks?source_id=${SRC}&target_id=${TGT}&source_schema_id=${TGT_SCHEMA}`));
    assert.equal(wrongOwner.status, 400, "a target-owned schema cannot be selected as source");
    const wrongDirection = await route.GET(get(`/api/checks?source_id=${SRC}&target_id=${TGT}&source_schema_id=${SRC_REQUEST_SCHEMA}`));
    assert.equal(wrongDirection.status, 400, "a request schema cannot be selected as source output");
    const malformed = await route.GET(get(`/api/checks?source_id=${SRC}&target_id=${TGT}&source_schema_id=not-a-uuid`));
    assert.equal(malformed.status, 400);
  });
});

test("preview and saved answers use the explicitly selected schema pair", async () => {
  const db = makeDb();
  const preview = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/preview-answers/route.ts");
  const answers = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/answers/route.ts");
  await withDb(db, async () => {
    const choice = {
      source_id: SRC,
      target_id: TGT,
      source_schema_id: SRC_ALT_SCHEMA,
      target_schema_id: TGT_ALT_SCHEMA,
      target_path: "selectedDueDate",
      option: "external",
    };
    const previewResponse = await preview.POST(post("/api/checks/preview-answers", { choices: [choice] }));
    const previewPayload = await previewResponse.json() as {
      report?: {
        check2: {
          schema: {
            source_schema_used: { schema_id: string } | null;
            target_schema_used: { schema_id: string } | null;
          };
        };
      };
      error?: string;
    };
    assert.equal(previewResponse.status, 200, previewPayload.error);
    assert.equal(previewPayload.report?.check2.schema.source_schema_used?.schema_id, SRC_ALT_SCHEMA);
    assert.equal(previewPayload.report?.check2.schema.target_schema_used?.schema_id, TGT_ALT_SCHEMA);
    assert.equal(db.tables.check_choice.length, 0, "preview must not write answer history");
    const saveResponse = await answers.POST(post("/api/checks/answers", choice));
    const savePayload = await saveResponse.json() as {
      report?: {
        check2: {
          schema: {
            source_schema_used: { schema_id: string } | null;
            target_schema_used: { schema_id: string } | null;
          };
        };
      };
      error?: string;
    };
    assert.equal(saveResponse.status, 200, savePayload.error);
    assert.equal(db.tables.check_choice.length, 1);
    assert.equal(db.tables.check_choice[0].source_content_hash, "src-v2");
    assert.equal(db.tables.check_choice[0].target_content_hash, "tgt-v2");
    assert.equal(savePayload.report?.check2.schema.source_schema_used?.schema_id, SRC_ALT_SCHEMA);
    assert.equal(savePayload.report?.check2.schema.target_schema_used?.schema_id, TGT_ALT_SCHEMA);
  });
});

test("POST /api/checks/preview-answers recomputes without writing answer history", async () => {
  const db = makeDb();
  const route = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/preview-answers/route.ts");
  await withDb(db, async () => {
    const response = await route.POST(post("/api/checks/preview-answers", {
      choices: [{ source_id: SRC, target_id: TGT, target_path: "dueDate", option: "external" }],
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { preview: boolean; report: { overall: { overall: string }; check2: { semantics: { applied: { target_path: string; option: string }[] } } } };
    assert.equal(payload.preview, true);
    assert.equal(payload.report.overall.overall, "pass");
    assert.deepEqual(payload.report.check2.semantics.applied.map((item) => [item.target_path, item.option]), [["dueDate", "external"]]);
    assert.equal(db.tables.check_choice.length, 0, "a preview must never write check_choice");
  });
});

test("POST /api/checks/preview-answers rejects invalid and automatically determined fields", async () => {
  const db = makeDb();
  const route = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/preview-answers/route.ts");
  await withDb(db, async () => {
    const invalid = await route.POST(post("/api/checks/preview-answers", { choices: [] }));
    assert.equal(invalid.status, 400);
    const determined = await route.POST(post("/api/checks/preview-answers", {
      choices: [{ source_id: SRC, target_id: TGT, target_path: "invoiceNumber", option: "none" }],
    }));
    assert.equal(determined.status, 409);
    assert.equal(db.tables.check_choice.length, 0);
  });
});

test("POST /api/checks/answers appends a user answer with the current hashes and recomputes; a second user's different answer creates a conflict; the administrator settles it", async () => {
  const db = makeDb();
  const answersA = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/answers/route.ts");
  const answersB = routeHarness({ "@/lib/auth": authAs(USER_B, "viewer") })("app/api/checks/answers/route.ts");
  const settle = routeHarness({ "@/lib/auth": authAs(ADMIN, "admin") })("app/api/checks/settle/route.ts");
  const settleAsViewer = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/settle/route.ts");
  await withDb(db, async () => {
    const a = await answersA.POST(post("/api/checks/answers", { source_id: SRC, target_id: TGT, target_path: "dueDate", option: "external" }));
    assert.equal(a.status, 200);
    let { report } = (await a.json()) as { report: { overall: { overall: string }; check2: { semantics: { applied: unknown[]; conflicts: unknown[] } } } };
    assert.equal(report.overall.overall, "pass");
    assert.equal(db.tables.check_choice.length, 1);
    assert.equal(db.tables.check_choice[0].kind, "user");
    assert.equal(db.tables.check_choice[0].chosen_by, USER_A);
    assert.equal(db.tables.check_choice[0].source_content_hash, "src-v1");
    assert.equal(db.tables.check_choice[0].target_content_hash, "tgt-v1");
    assert.equal(db.tables.check_choice[0].target_name_norm, "duedate");

    const b = await answersB.POST(post("/api/checks/answers", { source_id: SRC, target_id: TGT, target_path: "dueDate", option: "candidate", chosen_source_path: "issueDate" }));
    assert.equal(b.status, 200);
    ({ report } = (await b.json()) as typeof report extends infer R ? { report: R } : never);
    assert.equal(report.overall.overall, "pending_admin");
    assert.equal(report.check2.semantics.conflicts.length, 1);

    const refused = await answersA.POST(post("/api/checks/answers", { source_id: SRC, target_id: TGT, target_path: "dueDate", option: "none" }));
    assert.equal(refused.status, 409, "users cannot answer a field awaiting an administrator");

    const notAdmin = await settleAsViewer.POST(post("/api/checks/settle", { source_id: SRC, target_id: TGT, target_path: "dueDate", option: "external" }));
    assert.equal(notAdmin.status, 403);

    const s = await settle.POST(post("/api/checks/settle", { source_id: SRC, target_id: TGT, target_path: "dueDate", option: "external", note: "out-of-chain input" }));
    assert.equal(s.status, 200);
    ({ report } = (await s.json()) as typeof report extends infer R ? { report: R } : never);
    assert.equal(report.overall.overall, "pass");
    assert.equal(db.tables.check_choice.at(-1)?.kind, "admin");
    assert.equal(db.tables.check_choice.length, 3, "the table is append-only");
    // Both users who answered are told; the settling administrator is not.
    assert.deepEqual(db.tables.check_notification.map((n) => n.recipient_user_id).sort(), [USER_A, USER_B].sort());
    assert.equal(db.tables.check_notification[0].kind, "conflict_settled");
    assert.equal(db.tables.check_notification[0].option, "external");
    assert.equal(db.tables.check_notification[0].target_path, "dueDate");
  });
});

test("POST /api/checks/answers rejects cross-origin, malformed and out-of-scope answers", async () => {
  const db = makeDb();
  const route = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/answers/route.ts");
  await withDb(db, async () => {
    const cross = await route.POST(new Request(`https://${HOST}/api/checks/answers`, { method: "POST", headers: { origin: "https://evil.example", host: HOST }, body: "{}" }));
    assert.equal(cross.status, 403);
    const malformed = await route.POST(post("/api/checks/answers", { source_id: SRC, target_id: TGT, target_path: "dueDate", option: "candidate" }));
    assert.equal(malformed.status, 400);
    const notAsked = await route.POST(post("/api/checks/answers", { source_id: SRC, target_id: TGT, target_path: "invoiceNumber", option: "none" }));
    assert.equal(notAsked.status, 409, "invoiceNumber was determined automatically and is not open for an answer");
    const unknownSource = await route.POST(post("/api/checks/answers", { source_id: SRC, target_id: TGT, target_path: "dueDate", option: "candidate", chosen_source_path: "nope" }));
    assert.equal(unknownSource.status, 400);
    assert.equal(db.tables.check_choice.length, 0);
  });
});

function answerRow(over: Record<string, unknown>) {
  return {
    id: `seed-${Math.random().toString(16).slice(2)}`,
    source_api_id: SRC, target_api_id: TGT, target_path: "dueDate", target_name_norm: "duedate",
    kind: "user", option: "external", chosen_source_path: null, chosen_source_norm: "",
    source_content_hash: "src-v1", target_content_hash: "tgt-v1",
    chosen_by: USER_A, chosen_at: "2026-09-17T00:01:00Z", note: "",
    ...over,
  };
}

test("GET /api/checks/conflicts runs the checks over the answered pairs rather than reading the view", async () => {
  const db = makeDb();
  // Two users answering the same field differently: the pair is in conflict.
  db.tables.check_choice.push(answerRow({ chosen_by: USER_A }));
  db.tables.check_choice.push(answerRow({ chosen_by: USER_B, option: "candidate", chosen_source_path: "issueDate", chosen_source_norm: "issuedate", chosen_at: "2026-09-17T00:02:00Z" }));
  // The view is deliberately left empty: the list must not depend on it.
  const admin = routeHarness({ "@/lib/auth": authAs(ADMIN, "admin") })("app/api/checks/conflicts/route.ts");
  const viewer = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/conflicts/route.ts");
  await withDb(db, async () => {
    assert.equal((await viewer.GET(get("/api/checks/conflicts"))).status, 403);
    const res = await admin.GET(get("/api/checks/conflicts"));
    assert.equal(res.status, 200);
    const list = (await res.json()) as { conflicts: { target_path: string; target_api_name: string; answers: unknown[] }[]; pairs: number; complete: boolean };
    assert.deepEqual(list.conflicts.map((c) => c.target_path), ["dueDate"]);
    assert.equal(list.conflicts[0].target_api_name, "Target", "the list carries the names, so the page needs no second call");
    assert.equal(list.conflicts[0].answers.length, 2);
    assert.equal(list.pairs, 1);
    assert.equal(list.complete, true);
  });
});

test("GET /api/checks/conflicts reports nothing when the saved answers agree", async () => {
  const db = makeDb();
  db.tables.check_choice.push(answerRow({ chosen_by: USER_A }));
  db.tables.check_choice.push(answerRow({ chosen_by: USER_B, chosen_at: "2026-09-17T00:02:00Z" }));
  const admin = routeHarness({ "@/lib/auth": authAs(ADMIN, "admin") })("app/api/checks/conflicts/route.ts");
  await withDb(db, async () => {
    const res = await admin.GET(get("/api/checks/conflicts"));
    const list = (await res.json()) as { conflicts: unknown[]; pairs: number };
    assert.deepEqual(list.conflicts, []);
    assert.equal(list.pairs, 0);
  });
});

test("a visitor is shown the check's own result: other people's saved answers are not applied and no field is held for review", async () => {
  const db = makeDb();
  // Two users disagree about dueDate: for them the pair waits for an administrator.
  db.tables.check_choice.push(answerRow({ chosen_by: USER_A }));
  db.tables.check_choice.push(answerRow({ chosen_by: USER_B, option: "candidate", chosen_source_path: "issueDate", chosen_source_norm: "issuedate", chosen_at: "2026-09-17T00:02:00Z" }));

  const signedIn = routeHarness({ "@/lib/auth": authAs(USER_A, "viewer") })("app/api/checks/route.ts");
  const visitor = routeHarness({ "@/lib/auth": GUEST })("app/api/checks/route.ts");

  await withDb(db, async () => {
    const asUser = await (await signedIn.GET(get(`/api/checks?source_id=${SRC}&target_id=${TGT}`))).json() as
      { report: { overall: { overall: string }; check2: { semantics: { conflicts: unknown[]; not_found: { target_path: string }[]; applied: unknown[] } } } };
    assert.equal(asUser.report.overall.overall, "pending_admin");
    assert.equal(asUser.report.check2.semantics.conflicts.length, 1);

    const asVisitor = await (await visitor.GET(get(`/api/checks?source_id=${SRC}&target_id=${TGT}`))).json() as typeof asUser;
    assert.equal(asVisitor.report.overall.overall, "pending_user", "for a visitor the field is simply undecided");
    assert.deepEqual(asVisitor.report.check2.semantics.conflicts, [], "no review detail reaches a visitor");
    assert.deepEqual(asVisitor.report.check2.semantics.applied, []);
    assert.deepEqual(asVisitor.report.check2.semantics.not_found.map((f) => f.target_path), ["dueDate"],
      "and the field is offered again, with its candidates, so nothing silently disappears");
  });
});
