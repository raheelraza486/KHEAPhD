-- 0017  An operation's path and query parameters
--
-- 0016 stores request and response *bodies*. An operation whose whole input
-- is parameters has no body, and extractDocumentSchemas dropped such
-- operations entirely, so they reached the catalogue with nothing stored and
-- the comparison screen could only answer "cannot be determined" for them.
--
-- On the live catalogue that is seven records whose documentation parses
-- perfectly well as OpenAPI 3: six Serbian SEF downloads
-- (GET /api/publicApi/sales-invoice/xml?invoiceId=...) and one Poland KSeF
-- session operation. Reading the Serbian document again with the parameter
-- walk in place keeps 14 operations that were being dropped, and finds that
-- 43 further operations have parameters *as well as* a body -- so the
-- parameters of operations that were already stored were being lost too.
--
-- Why a table of its own rather than a row in api_schema: parameters belong
-- to the operation, not to one of its bodies. api_schema's identity is
-- (api_id, direction, status_code, media_type), and a parameters-only input
-- has no media type at all; putting one there would mean inventing a value
-- for a column whose comment says it is "the media type key as the document
-- stated it". One row per parameter also lets field matching read a
-- parameter the same way it reads a field, which is what
-- lib/compatibility/parameters.ts already expects.
--
-- Nothing existing changes. One new table.

-- ------------------------------------------------------------ api_parameter

create table if not exists public.api_parameter (
  id           uuid primary key default gen_random_uuid(),

  api_id       uuid not null references public.apis (id) on delete cascade,

  -- The parameter name as stated: 'invoiceId', 'irn'.
  name         text not null,

  -- Where it travels. Only the two locations that carry data the previous
  -- operation has to supply are stored; a header or cookie parameter
  -- (Authorization, Content-Type, a session cookie) is a transport concern,
  -- and lib/compatibility/parameters.ts already skips those when comparing.
  location     text not null,

  -- Path parameters are required by the OpenAPI specification whatever the
  -- document says, and extraction records that rather than the document's
  -- word. Query parameters are required only when stated.
  is_required  boolean not null default false,

  -- The parameter's own schema as stated, after local $ref resolution, so
  -- that a stored parameter stands on its own: the components section it
  -- pointed into is not stored with it. A parameter that states no schema is
  -- recorded as {"type":"string"}, which is the assumption comparison makes
  -- anyway -- written down once here instead of twice.
  schema       jsonb not null,

  -- The same vocabulary api_schema_field uses, so that a parameter and a body
  -- field can be compared without two sets of rules. 'unknown' is a real
  -- outcome: it means the schema stated no type.
  json_type    text not null,
  format       text,
  enum_values  text[],

  -- leaf_name_norm's rule applied to name: lowercased, separators removed.
  -- Computed at write time for the same reason it is on api_schema_field.
  name_norm    text not null,

  description  text not null default '',

  -- 'extracted' walked out of the document the importer fetched
  -- 'uploaded'  supplied by a person, for operations whose documentation
  --             cannot be reached
  origin       text not null,
  source_url   text not null default '',
  created_by   text not null default '',

  created_at   timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_parameter_location_check') then
    alter table public.api_parameter add constraint api_parameter_location_check
      check (location in ('path', 'query'));
  end if;

  -- A path parameter that is not required would contradict the
  -- specification; extraction cannot produce one, and neither can an upload.
  if not exists (select 1 from pg_constraint where conname = 'api_parameter_path_required_check') then
    alter table public.api_parameter add constraint api_parameter_path_required_check
      check (location <> 'path' or is_required);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'api_parameter_origin_check') then
    alter table public.api_parameter add constraint api_parameter_origin_check
      check (origin in ('extracted', 'uploaded'));
  end if;

  -- The same rule 0016 puts on api_schema: extraction always knows its
  -- document, an upload always knows who supplied it.
  if not exists (select 1 from pg_constraint where conname = 'api_parameter_origin_source_check') then
    alter table public.api_parameter add constraint api_parameter_origin_source_check
      check ((origin = 'extracted' and source_url <> '')
          or (origin = 'uploaded'  and created_by <> ''));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'api_parameter_name_check') then
    alter table public.api_parameter add constraint api_parameter_name_check
      check (name <> '');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'api_parameter_json_type_check') then
    alter table public.api_parameter add constraint api_parameter_json_type_check
      check (json_type in ('object', 'array', 'string', 'number', 'integer',
                           'boolean', 'null', 'unknown'));
  end if;
end
$$;

-- The specification identifies a parameter by the pair (name, in), so the
-- same name in the path and in the query are two parameters, not a conflict.
create unique index if not exists api_parameter_identity_idx
  on public.api_parameter (api_id, location, name);

-- The BP-Builder's access path: given a target operation, fetch its inputs.
create index if not exists api_parameter_api_idx
  on public.api_parameter (api_id);

-- Field matching looks up candidates by normalised name, across parameters
-- as well as fields.
create index if not exists api_parameter_norm_idx
  on public.api_parameter (name_norm);

comment on table public.api_parameter is
  'One row per path or query parameter of one API operation, as the document
   stated it. The input of an operation that takes no body: without these,
   a query operation such as GET /invoices/{irn} has nothing stored and the
   comparison can only answer "cannot be determined". Header and cookie
   parameters are deliberately not stored -- they are transport, not data the
   previous operation supplies.';

comment on column public.api_parameter.is_required is
  'Path parameters are recorded as required whatever the document says, per
   the OpenAPI specification. Query parameters only when stated.';

comment on column public.api_parameter.schema is
  'The parameter schema as stated, after local $ref resolution. A parameter
   that states no schema is recorded as {"type":"string"}.';

-- ---------------------------------------------------------------------- RLS

-- Closed to the public roles exactly as 0016 closes the schema tables: read
-- through the application''s own API routes, never straight from the browser.
-- The service key the server holds is unaffected.

alter table public.api_parameter enable row level security;
revoke all on table public.api_parameter from anon, authenticated;

-- ------------------------------------------------------------------ reading

-- What the BP-Builder can compare once parameters count as an input. Before
-- this migration an operation with parameters and no body was indistinguish-
-- able from an operation with nothing stored at all, which is the number
-- 0016's coverage view was quietly overstating as 'no schema'.
create or replace view public.v_api_input_coverage as
  with per_api as (
    select a.id,
           count(distinct s.id) filter (where s.direction = 'request')  as request_bodies,
           count(distinct s.id) filter (where s.direction = 'response') as response_bodies,
           count(distinct p.id)                                         as parameters
      from public.apis a
      left join public.api_schema s    on s.api_id = a.id
      left join public.api_parameter p on p.api_id = a.id
     where a.is_active = true
       and a.duplicate_of is null
     group by a.id
  )
  select case
           when request_bodies = 0 and response_bodies = 0 and parameters = 0 then 'nothing stored'
           when request_bodies = 0 and parameters > 0 and response_bodies > 0 then 'response body + parameter input'
           when request_bodies = 0 and parameters > 0                         then 'parameter input only'
           when request_bodies > 0 and response_bodies > 0                    then 'both bodies'
           when response_bodies = 0                                          then 'request body only'
           else 'response body only'
         end      as coverage,
         count(*) as apis
    from per_api
   group by 1
   order by 2 desc;

comment on view public.v_api_input_coverage is
  'public.v_api_schema_coverage counts bodies only. This one counts an
   operation whose input is path/query parameters as having an input, which
   is what the BP-Builder needs to know before it says a pair cannot be
   compared.';
