-- Schemas in their own tables, separate from the API records
--
-- The problem
-- -----------
-- The catalogue records what an operation IS (provider, endpoint, method,
-- authentication) but nothing about the SHAPE of what it accepts and returns.
-- The BP-Builder's whole job is to decide whether operation A's output can
-- feed operation B's input, and today it has nothing to decide with:
-- input_formats and output_formats hold one value across the entire
-- catalogue -- JSON, 378 times across 189 records -- so every pair compares
-- as compatible (0005 records the same finding for the invoice standard).
--
-- The information exists. The importer parses each document's requestBody
-- and responses in order to fill input_formats and output_formats, then
-- discards the schemas it walked past. import_session.candidates keeps the
-- parsed operations, not their schemas.
--
-- The client asked for this shape directly on 10 September: the APIs live in
-- one table and "schema database will be separate table storing schemas or
-- invoice schemas or open api specs". Two tables, not columns on apis: one
-- operation has a request schema and one response schema per status and media
-- type, and each schema has many fields, so neither relationship fits in a
-- column.
--
-- Why the fields are flattened as well as stored raw
-- --------------------------------------------------
-- api_schema.raw keeps the schema exactly as the document stated it, so a
-- later reader can always see what was actually published. api_schema_field
-- holds the same thing flattened to one row per leaf, because comparison
-- happens field-by-field: "does A's output have something that fits B's
-- required 'invoiceNumber'" is a query over rows, not a walk over JSON. The
-- flattened form is derived and can be rebuilt from raw at any time.
--
-- leaf_name_norm is computed here, at write time, rather than during
-- comparison. Field matching normalises names before comparing them
-- (lowercase, separators removed) and a comparison of two operations would
-- otherwise recompute it for every field on both sides, every time.
--
-- What this deliberately does not do
-- ----------------------------------
-- A schema is always attached to one API operation. A free-standing invoice
-- schema with no operation behind it (a bare UBL 2.1 Invoice.xsd, say) has no
-- row here, because the BP-Builder compares operations: the question it
-- answers is whether these two endpoints can be chained. When a person
-- uploads an invoice schema by hand it is stored against the operation it
-- describes, with origin = 'uploaded'. If a use for detached schemas appears,
-- it is a later migration and a nullable api_id, not a guess made now.
--
-- Nothing existing changes. Two new tables.

-- --------------------------------------------------------------- api_schema

create table if not exists public.api_schema (
  id          uuid primary key default gen_random_uuid(),

  api_id      uuid not null references public.apis (id) on delete cascade,

  -- Which side of the call this schema describes.
  direction   text not null,

  -- The media type key as the document stated it, e.g. 'application/json'.
  -- Not normalised: a provider writing 'application/json; charset=utf-8' said
  -- that, and the alias resolution that exists for formats does not apply to
  -- schemas.
  media_type  text not null,

  -- Responses only: the response key as stated -- '200', '2XX', 'default'.
  -- Null on a request schema. A text column, not an integer, because '2XX'
  -- and 'default' are both legal OpenAPI response keys.
  status_code text,

  -- 'extracted'  walked out of the document the importer fetched
  -- 'uploaded'   supplied by a person, for the operations whose documentation
  --              cannot be reached (54 records carry data_quality =
  --              'access_restricted'; for those, extraction is not available
  --              and upload is the only path into the BP-Builder)
  origin      text not null,

  -- The document this schema was read from, or the empty string when a person
  -- uploaded it. Provenance, on the same principle as apis.source_url.
  source_url  text not null default '',

  -- Hash of the canonical form of raw. Lets a re-import notice that a
  -- provider changed a schema, rather than silently replacing it.
  content_hash text,

  -- The schema as stated, after local $ref resolution. Kept so that the
  -- flattened rows can be rebuilt and so a reviewer can read the original.
  raw         jsonb not null,

  -- Non-fatal notes from extraction: an unresolved external $ref, a recursion
  -- limit reached, a schema with no properties. The same convention as
  -- Candidate.warnings -- a note, not a failure.
  warnings    text[] not null default '{}',

  created_at  timestamptz not null default now(),

  -- Who uploaded it, when origin = 'uploaded'. Empty for extraction.
  created_by  text not null default ''
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_schema_direction_check') then
    alter table public.api_schema add constraint api_schema_direction_check
      check (direction in ('request', 'response'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'api_schema_origin_check') then
    alter table public.api_schema add constraint api_schema_origin_check
      check (origin in ('extracted', 'uploaded'));
  end if;

  -- A request has no status; a response must have one. Without this a
  -- request row could carry '200' and the uniqueness rule below would stop
  -- meaning what it says.
  if not exists (select 1 from pg_constraint where conname = 'api_schema_status_shape_check') then
    alter table public.api_schema add constraint api_schema_status_shape_check
      check ((direction = 'request'  and status_code is null)
          or (direction = 'response' and status_code is not null));
  end if;

  -- Extraction always knows its document; an upload never has one.
  if not exists (select 1 from pg_constraint where conname = 'api_schema_origin_source_check') then
    alter table public.api_schema add constraint api_schema_origin_source_check
      check ((origin = 'extracted' and source_url <> '')
          or (origin = 'uploaded'  and created_by <> ''));
  end if;
end
$$;

-- One schema per side per status per media type. coalesce is why this is an
-- index and not a table constraint: status_code is null on every request row,
-- and null is not equal to null, so a plain unique constraint would let the
-- same request schema be inserted twice.
create unique index if not exists api_schema_identity_idx
  on public.api_schema (api_id, direction, coalesce(status_code, ''), media_type);

-- The BP-Builder's access path: given an operation, fetch its schemas.
create index if not exists api_schema_api_idx
  on public.api_schema (api_id, direction);

comment on table public.api_schema is
  'One row per (operation, direction, status, media type): the request or
   response schema of one API operation, as the document stated it. Separate
   from public.apis at the client''s instruction of 10 September 2026. raw is
   authoritative; public.api_schema_field is derived from it.';

comment on column public.api_schema.origin is
  'extracted  read out of the document the importer fetched
   uploaded   supplied by a person, the only route for operations whose
              documentation cannot be reached';

comment on column public.api_schema.raw is
  'The schema exactly as stated, after local $ref resolution. External refs
   are not followed; api_schema.warnings records where one was met.';

-- --------------------------------------------------------- api_schema_field

create table if not exists public.api_schema_field (
  id            uuid primary key default gen_random_uuid(),

  schema_id     uuid not null references public.api_schema (id) on delete cascade,

  -- Dotted path from the schema root, with '[]' marking an array boundary:
  -- 'invoice.lines[].unitPrice'. Unique within the schema, which is what
  -- makes a field addressable by a comparison result.
  path          text not null,

  -- The last segment of path, as stated: 'unitPrice'.
  leaf_name     text not null,

  -- leaf_name lowercased with separators removed: 'unitprice'. Computed at
  -- write time so that field matching does not recompute it per comparison.
  leaf_name_norm text not null,

  -- object | array | string | number | integer | boolean | null | unknown.
  -- 'unknown' is a real outcome, not a failure: a schema may state no type at
  -- all, and recording that is more use than guessing one.
  json_type     text not null,

  -- The 'format' keyword as stated -- 'date-time', 'uuid', 'decimal'. Null
  -- when absent. Type compatibility reads this as well as json_type.
  format        text,

  -- True when the parent object listed this name in its 'required' array.
  -- The distinction that decides whether an unmatched field is a warning or
  -- an incompatibility.
  is_required   boolean not null default false,

  -- True when this field is reached through an array boundary, so a
  -- comparison can tell 'one invoice' from 'many invoices'.
  is_array_item boolean not null default false,

  -- Segments from the root; 0 for a top-level field.
  depth         integer not null,

  -- The 'enum' keyword as stated, cast to text. Null when absent.
  enum_values   text[],

  description   text not null default ''
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_schema_field_type_check') then
    alter table public.api_schema_field add constraint api_schema_field_type_check
      check (json_type in ('object', 'array', 'string', 'number',
                           'integer', 'boolean', 'null', 'unknown'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'api_schema_field_depth_check') then
    alter table public.api_schema_field add constraint api_schema_field_depth_check
      check (depth >= 0);
  end if;
end
$$;

create unique index if not exists api_schema_field_path_idx
  on public.api_schema_field (schema_id, path);

-- Field matching looks up candidates by normalised name across schemas.
create index if not exists api_schema_field_norm_idx
  on public.api_schema_field (leaf_name_norm);

comment on table public.api_schema_field is
  'public.api_schema.raw flattened to one row per leaf, so that comparison is
   a query over rows rather than a walk over JSON. Derived data: it can be
   rebuilt from raw at any time, and a rebuild is the correct fix if it is
   ever found to disagree with raw.';

comment on column public.api_schema_field.leaf_name_norm is
  'leaf_name lowercased with separators removed. Computed at write time so
   that comparing two operations does not renormalise both sides each run.';

comment on column public.api_schema_field.json_type is
  'unknown means the schema stated no type. Recorded rather than guessed.';

-- ---------------------------------------------------------------------- RLS

-- Written by the importer and read through the application''s own API routes,
-- exactly as import_session is: the front end reaches data through defined
-- endpoints rather than the database. Row level security with no policies,
-- plus the revoke, closes both tables to the public roles; the service key
-- the server holds is unaffected.

alter table public.api_schema enable row level security;
revoke all on table public.api_schema from anon, authenticated;

alter table public.api_schema_field enable row level security;
revoke all on table public.api_schema_field from anon, authenticated;

-- ------------------------------------------------------------------ reading

-- How much of the catalogue the BP-Builder can actually compare. The answer
-- is 0 until extraction runs, and that is the number worth watching: a
-- comparison feature over a catalogue with no schemas has nothing to compare.

-- Counted per API first, then classified. The classification cannot live in
-- the outer GROUP BY with the aggregates inside it -- Postgres refuses that,
-- and the local rehearsal is where that was found.
create or replace view public.v_api_schema_coverage as
  with per_api as (
    select a.id,
           count(s.id) filter (where s.direction = 'request')  as requests,
           count(s.id) filter (where s.direction = 'response') as responses
      from public.apis a
      left join public.api_schema s on s.api_id = a.id
     where a.is_active = true
       and a.duplicate_of is null
     group by a.id
  )
  select case
           when requests = 0 and responses = 0 then 'no schema'
           when requests  = 0                  then 'response only'
           when responses = 0                  then 'request only'
           else 'both sides'
         end      as coverage,
         count(*) as apis
    from per_api
   group by 1
   order by 2 desc;

comment on view public.v_api_schema_coverage is
  'How many active catalogue records carry a request schema, a response
   schema, both, or neither. "no schema" is the backlog the BP-Builder cannot
   yet reason about.';
