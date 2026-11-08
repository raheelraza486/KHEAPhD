# lib/checks — BP-Builder compatibility checks

Implements the *BP-Builder Compatibility Check Manual* V2.3 and the
*BP-Builder Semantic Check Manual* V2.3 (shared project folder on OneDrive,
`BP-Builder 组/兼容性检查手册 v2.3`). Pure
functions: no database access, no React. Reference data comes from
`lib/compatibility/data/generated/*.ts` (see `lib/compatibility/data/README.md`).

```ts
import { runChecks } from "@/lib/checks";
const report = runChecks({ source, target, formatAliases, choices });
```

| File | Manual | Content |
|---|---|---|
| `run.ts` | ch. 4, 9 | `runChecks` (entry point), overall verdict and early blocking, stale-choice handling, whole-document exchange |
| `check0-operation.ts` | ch. 5 | Check 0: category order Transformation → Validation → Communication, `validatedBetween` |
| `check1-format.ts` | ch. 6 | Check 1: format-name normalisation, no-request-body rule, common format |
| `check2-auth.ts` | §7.3.1 | 2.0a: credential sets, credential-obtained-first flag (information only) |
| `check2-standard.ts` | §7.3.2 | 2.0b: invoice standard (claims, label, hierarchy, exceptions; a claim's request option is reported as `configuration_required`) |
| `documents.ts` | §6.6, §7.8 | Whole-document carriers, envelope formats, pass-through validators |
| `adhoc.ts` | — | A side read from a document rather than the catalogue (#33) |
| `check2-schema.ts` | §7.4 | 2.1: schema selection (2xx / default), `(body)`, anyOf/oneOf, thin / unverified flags |
| `check2-semantics.ts` | §7.5, Semantic Manual ch. 5 | 2.2: rules S-0 … S-9, contention, user-choice write-back |
| `check2-types.ts` | §7.6 | 2.3: type vocabulary and conversion matrix |
| `check2-required.ts` | §7.7 | 2.4: required-field coverage |
| `check3-constraints.ts` | ch. 8 | Check 3: declared values (enum, case-insensitive), source type against a target enum, conditional conversions decided from the source's format or enum; a representation difference is information only |
| `fields.ts` | §7.4 (5) | Field model shared by 2.1–2.4 |
| `data.ts` | data README | Lookups over the generated reference data |
| `types.ts` | ch. 9 | Every input and output type |

## Check 2.2 — two rules decided from the records (21 October 2026, #119)

**S-5b, array and element.** A field table stores an array twice: the array
(`invoice`, `json_type` array) and its element (`invoice[]`, `is_array_item`).
Both carry the same name and the same unit, so both reach the candidate list.
They cannot stand in for one another: when both are candidates, an array
target keeps the array and an array-element target keeps the element. Any
other target, and candidates on other paths, are left as they are.

**S-9, constant.** A target field whose `enum_values` holds exactly one value
admits only that value. Where 2.2 finds **no source candidate** for it, the
caller writes the value in, so the field is excluded with `reason: "constant"`
(as S-1 excludes envelope fields) and stays out of 2.4's required set and of
Check 3. A constant that does have a candidate keeps its mapping and Check 3
compares the values: a source that only yields `INV-001` must not feed a
target that only accepts `INV-002`. Two or more admissible values are a
choice, not a constant. `AmitTransform Convert`'s `outputFormat`
(`["UBL XML"]`, no source field of that name) is the designated-chain case.

## Check 3 (value / constraint compatibility)

Every verdict comes from the records: the target's `enum_values`, the
source's `enum_values`, `json_type` and `format`. Nothing is called.

| Situation | Verdict | `issues[].kind` |
|---|---|---|
| Target enum, source enum, every source value accepted (compared ignoring case) | pass | — |
| Target enum, source enum, a value outside the target's list | fail | `enum_partial_overlap` / `enum_no_overlap` |
| Target enum, no source enum, source type can never produce any target value (object, array, number where words are wanted) | fail | `source_type_mismatch` |
| Target enum, no source enum, otherwise | unknown | `source_values_unknown` |
| 2.3 conditional conversion that succeeds for every value of the source type (date-time → string, date-time → date, date-time → integer / number) | pass | `conversion_always_succeeds` |
| 2.3 conditional conversion ruled out by the source's `format` (guid, uuid, uri, url, hostname, ipv4, ipv6 can never be numeric, boolean, date, e-mail or base64 text) | fail | `conversion_impossible` |
| 2.3 conditional conversion, source enum tested value by value | pass / fail | — / `conversion_impossible` |
| 2.3 conditional conversion with no evidence either way | unknown | `conditional_conversion` |
| No target enum and no conditional conversion among the mappings | not_voting | — |

A representation difference noted by 2.2 (rule S-7) is listed in
`representation_differs` and raises `value_mapping_required`, as does a
conversion that always succeeds: a transformation step between the two APIs
must rewrite the value. It does not change the verdict. The check never
collects value mappings from users; a conversion is the composition's job,
as a shape difference is in 2.3 (decided 21 October 2026, #31).

`runtime_validation_required` means at least one pair stays undetermined
because the source declares neither its values nor a format that decides
the conversion; only a call with real values can settle it.

## Byte-array document inputs

JSON file envelopes can also carry a byte array, as EzzyBills does in
`PictureStream`. A reviewed schema marks that required top-level array with
`x-document-carrier: "byte-array"` and integer items bounded by 0 and 255.
The explicit annotation distinguishes document bytes from ordinary numeric
arrays. The report states when a document must be encoded into or reconstructed
from an array, including base64-to-array changes. This describes compatibility;
it does not execute a provider request or certify extraction accuracy.

## Routes (app/api/checks)

| Route | Who | Does |
|---|---|---|
| `GET /api/checks?source_id&target_id` | anyone | loads the pair (`store.ts`), runs `runChecks`, returns `{ report }` |
| `POST /api/checks/adhoc` | anyone | the same report for a pair in which a side is an OpenAPI link, an uploaded document or one JSON Schema (#33): the side is built by `adhoc.ts` through the Publisher's import pipeline (`parseOpenApi3`, `toApiRow`, `extractDocumentSchemas`, the upload reader), so category, formats and fields come out as an import would store them; no answers are saved for a side without a catalogue identity |
| `POST /api/checks/answers` | signed-in users | appends one `kind = user` row to `check_choice` (current hashes recorded), returns the recomputed report; 409 when the field is not open or awaits an administrator |
| `POST /api/checks/settle` | administrators | same body, `kind = admin` (final) |
| `GET /api/checks/conflicts` | administrators | the work list from `v_check_choice_current` (`state = conflict`) |

The page contract is written for the UI team in
`UI_Handover_Compatibility_Check_v2.3.md`, in the same OneDrive folder.

Check 2.0b's `status` is the invoice-standard verdict. Its optional `review`
object describes the source and target claim review independently; current
reports populate it, while older saved reports may omit it. Each side records
the direction used and `confirmed`, `unreviewed`, `not_assessed` (catalogue
label only) or `not_recorded` (no resolved standard). This metadata never
changes the verdict. Keep `claims_unreviewed` and the other informational
flags visible. `components/invoice-standard-result.tsx` renders both the
standard verdict and review states; Composition reuses the same result in
its `standard_checks` response (see `../composition/README.md`).

## What the caller (API route / page) is responsible for

1. **Assembling `PairInput`** from the tables: `apis` (active, non-duplicate,
   with `category` and `invoice_standard`), `api_schema` with its
   `api_schema_field` rows attached as `fields`, `api_parameter`,
   `format_alias`, and the API's rows of `api_invoice_standard_capability` as
   `standard_claims` (2.0b). Pass `content_hash` on every schema.
2. **Persisting answers.** When `report.overall.overall === "pending_user"`,
   show `report.check2.semantics.ambiguous` and `.not_found` (required first;
   optional ambiguous fields are skippable). Append the two fixed options
   "None of the above" and "Provided externally" to every candidate list.
   **Insert** each answer into `check_choice` (migration 0033; append-only,
   never update or delete), recording `kind = user`, the user, the time and
   the `content_hash` of the source schema in
   `report.check2.schema.source_schema_used` and of the target request schema.
   For a field already answered (`report.check2.semantics.applied`), show
   "currently using X (who, when)" and offer "change"; when the user changes
   it, show the earlier answer first — insisting on a different answer creates
   a conflict.
3. **Re-running with the history.** Load the pair's whole `check_choice`
   history into `PairInput.choices` on every check. The engine merges it per
   field: agreed → applied; conflict (users disagree, or a user disagrees with
   the registry's automatic match) → `report.check2.semantics.conflicts` and
   `overall = "pending_admin"`; resolved (`kind = admin`) → applied, final.
   Conflicts are the administrator's work list (also the view
   `v_check_choice_current`, `state = conflict`); the settlement is one more
   row with `kind = admin`. Answers whose hashes no longer match are listed in
   `stale_choices`; ask those fields again.
4. **Reading the verdict.** `report.overall` has two tiers for the page,
   "Can connect" / "Cannot connect", plus two waiting states `pending_user`
   and `pending_admin`. A `fail` carries
   `blocking_reason` (`incompatible` / `insufficient_info`) and `reason_codes`
   (Check Manual §4.3 gives owner and remedy for each code). Show the flags:
   `required_info_missing` (no required fields and not yet confirmed as
   genuinely all-optional), `thin_schema`, `schema_unverified`,
   `input_in_parameters`, `conversion_conditional`, `source_field_optional`.

Registry maintenance (registering names in `field_semantics.csv`) is batch
work done from the view `v_registry_candidates` (agreed and resolved answers
only); it never touches individual rows of `check_choice`.

## Not yet implemented

Shape alignment between differently nested containers (Semantic Manual 5.10)
is not performed by the engine. Since 14 October 2026 a shape difference on a
required field is reported as `shape_transformation_required`, with the
conversion's `condition` saying what a transformation step between the two
APIs would have to do (take the first element, wrap the value, pick it out of
the object); the composition layer can add such a step (#89), the check does
not. Two recognitions were widened the same day: the string that holds an
XML document in a JSON response may be named `invoice_xml`, `ublXml` or the
like, not only `xml`; and a required container whose child fields are matched
(the previous API's whole response nested in one field of the next request)
is decided by its children (2.4 rule 4) and no longer asks for an answer of
its own. Check 0 fails a Validation after a Validation and a Communication
after a Communication (`operation_sequence_repeats_stage`, decided 7 October
2026, in the engine since 14 October); two Transformations still pass.

## Tests

```
node --test "tests/checks/*.test.ts"
```
