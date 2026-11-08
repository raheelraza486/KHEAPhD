import { test } from "node:test";
import assert from "node:assert/strict";
import {
  predictOutcome,
  sameMergeableValues,
  type StoredRecord,
} from "../lib/import/merge.ts";
import { toApiRow, type AliasMaps } from "../lib/import/candidate-record.ts";
import type { Candidate } from "../lib/import/types.ts";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    api_endpoint: "https://api.x.dev/v1/invoices",
    http_method: "POST",
    api_name: "X Send invoice",
    official_api_name: "sendInvoice",
    description: "Send an invoice",
    company_name: "X",
    input_formats: ["application/json"],
    output_formats: ["application/json"],
    authentication_raw: ["http bearer"],
    data_quality: "ok",
    warnings: [],
    ...overrides,
  };
}

function stored(overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    api_name: "X Send invoice",
    official_api_name: "sendInvoice",
    description: "Send an invoice",
    company_name: "X",
    category: "Communication",
    communication_direction: "Send",
    input_formats: ["application/json"],
    output_formats: ["application/json"],
    ...overrides,
  };
}

test("preview classifies a missing identity as a new insert", () => {
  assert.equal(predictOutcome(null, stored()), "insert");
});

test("preview classifies an exact existing row as a duplicate", () => {
  assert.equal(predictOutcome(stored(), stored()), "duplicate");
});

test("preview locks a changed existing identity instead of offering an update", () => {
  assert.equal(
    predictOutcome(stored({ description: "catalogue correction" }), stored({ description: "document text" })),
    "existing",
  );
});

test("a newly inferred category never reclassifies an existing record", () => {
  assert.equal(
    predictOutcome(
      stored({ category: "Other", communication_direction: "" }),
      stored({ category: "Communication", communication_direction: "Send" }),
    ),
    "existing",
  );
});

test("a newly inferred Communication direction is a visible metadata change", () => {
  assert.equal(
    predictOutcome(
      stored({ communication_direction: "Unspecified" }),
      stored({ communication_direction: "Send" }),
    ),
    "existing",
  );
});

test("array comparison is exact and order-sensitive", () => {
  assert.equal(sameMergeableValues(stored(), stored()), true);
  assert.equal(
    sameMergeableValues(
      stored({ output_formats: ["JSON", "XML"] }),
      stored({ output_formats: ["XML", "JSON"] }),
    ),
    false,
  );
});

test("normalised alias values compare equal", () => {
  const aliases: AliasMaps = {
    provider: new Map([["ecosio gmbh", "Ecosio"]]),
    format: new Map([["application/json", "JSON"]]),
  };
  const raw = candidate({
    company_name: "ECOSIO GmbH",
    input_formats: ["application/json"],
    operation_id: "sendInvoice",
  });
  const existing = stored({
    company_name: "Ecosio",
    input_formats: ["JSON"],
    output_formats: ["JSON"],
  });
  const normalisedIncoming = toApiRow(raw, "https://docs.example/openapi.json", aliases);
  const unnormalisedIncoming = {
    ...normalisedIncoming,
    company_name: raw.company_name,
    input_formats: raw.input_formats,
    output_formats: raw.output_formats,
  };

  assert.equal(predictOutcome(existing, unnormalisedIncoming), "existing");
  assert.equal(sameMergeableValues(existing, normalisedIncoming), true);
  assert.equal(predictOutcome(existing, normalisedIncoming), "duplicate");
});
