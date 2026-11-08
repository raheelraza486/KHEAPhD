# API Composition

From a business process of at most four steps to the combinations of
catalogue APIs that can carry it out — the "list feasible combinations" step
the client set out on 19 September 2026.

```ts
const result = composeChains(process, catalogue, (source, target) =>
  runChecks({ source, target, formatAliases, choices }).overall.overall);
```

## What a step does with the document

The checks in `lib/checks` judge one ordered pair. A process is not a plain
pipe, so `planProcess` first decides which pairs to judge:

| Category | Role | Its output |
|---|---|---|
| Transformation | produces a new document | read by the next steps |
| Validation | checks the current document and lets it through | a report for the user |
| Communication | delivers the document | a receipt or status for the user |

For *convert → validate → send*, the send step is checked against what the
convert step produced, not against the validator's report. Only the ends of a
link need the matching side: a first step needs an output but not an input,
and a last step needs an input but not an output.

The order Transformation → Validation → Communication is the client's (16
September), with two rulings since:

- **No skipping Validation** (1 October). A Transformation followed directly
  by a Communication is refused (`validation_skipped`). Transformation →
  Validation and Validation → Communication on their own are fine.
- **Two Transformations** (3 October), such as extraction then conversion; so
  a process has at most four steps. The second works on the first one's output.

Going backwards is refused. In convert → validate → send, the send step is
still checked against the convert step: `composeChains` tells the checks a
Validation stands between them (`LinkContext.validated_between`), so Check 0
accepts that pair there, while the same pair compared on its own fails.

A chain is **feasible** when every link passes, and **needs a decision** when
none has a proven incompatibility but one lacks technical evidence, awaits a
field mapping or administrator (`unknown` / `pending_user` / `pending_admin`).

## The process JSON (format 1.0)

What the Discovery / LLM stream hands over. Set by the BP-Builder stream on
28 September 2026. The endpoint parses this JSON, resolves candidate IDs from
the catalogue, then calls `composeChains`. Contract: `process-format.schema.json`
(give it to the model as its response schema); check: `parseProcessJson` in
`process-format.ts`.

The implemented `POST /api/discovery` route produces this contract from text,
BPMN/process images and audio. Its request formats, limits and composition
hand-off are documented in `lib/discovery/README.md`.

### Automatic two-API conversions (#89)

Discovery describes the business goal; it does not need an uploaded invoice.
For a Transformation with named input and output formats, the composition
endpoint first looks for an operation that covers both. Otherwise,
`transformation-expansion.ts` searches two format segments and inserts a second
Transformation. For example, PDF to UBL XML can become extraction to JSON,
then conversion to UBL XML. Existing explicit two-Transformation processes are
not expanded again, and an explicit empty candidate list stays empty.

The search reads the stored schemas using the existing whole-document format
logic: a base64 PDF inside JSON is a PDF input, and AmitTransform's JSON `xml`
field carries XML. Generic XML output alone does not establish UBL support;
the operation must also declare UBL output capability. In addition to explicit
UBL formats and output descriptions, documented, non-rejected output claims
for UBL or Peppol BIS Billing 3.0 qualify. Input claims and aggregate catalogue
labels do not establish UBL output. Reported or conditional claims nominate
candidates without bypassing the existing compatibility and version checks.
Named standards and output versions remain constraints. Extra Transformation
schemas are loaded in the same bulk read, never once per candidate pair.
Direct candidates found through output claims are included alongside keyword
matches, preserving the keyword ranking first.
When every direct UBL candidate relies on a standard output claim, an available
two-API conversion is preferred. An output claim does not prove that a converter
accepts ordinary PDFs: XML/hybrid PDF support can require embedded invoice XML.
Explicit UBL output formats or descriptions retain the existing direct path.
If no two-API path exists, claim-based direct candidates remain in the shortlist;
their presence is not evidence of a successful provider call.

This is deterministic planning, not provider execution. Every inserted link
still runs the existing compatibility checks; unresolved field mappings stay
`needs_decision` (#96), and failed links are excluded. An input or output format
absent from the alias table returns `unrecognised_format` in both the planning
issue and the step's `candidate_issue`, naming the unrecognised direction and
value. It does not fall back to keyword matches, which cannot prove format
support. This reports a recognition limitation, not a lack of conversion APIs.
A recognised goal with no matching conversion returns `conversion_unresolved`;
a split exceeding four steps returns `too_many_steps`. The alias table is read
even when no conversion APIs exist, so an empty catalogue does not make known
formats look unrecognised. No Gemini or provider call is made by this endpoint.

The response retains the original `input_text` and returns the expanded
`steps`. An inserted step has `system_added: { original_order, reason }`;
the results page should mark it as "Automatically added". This response-only
metadata does not change the strict Discovery process JSON 1.0 input.

```json
{
  "version": "1.0",
  "input_text": "convert PDF to UBL XML, validate with Australian rules and send by email",
  "steps": [
    { "order": 1, "category": "Transformation", "task": "convert PDF to UBL XML",
      "input_format": "PDF", "output_format": "UBL XML", "rule_set": null, "candidate_ids": null },
    { "order": 2, "category": "Validation", "task": "validate with Australian rules",
      "input_format": null, "output_format": null, "rule_set": "Australian rules", "candidate_ids": null },
    { "order": 3, "category": "Communication", "task": "send by email",
      "input_format": null, "output_format": null, "rule_set": null, "candidate_ids": null }
  ],
  "unmatched": []
}
```

| Field | Required | Rule |
|---|---|---|
| `version` | yes | `"1.0"` |
| `input_text` | yes | the user's text, unchanged |
| `steps` | yes | in the order the user described them; `[]` when nothing was recognised |
| `steps[].order` | yes | 1, 2, 3, … — the position in the list |
| `steps[].category` | yes | exactly `Transformation`, `Validation` or `Communication`; never `Other` |
| `steps[].task` | yes | what the step does, in the user's words |
| `steps[].input_format`, `output_format` | no | a format the user named ("PDF", "UBL XML"), else null |
| `steps[].rule_set` | no | a rule set the user named ("Australian rules"), else null |
| `steps[].candidate_ids` | no | repository ids (`apis.id`) that suit the task; null = not narrowed, `[]` = none found |
| `unmatched` | yes | parts of the text that are not one of the three kinds of step; `[]` if none |

- **Any other field is an error.** A misspelt `input_fromat` is reported, not
  dropped. A new field means version 1.1, agreed between the streams.
- **Do not reorder or cut.** Report the steps as the user gave them, even five
  of them, send-before-convert or convert-then-send without validating:
  `planProcess` refuses those with a message the page can show
  (`too_many_steps`, `order_reversed`, `validation_skipped`).
- **`candidate_ids` come from searching the repository, never from the
  model**, which does not know our ids. Without them every API of the
  category is a candidate — 1,207 feasible chains for convert → validate →
  send on 25 September — so narrowing by task is what makes the list worth
  showing.
- Before calling `composeChains`, call `narrowProcessCandidates(process,
  catalogue)` from `task-candidates.ts` using the catalogue rows already read
  for this request. Pass its `result.process` to the engine. The returned
  `result.steps` gives each step's source, ranked IDs, total matches and an
  issue code for the UI. This is a pure search; it does not read the database.
  Discovery-provided IDs are checked against the active, non-duplicate
  catalogue and category. When IDs are null, a keyword search uses the task,
  formats and rule set, plus API names, descriptions and metadata. It returns
  at most five ranked IDs per step by default (`maxKeywordCandidates` can
  change that); `total_matches` shows if more were found. If a task is too
  vague or has no match, its IDs become `[]`, never all category APIs. The UI
  should ask the user to clarify or select an API in that case.
- The keyword search handles a small English/Chinese vocabulary. It is a
  shortlist that includes catalogue `network` metadata: Mailgun can match
  `send invoice via email` even though its operation describes MIME messages
  rather than invoices. For Communication steps, bare `email or peppol`
  delivery alternatives are searched separately and merged without duplicates.
  When the candidate cap allows it, the shortlist keeps a match for each
  alternative. Named invoice standards and releases elsewhere in the task or
  rule set remain required; `email and peppol` stays a joint requirement.
  This nominates senders; it does not establish attachment compatibility,
  complete required parameters or send a message.
  `composeChains` and its checks still decide which API chains are feasible.
  Discovery can supply better IDs
  through the same `candidate_ids` field when it is ready.
- Extraction words (extract, OCR, read, parse, scan and capture, plus Chinese
  equivalents) identify Transformation candidates even when their metadata
  records only a JSON or multipart envelope, provided the record shows the
  operation takes a document (PDF, image, file upload or base64): a name such
  as "Get Extracted Invoice Data" alone is not enough. A PDF conversion can
  include extraction as its first stage; this does not claim the extractor
  outputs UBL XML. When the step names its formats, the second Transformation
  is added as described above. Converters matching only the output format,
  with no PDF evidence, are excluded from that PDF request. PDF evidence is
  the API's name, else the document formats its record declares, else its
  text: e-invoice conversion declares CSV, XML and EDIFACT (migration 0050),
  so its mention of a ZUGFeRD / Factur-X PDF does not make it a PDF reader.
  A declared "Hybrid PDF" (ZUGFeRD / Factur-X, migration 0051: beliq and
  e-invoice conversion) counts only when the task asks for that kind of PDF.
  For the same reasons the checks let declared document formats replace the
  PDF-or-image guess for a Transformation's file upload, and read a Hybrid PDF
  as a PDF to any side that takes a PDF but never a plain PDF as a Hybrid PDF
  (`lib/checks/documents.ts`, `check1-format.ts`).
- If the task explicitly names a numeric release such as `XRechnung 3.0`,
  candidates that declare a different release are removed. Confirmed
  directional claims take precedence over legacy API-wide labels for this
  filter. An unversioned label remains uncertain rather than being treated as
  an exact release match.
- If a model's API rejects a schema keyword (such as `format` or
  `uniqueItems`), drop it there; `parseProcessJson` still checks it.

## Results-page endpoint

`POST /api/composition` accepts the process JSON above as its body. It does
not call an LLM or execute a provider API. The handler reads active,
non-duplicate API metadata once, reads directional standard claims once,
narrows each step, bulk-loads the selected APIs' schemas, fields, parameters
and format aliases, and runs the existing checks in memory. Signed-in requests
also load saved field answers in one bulk read, matching the compatibility
endpoint's access policy; anonymous requests do not use those answers. No
database query is made per API pair. Operations with an undocumented input or
output side remain candidates for an `unknown` result instead of disappearing.
A pending link can be opened in the compatibility workspace for review.

The successful response is version 1.1 (`api-contract.ts`); the request still
uses process JSON 1.0. Response 1.1 replaces the former exact-match
`standard_checks` shape with Check 2.0b's result and separate review metadata.

| Field | Meaning for the UI |
|---|---|
| `version`, `requestId`, `input_text`, `unmatched` | The response version, trace ID, unchanged user text and unrecognised text |
| `check_scope` | Technical checks ran; `directional_standard_version` says whether the new capability table was read; jurisdiction checking is still absent |
| `technical_checks[]` | Per-pair status, blocking reason and reason codes, including failed pairs omitted from the chain list and missing input/output schemas; `standard_flags` and `standard_conditions` retain Check 2.0b's flags and required request options for existing consumers (#107) |
| `standard_checks[]` | Per-pair Check 2.0b result: `status` (`pass`, `fail`, `unknown`, `not_voting`), `reason_code`, resolved standards, `source_basis`, `target_basis`, `matches`, `flags` and `conditions` |
| `standard_checks[].review` | Informational `source` and `target` review states; each contains the direction read and its review status |
| `steps[]` | Original step fields plus resolved `candidate_ids` |
| `steps[].candidate_source` | `discovery`, `keywords`, `formats` or `none` |
| `steps[].system_added` | Present only on an inserted Transformation: original step order and explanation |
| `steps[].candidate_issue` | `insufficient_task_detail`, `no_match`, `unrecognised_format` or null; show a clarification message when set |
| `steps[].candidate_total_matches` | All keyword matches before the five-result limit, or all candidates when resolved by formats |
| `steps[].candidate_apis[]` | `{ id, api_name, company_name, score, matched_terms }` for displaying the shortlist |
| `composition.plan`, `composition.issues` | Step roles and process-order problems |
| `composition.chains[]` | API IDs and pair verdicts, with `feasible` or `needs_decision` status |
| `composition.candidates`, `composition.counts`, `composition.truncated` | Eligible counts, all-chain counts and whether the displayed list was capped |

Invalid JSON or process format returns 400 with `{ error, requestId, details }`;
missing database configuration returns 503, and a catalogue read failure
returns 502. Every response uses `Cache-Control: no-store`. An unacceptable
step order is a valid process-format response whose `composition.issues`
explains why there are no chains; it does not read the catalogue.

`feasible` means the implemented compatibility checks passed. The route uses
the `check2.standard` result from the same `runChecks` call that decides the
link; there is no second exact-version or claim-review gate in Composition.
Check 2.0b passes same, subset and listed fillable relations, returns `unknown`
for a superset requiring an unconfirmed specification identifier, and fails
disjoint standards. Only a version difference or missing standard information
is `not_voting`: show that limitation, never label it a standard pass. Other
checks can still block a pair whose standard check passes. Insufficient
information produces an `unknown` link; proven incompatibility excludes it.

Each side uses its non-rejected directional claims, falling back to catalogue
labels when no such claims exist. A validator passing on its document uses
its input claims. This also applies when the capability table is unavailable:
Check 2.0b still runs on catalogue labels, while
`check_scope.directional_standard_version` is false.

Show **Invoice standard compatibility** and **Standard claim review** separately.
The shared `components/invoice-standard-result.tsx` component accepts one
`standard_checks` entry directly and is also used by the compatibility report.
The BP Builder results page at `/discovery` consumes this 1.1 shape and does
not read the retired `reason`, `matched` or `not_checked` fields.

| Review status | Display meaning |
| --- | --- |
| `confirmed` | All non-rejected claims on the direction used by the check are recorded as confirmed |
| `unreviewed` | At least one of those claims has not been confirmed |
| `not_assessed` | Only a catalogue label was available; directional review is unavailable |
| `not_recorded` | No invoice standard was resolved for this side (syntax-only data also falls here) |

Review does not change the verdict. For example, matching Peppol BIS 3.0
claims for beliq generate and Peppol Validator pass Check 2.0b even when a
claim is reported; the UI separately shows "Not yet reviewed". Confirming
that claim updates the review display without changing the match. Keep
`fill_required`, `version_differs`, `standard_not_recorded` and other flags
visible. Also display `configuration_required` with its `conditions`, such as
the source setting `standard=peppol-bis; output=xml`. The configuration
information introduced in #107 is preserved independently of claim review.
A passing relation does not fill invoice data, select request options,
validate a real invoice or establish complete jurisdiction compliance.

## Step Functions workflow for a chain (#62)

`POST /api/composition/workflow` turns one chain from the response above into
an AWS SAM application that one `sam deploy` in AWS CloudShell creates, as a
zip with one folder named after the workflow. It follows the client's guide of
16 October 2026 (*AWS Step Functions: A Beginner's Guide to Building Your BP
Workflow*) and the client's review of 24 October (a Lambda step per API, named
after it, with the adapter steps drawn):

| File | Content |
|---|---|
| `template.yaml` | The SAM template: one `AWS::Serverless::Function` per step, the `AWS::Serverless::StateMachine` with each function's ARN substituted, the invoke and Secrets Manager policies, and the deploy parameters |
| `statemachine.asl.json`, `.yaml` | The state machine (Amazon States Language); the YAML is for reading |
| `lambdas/<function>/lambda_function.py` | One Python 3.12 function per API |
| `lambdas/<function>/index.mjs` ... | The Node.js 22 adapter steps, with the #96 modules and `@xmldom/xmldom` carried in `node_modules`, so nothing is installed or built |
| `make_input.py`, `options.example.json` | The execution input for an invoice file; the adapter's mapping options |
| `README.txt` | The CloudShell steps, the secrets and parameters, and the warnings |

Body: `{ "api_ids": [...], "status"?: "feasible" | "needs_decision", "name"?: string }`,
taken from one `composition.chains[]` entry; `name` defaults to `BP-` and the
companies (`BP-Upbrains-AmitTransform-ESS-Mailgun`).
`?format=json` returns `{ name, warnings, files: [{ path, content }] }` instead.
Errors: 400 for a malformed body, 422 with `details` when the chain cannot be
a workflow (an unknown API, an Other category, or an order `planProcess`
refuses), 503 without a database, 502 when the catalogue cannot be read.

The diagram: `Check workflow input` (the execution input must carry
`document`, else `Workflow input rejected`), then one Task per step named
`NN <API name>` (`01 Upbrains Extract Invoice From PDF`) that invokes its own
function (`arn:aws:states:::lambda:invoke`, function `bp<chain code>-NN-<Name>`).
Each result is kept under its own key (`transformed`, `transformed2`,
`validation`, `delivery`) and the next step's document chosen with
`InputPath`; after a validator, `Check validation` reads `$.validation.isValid`
and anything but a boolean true goes to `Validation failed`. An error in any
step goes to `Composition failed` with that step's error and cause. A sender
receives the converted document, not the validator's report.

Endpoints, methods and authentication come from the catalogue. A credential
is read from the Secrets Manager secret `bp-builder/<company>`, never written
into the template; an API key goes in the header the catalogue's note names
(else the one the group's own calls use: ESS `x-api-key`, B2Brouter
`X-B2B-API-Key`, Billit `apiKey`). An endpoint's path parameters (Upbrains'
`{flowId}`, hidden as it is the webhook's secret; Mailgun's `{domain_name}`)
and the settings only the deployer knows (Mailgun `from`, `to`, `subject`;
ESS `filename`) are template parameters, asked by `sam deploy --guided`.
Three things the group's own calls send are added even where the stored
schema does not require them (`addKnownSettings`): Mailgun's message body
`text` (a parameter with a default, since Mailgun answers 400 without one),
ESS's rule pack `"pack": "billing"`, and B2Brouter's
`issued=true&send_after_import=true` with the Peppol transport and BIS 3.0
document type, without which the import only stores a draft.
The site can also deploy the workflow itself: see
`lib/workflow-deploy/README.md` (#135).

Each function sends the request its API takes, read from the API's stored
schemas with `findCarrier` (`callPlan`, `workflow-calls.ts`): the document as
the whole body (B2Brouter), a multipart file field (Mailgun `attachment`), a
base64 JSON field (Upbrains `fileBase64`, ESS `content`), a JSON field beside
fixed settings (AmitTransform `invoiceData` with `invoiceType` and
`outputFormat`) or the text in a JSON string field (Billit `XML`), and takes
the document out of a JSON string field (AmitTransform `xml`). A validator's
verdict is read from `isValid`, `success` or `valid`, or `status` of `success`
(ESS) or `valid` (Peppol Validator).

Between Upbrains and AmitTransform the workflow adds the two deterministic
steps of `/api/composed/pdf-invoice` (#96): `Adapter Upbrains to
AmitTransform` (`mapExtractionToAmit`, under PINT A-NZ when the validator is
the A-NZ one, with the seller's ABN read from the invoice as the site does)
before the converter and `Adapter complete AmitTransform UBL`
(`enrichAmitXml`) after it. Under PINT A-NZ, B2Brouter is preceded by
`Adapter Peppol BIS 3 copy for B2Brouter` (`asPeppolBis3`), as the site hands
B2Brouter's BIS-only sandbox recipients the BIS 3.0 copy of the validated
invoice. Their JavaScript is generated from `invoice-mapping.ts`,
`invoice-xml.ts` and `peppol-bis3-copy.ts`, with xmldom's files, into
`workflow-lambda-sources.generated.ts`; run `node
scripts/build-workflow-lambdas.mjs` after changing any of them or the xmldom
version (a test fails until you do). Run locally against mock APIs with the
saved Upbrains result and AmitTransform output of `tests/composition/fixtures`
(27 October 2026), the generated workflow emailed the same XML as
`/api/composed/pdf-invoice`, and stopped at `Validation failed`, `Composition
failed` or `Workflow input rejected` when it should. cfn-lint 1.58 passes the
template and the definition.

The results page shows `components/generate-workflow-button.tsx` on the chosen
chain. Nothing is deployed or executed by this endpoint.

## Composed APIs

Two operations run a chain for real, end to end. Each stops at the first step
that fails and says which one; in both, the validator is a gate, so an invoice
that is invalid, or that could not be validated, is not sent.

| Route | Page | Chain | Code |
| --- | --- | --- | --- |
| `POST /api/composed/peppol-invoice` | `/compose/peppol-invoice` | beliq generate → Peppol Validator → B2Brouter (Peppol) or Mailgun (email) | `peppol-invoice.ts` |
| `POST /api/composed/pdf-invoice` | `/compose/pdf-invoice` | Upbrains extract → AmitTransform convert → ESS PINT A-NZ → B2Brouter or Ademico (Peppol) or Mailgun | `pdf-invoice.ts` |

The second is the client's use case of 11 October 2026 ("convert pdf to ubl
xml, validate using Australian rules and send via email or peppol"), built
from the APIs the client designated. Its APIs do not fit each other as they
are, so two deterministic steps sit around the converter, from #96's mapping:

- `mapExtractionToAmit` (`invoice-mapping.ts`) reads the extractor's result
  into the converter's input. It refuses what it cannot balance or does not
  cover (more than one document, a credit note, a discount, an unknown unit,
  totals that do not add up) rather than guessing.
- `enrichAmitXml` (`invoice-xml.ts`) checks that the converter kept every
  value it was given, adds what it never writes (the specification
  identifiers, the currency on each amount, the tax breakdown, each line's tax
  category) and drops the loose elements it leaves under the root.

The flow maps for PINT A-NZ and gives the parties the identifiers a PDF does
not carry: the seller's ABN, read from the tax number printed on the invoice,
as its electronic address and legal registration, and the buyer reference,
the buyer's ABN and electronic address the caller enters. None is made up,
and the response lists everything that was added. Sent to ESS as it came,
the converter's XML failed EN 16931 with 28 fatal errors (real run,
12 October); mapped and completed this way the same invoice passes PINT A-NZ
(real runs, 14 October).

By email the validated document is attached as it is. Over Peppol it is not:
B2Brouter's sandbox recipients receive only Peppol BIS Billing 3.0, and
B2Brouter replaces a PINT A-NZ document type with that one without saying
so, after which the GST tax has no category and the invoice is not sent
(two real runs and a directory lookup, 13 October). So `asPeppolBis3` makes a
copy with the BIS 3.0 specification identifiers, the tax scheme named VAT and
the country in front of the tax number (BR-CO-09), with every amount, party
and line the same, and the response carries it as
`sent_copy` so that what was sent is never passed off as what was validated.
The copy (`peppol-bis3-copy.ts`) is not validated in the flow; the copies
of the 13 and 14 October runs pass the Peppol Validator as BIS Billing 3.0.

Ademico, the second Peppol platform (`peppol_platform=ademico`), needs no
copy: it sends on the real Peppol test network and takes a PINT A-NZ invoice
as it is, so the validated document is sent. It queues the document and
answers with a transmission id; the outcome is read, not consumed, from that
transmission's notifications (DOCUMENT_SENT → delivered, DOCUMENT_SEND_FAILED
→ error, a buyer's invoice response → its status), and is "queued" if none
has come within the polls. Ademico sends only as a participant registered on
the account, so the PDF's seller ABN must be that participant, and the
receiver must be a test-network participant that accepts PINT A-NZ.

The delivery step is shared (`deliverInvoice` in `peppol-invoice.ts`). The
settings are listed in `frontend/.env.example`.

The PDF page offers **Cancel** while a run is in progress. It aborts the browser
request and keeps the chosen file and form values for a retry. Leaving the page
also aborts the request, and late replies cannot update a cancelled or newer run.
The route passes its cancellation signal through extraction, conversion,
validation, delivery and polling waits, preventing later requests after cancellation.
An external service may still finish work it already accepted; cancellation cannot
recall an invoice already sent. Cancelled HTTP requests use status 499 when a
response can still be returned.

## Directional standard-version claims

Migration `0038_directional_invoice_standards.sql` adds one row per API
operation, `input`/`output` direction, standard and specific version, with an
optional profile and request `condition`. Existing `apis.invoice_standard`
values are not split automatically: a conversion API's old array does not
tell which standard it consumes and which it produces.

`POST /api/invoice-standard-capabilities` accepts a claim from an authenticated
publisher for an API they own, or from an administrator. It always saves
`status: "reported"`, even if the caller supplies another status. Example body:

```json
{
  "api_id": "<existing API UUID>",
  "direction": "output",
  "standard": "XRechnung",
  "version": "3.0.2",
  "profile": "",
  "condition": "standard=xrechnung",
  "evidence_url": "https://provider.example/docs"
}
```

`GET /api/invoice-standard-capabilities?api_id=<UUID>` lets the owner or
administrator inspect claims. `PATCH /api/invoice-standard-capabilities`
requires an administrator: `{ "id": "<claim UUID>", "decision": "confirmed",
"evidence_url": "https://provider.example/docs" }`. Confirmation requires a
review-time source URL; rejection requires a note. Final reviews cannot be
overwritten through this endpoint. These administrative rules govern the
review record; they are not an additional compatibility gate. Check 2.0b
considers both reported and confirmed claims, excludes rejected claims, and
returns their review state separately. `profile` and evidence URLs remain
curation metadata; Check 2.0b does not require exact profile equality.
A matched claim's `condition` is returned as a required request setting with
`configuration_required`; it does not change the verdict. An executing
integration must supply those settings. Different releases follow Check
2.0b's `version_differs` policy
described above.

## Extraction result to UBL XML (#96)

`POST /api/composed/extracted-invoice` accepts `{ extraction, options? }`, where
`extraction` is a saved Upbrains response with exactly one invoice in
`extractor_result.documents`. It requires an authenticated same-origin request,
permits ten requests per user per minute and accepts up to 500,000 characters.
The response is not cached. This endpoint neither uploads a PDF nor calls
Upbrains, ESS or a sender. The complete execution flow is tracked in #102.

`mapExtractionToAmit` unwraps fields and parsed details, checks the amounts,
formats dates, and maps the invoice into AmitTransform's flexible input.
`convertExtractedInvoice` calls AmitTransform; `enrichAmitXml` removes misplaced
root fields and inferred party IDs, completes currency/tax/profile information
and restores UBL element order. A separate `totals` object avoids the provider
mistaking the scalar gross amount for its totals input. No Gemini is used.

```javascript
const response = await fetch('/api/composed/extracted-invoice', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    extraction: savedUpbrainsResponse,
    options: {
      profile: 'pint-aunz',
      buyerReference,
      seller: {
        countryCode: 'AU', endpointId: sellerEndpoint, endpointSchemeId: sellerEndpointScheme,
        legalRegistrationId: sellerAbn, legalRegistrationSchemeId: '0151',
      },
      buyer: {
        countryCode: 'AU', endpointId: buyerEndpoint, endpointSchemeId: buyerEndpointScheme,
        legalRegistrationId: buyerAbn, legalRegistrationSchemeId: '0151',
      },
    },
  }),
});
const result = await response.json();
```

Supply actual party identifiers, or explicitly chosen test values for a demo:

- `buyerReference` fills a missing reference; a conflict with the extracted
  `BuyerReference` is rejected. No reference is invented when this option is absent.
- `seller` / `buyer` accept `countryCode`, paired `endpointId` / `endpointSchemeId`,
  and paired `legalRegistrationId` / `legalRegistrationSchemeId`. The legal ID
  goes in `PartyLegalEntity/CompanyID` with its explicit scheme. It is separate
  from the electronic address and the tax identifier; neither is copied into it.
  Scheme `0151` identifies an ABN. Whitespace in an ABN is removed.
- `VendorTaxId` is whitespace-normalised. BIS VAT identifiers receive the
  seller's known country prefix if none is present. PINT GST identifiers use the
  local number. Parsed ISO countries, Australia and New Zealand are recognised;
  other country names require explicit ISO context. Conflicting countries fail.
- `currency` is needed when no monetary `details.code` exists; conflicts fail.
  A dollar symbol does not choose a currency.
- `taxRate` is a fallback for a missing line rate, with no default 10%.
- `dateOrder` (`DMY` / `MDY`) is needed for non-ISO dates without parsed details.
- `profile` defaults to `peppol-bis3` (BIS identifiers / VAT). `pint-aunz` selects
  [PINT A-NZ identifiers / GST](https://docs.peppol.eu/poac/aunz/pint-aunz/bis/).

Common unit words are normalised by a small explicit table: hours/hr/hrs to HUR,
days to DAY, minutes to MIN, months to MON, years to ANN, each/units to C62,
pieces to H87, kilograms/kg to KGM, grams to GRM, metres/meters to MTR and litres
to LTR. Codes are case-insensitive. Other supported codes are PCE, MTK, MTQ, MLT,
TNE, XBX and XPK; unknown units fail clearly. An absent unit retains C62.

The current scope is unpaid invoices with positive standard tax rates. Prices
and quantities allow four decimal places; line amounts and totals must balance
after rounding each tax subtotal to cents. Credit notes, exempt/zero tax,
allowances/charges, prepayments and results requiring review are rejected.

The response carries `invoice_xml`, `profile`, `currency` and
`validation: { status: "not_run" }`. Converter HTTP 200 is not validation.
Pass the completed XML unchanged to the agreed validator and gate sending on
its valid verdict. Missing party metadata may still cause validation errors.
Verification records belong in the group's OneDrive, not the repository.

Offline regression tests:

```bash
node --test tests/composition/invoice-mapping.test.ts tests/composition/extracted-invoice-route.test.ts
```

### PDF demo replay safeguards (31 October)

The PDF send route now checks the selected transport's local configuration
before spending extraction credits. Missing Mailgun or B2Brouter settings
return 503 before extraction, matching the existing Ademico preflight.
This checks configuration presence, not the external account's Peppol
connection or credit balance.

For an agreed B2Brouter sandbox replay the form accepts `invoice_number`,
`issue_date` and `due_date`. They are validated before extraction, passed into
the same mapping used by AWS workflows and listed as replacements in the
result. The original PDF, source party identities and amounts stay unchanged.
Empty fields retain the source values. If a replaced issue date exceeds the
original due date, the run asks for an explicit due-date replacement rather
than silently changing payment terms. These fields are refused for other
transports. A duplicate number can already be reserved by a failed import;
it does not mean extraction credits or Peppol test allowance have expired.
