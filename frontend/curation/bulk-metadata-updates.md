# Bulk metadata list updates

In the administrator metadata workbook, `Proposed Value` uses one value per
line for `client_types`, `input_formats`, `output_formats`, `invoice_standard`
and `business_rules`.

- Enter `[]` alone to deliberately clear a list. The preview represents this as
  an empty array, and the database stores an empty PostgreSQL `text[]` (`{}`).
- Blank cells remain errors, so an unfinished workbook cannot accidentally
  clear existing metadata. Evidence and its official URL are still required.
- Literal `null` (in any case), empty list elements and embedded list markers
  are rejected. Each error identifies the worksheet row and field.
- Put formats, client types and invoice standards on separate lines, not in a
  comma-separated cell. For example, use `UBL` and `CII` on two lines.
- A business-rule sentence may contain commas; each rule still occupies one
  line. Normal trimming and deduplication remain supported.

Migration `0044_validate_bulk_metadata_lists.sql` adds element checks to the
existing administrator RPC as well. Direct callers must pass arrays of valid
strings; JSON nulls, other element types and joined values cannot bypass the
spreadsheet validation. Apply this migration with the application change.

The writer retains the existing administrator checks, stale-preview rejection,
one-transaction batch updates and audit provenance. It does not grant Verified
status. The existing verification trigger still clears verification when a
covered field changes; ordinary bookkeeping retains it.

## Verification

From `frontend`, run the application regression tests:

```sh
node --test tests/metadata-bulk-update.test.ts tests/owner-api-routes.test.ts tests/site-header.test.ts
```

On a disposable PostgreSQL database with the schema through migration `0028`
and the new `0044` migration, run from the repository root:

```sh
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/tests/bulk-metadata-lists.sql
```

The SQL regression script rolls back its fixtures. It checks explicit clears,
89 malformed direct-RPC inputs, normal replacements, audit evidence, rollback
of an earlier row when a later row is invalid, stale previews, permissions and
verification behaviour. It fails against the original writer from `0028`.
