import assert from "node:assert/strict";
import test from "node:test";
import { effectiveFormats, findCarrier, schemaCarries } from "../../lib/checks/documents.ts";
import { runChecks } from "../../lib/checks/run.ts";
import { flattenSchema } from "../../lib/schema/extract.ts";
import type { SchemaRecord } from "../../lib/checks/types.ts";
import { ALIASES, api, pair, schema, side } from "./helpers.ts";

function rawBytes() {
  return { type: "object", required: ["PictureStream"], properties: {
    PictureName: { type: "string" },
    PictureStream: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, "x-document-carrier": "byte-array" },
  } };
}
function stored(raw: unknown, direction: SchemaRecord["direction"] = "request", media_type = "application/json") {
  return schema({ direction, media_type, raw, fields: flattenSchema(raw, {}).fields });
}
const bytes = (direction: SchemaRecord["direction"]) => side(api({ input_formats: ["PDF", "JSON"], output_formats: ["PDF", "JSON"] }), [stored(rawBytes(), direction)]);
const binary = (direction: SchemaRecord["direction"]) => side(api({ input_formats: ["PDF"], output_formats: ["PDF"] }), [schema({ direction, media_type: "application/pdf", raw: { type: "string", format: "binary" } })]);
const base64 = (direction: SchemaRecord["direction"]) => side(api({ input_formats: ["PDF", "JSON"], output_formats: ["PDF", "JSON"] }), [stored({ type: "object", required: ["content"], properties: { content: { type: "string", format: "byte" } } }, direction)]);

test("an explicitly marked byte array carries the PDF, including every JSON media variant", () => {
  for (const media of ["application/json", "text/json", "application/*+json"]) {
    const input = stored(rawBytes(), "request", media);
    assert.deepEqual(findCarrier(input, "Transformation"), { kind: "byte-array", path: "PictureStream", formats: ["PDF", "Images"], container: "JSON" });
    assert.equal(schemaCarries(input, "PDF", "Transformation"), true);
    assert.equal(schemaCarries(input, "JSON", "Transformation"), false);
    assert.deepEqual(findCarrier({ ...input, raw: JSON.stringify(input.raw) }, "Transformation"), findCarrier(input, "Transformation"));
  }
  assert.deepEqual(effectiveFormats(bytes("request"), "input", ALIASES).formats, ["PDF"]);
});

test("ordinary, ambiguous or incomplete numeric arrays do not become document carriers", () => {
  const edits: ((raw: Record<string, any>) => void)[] = [
    raw => { delete raw.properties.PictureStream["x-document-carrier"]; },
    raw => { raw.required = []; },
    raw => { raw.properties.PictureStream.items.type = "number"; },
    raw => { delete raw.properties.PictureStream.items.minimum; },
    raw => { raw.properties.PictureStream.items.minimum = -128; },
    raw => { raw.properties.PictureStream.items.maximum = 256; },
    raw => { raw.properties.PictureStream.items.enum = [0, 1]; },
    raw => { raw.properties.PictureStream.items = [{ type: "integer" }]; },
    raw => { raw.properties.OtherFile = structuredClone(raw.properties.PictureStream); raw.required.push("OtherFile"); },
    raw => { raw.properties.encodedFile = { type: "string", format: "byte" }; },
    raw => { raw.properties.encryptedFile = raw.properties.PictureStream; delete raw.properties.PictureStream; raw.required = ["encryptedFile"]; },
    raw => { raw.oneOf = [{ required: ["PictureName"] }]; },
    raw => { raw.allOf = [{ properties: { PictureStream: { maxItems: 2 } } }]; },
    raw => { raw.properties.PictureStream.items.allOf = [{ maximum: 10 }]; },
  ];
  for (const edit of edits) {
    const raw = rawBytes(); edit(raw);
    assert.equal(findCarrier(stored(raw), "Transformation"), null);
  }
  const staleFields = stored(rawBytes());
  staleFields.fields = staleFields.fields.map(f => f.path === "PictureStream" ? { ...f, json_type: "string" } : f);
  assert.equal(findCarrier(staleFields, "Transformation"), null);
  assert.equal(findCarrier(stored(rawBytes(), "request", "multipart/form-data"), "Transformation"), null);
});

test("document exchange covers the array once and reports encoding in both directions", () => {
  const cases = [
    { source: binary("response"), target: bytes("request"), notes: ["encode_byte_array"], words: [/JSON array of byte values/] },
    { source: base64("response"), target: bytes("request"), notes: ["decode_base64", "encode_byte_array"], words: [/decoded from base64/, /JSON array of byte values/] },
    { source: bytes("response"), target: base64("request"), notes: ["decode_byte_array", "encode_base64"], words: [/reconstructed from a JSON byte array/, /sent base64-encoded/] },
    { source: bytes("response"), target: binary("request"), notes: ["decode_byte_array"], words: [/reconstructed from a JSON byte array/] },
    { source: bytes("response"), target: bytes("request"), notes: [], words: [/passed on unchanged/] },
  ];
  for (const { source, target, notes, words } of cases) {
    const report = runChecks(pair(source, target));
    assert.equal(report.overall.overall, "pass");
    assert.equal(report.check1.format_selected, "PDF");
    assert.deepEqual(report.check2.semantics!.mappings[0].notes, ["whole_document", ...notes]);
    for (const word of words) assert.match(report.check2.types!.conversions[0].condition!, word);
    assert.equal(report.check2.required!.status, "pass");
    assert.equal(report.check2.required!.required_fields.some(f => f.target_path === "PictureStream[]"), false);
  }
});
