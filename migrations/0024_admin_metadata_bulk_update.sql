-- Administrators may apply reviewed metadata spreadsheets atomically.
--
-- The browser first previews the spreadsheet against the current catalogue and
-- sends each record's updated_at value back with the commit. This function
-- locks every target row and refuses the whole transaction if any record has
-- changed since that preview. The service role is the only database role that
-- may execute it; the authenticated application user is checked again here.

create or replace function public.admin_bulk_update_api_metadata(
  p_updates jsonb,
  p_actor_user_id uuid,
  p_actor_name text
)
returns table (
  api_id uuid,
  updated_at timestamptz,
  review_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  changes jsonb;
  target public.apis%rowtype;
  row_id uuid;
  expected_updated_at timestamptz;
  invalid_keys text[];
  seen_ids uuid[] := '{}';
  actor_display_name text;
  allowed_keys constant text[] := array[
    'official_api_name', 'official_company_name', 'category_other',
    'communication_direction', 'country_region', 'http_method',
    'authentication_details', 'client_types', 'network', 'input_formats',
    'invoice_standard', 'website_url', 'instructions', 'business_rules'
  ];
begin
  select left(coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.email), ''), 'Authenticated user'), 120)
    into actor_display_name
    from public.app_user u
   where u.id = p_actor_user_id
     and u.role = 'admin'
     and u.is_active;
  if not found then
    raise exception 'An active administrator is required.' using errcode = '42501';
  end if;
  if p_actor_name is distinct from actor_display_name then
    raise exception 'Administrator attribution does not match the active account.' using errcode = '42501';
  end if;

  if coalesce(jsonb_typeof(p_updates), '') <> 'array' then
    raise exception 'p_updates must be a JSON array.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_updates) < 1 or jsonb_array_length(p_updates) > 500 then
    raise exception 'A bulk metadata update must contain between 1 and 500 APIs.' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p_updates)
  loop
    if jsonb_typeof(item) <> 'object' then
      raise exception 'Every update must be a JSON object.' using errcode = '22023';
    end if;

    begin
      row_id := (item->>'id')::uuid;
      expected_updated_at := (item->>'expected_updated_at')::timestamptz;
    exception when others then
      raise exception 'Every update requires a valid id and expected_updated_at.' using errcode = '22023';
    end;
    if row_id = any(seen_ids) then
      raise exception 'API % appears more than once in the update.', row_id using errcode = '22023';
    end if;
    seen_ids := array_append(seen_ids, row_id);

    changes := item->'changes';
    if coalesce(jsonb_typeof(changes), '') <> 'object' or changes = '{}'::jsonb then
      raise exception 'API % has no metadata changes.', row_id using errcode = '22023';
    end if;
    select coalesce(array_agg(key), '{}')
      into invalid_keys
      from jsonb_object_keys(changes) as supplied(key)
     where not (key = any(allowed_keys));
    if cardinality(invalid_keys) > 0 then
      raise exception 'API % contains unsupported fields: %.', row_id, array_to_string(invalid_keys, ', ')
        using errcode = '22023';
    end if;

    if changes ?| array['client_types', 'input_formats', 'invoice_standard', 'business_rules'] then
      if (changes ? 'client_types' and jsonb_typeof(changes->'client_types') <> 'array')
         or (changes ? 'input_formats' and jsonb_typeof(changes->'input_formats') <> 'array')
         or (changes ? 'invoice_standard' and jsonb_typeof(changes->'invoice_standard') <> 'array')
         or (changes ? 'business_rules' and jsonb_typeof(changes->'business_rules') <> 'array') then
        raise exception 'List metadata for API % must be JSON arrays.', row_id using errcode = '22023';
      end if;
    end if;

    select a.* into target
      from public.apis a
     where a.id = row_id
     for update;
    if not found or not target.is_active or target.duplicate_of is not null then
      raise exception 'Active API % was not found.', row_id using errcode = 'P0002';
    end if;
    if target.updated_at is distinct from expected_updated_at then
      raise exception 'API % changed since preview; preview the spreadsheet again.', row_id using errcode = '40001';
    end if;
    if changes ? 'category_other' and target.category <> 'Other' then
      raise exception 'category_other does not apply to API %.', row_id using errcode = '22023';
    end if;
    if changes ? 'communication_direction' and target.category <> 'Communication' then
      raise exception 'communication_direction does not apply to API %.', row_id using errcode = '22023';
    end if;

    update public.apis a
       set official_api_name = case when changes ? 'official_api_name' then changes->>'official_api_name' else a.official_api_name end,
           official_company_name = case when changes ? 'official_company_name' then changes->>'official_company_name' else a.official_company_name end,
           category_other = case when changes ? 'category_other' then changes->>'category_other' else a.category_other end,
           communication_direction = case when changes ? 'communication_direction' then changes->>'communication_direction' else a.communication_direction end,
           country_region = case when changes ? 'country_region' then changes->>'country_region' else a.country_region end,
           http_method = case when changes ? 'http_method' then changes->>'http_method' else a.http_method end,
           authentication_details = case when changes ? 'authentication_details' then changes->>'authentication_details' else a.authentication_details end,
           client_types = case when changes ? 'client_types' then array(select jsonb_array_elements_text(changes->'client_types')) else a.client_types end,
           network = case when changes ? 'network' then changes->>'network' else a.network end,
           input_formats = case when changes ? 'input_formats' then array(select jsonb_array_elements_text(changes->'input_formats')) else a.input_formats end,
           invoice_standard = case when changes ? 'invoice_standard' then array(select jsonb_array_elements_text(changes->'invoice_standard')) else a.invoice_standard end,
           invoice_standard_source = case when changes ? 'invoice_standard' then 'confirmed' else a.invoice_standard_source end,
           website_url = case when changes ? 'website_url' then changes->>'website_url' else a.website_url end,
           instructions = case when changes ? 'instructions' then changes->>'instructions' else a.instructions end,
           business_rules = case when changes ? 'business_rules' then array(select jsonb_array_elements_text(changes->'business_rules')) else a.business_rules end
     where a.id = row_id
     returning a.* into target;

    insert into public.api_audit_events (
      api_id, api_name, company_name, action, actor_name, actor_user_id, details
    ) values (
      target.id,
      target.api_name,
      target.company_name,
      'edit',
      actor_display_name,
      p_actor_user_id,
      jsonb_build_object(
        'type', 'admin_metadata_bulk_update',
        'fields', coalesce(item->'fields', '[]'::jsonb),
        'evidence', coalesce(item->'evidence', '[]'::jsonb),
        'evidence_urls', coalesce(item->'evidence_urls', '[]'::jsonb),
        'source_rows', coalesce(item->'source_rows', '[]'::jsonb)
      )::text
    );

    api_id := target.id;
    updated_at := target.updated_at;
    review_status := target.review_status;
    return next;
  end loop;
end;
$$;

comment on function public.admin_bulk_update_api_metadata(jsonb, uuid, text) is
  'Atomically applies an administrator-curated metadata spreadsheet, refuses stale previews, and retains structured evidence without claiming manual verification.';

revoke all on function public.admin_bulk_update_api_metadata(jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_bulk_update_api_metadata(jsonb, uuid, text) to service_role;
