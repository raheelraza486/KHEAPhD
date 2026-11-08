import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthenticatedAppUser } from "../lib/auth-policy.ts";
import { normalizeApiRecord, type ApiRecord } from "../lib/types.ts";
import { componentHarness } from "./helpers/component-harness.ts";

const load = componentHarness();
const SiteHeader = load("components/site-header.tsx").default as ComponentType<{
  active: "compatibility" | "apis" | "profile";
  user: AuthenticatedAppUser | null;
  apiView?: "all" | "awaiting";
}>;
const rowsFromMetadataWorksheet = load("components/admin-metadata-bulk-update.tsx")
  .rowsFromMetadataWorksheet as (table: unknown[][]) => Array<Record<string, unknown>>;

test("the metadata workbook reader accepts the audit headers and source URL fallback", () => {
  const rows = rowsFromMetadataWorksheet([
    ["Metadata completion sheet"],
    ["API ID", "API / Operation Name", "Supabase Column", "Proposed Value", "Evidence", "Official Documentation URL", "Source URL", "Notes"],
    ["20000000-0000-4000-8000-000000000001", "Invoice API", "network", "Peppol", "Official guide", "", "https://example.test/docs", "Checked"],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_row, 3);
  assert.equal(rows[0].evidence_url, "https://example.test/docs");
});

test("metadata list clears retain their marker and worksheet row after blank rows", () => {
  const rows = rowsFromMetadataWorksheet([
    ["Metadata completion sheet"], [],
    ["API ID", "Supabase Column", "Proposed Value", "Evidence", "Official Documentation URL"],
    [],
    ["20000000-0000-4000-8000-000000000001", "input_formats", "[]", "No request body", "https://example.test/docs"],
    [],
    ["20000000-0000-4000-8000-000000000002", "output_formats", "", "Unfilled cell", "https://example.test/docs"],
  ]);
  assert.deepEqual(rows.map((row) => [row.source_row, row.proposed_value]), [[5, "[]"], [7, ""]]);
});

for (const role of ["viewer", "publisher"] as const) {
  test(`comparison navigation shows Profile in the account controls for ${role}`, () => {
    const html = renderToStaticMarkup(createElement(SiteHeader, {
      active: "compatibility",
      user: { id: "test-user", email: "member@example.test", displayName: "Member", role },
    }));
    assert.match(html, /aria-label="Account navigation"[\s\S]*?href="\/profile"[^>]*>[\s\S]*?<span>My Profile<\/span>/);
    assert.match(html, /<div class="sidebar-account-identity">[\s\S]*?<strong title="Member">Member<\/strong>/);
    assert.doesNotMatch(html, /href="\/apis\?scope=mine"/);
    assert.match(html, /<summary aria-label="Inbox"><svg[\s\S]*?<\/svg>Inbox<\/summary>/);
    assert.match(html, /href="\/compatibility" aria-current="page"/);
    assert.equal(html.includes('href="/submit"'), role !== "viewer");
  });
}

test("admin navigation keeps a submission inbox without personal submission links", () => {
  const html = renderToStaticMarkup(createElement(SiteHeader, {
    active: "compatibility",
    user: { id: "admin", email: "admin@example.test", displayName: "Admin", role: "admin" },
  }));
  assert.match(html, /<summary aria-label="Inbox"><svg[\s\S]*?<\/svg>Inbox<\/summary>/);
  assert.match(html, /New API submissions from users\./);
  assert.match(html, /href="\/apis\?status=Published">View awaiting verification<\/a>/);
  assert.match(html, /href="\/submit"/);
  assert.doesNotMatch(html, /scope=mine|[Mm]y submissions|Updates about APIs you submitted/);
});

test("My Profile is the current account navigation item on the profile page", () => {
  const html = renderToStaticMarkup(createElement(SiteHeader, {
    active: "profile",
    user: { id: "test-user", email: "member@example.test", displayName: "Member", role: "publisher" },
  }));
  assert.match(html, /href="\/profile" aria-current="page"/);
  assert.match(html, /<button class="sidebar-account-row" type="button">[\s\S]*?<span>Log out<\/span><\/button>/);
});

test("admin awaiting-verification navigation marks the sidebar destination, not All APIs", () => {
  const html = renderToStaticMarkup(createElement(SiteHeader, {
    active: "apis",
    apiView: "awaiting",
    user: { id: "admin", email: "admin@example.test", displayName: "Admin", role: "admin" },
  }));
  assert.match(html, /href="\/apis\?status=Published" aria-current="page"/);
  assert.doesNotMatch(html, /href="\/apis" aria-current="page"/);
});

test("signed-out comparison navigation keeps login and hides personal account controls", () => {
  const html = renderToStaticMarkup(createElement(SiteHeader, { active: "compatibility", user: null }));
  assert.match(html, /href="\/compatibility" aria-current="page"/);
  assert.match(html, /href="\/login"/);
  assert.doesNotMatch(html, /href="\/profile"|My submissions|aria-label="Inbox"/);
});

test("an admin opening an old My submissions URL still sees other users' APIs and catalogue links", () => {
  const ApiRepository = load("components/api-repository.tsx").default as ComponentType<{
    initialRecords: ApiRecord[]; initialScope: "mine"; initialApiId: string; userId: string; role: "admin";
  }>;
  const html = renderToStaticMarkup(createElement(ApiRepository, {
    initialRecords: [normalizeApiRecord({
      id: "user-api", api_name: "User submitted API", company_name: "Provider", category: "Other",
      created_by_user: "publisher", is_active: true, review_status: "Published",
    })],
    initialScope: "mine", initialApiId: "deleted-api", userId: "admin", role: "admin",
  }));
  assert.match(html, /<h1>All APIs<\/h1>/);
  assert.match(html, /User submitted API/);
  assert.match(html, /href="\/apis">View all APIs<\/a>/);
  assert.doesNotMatch(html, /[Mm]y submissions|scope=mine/);
});

const ApiRepository = load("components/api-repository.tsx").default as ComponentType<{
  initialRecords: ApiRecord[]; initialApiId: string; userId: string;
  role: "publisher" | "admin";
}>;

test("the metadata workbook overwrite is visible only to administrators", () => {
  const record = normalizeApiRecord({
    id: "listed-api", api_name: "Listed API", company_name: "Provider", category: "Validation",
    created_by_user: "current-user", is_active: true, review_status: "Published",
  });
  const adminHtml = renderToStaticMarkup(createElement(ApiRepository, {
    initialRecords: [record], initialApiId: "", userId: "current-user", role: "admin",
  }));
  const publisherHtml = renderToStaticMarkup(createElement(ApiRepository, {
    initialRecords: [record], initialApiId: "", userId: "current-user", role: "publisher",
  }));
  assert.match(adminHtml, /Bulk update API metadata/);
  assert.match(adminHtml, /aria-label="Repository actions"/);
  assert.doesNotMatch(adminHtml, />All APIs<\/button>|>Awaiting verification \(\d+\)<\/button>/);
  assert.doesNotMatch(publisherHtml, /Bulk update API metadata/);
});

for (const role of ["publisher", "admin"] as const) {
  test(`a missing API link never substitutes another record's edit controls for ${role}`, () => {
    const html = renderToStaticMarkup(createElement(ApiRepository, {
      initialRecords: [normalizeApiRecord({
        id: "other-api", api_name: "Another API", company_name: "Provider", category: "Other",
        created_by_user: "current-user", is_active: true, review_status: "Published",
      })],
      initialApiId: "removed-api", userId: "current-user", role,
    }));
    assert.match(html, /Another API/);
    assert.match(html, /The linked API is unavailable in this view/);
    assert.doesNotMatch(html, /detail-header|>Edit API<|>Delete API<|>Update status</);
  });
}

for (const scenario of [
  { role: "publisher", owner: "current-user", manage: true, verify: false },
  { role: "publisher", owner: "someone-else", manage: false, verify: false },
  { role: "admin", owner: "someone-else", manage: true, verify: true },
] as const) {
  test(`${scenario.role} sees management actions only for allowed records owned by ${scenario.owner}`, () => {
    const html = renderToStaticMarkup(createElement(ApiRepository, {
      initialRecords: [normalizeApiRecord({
        id: "linked-api", api_name: "Linked API", company_name: "Provider", category: "Other",
        created_by_user: scenario.owner, is_active: true, review_status: "Published",
      })],
      initialApiId: "linked-api", userId: "current-user", role: scenario.role,
    }));
    assert.match(html, /<h1[^>]*>Linked API<\/h1>/);
    assert.equal(html.includes(">Edit API<"), scenario.manage);
    assert.equal(html.includes(">Delete API<"), false);
    assert.equal(html.includes(">Update status<"), scenario.verify);
  });
}
