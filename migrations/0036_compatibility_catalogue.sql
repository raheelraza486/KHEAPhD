-- 0036  The compatibility workspace must not browse the complete catalogue.
--
-- A comparison can only get as far as the schema checks when the selected
-- operation has stored definitions on both sides. Keep that access boundary
-- in the database: the application route reads this projection, rather than
-- downloading every API and filtering the catalogue in the browser.

drop view if exists public.v_compatibility_catalogue;

create view public.v_compatibility_catalogue
with (security_invoker = true)
as
  with schema_counts as (
    select schema_row.api_id,
           count(*) filter (
             where schema_row.direction = 'request'
           ) as request_count,
           count(*) filter (
             where schema_row.direction = 'response'
               and (
                 schema_row.status_code ~ '^2[0-9][0-9]$'
                 or upper(coalesce(schema_row.status_code, '')) = '2XX'
                 or lower(coalesce(schema_row.status_code, '')) = 'default'
               )
           ) as response_count
      from public.api_schema schema_row
     where exists (
       select 1
         from public.api_schema_field field_row
        where field_row.schema_id = schema_row.id
     )
     group by schema_row.api_id
  )
  select api.id,
         api.api_name,
         api.official_api_name,
         api.api_endpoint,
         api.http_method,
         api.operation_selector,
         api.company_name,
         api.official_company_name,
         api.country_region,
         api.website_url,
         api.documentation_url,
         api.source_url,
         api.category,
         api.category_other,
         api.input_formats,
         api.output_formats,
         api.is_active,
         api.duplicate_of,
         counts.request_count,
         counts.response_count
    from public.apis api
    join schema_counts counts on counts.api_id = api.id
   where api.is_active = true
     and api.duplicate_of is null
     and counts.request_count > 0
     and counts.response_count > 0;

comment on view public.v_compatibility_catalogue is
  'The comparison-ready API catalogue: active, non-duplicate operations with
   at least one stored request schema containing fields and one stored
   successful response schema containing fields. Empty binary, PDF or
   unstructured XML schema rows do not qualify. The compatibility page reads
   this projection instead of the full catalogue.';

-- api_schema is deliberately closed to browser roles. This projection stays
-- behind the application route as well, so the browser cannot expand it into
-- a general catalogue query or inspect the underlying schema inventory.
revoke all on public.v_compatibility_catalogue from public, anon, authenticated;
grant select on public.v_compatibility_catalogue to service_role;
