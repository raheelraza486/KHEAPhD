-- Record the invoice standard separately from the transport format
--
-- The problem
-- -----------
-- input_formats and output_formats hold one value across the whole catalogue:
-- JSON, 378 times across 189 records. The BP-Builder decides whether two APIs
-- can be chained by comparing those fields, so as it stands every pair compares
-- as compatible and the check has no discriminating power at all.
--
-- The information is not lost. It is in prose: 'UBL' appears in 19 descriptions
-- and 9 authentication_details fields, and a scan of the free text turns up
-- PEPPOL, Facturae, CFDI, CII, XRechnung and EN 16931 as well. For example:
--
--   "Asynchronously submits a ZIP containing up to 50 signed Colombian UBL
--    invoices or notes and returns a Track ID."
--
-- So this is not data that was overwritten. It is a dimension the schema never
-- had. Two different things were being recorded in one pair of columns:
--
--   JSON, XML, PDF, CSV          how the payload travels
--   UBL, PEPPOL, CFDI, Facturae  what the invoice inside it conforms to
--
-- An API can perfectly well carry a UBL invoice inside a JSON envelope, and
-- today only the envelope is recorded.
--
-- The approach
-- ------------
-- Patterns live in a table so that adding a standard is a reviewable row rather
-- than an edit to a regular expression buried in a migration. Extraction only
-- fills rows nobody has confirmed by hand, so a human decision is never
-- overwritten by a later re-run.

create table if not exists public.invoice_standard_pattern (
  standard   text primary key,
  pattern    text not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);

comment on table public.invoice_standard_pattern is
  'Regular expressions used to find an invoice standard in a record''s prose.
   Transport formats -- JSON, XML, PDF, CSV -- are deliberately absent: those
   belong in input_formats and output_formats, and mixing the two dimensions is
   what caused the problem this migration addresses.';

insert into public.invoice_standard_pattern (standard, pattern, note) values
  ('UBL',       '\mUBL\M',        'OASIS Universal Business Language'),
  ('PEPPOL',    '\mPEPPOL\M',     'network and its BIS profiles'),
  ('CII',       '\mCII\M',        'UN/CEFACT Cross Industry Invoice'),
  ('EN 16931',  'EN[ -]?16931',   'European semantic standard'),
  ('Factur-X',  'Factur-?X',      'French/German hybrid PDF/A-3 with CII'),
  ('ZUGFeRD',   '\mZUGFeRD\M',    'German profile of Factur-X'),
  ('XRechnung', 'X-?Rechnung',    'German CIUS of EN 16931'),
  ('FatturaPA', 'Fattura ?PA',    'Italian national format'),
  ('Facturae',  '\mFacturae\M',   'Spanish national format'),
  ('CFDI',      '\mCFDI\M',       'Mexican Comprobante Fiscal Digital'),
  ('EDIFACT',   '\mEDIFACT\M',    'UN/EDIFACT INVOIC')
on conflict (standard) do nothing;

-- ------------------------------------------------------------------- columns

alter table public.apis
  add column if not exists invoice_standard        text[] not null default '{}',
  add column if not exists invoice_standard_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'apis_invoice_standard_source_check') then
    alter table public.apis add constraint apis_invoice_standard_source_check
      check (invoice_standard_source is null
             or invoice_standard_source in ('extracted', 'confirmed'));
  end if;
end
$$;

comment on column public.apis.invoice_standard is
  'What the invoice inside the payload conforms to -- UBL, PEPPOL, CFDI and so
   on. Distinct from input_formats and output_formats, which say how the payload
   travels.';

comment on column public.apis.invoice_standard_source is
  'extracted = found in the record''s prose by this migration and not yet checked
   by a person. confirmed = a person has checked it against the provider''s
   documentation; re-running the extraction will not touch such a row.';

create index if not exists apis_invoice_standard_idx
  on public.apis using gin (invoice_standard);

-- ---------------------------------------------------------------- extraction
-- Only rows nobody has confirmed. A row marked 'confirmed' is left alone, so a
-- human decision survives every later run of this file.

with found as (
  select a.id,
         array_agg(distinct p.standard order by p.standard) as standards
    from public.apis a
    join public.invoice_standard_pattern p
      on concat_ws(' ', a.description, a.instructions, a.authentication_details,
                        a.official_api_name, a.api_name) ~* p.pattern
   where a.invoice_standard_source is distinct from 'confirmed'
   group by a.id
)
update public.apis a
   set invoice_standard        = found.standards,
       invoice_standard_source = 'extracted'
  from found
 where found.id = a.id
   and a.invoice_standard is distinct from found.standards;

-- ------------------------------------------------------------------- read-out

create or replace view public.v_invoice_standard_coverage as
  select coalesce(nullif(array_to_string(invoice_standard, ' + '), ''), '(none found)')
           as standards,
         invoice_standard_source as source,
         count(*)                as records
    from public.apis
   group by 1, 2
   order by count(*) desc, 1;

comment on view public.v_invoice_standard_coverage is
  'How many records carry each combination of standards, and whether it was
   extracted or confirmed. Records under "(none found)" need a person to read
   the provider documentation and fill the field in.';
