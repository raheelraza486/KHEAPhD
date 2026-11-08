# Schema recovery

Run from `frontend` with Node 24. The commands load the existing server-only
`.env.local`; never put its contents or database keys in a report.

```powershell
# Fetch documentation once per URL and create a file-backed plan (no DB writes).
pnpm schemas:backfill --plan .schema-backfill/recovery.plan.json

# Review the plan's fill/skipped entries, then add missing schemas.
pnpm schemas:backfill --apply --from-plan .schema-backfill/recovery.plan.json --actor-user-id <active-admin-UUID> --report .schema-backfill/recovery.apply.json
```

The planner reads all active, nonduplicate APIs, discovers explicitly declared
OpenAPI 3 documents in JSON/YAML, Swagger/Redoc configuration or inert embedded
JSON, and matches their declared endpoints and methods. Older API rows without
a method require an unambiguous operation. Multiple declared servers are
supported. Request bodies and successful/default responses are stored separately
by media type/status; error-only definitions do not count as usable outputs.

If a documentation link fails or has an unsupported format, the planner also
checks other specifications already fetched from catalogue links in that run.
The complete endpoint/method must be unambiguous across those documents, and
their schema definitions must agree. Cross-document matches retain the original
API identity and record the actual source URL/hash plus a warning. Documents
linked by already-covered APIs are still fetched while gaps remain, so their
definitions can recover other legacy records on subsequent runs.

Each plan includes API snapshots, document URLs/hashes, raw definitions, derived
field rows and per-API skip reasons. Apply checks the selected administrator,
database identity, current API identity and existing schema rows before writing.
It does not alter API metadata or replace schemas. A replay skips APIs already
filled. Each completed API is checkpointed to the report and audited in the DB.
Interrupted writes should be reconciled against the report/database before a
retry; schema and field insertion use separate REST requests.

## NAV WADL/XSD

NAV publishes XML rather than OpenAPI. This companion fetches the official WADL
and README, then invokes the offline PowerShell 7 extractor (`pwsh` required):

```powershell
node --env-file=.env.local scripts/plan-nav-schemas.ts --from-plan .schema-backfill/recovery.plan.json --plan .schema-backfill/nav.plan.json
pnpm schemas:backfill --apply --from-plan .schema-backfill/nav.plan.json --actor-user-id <active-admin-UUID> --report .schema-backfill/nav.apply.json
```

Only NAV v3's documented POST operations are matched. The provider README must
explicitly identify both production and test origins before applying that narrow
environment mapping. XML media types, root element, namespaces, attributes and
source provenance are preserved. The JSON-Schema-like structural projection
supports field comparison; XML lexical, namespace, ordering and nil rules still
require XML validation. Unsupported or recursive definitions are skipped.

## Missing sources

PDF/plain HTML/WSDL documents need their own supported extraction path; protected
or broken links need an accessible source. Missing request/response definitions,
method ambiguity and version mismatches remain explicit skipped rows. Recovery
does not invent definitions or infer required fields from example values.

The public compatibility page shows directional saved-schema counts, selected
media types, source links and extraction warnings. User selections do not require
admin access or local schema uploads once definitions have been recovered.

# Client use-case snapshot

`tests/composition/client-use-case-regression.test.ts` runs the client's
wordings of the use case through the composition route against a snapshot of
the live catalogue. Refresh the snapshot after a designated API's record or
schema is corrected on purpose:

```sh
node scripts/refresh-client-use-case-fixture.ts
npm test
```

The script uses only the site's public reads (`/api/apis` and `/api/schemas`)
and rebuilds `format_alias` from the migrations; it needs no keys and writes
nothing to the database. Read the diff of
`tests/composition/fixtures/client-use-case-catalogue.json` before committing:
every change should be a correction someone made on purpose.
