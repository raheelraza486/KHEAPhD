import { test } from "node:test";
import assert from "node:assert/strict";
import { compareParameters } from "../../lib/compatibility/parameters.ts";

// A query operation's input is its path/query parameters, not a body.
// Example: Submit Invoice (POST, responds with an irn) -> Check Invoice Status (GET /status/{irn}).

const submitResponse = {
  type: "object",
  properties: {
    irn: { type: "string" },
    ack_no: { type: "integer" },
    status: { type: "string" },
  },
};

test("a path parameter supplied by an identically named source field is an exact match", () => {
  const r = compareParameters(
    submitResponse,
    [{ name: "irn", in: "path", schema: { type: "string" } }],
    "Submit Invoice",
    "Check Invoice Status",
  );
  assert.equal(r.compatibility, "directly_compatible");
  assert.deepEqual(r.issues.map((i) => [i.code, i.source_path, i.target_path]), [
    ["exact_parameter_match", "irn", "path:irn"],
  ]);
});

test("a parameter with a near name goes through the same tiers as a field", () => {
  const r = compareParameters(
    submitResponse,
    [{ name: "ackNo", in: "query", required: true, schema: { type: "string" } }],
    "s",
    "t",
  );
  const m = r.issues.find((i) => i.code === "parameter_mapping_required");
  assert.equal(m?.source_path, "ack_no");
  assert.equal(m?.match_tier, 1); // same normalised name, integer -> string is a cast
  assert.ok(r.issues.some((i) => i.code === "type_conversion_required"));
  assert.equal(r.compatibility, "compatible_with_mapping");
});

test("a required parameter the source cannot supply is blocking; an optional one is informational", () => {
  const r = compareParameters(
    submitResponse,
    [
      { name: "gstin", in: "query", required: true, schema: { type: "string" } },
      { name: "page", in: "query", schema: { type: "integer" } },
    ],
    "s",
    "t",
  );
  assert.deepEqual(r.issues.map((i) => i.code), ["missing_required_parameter", "missing_optional_parameter"]);
  assert.equal(r.compatibility, "incompatible");
});

test("header and cookie parameters are ignored — they are transport, not data", () => {
  const r = compareParameters(
    submitResponse,
    [
      { name: "Authorization", in: "header", required: true },
      { name: "session", in: "cookie", required: true },
    ],
    "s",
    "t",
  );
  assert.equal(r.issues.length, 0);
  assert.equal(r.compatibility, "directly_compatible");
});

