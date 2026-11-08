-- Audit history is user-facing, but the stored audit record is also the
-- provenance used by later verification work.  Keep the evidence statements,
-- source rows, URLs and document references exactly as written; narrow them
-- only at the read boundary before they are returned to a catalogue user.
--
-- frontend/lib/audit-presentation.ts is the application read boundary.  The
-- SQL helper below is available to a future database view that needs the same
-- deliberately narrow projection.  Nothing in this migration rewrites stored
-- details or prevents an internal writer from recording provenance.

create or replace function public.public_metadata_audit_summary(raw_details text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  payload jsonb;
  summary text;
  allowed_fields constant text[] := array[
    'api_name', 'official_api_name', 'company_name', 'official_company_name',
    'description', 'api_endpoint', 'documentation_url', 'category',
    'category_other', 'communication_direction', 'country_region',
    'http_method', 'authentication_method', 'authentication_details',
    'client_types', 'network', 'input_formats', 'output_formats',
    'invoice_standard', 'website_url', 'instructions', 'business_rules'
  ];
begin
  if raw_details is null or btrim(raw_details) = '' then return null; end if;
  begin
    payload := raw_details::jsonb;
  exception when others then
    return null;
  end;
  if jsonb_typeof(payload) <> 'object'
     or coalesce(payload->>'type', '') not in ('admin_metadata_bulk_update', 'api_fields_updated') then
    return null;
  end if;
  if coalesce(jsonb_typeof(payload->'fields'), '') = 'array' then
    select string_agg(format('%s updated', field), ', ' order by field)
      into summary
      from (
        select distinct value as field
          from jsonb_array_elements_text(payload->'fields')
         where value = any(allowed_fields)
      ) visible_fields;
  end if;
  return coalesce(summary || '.', 'API metadata updated.');
end;
$$;

revoke all on function public.public_metadata_audit_summary(text) from public, anon, authenticated;

comment on function public.admin_bulk_update_api_metadata(jsonb, uuid, text) is
  'Atomically applies administrator-curated metadata and retains structured provenance in the internal audit record. User-facing routes render a narrow audit summary.';
