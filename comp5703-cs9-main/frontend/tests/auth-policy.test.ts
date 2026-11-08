import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_ROLES,
  SUBMITTER_ROLES,
  authenticatedUserFromProfile,
  bearerTokenFromRequest,
  hasAllowedRole,
  ownsImportSession,
} from "../lib/auth-policy.ts";

test("bearerTokenFromRequest accepts a well-formed bearer token", () => {
  const request = new Request("https://catalogue.example/api", {
    headers: { Authorization: "Bearer verified.jwt.token" },
  });
  assert.equal(bearerTokenFromRequest(request), "verified.jwt.token");
});

test("bearerTokenFromRequest rejects ambiguous authorization values", () => {
  assert.equal(bearerTokenFromRequest(new Request("https://catalogue.example")), null);
  assert.equal(bearerTokenFromRequest(new Request("https://catalogue.example", {
    headers: { Authorization: "Basic abc" },
  })), null);
  assert.equal(bearerTokenFromRequest(new Request("https://catalogue.example", {
    headers: { Authorization: "Bearer one two" },
  })), null);
});

test("an active profile supplies a trusted actor name and role", () => {
  assert.deepEqual(
    authenticatedUserFromProfile(
      { id: "user-1", email: "identity@example.com" },
      {
        id: "user-1",
        email: "profile@example.com",
        display_name: "  Catalogue User  ",
        role: "publisher",
        is_active: true,
      },
    ),
    {
      id: "user-1",
      email: "profile@example.com",
      displayName: "Catalogue User",
      role: "publisher",
    },
  );
});

test("missing, inactive, mismatched and unknown-role profiles fail closed", () => {
  const identity = { id: "user-1", email: "person@example.com" };
  assert.equal(authenticatedUserFromProfile(identity, null), null);
  assert.equal(authenticatedUserFromProfile(identity, {
    id: "user-1", role: "publisher", is_active: false,
  }), null);
  assert.equal(authenticatedUserFromProfile(identity, {
    id: "user-2", role: "publisher", is_active: true,
  }), null);
  assert.equal(authenticatedUserFromProfile(identity, {
    id: "user-1", role: "owner", is_active: true,
  }), null);
});

test("the trusted actor snapshot stays within the database attribution limit", () => {
  const user = authenticatedUserFromProfile(
    { id: "user-1", email: "identity@example.com" },
    {
      id: "user-1",
      display_name: "x".repeat(150),
      role: "admin",
      is_active: true,
    },
  );
  assert.equal(user?.displayName.length, 120);
});

test("publisher may submit while verification remains admin-only", () => {
  assert.equal(hasAllowedRole("publisher", SUBMITTER_ROLES), true);
  assert.equal(hasAllowedRole("viewer", SUBMITTER_ROLES), false);
  assert.equal(hasAllowedRole("publisher", ADMIN_ROLES), false);
  assert.equal(hasAllowedRole("admin", ADMIN_ROLES), true);
});

test("an import preview can only be confirmed by its creator", () => {
  assert.equal(ownsImportSession("user-1", "user-1"), true);
  assert.equal(ownsImportSession("user-1", "user-2"), false);
  assert.equal(ownsImportSession("user-1", null), false);
});
