import assert from "node:assert/strict";
import test from "node:test";
import { assessConnectionPotential } from "../../lib/compatibility/connection-potential.ts";
import type { CheckReport } from "../../lib/checks/types.ts";
import type { ApiSchemaField } from "../../lib/compatibility/ui-types.ts";

function field(path: string, description: string | null, required = true): ApiSchemaField {
  const leaf = path.split(".").at(-1) ?? path;
  return {
    path,
    leaf_name: leaf,
    leaf_name_norm: leaf.toLowerCase(),
    json_type: "string",
    format: null,
    is_required: required,
    is_array_item: false,
    depth: 0,
    enum_values: null,
    description,
  };
}

function report(notFound: string[]): CheckReport {
  return {
    source: { id: "sap", name: "SAP Concur Purchase Order Receipts API" },
    target: { id: "zatca", name: "ZATCA Fatoora Clearance API" },
    check0: { status: "pass", reason_code: null, source_category: "Transformation", target_category: "Validation", sequence: ["Transformation", "Validation", "Communication"], flags: [] },
    check1: { status: "pass", reason_code: null, source_formats: ["JSON"], target_formats: ["JSON"], common_formats: ["JSON"], unrecognised_values: [], format_options: [], format_selected: "JSON", flags: [] },
    check2: {
      auth: { status: "pass", credential_sets: 0, source_auth: { method: null, details: null }, target_auth: { method: null, details: null }, auth_requires_prior_call: false },
      schema: { status: "pass", reason_code: null, source_schema_used: null, source_schema_alternatives: [], target_schema_used: null, target_schema_alternatives: [], target_inputs: ["body"], flags: [] },
      semantics: { status: "pending_user", mappings: [], ambiguous: [], not_found: notFound.map((target_path) => ({ target_path, target_type: "string", target_format: null, required: true, suggestions: [] })), excluded: [{ path: "invoiceHash", reason: "envelope" }], uncovered_by_choice: [], external_by_choice: [], stale_choices: [], applied: [], conflicts: [] },
      types: null,
      required: null,
    },
    check3: { status: "unknown", reason_code: null, issues: [], representation_differs: [], conditional_conversions: [], flags: ["check3_waiting_for_semantics"] },
    overall: { overall: "pending_user", blocking_checks: [], blocking_reason: null, reason_codes: [] },
  };
}

test("an identifier is proposed as an external lookup key, never as a document conversion", () => {
  const assessment = assessConnectionPotential(
    report(["invoice"]),
    [field("PurchaseOrderNumber", "Purchase order number")],
    [field("invoice", "The invoice encoded in base64"), field("invoiceHash", "Hash of the invoice")],
  );

  assert.equal(assessment.directLabel, "Not directly compatible");
  assert.equal(assessment.potentialLabel, "Possible with external enrichment");
  assert.deepEqual(assessment.resolutions.map((item) => [item.targetPath, item.kind, item.sourcePath]), [
    ["invoice", "enrichment", "PurchaseOrderNumber"],
    ["invoiceHash", "derived", "invoice"],
  ]);
  assert.match(assessment.resolutions[0].detail, /lookup key, not the target value/);
});

test("a complete invoice document is classified as transformable", () => {
  const assessment = assessConnectionPotential(
    report(["invoice"]),
    [field("invoiceXml", "The complete invoice XML document")],
    [field("invoice", "The invoice encoded in base64")],
  );

  assert.equal(assessment.potentialLabel, "Possible with transformation");
  assert.equal(assessment.resolutions[0].kind, "transformation");
  assert.deepEqual(assessment.resolutions[0].steps, ["invoiceXml", "Base64 encode", "invoice"]);
});

test("a required value with neither a source nor a safe construction path remains incompatible", () => {
  const assessment = assessConnectionPotential(report(["invoice"]), [field("Status", "Receipt status")], [field("invoice", "The invoice encoded in base64")]);
  assert.equal(assessment.potentialLabel, "No known connection path");
  assert.equal(assessment.resolutions[0].kind, "missing");
});
