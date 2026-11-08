import { test } from "node:test";
import assert from "node:assert/strict";
import { DETECTED_FORMATS, HTTP_METHODS } from "../lib/import/types.ts";
import {
  COMMUNICATION_DIRECTIONS,
  normalizeApiRecord,
  normalizeCommunicationDirection,
} from "../lib/types.ts";

test("the format vocabulary matches migration 0008's check constraint", () => {
  assert.deepEqual(
    [...DETECTED_FORMATS],
    ["openapi_3", "swagger_2", "wsdl", "html_page", "unknown"],
  );
});

test("the method vocabulary matches migration 0007's check constraint", () => {
  assert.equal(HTTP_METHODS.length, 8);
  assert.ok(HTTP_METHODS.includes("GET") && HTTP_METHODS.includes("POST"));
});

test("a missing category remains unclassified rather than defaulting to Communication", () => {
  const record = normalizeApiRecord({});
  assert.equal(record.category, "Other");
  assert.equal(record.communication_direction, "");
});

test("the direction vocabulary matches migration 0012's check constraint", () => {
  assert.deepEqual(
    [...COMMUNICATION_DIRECTIONS],
    ["Send", "Receive", "Send and receive", "Unspecified"],
  );
});

test("historic or invalid Communication directions normalise to Unspecified", () => {
  assert.equal(normalizeCommunicationDirection(undefined, "Communication"), "Unspecified");
  assert.equal(normalizeCommunicationDirection("", "Communication"), "Unspecified");
  assert.equal(normalizeCommunicationDirection("Outbound", "Communication"), "Unspecified");
  assert.equal(normalizeApiRecord({ category: "Communication" }).communication_direction, "Unspecified");
});

test("controlled Communication directions are preserved", () => {
  for (const direction of COMMUNICATION_DIRECTIONS) {
    assert.equal(normalizeCommunicationDirection(direction, "Communication"), direction);
  }
});

test("non-Communication records always have an empty direction", () => {
  assert.equal(normalizeCommunicationDirection("Send", "Validation"), "");
  assert.equal(normalizeApiRecord({
    category: "Transformation",
    communication_direction: "Receive",
  }).communication_direction, "");
});
