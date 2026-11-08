# CS-9 — Business API Ecosystem

COMP5703 Information Technology Capstone Project, Semester 2 2026
University of Sydney — group **CS9-5**, Tutorial 21

A platform for e-invoicing Business APIs: a catalogue of real APIs with their
schemas, a way to describe a business process in text, a BPMN diagram or speech,
and a builder that finds which catalogued APIs can be chained to carry it out.

## Components

| Component | Purpose | Status |
| --- | --- | --- |
| API Repository | Catalogue of e-invoicing APIs: metadata, request and response schemas, categories, search, admin verification | Built and live (`/apis`, `/apis/[id]`) |
| API Publisher | Import an OpenAPI 3.x definition by URL, extract its schemas, submit it for review | Built and live (`/submit`, `/api/import`); records wait for an admin to verify them |
| API Discovery | Turn text, a BPMN file or image, or audio into editable requirements, then find individual API matches | `/discovery?step=1..3`; inputs, files and results remain only in active-page memory and clear on refresh or exit. The extraction model never chooses API IDs; independent matching does not generate chains. |
| BP-Builder | Describe a task with text, a diagram or audio, review its requirements, then explore checked API chains | `/workflows/create?step=1..3`; shares Discovery input and editing components; one-time Discovery handoff enters Step 2. Refresh, exit or reopening clears the flow. Existing `/api/composition` contracts and standalone `/compatibility` and invoice workflows remain available. |
| Platform base | Sign-in, roles, database, deployment | Supabase Auth and Postgres; deployed on AWS ECS |

## Team

| Name | SID |
| --- | --- |
| Jinghang Miao | 520325186 |
| Junyi Zang | 530419471 |
| Di Hou | 550552093 |
| Guoqiang Chen | 540314830 |
| Yan Wang | 550477730 |
| Xiang Xu | 540372896 |
| Xinzhan Peng | 540926736 |
| Xinrui Zhang | 540981942 |

## Technology stack

There is no separate backend service: the whole application is one Next.js
project in `frontend/`.

- **Application**: Next.js (App Router) and React, TypeScript throughout. Server
  endpoints are route handlers under `frontend/app/api/`.
- **Database and sign-in**: Supabase (PostgreSQL and Supabase Auth). The schema,
  triggers and SQL functions are numbered migrations under `migrations/`.
- **LLM**: Google Gemini for API Discovery, `gemini-3.5-flash-lite` by default
  (`DISCOVERY_MODEL` overrides it).
- **Deployment**: a Docker image (`frontend/Dockerfile`) in Amazon ECR, run by
  Amazon ECS Express Mode in `ap-southeast-2`. API keys are held in AWS Secrets
  Manager and injected into the container at start.

`migrations/0001_enable_pgvector.sql` enables pgvector, but nothing uses it yet:
candidate search is keyword-based (`frontend/lib/composition/task-candidates.ts`).

## Rules for this repository

These come from the course kick-off lecture and are not optional.

- **This repository must remain private.**
- All members register and commit using their `unikey@uni.sydney.edu.au` address.
- The tutor and the client must be added as members of the organisation.
- **No codebase or resource shared by the client may be cloned or downloaded into
  this repository, or onto any member's machine, without the client's approval.**
  Request written approval at the first client meeting and archive the reply.
- All code contributions must go through Git. Everyone commits under their own
  account — `git log` is the evidence for individual contribution marks.

## Repository layout

```
frontend/                  The Next.js application
  app/                     Pages, and API route handlers under app/api/
  components/              React components
  lib/import, lib/schema   OpenAPI import and schema extraction
  lib/checks               Compatibility checks 0–3 (see its README)
  lib/composition          Candidate search, chain building, composed APIs (see its README)
  lib/discovery            LLM Discovery: prompt, Gemini provider, BPMN handling (see its README)
  tests/                   node:test suites, run by `pnpm test`
  scripts/                 Schema backfill and data scripts (see its README)
  Dockerfile               The production image
  .env.example             Copy to .env.local; Supabase, Gemini and partner API keys
migrations/                Numbered SQL migrations, applied by scripts/migrate.sh
scripts/                   deploy.sh, migrate.sh, check.sh, check-secrets.sh, verify-pgvector.sh
docker-compose.yml         Local Postgres + pgvector, for rehearsing a migration
.env.example               Copy to .env; database credentials and DATABASE_URL
```

**Documents are never stored in this repository.** The decision log, meeting
minutes, the compatibility check manuals, data reviews and reports all live in
the shared project folder on OneDrive; reports are submitted through Canvas. This
repository carries the system only: migrations, application code, tests, and the
scripts that build and check it. A README that explains the code next to it is
the one exception.

## Getting started

### Running the application locally

```bash
cd frontend
cp .env.example .env.local       # fill in the keys; .env.local is not committed
pnpm install
pnpm dev                         # http://localhost:3000
pnpm test                        # all node:test suites
pnpm typecheck
```

For `pnpm dev`, put the Supabase server and public Auth values and
`GEMINI_API_KEY` in `frontend/.env.local`. If you run the frontend with
Docker Compose, put those same values in the root `.env` using the root
`.env.example` as a template, then run `docker compose up -d --build frontend`.
Both setups read the API catalogue from the configured Supabase project.

Without `GEMINI_API_KEY`, `/api/discovery` answers 503; without the beliq,
B2Brouter or Mailgun values, the composed Peppol invoice API cannot call those
services; without the Upbrains address and the SmartDocFlow key, the composed
PDF invoice API answers 503. The rest of the application needs only the
Supabase values.

### The database

**Supabase is the project's database**, as the client asked. The schema lives in this repository as numbered migrations
under `migrations/`, and `scripts/migrate.sh` applies them and records what it
has already run, so that the deployed database and this repository do not drift
apart.

#### Applying migrations to Supabase

Get the connection string from the Supabase dashboard, under
**Project Settings → Database → Connection string → URI**, and put it in `.env`:

```
DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres
```

Use the **session** string rather than the pooled one — migrations run DDL and
the transaction pooler does not support it. That string contains the database
password, so it belongs only in `.env`, which is not committed.

```bash
./scripts/migrate.sh --dry-run   # list what would be applied, change nothing
./scripts/migrate.sh             # apply
```

Use `--to` when a later migration is not ready for the current application. For
example, `./scripts/migrate.sh --dry-run --to 0002` previews only migrations
`0000` through `0002`, and `./scripts/migrate.sh --to 0002` applies that same
bounded set. If `psql` is not installed but Docker is running, the script uses a
temporary PostgreSQL client container automatically.

Running it a second time reports `skip` for everything and changes nothing.

The first run against the existing database applies `0002_repository_schema.sql`,
which is written to be idempotent, so it prints a page of *already exists,
skipping* notices and changes nothing. That is expected: it is how the live
database gets recorded in `schema_migrations` for the first time.

#### Rehearsing a migration first — optional

Before a migration reaches the database the client looks at, it can be run
against an empty local Postgres. This is not required, and nobody has to install
Docker to work on the project.

```bash
cp .env.example .env             # set POSTGRES_PORT=5433 if 5432 is taken
docker compose up -d postgres
docker compose ps                # wait for (healthy), not just running
./scripts/migrate.sh --target local
./scripts/verify-pgvector.sh     # confirms a vector index builds and queries
```

`migrations/0000_supabase_compat.sql` creates the roles and the `auth` schema
that Supabase provides and plain Postgres does not, and only if they are absent,
so the same migrations run in both places. Without it the schema stops at
`role "anon" does not exist`, leaving the audit table and every policy uncreated
while the `apis` table looks perfectly fine.

Reset the local database with `docker compose down -v`, which deletes its data.
That is also the fix when a changed password or a newly added `initdb` script
appears not to take effect: both apply only when the data volume is first
created.

### Deploying to the live site

The live site runs as the AWS ECS Express service `cs9-api-repository` in
`ap-southeast-2`. Releases are built and deployed by hand, because the
university's GitHub has no automated pipeline.

```bash
git pull --ff-only origin main
aws login
./scripts/deploy.sh
```

The script builds the image from the current commit, pushes it to ECR as
`main-<commit>`, updates the service with that image and keeps every other
setting and secret as it is, waits until the service is stable, and checks the
load balancer's idle timeout (120 seconds, which the update can reset). It
needs Docker running and stops if the checkout has uncommitted changes or is
not at `origin/main`. It changes code only: apply new migrations first, and
change keys in AWS Secrets Manager (the following deployment makes the service
read them). The settings at the top of the script can be overridden to deploy
to another account or service.

### Before opening a pull request

```bash
./scripts/check.sh
```

There is no CI — GitHub Actions is not available on this instance — so this is
what stands in its place, together with `pnpm test` and `pnpm typecheck` in
`frontend/`.
It checks shell syntax, executable permissions, that the compose file parses with
every variable resolved, that migration filenames sort correctly, and that no
secret has been staged. When `DATABASE_URL` is set it also compares the database
with `migrations/`: every applied migration and every database object must be in a
migration file, every format value must have an alias, and catalogue records must
carry the fields the client requires. Without a database those checks are skipped,
not failed. It exits non-zero when something fails.

### First time on the project

```bash
git clone git@github.sydney.edu.au:gche0901/comp5703-cs9.git
cd comp5703-cs9
git config user.name "Your Name"
git config user.email "yourunikey@uni.sydney.edu.au"
```

Set the identity **inside the repository**, as above, rather than globally — it keeps
this project's commits under your university address without touching your other work.

Check it took before your first commit:

```bash
git config user.email
```

If commits land under the wrong address they are not credited to you in the history,
and the history is what you cite as evidence in your individual contribution report.

### Making a change

`main` is protected: it takes changes only through a pull request, merged by
squash. Start from an up-to-date `main`:

```bash
git switch main && git pull
git switch -c <area>/<short-description>    # e.g. composition/match-scope
# work, then
git add -A && git commit -m "What you changed"
git push -u origin <area>/<short-description>
```

Then open the pull request on github.sydney.edu.au and ask someone from another
group to review it. Delete the branch once it is merged.
