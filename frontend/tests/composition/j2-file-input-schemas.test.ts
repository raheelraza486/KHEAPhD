import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { effectiveFormats, findCarrier } from "../../lib/checks/documents.ts";
import { runChecks } from "../../lib/checks/run.ts";
import type { ApiRecord, ApiSideInput, SchemaRecord } from "../../lib/checks/types.ts";
import { composeChains } from "../../lib/composition/compose.ts";
import { narrowProcessCandidates, type CandidateApi } from "../../lib/composition/task-candidates.ts";
import { expandTransformations } from "../../lib/composition/transformation-expansion.ts";
import type { BusinessProcess } from "../../lib/composition/types.ts";
import { flattenSchema, schemaContentHash } from "../../lib/schema/extract.ts";
import { ALIASES, api, schema, side } from "../checks/helpers.ts";

// Read the migration's payload itself: a copied fixture would keep passing if
// the SQL accidentally lost required/file/binary or one of the JSON variants.
const original = readFileSync(new URL("../../../migrations/0040_client_designated_apis.sql", import.meta.url), "utf8");
const blocks = [...original.matchAll(/\$rows0040\$([\s\S]*?)\$rows0040\$/g)].map((match) => JSON.parse(match[1]));
const originalApis = blocks[0] as ApiRecord[];
const originalSchemas = blocks[1] as SchemaRecord[];
const migration = readFileSync(new URL("../../../migrations/0052_nanonets_ezzybills_file_inputs.sql", import.meta.url), "utf8");
type Patch = { api_id: string; raw: Record<string, unknown>; content_hash: string; previous_raw: unknown; previous_hash: string | null; warning: string };
const patches = JSON.parse(migration.match(/\$schemas0052\$([\s\S]*?)\$schemas0052\$/)![1]) as Patch[];
const correction = readFileSync(new URL("../../../migrations/0053_ezzybills_byte_array_input.sql", import.meta.url), "utf8");
const correctedEzzy = (JSON.parse(correction.match(/\$schemas0053\$([\s\S]*?)\$schemas0053\$/)![1]) as Patch[])[0];
const nano = "b1c13a58-0c0a-42ab-a161-1330f9c50859";
const ezzy = "1d04401c-5c74-43ca-8adc-b65235f874ec";
const aliases = [...ALIASES,
  { alias: "text/json", canonical: "JSON" },
  { alias: "application/*+json", canonical: "JSON" },
  { alias: "multipart/form-data", canonical: "Multipart form data" },
];

function extractor(id: string, migrated: boolean): ApiSideInput {
  const patch = id === ezzy ? correctedEzzy : patches.find((row) => row.api_id === id)!;
  const schemas: SchemaRecord[] = originalSchemas.filter((row) => row.api_id === id).map((row) => {
    const raw = migrated && row.direction === "request" ? patch.raw : row.raw;
    return { ...row, raw, fields: flattenSchema(raw, {}).fields };
  });
  if (migrated && id === nano) {
    schemas.push(schema({ direction: "request", media_type: "multipart/form-data", raw: patch.raw,
      fields: flattenSchema(patch.raw, {}).fields }));
  }
  return side(originalApis.find((row) => row.id === id)!, schemas);
}

test("0052 hashes follow the importer and EzzyBills changes only PictureStream's file contract", () => {
  assert.deepEqual(patches.map((row) => row.api_id), [nano, ezzy]);
  for (const patch of patches) assert.equal(patch.content_hash, schemaContentHash(patch.raw));
  const patch = patches.find((row) => row.api_id === ezzy)!;
  const expected = structuredClone(patch.previous_raw) as { required?: string[]; properties: { PictureStream: { description?: string } } };
  expected.required = ["PictureStream"];
  expected.properties.PictureStream.description = flattenSchema(patch.raw, {}).fields.find((field) => field.path === "PictureStream")!.description;
  assert.deepEqual(patch.raw, expected);
  assert.equal(patch.previous_hash, schemaContentHash(patch.previous_raw));
  assert.match(patch.warning, /inferred.*not explicitly stated/);
  assert.match(patch.warning, /No live-call verification/);
});

test("0053 corrects only EzzyBills' file representation and preserves the applied 0052 precondition", () => {
  const previous = patches.find((row) => row.api_id === ezzy)!;
  assert.equal(correctedEzzy.api_id, ezzy);
  assert.deepEqual(correctedEzzy.previous_raw, previous.raw);
  assert.equal(correctedEzzy.previous_hash, previous.content_hash);
  assert.equal(correctedEzzy.content_hash, schemaContentHash(correctedEzzy.raw));
  const expected = structuredClone(previous.raw);
  const properties = expected.properties as Record<string, unknown>;
  properties.PictureStream = (correctedEzzy.raw.properties as Record<string, unknown>).PictureStream;
  assert.deepEqual(correctedEzzy.raw, expected);
  assert.deepEqual((properties.PictureStream as Record<string, unknown>).items, { type: "integer", minimum: 0, maximum: 255 });
  assert.equal((properties.PictureStream as Record<string, unknown>)["x-document-carrier"], "byte-array");
  assert.match(correctedEzzy.warning, /OAuth bearer was not tested/);
  assert.match(correctedEzzy.warning, /not separately verified/);
});

test("0052 and 0053 make Nanonets and every EzzyBills request variant carry PDF files", () => {
  for (const id of [nano, ezzy]) {
    assert.equal(effectiveFormats(extractor(id, false), "input", aliases).formats.includes("PDF"), false);
    const updated = extractor(id, true);
    const requests = updated.schemas.filter((row) => row.direction === "request");
    assert.equal(requests.length, id === nano ? 1 : 3);
    for (const request of requests) {
      const carrier = findCarrier(request, "Transformation");
      assert.equal(carrier?.kind, id === nano ? "file" : "byte-array");
      assert.equal(carrier?.path, id === nano ? "file" : "PictureStream");
      assert.ok(carrier?.formats.includes("PDF"));
    }
    const formats = effectiveFormats(updated, "input", aliases).formats;
    assert.ok(formats.includes("PDF"));
    assert.equal(formats.includes("JSON"), false);
    assert.equal(formats.includes("Multipart form data"), false);
    assert.deepEqual(updated.schemas.filter((row) => row.direction === "response"),
      extractor(id, false).schemas.filter((row) => row.direction === "response"));
  }
});

test("PDF to UBL expansion finds both extraction candidates without implying an executable mapping", () => {
  const converter = side(api({ id: "convert", api_name: "Convert invoice JSON to UBL XML" }), [
    schema({ direction: "request", media_type: "application/json" }, ["invoiceNumber:string:req"]),
    schema({ direction: "response", media_type: "application/json" }, ["xml:string:req"]),
  ]);
  const process: BusinessProcess = { steps: [{ order: 1, category: "Transformation",
    task: "convert pdf to ubl xml", input_format: "PDF", output_format: "UBL XML", candidate_ids: null }] };
  const resolve = (migrated: boolean) => {
    const sides = [extractor(nano, migrated), extractor(ezzy, migrated), converter];
    const catalogue: CandidateApi[] = sides.map(({ api: row }) => ({
      id: row.id, api_name: row.api_name, category: "Transformation", is_active: true,
      input_formats: [...(row.input_formats ?? [])], output_formats: [...(row.output_formats ?? [])],
      invoice_standard: [...(row.invoice_standard ?? [])],
    }));
    return { sides, ...expandTransformations(process, narrowProcessCandidates(process, catalogue), catalogue, sides, aliases) };
  };
  assert.equal(resolve(false).issues[0].code, "conversion_unresolved");
  const result = resolve(true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.added.length, 1);
  assert.deepEqual(new Set(result.narrowed.process.steps[0].candidate_ids), new Set([nano, ezzy]));
  assert.deepEqual(result.narrowed.process.steps[1].candidate_ids, ["convert"]);
  const composition = composeChains(result.narrowed.process, result.sides, (source, target, context) =>
    runChecks({ source, target, formatAliases: aliases, choices: [], validatedBetween: context.validated_between }).overall.overall);
  assert.deepEqual(new Set(composition.chains.map((chain) => chain.api_ids[0])), new Set([nano, ezzy]));
  assert.ok(composition.chains.every((chain) => chain.status === "needs_decision"));
});
