import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPreviewCandidates,
  isNewPreviewCandidate,
  isSupportedDocumentUrl,
  isUnreadableDocumentResponse,
  selectablePreviewIndexes,
} from "../lib/import/preview-ui.ts";

test("document URL validation accepts only absolute HTTP and HTTPS URLs", () => {
  assert.equal(isSupportedDocumentUrl("https://example.gov/openapi.json"), true);
  assert.equal(isSupportedDocumentUrl("http://example.gov/openapi.yaml"), true);
  assert.equal(isSupportedDocumentUrl("example.gov/openapi.json"), false);
  assert.equal(isSupportedDocumentUrl("ftp://example.gov/openapi.json"), false);
  assert.equal(isSupportedDocumentUrl(""), false);
});

test("candidate classification keeps zero operations distinct from all existing operations", () => {
  assert.equal(classifyPreviewCandidates([]), "none");
  assert.equal(
    classifyPreviewCandidates([{ predicted_outcome: "duplicate" }]),
    "all_existing",
  );
  assert.equal(
    classifyPreviewCandidates([
      { predicted_outcome: "duplicate" },
      { predicted_outcome: "existing" },
    ]),
    "all_existing",
  );
  assert.equal(
    classifyPreviewCandidates([
      { predicted_outcome: "duplicate" },
      { predicted_outcome: "insert" },
    ]),
    "has_new",
  );
});

test("only insert candidates are selectable in an append-only preview", () => {
  assert.equal(isNewPreviewCandidate({ predicted_outcome: "insert" }), true);
  assert.equal(isNewPreviewCandidate({ predicted_outcome: "duplicate" }), false);
  assert.equal(isNewPreviewCandidate({ predicted_outcome: "existing" }), false);
  assert.equal(isNewPreviewCandidate({ predicted_outcome: "unexpected" }), false);
  assert.deepEqual(
    selectablePreviewIndexes([
      { index: 0, predicted_outcome: "duplicate" },
      { index: 1, predicted_outcome: "insert" },
      { index: 2, predicted_outcome: "existing" },
      { index: 3, predicted_outcome: "insert" },
    ]),
    [1, 3],
  );
});

test("only a 422 preview response is classified as an unreadable document", () => {
  assert.equal(isUnreadableDocumentResponse(422), true);
  assert.equal(isUnreadableDocumentResponse(400), false);
  assert.equal(isUnreadableDocumentResponse(403), false);
  assert.equal(isUnreadableDocumentResponse(429), false);
  assert.equal(isUnreadableDocumentResponse(500), false);
  assert.equal(isUnreadableDocumentResponse(503), false);
});
