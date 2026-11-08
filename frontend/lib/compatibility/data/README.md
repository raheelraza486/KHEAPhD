# Compatibility check reference data

Reference tables used by the compatibility checks described in the
*BP-Builder Compatibility Check Manual* (v1.0) and the *BP-Builder Semantic
Check Manual* (v1.0). The CSV files in this directory are the source of truth
and are maintained by hand; `generated/*.ts` is produced from them and is what
the code loads.

```
node scripts/build-compatibility-data.mjs      # run from frontend/ after editing any CSV
```

| File | Used by | Rows (v1.0) |
|---|---|---|
| `type_vocabulary.csv` | Check 2.3, rule (1): normalises `json_type` + `format` to one normalised type | 19 |
| `type_conversion.csv` | Check 2.3, rules (2)–(5): the conversion matrix | 121 |
| `semantic_units.csv` | Check 2.2 (rule S-3): the catalogue of semantic units | 221 |
| `field_semantics.csv` | Check 2.2 (rules S-1, S-3, S-4): registry of normalised field names | 2,349 |
| `invoice_standards.csv` | Check 2.0b: canonical invoice standards, their parent (EN 16931 for each CIUS), and syntaxes that are not compared | 10 |
| `invoice_standard_exceptions.csv` | Check 2.0b: source → target pairs of different CIUS that are accepted, with the decision behind each | 1 |

Snapshot the rows were derived from: team Supabase project, 2026-09-17 02:43
AEST, 190 active API records, 299 physical schema rows, 11,114 physical schema
field rows, 156 parameters (migrations 0001–0032). Several identical schema
definitions are intentionally stored once per declared media type. D13 does
not delete those rows: reporting and future occurrence-count refreshes must use
`scripts/compatibility-statistics.sql`, which selects one representative per
`(api_id, direction, status_code, content_hash)` while preserving every
media-type row in the catalogue.

## `type_vocabulary.csv`

| Column | Meaning |
|---|---|
| `json_type` | Value of `api_schema_field.json_type` / `api_parameter.json_type` |
| `format` | Value of `format`; empty means "no format" |
| `normalized_type` | One of `string`, `integer`, `number`, `boolean`, `date`, `date-time`, `email`, `binary`, `object`, `array`, `unknown` |
| `note` | Free text |

A combination not listed here normalises to `unknown` and is logged.

## `type_conversion.csv`

| Column | Meaning |
|---|---|
| `source_type`, `target_type` | Normalised types (see above) |
| `kind` | `same` — identical; `lossless` — pass, conversion recorded; `conditional` — pass with flag `conversion_conditional`, value checked in check 3; `incompatible` — fail; `undetermined` — one side is `unknown`, reason `field_type_unknown`; `container` — same-shape object/array, not judged here, child fields are judged individually; `shape` — different container shapes, reason `shape_unsupported` in this phase |
| `condition` | For `conditional`: what the value must satisfy; for the others an explanation |

## `semantic_units.csv`

| Column | Meaning |
|---|---|
| `unit_id` | `U01`–`U65` generic units; `V-<VENDOR>-nn` vendor-specific units |
| `name` | Unique short name |
| `meaning` | One-sentence definition |
| `owner` | Ownership scope the unit requires: `document`, `line`, `document_or_line`, `party`, `party_seller`, `party_buyer`, `party_address`, `party_by_role` (role taken from the parent path or a role word in the name), `line_or_tax_bracket`, `record` (the platform record, not the business document), `by_parent` (decided by the parent path) |
| `scope` | `generic` or `vendor` |
| `vendor` | `apis.company_name` of the owning vendor (vendor-specific units only) |
| `status`, `registered_on` | Registration state and date |

## `field_semantics.csv`

One row per (normalised name, unit). A name registered under more than one unit
has several rows; the `vendor_condition` / `parent_condition` columns say which
row applies (rule S-4).

| Column | Meaning |
|---|---|
| `normalized_name` | `api_schema_field.leaf_name_norm` (parameters: name lower-cased, non-alphanumerics removed) |
| `unit_id` | A `semantic_units.unit_id`; `E` = envelope field, excluded by rule S-1; `G` = generic name, disambiguated by rule S-4; empty for `next_batch` / `data_defect` rows |
| `envelope_category` | For `E` rows: `software_header`, `pagination_query`, `result_error`, `xml_signature`, `notification_channel`, `device_audit`, `other` |
| `vendor_condition` | `\|`-separated substrings matched against `apis.company_name`; empty = no vendor condition |
| `parent_condition` | `\|`-separated normalised leaf names of the parent path; empty = no parent condition |
| `case_type` | Case from the Semantic Check Manual, chapter 6 (`A1`–`A8`, `B1`–`B5`), possibly combined (`A6/A4`) |
| `note` | Evidence or applicability note (free text) |
| `original_spellings` | Spellings seen in the snapshot with counts, `spelling (n)\|…` |
| `occurrences` | Total occurrences in the snapshot (schema fields + parameters) |
| `language` | `\|`-separated: `en`, `es`, `fr`, `pt`, `abbr` (systematic abbreviation scheme) |
| `vendors` | `\|`-separated `apis.company_name` values where the name occurs |
| `status` | `confirmed` — reviewed and in force; `unclassified` — seen in the snapshot, no description, not yet assigned (data item D7); `reserved` — expected spelling not yet seen in the catalogue; `next_batch` — evidence insufficient, deferred (D9); `data_defect` — transcription defect to fix in the schema first (D9) |
| `registered_on` | Date of the registration decision |

Rule S-4 precedence when a name has several rows: rows whose `parent_condition`
matches the field's parent are considered first; then rows whose
`vendor_condition` matches the API's vendor; rows with both conditions empty
apply to every occurrence (a name registered under two units with no condition,
e.g. `entityvatnumber` → U19 and U20, means both units apply at once). Rows
with `status = confirmed` or `reserved` take part in matching (a reserved
spelling is registered so that it is recognised the first time it occurs);
`unclassified`, `next_batch` and `data_defect` rows do not. The generated
`field_semantics_by_name.ts` already contains only the matching rows.

## Maintaining the registry

Registration is batch work, not a queue. Two sources of evidence:

1. Unregistered names: after each catalogue synchronisation, normalised names
   present in the catalogue but absent from `field_semantics.csv`.
2. Aggregated user choices: the database view `v_registry_candidates`
   (migration 0033) groups the agreed and administrator-settled answers users
   gave in the check's drop-downs (conflicts are left out) by target name,
   answer and chosen source name, with the number of pairs and of people. A combination chosen by at least 3 pairs or 2 people is a
   registration candidate (v1.0 threshold); below that it is noise from a
   single pair.

Individual choices are not reviewed: agreed answers apply to their own pair at
once (`check_choice`, an append-only history) and stop applying when a schema
changes; only conflicting answers go to an administrator, who settles them per
pair. Registering a name
here makes the check stop asking about it, so it leaves the view by itself.

## `invoice_standards.csv` (check 2.0b, issue #42)

| Column | Meaning |
|---|---|
| `standard` | Canonical name used in reports |
| `parent` | The standard this one is a CIUS of; empty for a top-level standard |
| `kind` | `semantic`, `cius`, `syntax` (UBL, CII, PDF — not compared) or `none` (N/A) |
| `pattern` | Case-insensitive regular expression matched against `apis.invoice_standard` values and capability claims; first match wins |
| `note` | Free text |

A value that matches no row is treated as its own standard (its name without
the version), with no parent.

## `invoice_standard_exceptions.csv`

| Column | Meaning |
|---|---|
| `source`, `target` | Canonical standards, in the direction of the pair |
| `relation` | `fillable`: accepted; the report says the target's extra details must be filled in |
| `note` | The decision behind the row, with its date |
