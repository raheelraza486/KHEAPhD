-- One row per submitted URL: the fetch, the parse, the review, and the outcome
--
-- The URL importer is a two-phase interaction:
-- preview fetches and parses a document and shows its operations; confirm
-- writes the new ones the submitter selected. Between the two
-- phases the parsed candidates must live on the server. Content accepted back
-- from a browser is a claim about what the document said, not what it said,
-- so the candidates are stored here at preview time and loaded back at
-- confirm time.
--
-- The table records refused submissions as well as successful ones. A
-- refusal that names the format it recognised ("wsdl", "swagger_2") is the
-- data that decides which parser the next release implements; without this
-- table it would be an error message that disappears. It also holds the
-- normalised document URL, the content hash retained for provenance, and the
-- candidates and selections that explain what each submission did. Existing
-- catalogue records are never changed by this importer.
--
-- Nothing existing changes. One new table, and one partial unique index on
-- public.apis whose predicate excludes every record that predates import.

-- ------------------------------------------------------------------ table

create table if not exists public.import_session (
  id                    uuid primary key default gen_random_uuid(),

  -- Exactly what the user submitted, kept for support and audit.
  documentation_url_raw text not null,

  -- After redirects, normalised (lowercased scheme and host, default port
  -- and fragment removed, query preserved, trailing slash removed). This is
  -- the form the importer's matching key and the hash comparison use.
  documentation_url     text not null,

  -- Hash of the fetched bytes, retained for provenance and diagnostics. It
  -- must not suppress a later preview: one document can be imported partially,
  -- then submitted again so the remaining operations can be selected.
  content_hash          text,

  detected_format       text,

  -- What the document claims about itself (info.version). Recorded so a
  -- reviewer reading the audit trail can see "2.1 -> 2.0" at a glance; never
  -- acted on, because a claim of newness is an inference, not a fact.
  info_version          text,

  outcome               text not null default 'previewed',
  refusal_reason        text,

  -- The parsed operations, exactly as the document stated them; after
  -- confirm, also the selected/applied indices retained for provenance.
  candidates            jsonb,

  -- Free text until sign-in exists; the column is what makes "which records
  -- came from an import, submitted by whom" answerable at all.
  submitted_by          text,

  created_at            timestamptz not null default now(),

  -- When stored candidates stop being offered for confirmation.
  expires_at            timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'import_session_detected_format_check') then
    alter table public.import_session add constraint import_session_detected_format_check
      check (detected_format is null or detected_format in
        ('openapi_3', 'swagger_2', 'wsdl', 'html_page', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'import_session_outcome_check') then
    alter table public.import_session add constraint import_session_outcome_check
      check (outcome in ('previewed', 'imported', 'refused', 'expired'));
  end if;
end
$$;

-- Support URL-based submission history queries. The hash remains useful for
-- provenance and diagnostics only.
create index if not exists import_session_url_idx
  on public.import_session (documentation_url, created_at desc);

comment on table public.import_session is
  'One row per URL submitted to the importer, refused submissions included.
   Holds the parsed candidates between the preview and confirm phases, the
   normalised URL, provenance hash, candidates and selection outcome.';

comment on column public.import_session.outcome is
  'previewed  parsed and awaiting confirmation
   imported   confirmed; candidates records what was selected and added
   refused    not parsed; refusal_reason and detected_format say why
   expired    previewed but never confirmed before expires_at';

-- The table is read and written only by the server. Row-level security with
-- no policies, plus the revoke, closes it to the public roles; the service
-- key bypasses RLS as it does everywhere else.
alter table public.import_session enable row level security;
revoke all on table public.import_session from anon, authenticated;

-- ------------------------------------------------------- concurrency guard

-- The importer looks up (documentation_url, api_endpoint, http_method) to
-- decide whether an operation already exists. Two confirmations running at
-- once could both find nothing and both insert; this index makes the second
-- insert fail so it can be reported as a conflict instead of becoming a
-- duplicate. The predicate excludes every record that predates import:
-- http_method is null on all of them, deliberately (0007).
--
-- Known consequence, by design: backfilling http_method on a hand-entered
-- record that duplicates an imported one is rejected by this index. That is
-- the reconciliation between the two happening at the moment it becomes
-- answerable -- resolve the duplicate, then fill the column.

create unique index if not exists apis_import_identity_idx
  on public.apis (documentation_url, api_endpoint, http_method)
  where http_method is not null;
