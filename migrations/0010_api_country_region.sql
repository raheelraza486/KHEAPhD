-- Add an explicit geographic dimension to catalogue records.
--
-- Historical rows deliberately stay blank: a provider's headquarters, an API
-- server's location and the jurisdiction covered by an invoice format are not
-- interchangeable, so a migration must not guess and persist one of them.
-- The application can show a conservative, non-persisted fallback for legacy
-- rows until a person or the document importer supplies this field.

alter table public.apis
  add column if not exists country_region text not null default '';

comment on column public.apis.country_region is
  'Country, jurisdiction or geographic coverage used to find this API capability. Blank means not yet specified.';

create index if not exists apis_country_region_idx
  on public.apis (country_region)
  where country_region <> '';
