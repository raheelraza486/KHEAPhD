import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMetadataBulkPlan,
  metadataBulkPlanToken,
  normalizeMetadataSpreadsheetRows,
} from "../lib/metadata-bulk-update.ts";
import { normalizeApiRecord } from "../lib/types.ts";

const validationId = "20000000-0000-4000-8000-000000000001";
const communicationId = "20000000-0000-4000-8000-000000000002";
const evidence = "The provider documentation explicitly states this value.";
const evidenceUrl = "https://example.test/docs";

function row(apiId: string, field: string, proposedValue: string, sourceRow = 2) {
  return {
    source_row: sourceRow,
    api_id: apiId,
    api_name: apiId === validationId ? "Validate invoice" : "Send invoice",
    field,
    proposed_value: proposedValue,
    evidence,
    evidence_url: evidenceUrl,
    note: "",
  };
}

function records() {
  return [
    normalizeApiRecord({
      id: validationId,
      api_name: "Validate invoice",
      company_name: "Example",
      category: "Validation",
      updated_at: "2026-09-16T00:00:00.000Z",
      output_formats: ["JSON"],
      invoice_standard: ["OLD"],
      invoice_standard_source: "extracted",
    }),
    normalizeApiRecord({
      id: communicationId,
      api_name: "Send invoice",
      company_name: "Example",
      category: "Communication",
      communication_direction: "Unspecified",
      updated_at: "2026-09-16T00:00:00.000Z",
    }),
  ];
}

test("valid spreadsheet rows are normalized and grouped once per API", () => {
  const normalized = normalizeMetadataSpreadsheetRows([
    row(validationId, "invoice_standard", "UBL\nPEPPOL", 4),
    row(validationId, "client_types", "REST\nREST\nSOAP", 5),
    row(communicationId, "communication_direction", "Send", 6),
  ]);
  assert.deepEqual(normalized.invalid, []);
  assert.deepEqual(normalized.rows[0].value, ["UBL", "PEPPOL"]);
  assert.deepEqual(normalized.rows[1].value, ["REST", "SOAP"]);

  const plan = buildMetadataBulkPlan(normalized, records());
  assert.equal(plan.ready, true);
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.changedRows, 3);
  assert.deepEqual(plan.entries[0].source_rows.length + plan.entries[1].source_rows.length, 3);
  const validation = plan.entries.find((entry) => entry.id === validationId)!;
  assert.deepEqual(validation.changes.invoice_standard, ["UBL", "PEPPOL"]);
  assert.deepEqual(validation.changes.client_types, ["REST", "SOAP"]);
});

test("duplicate API-field rows and missing official evidence URLs are rejected", () => {
  const normalized = normalizeMetadataSpreadsheetRows([
    row(validationId, "network", "Peppol", 2),
    row(validationId, "network", "Other", 3),
    { ...row(communicationId, "network", "Peppol", 4), evidence_url: "" },
  ]);
  assert.equal(normalized.rows.length, 1);
  assert.match(normalized.invalid[0].error, /more than once/);
  assert.match(normalized.invalid[1].error, /Official evidence URL/);
});

test("category-specific metadata is checked against the current API", () => {
  const normalized = normalizeMetadataSpreadsheetRows([
    row(validationId, "communication_direction", "Receive", 2),
    row(communicationId, "category_other", "Clearance", 3),
  ]);
  const plan = buildMetadataBulkPlan(normalized, records());
  assert.equal(plan.ready, false);
  assert.equal(plan.invalid.length, 2);
  assert.match(plan.invalid[0].error, /Communication/);
  assert.match(plan.invalid[1].error, /category is Other/);
});

test("category can be corrected with category-specific metadata in the same spreadsheet", () => {
  const communication = buildMetadataBulkPlan(
    normalizeMetadataSpreadsheetRows([
      row(validationId, "category", "Communication", 2),
      row(validationId, "communication_direction", "Receive", 3),
    ]),
    records(),
  );
  assert.equal(communication.ready, true);
  assert.equal(communication.changedRows, 2);
  assert.deepEqual(communication.entries[0].changes, {
    category: "Communication",
    communication_direction: "Receive",
  });

  const other = buildMetadataBulkPlan(
    normalizeMetadataSpreadsheetRows([
      row(validationId, "category", "Other", 2),
      row(validationId, "category_other", "Clearance", 3),
    ]),
    records(),
  );
  assert.equal(other.ready, true);
  assert.deepEqual(other.entries[0].changes, {
    category: "Other",
    category_other: "Clearance",
  });
});

test("category validation rejects unsupported values and incomplete Other changes", () => {
  const unsupported = normalizeMetadataSpreadsheetRows([
    row(validationId, "category", "Billing"),
  ]);
  assert.equal(unsupported.rows.length, 0);
  assert.match(unsupported.invalid[0].error, /Category is not supported/);

  const incomplete = buildMetadataBulkPlan(
    normalizeMetadataSpreadsheetRows([row(validationId, "category", "Other")]),
    records(),
  );
  assert.equal(incomplete.ready, false);
  assert.match(incomplete.invalid[0].error, /also requires category_other/);
});

test("invoice standards require confirmation even when the text already matches", () => {
  const current = records();
  current[0].invoice_standard = ["UBL"];
  current[0].invoice_standard_source = "extracted";
  const plan = buildMetadataBulkPlan(
    normalizeMetadataSpreadsheetRows([row(validationId, "invoice_standard", "UBL")]),
    current,
  );
  assert.equal(plan.changedRows, 1);
  assert.equal(plan.unchangedRows, 0);
});

test("output formats can be replaced by a reviewed spreadsheet", () => {
  const normalized = normalizeMetadataSpreadsheetRows([
    row(validationId, "output_formats", "XML\nPDF"),
  ]);
  assert.deepEqual(normalized.invalid, []);
  assert.deepEqual(normalized.rows[0].value, ["XML", "PDF"]);

  const plan = buildMetadataBulkPlan(normalized, records());
  assert.equal(plan.ready, true);
  assert.equal(plan.changedRows, 1);
  assert.deepEqual(plan.entries[0].changes.output_formats, ["XML", "PDF"]);
});

test("preview tokens bind the update to values and current updated_at timestamps", () => {
  const normalized = normalizeMetadataSpreadsheetRows([row(validationId, "network", "Peppol")]);
  const firstPlan = buildMetadataBulkPlan(normalized, records());
  const changedRecords = records();
  changedRecords[0].updated_at = "2026-09-16T01:00:00.000Z";
  const secondPlan = buildMetadataBulkPlan(normalized, changedRecords);
  assert.notEqual(metadataBulkPlanToken(firstPlan.entries), metadataBulkPlanToken(secondPlan.entries));
});

test("an explicit empty list clears each list field and retains evidence in the plan", () => {
  const fields = ["client_types", "input_formats", "output_formats", "invoice_standard", "business_rules"];
  const normalized = normalizeMetadataSpreadsheetRows(fields.map((field, i) => row(validationId, field, " [] ", i + 7)));
  const plan = buildMetadataBulkPlan(normalized, records());
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.entries[0].changes, Object.fromEntries(fields.map((field) => [field, []])));
  assert.deepEqual(plan.entries[0].source_rows, [7, 8, 9, 10, 11]);
  assert.equal(plan.entries[0].evidence.length, 5);
  assert.deepEqual(plan.entries[0].evidence_urls, [evidenceUrl]);
});

test("invalid list values report the spreadsheet row and prevent the entire plan", () => {
  for (const field of ["client_types", "input_formats", "output_formats", "invoice_standard", "business_rules"]) {
    for (const value of ["", " \t ", "null", " NULL ", "XML\nNuLl", "XML\n\nPDF", "XML\n[]", "{}", null, [], ["XML"]]) {
      const normalized = normalizeMetadataSpreadsheetRows([
        row(communicationId, "network", "Peppol", 2),
        { ...row(validationId, field, "", 17), proposed_value: value },
      ]);
      const plan = buildMetadataBulkPlan(normalized, records());
      assert.equal(plan.ready, false, `${field}: ${JSON.stringify(value)}`);
      assert.equal(plan.invalid.length, 1);
      assert.equal(plan.invalid[0].source_row, 17);
      assert.equal(plan.invalid[0].field, field);
      assert.equal(plan.invalid[0].api_id, validationId);
    }
  }
});

test("a bare null in a text field is rejected instead of being stored as text (#152)", () => {
  for (const value of ["null", " NULL ", "Null"]) {
    const normalized = normalizeMetadataSpreadsheetRows([{ ...row(communicationId, "network", "", 12), proposed_value: value }]);
    assert.equal(normalized.rows.length, 0, JSON.stringify(value));
    assert.deepEqual(normalized.invalid.map(({ source_row, field, error }) => [source_row, field, error]), [[12, "network", "Proposed value must not be null."]]);
  }
  // A text that only contains the word stays allowed.
  assert.equal(normalizeMetadataSpreadsheetRows([row(communicationId, "network", "Null network")]).invalid.length, 0);
});

test("structured lists reject comma-joined values while business-rule prose keeps commas", () => {
  for (const field of ["client_types", "input_formats", "output_formats", "invoice_standard"]) {
    const normalized = normalizeMetadataSpreadsheetRows([row(validationId, field, "UBL, CII", 9)]);
    assert.equal(normalized.rows.length, 0);
    assert.match(normalized.invalid[0].error, /separate line/);
  }
  const normalized = normalizeMetadataSpreadsheetRows([
    row(validationId, "business_rules", "For invoices, include the seller identifier.\nValidate totals, tax and currency."),
  ]);
  assert.deepEqual(normalized.invalid, []);
  assert.deepEqual(normalized.rows[0].value, ["For invoices, include the seller identifier.", "Validate totals, tax and currency."]);
});

test("legal newline lists remain trimmed and deduplicated", () => {
  for (const separator of ["\n", "\r\n", "\r"]) {
    const normalized = normalizeMetadataSpreadsheetRows([
      row(validationId, "output_formats", [" XML ", "PDF", "XML"].join(separator)),
    ]);
    assert.deepEqual(normalized.invalid, []);
    assert.deepEqual(normalized.rows[0].value, ["XML", "PDF"]);
  }
});

test("clearing an already empty list is unchanged and cannot reuse a replacement preview", () => {
  const empty = buildMetadataBulkPlan(normalizeMetadataSpreadsheetRows([row(validationId, "input_formats", "[]")]), records());
  const replacement = buildMetadataBulkPlan(normalizeMetadataSpreadsheetRows([row(validationId, "input_formats", "XML")]), records());
  assert.equal(empty.ready, true);
  assert.equal(empty.changedRows, 0);
  assert.equal(empty.unchangedRows, 1);
  assert.notEqual(metadataBulkPlanToken(empty.entries), metadataBulkPlanToken(replacement.entries));
});
