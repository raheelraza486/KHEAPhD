-- Normalise the reference data in public.apis
--
-- Section A. Three problems found in the client's dataset and in the records we
-- added, all of which block later work:
--
--   1. One format is written several ways -- UBL, UBL XML, UBL XML format,
--      UBL 2.1 and XML all appear -- and the BP-Builder decides whether two
--      APIs can be chained by comparing exactly these fields.
--   2. One company appears under several spellings: ECOSIO and Ecosio GmbH,
--      StoreCove and Storecove, Ezzy Bills and EzzyBills.
--   3. Some records point at localhost or at example.com. These are not the
--      same thing and must not be treated alike: a localhost endpoint is a real
--      API a company runs privately, which the client asked us to keep and
--      categorise; a documentation URL on example.com cannot exist, because
--      RFC 2606 reserves that domain.
--
-- Design
-- ------
-- The mappings live in tables rather than in one-off UPDATE statements, so the
-- cleaning is repeatable, reviewable in a diff, and correctable without editing
-- history. Running this file twice changes nothing the second time.
--
-- Original values are copied aside before anything is rewritten, and only when
-- the copy is still empty, so a second run can never overwrite a true original.
--
-- Nothing is deleted. The client was explicit on 29 August: categorise rather
-- than remove.

-- ------------------------------------------------------------ format aliases

create table if not exists public.format_alias (
  alias      text primary key,
  canonical  text not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);

comment on table public.format_alias is
  'Maps the spellings found in the data to one canonical format name. Add a row
   rather than editing records by hand, so that every rewrite is reproducible.';

insert into public.format_alias (alias, canonical, note) values
  ('UBL',               'UBL',  'canonical'),
  ('UBL XML',           'UBL',  'same family, different spelling'),
  ('UBL XML format',    'UBL',  'same family, different spelling'),
  ('UBL 2.1',           'UBL',  'version is recorded in the record, not the format name'),
  ('JSON',              'JSON', 'canonical'),
  ('JSON payload',      'JSON', 'same format, different spelling'),
  ('XML',               'XML',  'generic XML, kept distinct from UBL on purpose'),
  ('PDF',               'PDF',  'canonical'),
  ('Base64',            'Base64', 'canonical'),
  ('Form URL encoded',  'Form URL encoded', 'canonical'),
  ('Validation Report', 'Validation Report', 'canonical'),
  ('Status Codes',      'Status Codes', 'canonical'),
  ('Email receipts',    'Email receipts', 'canonical'),
  ('Images',            'Images', 'canonical'),
  ('Scans',             'Scans',  'canonical')
on conflict (alias) do nothing;

-- XML is deliberately not folded into UBL. UBL is a specific standard; a record
-- that says only XML has not told us which one, and guessing would create a
-- false compatibility match in the BP-Builder.

-- ---------------------------------------------------------- provider aliases

create table if not exists public.provider_alias (
  alias      text primary key,
  canonical  text not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);

comment on table public.provider_alias is
  'Maps company-name spellings to one canonical provider. Curated by hand: name
   similarity alone is not evidence that two providers are the same company.';

insert into public.provider_alias (alias, canonical, note) values
  ('ECOSIO',      'Ecosio',    'same company, capitalisation'),
  ('Ecosio GmbH', 'Ecosio',    'same company, legal suffix'),
  ('StoreCove',   'Storecove', 'same company, capitalisation'),
  ('Storecove',   'Storecove', 'canonical'),
  ('Ezzy Bills',  'EzzyBills', 'same company, spacing'),
  ('EzzyBills',   'EzzyBills', 'canonical')
on conflict (alias) do nothing;

-- BILL and Billit are NOT aliases of one another. A string-similarity check
-- flags them as a probable duplicate; they are separate companies, bill.com and
-- billit.be. They are named here so that nobody merges them later.

-- ------------------------------------------------- keep the original values

alter table public.apis
  add column if not exists company_name_original   text,
  add column if not exists input_formats_original  text[],
  add column if not exists output_formats_original text[];

comment on column public.apis.company_name_original is
  'The value as supplied, captured before normalisation. Written once, never
   overwritten, so the record of what the source actually said survives.';

update public.apis
   set company_name_original   = coalesce(company_name_original, company_name),
       input_formats_original  = coalesce(input_formats_original, input_formats),
       output_formats_original = coalesce(output_formats_original, output_formats)
 where company_name_original is null
    or input_formats_original is null
    or output_formats_original is null;

-- --------------------------------------------------------- data quality flags

alter table public.apis
  add column if not exists access_scope text not null default 'public',
  add column if not exists data_quality text not null default 'ok';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'apis_access_scope_check') then
    alter table public.apis add constraint apis_access_scope_check
      check (access_scope in ('public', 'restricted', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'apis_data_quality_check') then
    alter table public.apis add constraint apis_data_quality_check
      check (data_quality in ('ok', 'unreachable_documentation', 'suspected_placeholder'));
  end if;
end
$$;

comment on column public.apis.access_scope is
  'restricted = a real API the provider runs for itself and does not expose,
   which the client asked us to keep and label rather than filter out.';

comment on column public.apis.data_quality is
  'unreachable_documentation = the documentation URL is on a reserved domain and
   cannot resolve, so the record cannot be confirmed. Kept, not deleted: the
   client asked for records to be categorised.';

-- A private endpoint is a property of the record, not a defect in it.
update public.apis
   set access_scope = 'restricted'
 where access_scope = 'public'
   and (api_endpoint ~* '://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|/|$)');

-- RFC 2606 reserves example.com, example.net and example.org for documentation.
-- A URL there can never resolve, so the record's source cannot be checked.
update public.apis
   set data_quality = 'unreachable_documentation'
 where data_quality = 'ok'
   and (documentation_url ~* '(^|\.)example\.(com|net|org)(/|$|:)'
     or source_url        ~* '(^|\.)example\.(com|net|org)(/|$|:)');

-- ------------------------------------------------------------- apply mappings

update public.apis a
   set company_name = pa.canonical
  from public.provider_alias pa
 where pa.alias = a.company_name
   and a.company_name is distinct from pa.canonical;

update public.apis a
   set input_formats = mapped.formats
  from (
    select a2.id,
           array_agg(distinct coalesce(fa.canonical, f) order by coalesce(fa.canonical, f)) as formats
      from public.apis a2
      cross join lateral unnest(a2.input_formats) as f
      left join public.format_alias fa on fa.alias = f
     group by a2.id
  ) as mapped
 where mapped.id = a.id
   and a.input_formats is distinct from mapped.formats;

update public.apis a
   set output_formats = mapped.formats
  from (
    select a2.id,
           array_agg(distinct coalesce(fa.canonical, f) order by coalesce(fa.canonical, f)) as formats
      from public.apis a2
      cross join lateral unnest(a2.output_formats) as f
      left join public.format_alias fa on fa.alias = f
     group by a2.id
  ) as mapped
 where mapped.id = a.id
   and a.output_formats is distinct from mapped.formats;

-- ------------------------------------------------------------------ read-outs

create or replace view public.v_unmapped_formats as
  select f as format_value, count(*) as records
    from public.apis
    cross join lateral unnest(input_formats || output_formats) as f
   where not exists (select 1 from public.format_alias fa where fa.alias = f)
   group by f
   order by count(*) desc, f;

comment on view public.v_unmapped_formats is
  'Format values with no row in format_alias. A new spelling appearing here is
   the signal to add an alias, not to edit records by hand.';

create or replace view public.v_data_quality_summary as
  select access_scope, data_quality, count(*) as records
    from public.apis
   group by access_scope, data_quality
   order by access_scope, data_quality;
