import assert from "node:assert/strict";
import test from "node:test";
import { workflowNameFromLabel } from "../lib/saved-chains.ts";
import { routeHarness } from "./helpers/route-harness.ts";

const owner = "10000000-0000-4000-8000-000000000001";
const chainId = "30000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-00000000000a";
const B = "20000000-0000-4000-8000-00000000000b";

type Call = { table: string; op: string; values?: unknown; options?: unknown; filters: [string, unknown][]; ids?: string[] };

function setup({ signedIn = true, catalogue = [A, B], writeError = null as { code: string } | null, updated = true } = {}) {
  const calls: Call[] = [];
  const revalidated: string[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      calls.push(call);
      const query = {
        select() { return query; },
        in(_: string, ids: string[]) { call.ids = ids; return query; },
        eq(key: string, value: unknown) { call.filters.push([key, value]); return query; },
        upsert(values: unknown, options: unknown) { call.op = "upsert"; call.values = values; call.options = options; return query; },
        update(values: unknown) { call.op = "update"; call.values = values; return query; },
        delete() { call.op = "delete"; return query; },
        maybeSingle() { return query; },
        then(resolve: (result: unknown) => unknown) {
          if (table === "v_catalogue") {
            return Promise.resolve(resolve({ error: null, data: catalogue.filter((id) => call.ids?.includes(id)).map((id) => ({ id })) }));
          }
          if (writeError) return Promise.resolve(resolve({ error: writeError, data: null }));
          return Promise.resolve(resolve({ error: null, data: call.op === "upsert" ? null : updated ? { id: chainId } : null }));
        },
      };
      return query;
    },
  };
  const load = routeHarness({
    "next/cache": { revalidatePath: (path: string) => revalidated.push(path) },
    "@/lib/auth": { getCurrentAppUser: async () => (signedIn ? { id: owner, role: "publisher" } : null) },
    "@/lib/supabase/server": { createSupabaseServerClient: async () => db },
  });
  const actions = load("app/profile/actions.ts") as unknown as {
    saveChain: (state: object, form: FormData) => Promise<{ error?: string; saved?: boolean }>;
    updateSavedChain: (state: object, form: FormData) => Promise<{ error?: string; saved?: boolean }>;
  };
  return { ...actions, calls, revalidated, writes: () => calls.filter((call) => call.table === "saved_chain") };
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

test("saving keeps the API order and ignores a repeated save of the same chain", async () => {
  const { saveChain, writes, revalidated } = setup();
  const result = await saveChain({}, form({ name: "  Australian invoice delivery ", api_ids: `${B.toUpperCase()},${A}` }));
  assert.deepEqual(result, { saved: true });
  const [write] = writes();
  assert.equal(write.op, "upsert");
  assert.deepEqual(write.values, { name: "Australian invoice delivery", api_ids: [B, A] });
  assert.deepEqual(write.options, { onConflict: "owner_id,name,api_ids", ignoreDuplicates: true });
  assert.deepEqual(revalidated, ["/profile"]);
});

test("saving refuses a missing name, a bad chain or a guest before writing", async () => {
  const cases: [Record<string, string>, RegExp, boolean?][] = [
    [{ name: " ", api_ids: A }, /chain name/],
    [{ name: "x".repeat(121), api_ids: A }, /chain name/],
    [{ name: "Chain", api_ids: "" }, /valid API chain/],
    [{ name: "Chain", api_ids: `${A},not-a-uuid` }, /valid API chain/],
    [{ name: "Chain", api_ids: [A, B, A, B, A].join(",") }, /valid API chain/],
    [{ name: "Chain", api_ids: A }, /Sign in/, false],
  ];
  for (const [values, message, signedIn = true] of cases) {
    const { saveChain, writes } = setup({ signedIn });
    const result = await saveChain({}, form(values));
    assert.match(result.error ?? "", message);
    assert.equal(writes().length, 0);
  }
});

test("saving refuses an API that has left the catalogue", async () => {
  const { saveChain, writes } = setup({ catalogue: [A] });
  const result = await saveChain({}, form({ name: "Chain", api_ids: `${A},${B}` }));
  assert.match(result.error ?? "", /no longer available/);
  assert.equal(writes().length, 0);
});

test("saving explains a database without the saved chains migration", async () => {
  const { saveChain } = setup({ writeError: { code: "PGRST205" } });
  const result = await saveChain({}, form({ name: "Chain", api_ids: A }));
  assert.match(result.error ?? "", /migration \(0056\)/);
});

test("rename and delete act only on the signed-in owner's chain", async () => {
  for (const intent of ["rename", "delete"] as const) {
    const { updateSavedChain, writes } = setup();
    const result = await updateSavedChain({}, form({ id: chainId, intent, name: "New name" }));
    assert.deepEqual(result, { saved: true });
    const [write] = writes();
    assert.equal(write.op, intent === "rename" ? "update" : "delete");
    if (intent === "rename") assert.deepEqual(write.values, { name: "New name" });
    assert.deepEqual(write.filters, [["id", chainId], ["owner_id", owner]]);
  }
});

test("rename reports a name clash, a missing chain and a bad request", async () => {
  assert.match((await setup({ writeError: { code: "23505" } }).updateSavedChain({}, form({ id: chainId, intent: "rename", name: "Taken" }))).error ?? "", /already saved/);
  assert.match((await setup({ updated: false }).updateSavedChain({}, form({ id: chainId, intent: "delete" }))).error ?? "", /unavailable/);
  assert.match((await setup().updateSavedChain({}, form({ id: "x", intent: "delete" }))).error ?? "", /Choose a saved chain/);
  assert.match((await setup().updateSavedChain({}, form({ id: chainId, intent: "rename", name: "" }))).error ?? "", /chain name/);
  assert.match((await setup({ signedIn: false }).updateSavedChain({}, form({ id: chainId, intent: "delete" }))).error ?? "", /Sign in/);
});

test("a saved chain's label becomes a readable workflow name", () => {
  assert.equal(workflowNameFromLabel("Australian invoice delivery"), "Australian-invoice-delivery");
  assert.equal(workflowNameFromLabel("  PDF → UBL / AU rules  "), "PDF-UBL-AU-rules");
  assert.equal(workflowNameFromLabel("BP-Upbrains_ESS"), "BP-Upbrains_ESS");
  assert.equal(workflowNameFromLabel("x".repeat(100)).length, 80);
});
