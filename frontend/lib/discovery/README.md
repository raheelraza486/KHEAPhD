# API Discovery

`POST /api/discovery` turns an authenticated user's text, BPMN/process image,
or audio description into the strict process JSON 1.0 contract consumed by
`POST /api/composition`.

The extraction model identifies the requested business steps. It does **not** choose API
records or receive repository data: every returned `candidate_ids` value is
set to `null` by the server. The composition endpoint then searches the live
catalogue and performs the compatibility checks. Keeping those responsibilities
separate prevents a model from inventing repository IDs or bypassing the
existing deterministic checks.

## Source facts and workflow suggestions

The model supplies private source citations alongside its proposed process. The
server checks text/XML citations against the submitted source and strips this
metadata before Process JSON 1.0 validation. Each format/rule must have a citation
inside its own step's clause; overlapping multi-step citations cannot justify
inheriting fields. The source clause also replaces model-paraphrased task wording
so unsupported formats cannot re-enter matching as task keywords. `XML_UBL` and
`UBL_XML` remain equivalent to `UBL XML`; bare `UBL` stays bare.

Suggested conversions may cite explicitly stated input/output goal formats from
different clauses. Suggested steps/order and fields that could not be grounded
produce review notes on Step 2, separate from the process contract. User edits
clear notes for that requirement. Source edits clear the old notes. A suggestion
is never an instruction to repair an explicit unsupported sequence.

For images/audio, citations are checked against the model's transcription, not an
independently verified OCR result. The review page states this limit. It cannot
prove that every visible/spoken label was recognised. Field checks are conservative;
users can correct an omitted field in the existing requirements editor.

Failure to reproduce the model's exact citation is not a reason to discard
explicit source facts. Action clauses (including passive `validated`/`sent`)
can recover a source-stated rule or delivery channel when a citation overlaps
other steps or is missing. Explicit input/delivery goal labels can bind a suggested
conversion across clauses. Task wording retains these grounded constraints so
matching does not become a generic "Validate invoice" / "Send invoice" search.
Unspecified format fields remain optional; users need not complete them to continue.

Repeated delivery actions are matched to source clauses in their stated order.
If a model changes "send it via Peppol" to "Send via Peppol", the source clause
still supplies that step's channel; a citation from the following email step
cannot supply it. A short citation that omits the channel is expanded from the
same source clause. BPMN email/Peppol branches are merged only when the
recognised flow describes alternatives; two sequential sends stay separate.

Validation and delivery still pass the current invoice according to the workflow
engine. Their report/receipt formats are not the invoice format. Discovery does
not need to fill these response fields to make the workflow connect.

Australian invoice-rule requests are a candidate constraint. A provider's country,
generic XML support or EN 16931/Peppol BIS labels alone do not establish PINT A-NZ
support. Positive rule evidence in catalogue metadata/input claims is required;
unestablished or conflicting records appear separately for review in independent
matching and never become chain candidates, including through explicit API IDs.
This is candidate filtering, not a compliance verdict; the existing compatibility
and invoice validation gates remain necessary. Other jurisdictions retain their
existing matching behaviour.

For catalogue search, generic "Create UBL Invoice" and "Convert PDF to UBL XML"
goals use the same PDF-to-UBL query when their explicit input/output formats
agree. A Peppol send step can use the latest declared document format for
operation matching without adding that format to the user's requirement. An
operation is excluded when its own instructions explicitly say it does not
accept the document format being delivered; a description of a separate
operation cannot override that negative evidence. Names and endpoint paths
alone do not prove a format mismatch. Extra requested standards and qualifiers
retain their own search terms.

## Temporary application workspaces

Discovery and Workflow Creation share text, diagram and recording inputs in
Step 1 and the requirements editor in Step 2. Discovery's third step matches
individual APIs; Workflow's third step explores checked API chains using the
existing composition engine. Inputs, uploaded files and results remain temporary.
The Save chain action explicitly stores the name and ordered API IDs in the
account's private Profile. It does not save the workflow inputs or analysis.

`WorkspaceMemoryProvider` keeps one active flow in browser memory. Returning
between its three steps preserves text, original File objects, edits and results.
Refreshing, closing/reopening, navigating to another page or restoring an exited
page from browser history starts empty at Step 1. Other tabs and devices cannot
restore the flow. Legacy `draft`/`view` URL parameters are discarded.

- `/discovery?step=1|2|3`: describe, edit requirements, discover APIs.
- `/workflows/create?step=1|2|3`: describe, edit requirements, explore chains.
- `POST /api/discovery`: analyse text or multipart media without storing it.
- `POST /api/composition?mode=match`: authenticated independent matching, including
  requirements that do not form a supported chain. It only reads catalogue and
  standards evidence; it does not generate chains or read schema/answer tables.
- `POST /api/composition`: existing compatibility and chain-generation contract.

Unchanged valid results are reused only within this flow. Editing a requirement
invalidates its matches and dependent chain results; reordering retains individual
matches. Source edits require fresh analysis. Refresh API matches explicitly reads
the current catalogue. There is no persistent model-result cache. Retry and cancel
retain inputs only while the user stays on the page; late responses cannot revive
an exited or restarted flow. Existing request timeouts remain configurable.

Discovery's Build a workflow action transfers an independent in-memory copy into
Workflow Step 2, clearing the source flow on exit. Selecting Run transfers only
the selected chain into the execution page in memory; refreshing that page clears
the selection. Existing standalone Compatibility and Invoice workflows remain
independent. Start again confirms and clears the current flow.

The old `/api/drafts` endpoints return 410 and perform no storage operations.
Migration `0054_discovery_workflow_drafts.sql` remains in the historical migration
ledger; its existing records and private files are not deleted by this change.
The active features no longer depend on that migration. Input still reaches the
backend and configured Gemini service when analysis is requested; in-memory UI
retention does not make model inference local to the browser.

## Configuration

Set these server-only values in `frontend/.env.local` or the Docker runtime:

```dotenv
GEMINI_API_KEY=<project key>
DISCOVERY_MODEL=gemini-3.5-flash-lite
```

Do not give either variable a `NEXT_PUBLIC_` prefix. The API key must never be
sent to the browser.

## Requests

Text requests use JSON (maximum 2,000 characters):

```http
POST /api/discovery
Content-Type: application/json

{
  "mode": "text",
  "text": "Convert PDF to UBL XML, validate it with Australian rules, then send it through Peppol."
}
```

File requests use `multipart/form-data` with `mode` and `file` fields:

```sh
curl -b cookies.txt \
  -F mode=bpmn \
  -F file=@invoice-process.png \
  http://localhost:3000/api/discovery

curl -b cookies.txt \
  -F mode=audio \
  -F file=@invoice-process.mp3 \
  http://localhost:3000/api/discovery
```

Accepted BPMN image types are PNG, JPEG and WebP, up to 5 MB. Accepted audio
types are AAC, FLAC, MP3, M4A, OGG, WAV and WebM, up to 10 MB.

## Response and composition hand-off

```json
{
  "requestId": "6afc2d73-17ca-4dd6-95bb-ec3ecb818e13",
  "source": { "mode": "text" },
  "process": {
    "version": "1.0",
    "input_text": "Convert PDF to UBL XML, validate it with Australian rules, then send it through Peppol.",
    "steps": [
      {
        "order": 1,
        "category": "Transformation",
        "task": "Convert PDF to UBL XML",
        "input_format": "PDF",
        "output_format": "UBL XML",
        "rule_set": null,
        "candidate_ids": null
      }
    ],
    "unmatched": []
  }
}
```

Send the `process` object, unchanged, as the JSON body of
`POST /api/composition`. That endpoint searches the repository, returns the
ranked API candidates, and evaluates the possible chains.

## Safety and failure behaviour

- A signed-in repository user is required.
- Requests are limited per user to protect model quota.
- Uploaded content is sent to the configured Gemini project but is not stored
  by this route.
- Model output is checked by the existing process JSON parser before it can
  reach composition.
- Provider errors are logged with a request ID; provider response details and
  credentials are never returned to the browser.
- Every response uses `Cache-Control: no-store`.

The route and provider tests use fakes, so `pnpm test` does not require a live
Gemini key. A real end-to-end request does require `GEMINI_API_KEY` and a
signed-in application session.
