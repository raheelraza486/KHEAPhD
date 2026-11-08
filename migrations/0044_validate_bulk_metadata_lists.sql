-- Issue #21: validate each list element at the writer boundary, including
-- callers that bypass the spreadsheet preview. JSON [] clears a list to a
-- PostgreSQL empty text array. Preserve the existing transaction, category,
-- concurrency, audit and manual-verification behaviour from 0028.

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
  list_field text;
  list_item jsonb;
  list_value text;
  target public.apis%rowtype;
  row_id uuid;
  expected_updated_at timestamptz;
  invalid_keys text[];
  seen_ids uuid[] := '{}';
  actor_display_name text;
  effective_category text;
  effective_category_other text;
  effective_communication_direction text;
  allowed_keys constant text[] := array[
    'official_api_name', 'official_company_name', 'category', 'category_other',
    'communication_direction', 'country_region', 'http_method',
    'authentication_details', 'client_types', 'network', 'input_formats',
    'output_formats', 'invoice_standard', 'website_url', 'instructions',
    'business_rules'
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

    foreach list_field in array array[
      'client_types', 'input_formats', 'output_formats', 'invoice_standard', 'business_rules'
    ] loop
      if not (changes ? list_field) then
        continue;
      end if;
      if jsonb_typeof(changes->list_field) is distinct from 'array' then
        raise exception 'API %, field % must be a JSON array.', row_id, list_field
          using errcode = '22023';
      end if;
      if jsonb_array_length(changes->list_field) > 40 then
        raise exception 'API %, field % may contain at most 40 values.', row_id, list_field
          using errcode = '22023';
      end if;
      for list_item in select value from jsonb_array_elements(changes->list_field)
      loop
        if jsonb_typeof(list_item) is distinct from 'string' then
          raise exception 'API %, field % must contain only strings.', row_id, list_field
            using errcode = '22023';
        end if;
        list_value := regexp_replace(list_item #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g');
        if list_value = '' or lower(list_value) = 'null' or list_value in ('[]', '{}') then
          raise exception 'API %, field % contains a null, empty or list-marker value; use an empty array to clear it.', row_id, list_field
            using errcode = '22023';
        end if;
        if (list_item #>> '{}') ~ E'[\r\n]'
           or (list_field <> 'business_rules' and position(',' in list_value) > 0) then
          raise exception 'API %, field % must store each value as a separate array element.', row_id, list_field
            using errcode = '22023';
        end if;
        if char_length(list_value) > (case when list_field = 'business_rules' then 500 else 100 end) then
          raise exception 'API %, field % contains an overlong list value.', row_id, list_field
            using errcode = '22023';
        end if;
      end loop;
    end loop;

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

    effective_category := case when changes ? 'category' then changes->>'category' else target.category end;
    if effective_category is null
       or effective_category not in ('Communication', 'Transformation', 'Validation', 'Other') then
      raise exception 'Category is not supported for API %.', row_id using errcode = '22023';
    end if;
    if changes ? 'category_other' and effective_category <> 'Other' then
      raise exception 'category_other does not apply to API %.', row_id using errcode = '22023';
    end if;
    effective_category_other := case
      when effective_category <> 'Other' then ''
      when changes ? 'category_other' then changes->>'category_other'
      when target.category = 'Other' then target.category_other
      else ''
    end;
    if effective_category = 'Other' and coalesce(btrim(effective_category_other), '') = '' then
      raise exception 'Changing API % to Other requires category_other.', row_id using errcode = '22023';
    end if;

    if changes ? 'communication_direction' and effective_category <> 'Communication' then
      raise exception 'communication_direction does not apply to API %.', row_id using errcode = '22023';
    end if;
    effective_communication_direction := case
      when effective_category <> 'Communication' then ''
      when changes ? 'communication_direction' then changes->>'communication_direction'
      when target.category = 'Communication' then target.communication_direction
      else 'Unspecified'
    end;
    if effective_category = 'Communication'
       and (effective_communication_direction is null
         or effective_communication_direction not in ('Send', 'Receive', 'Send and receive', 'Unspecified')) then
      raise exception 'Communication direction is not supported for API %.', row_id using errcode = '22023';
    end if;

    update public.apis a
       set official_api_name = case when changes ? 'official_api_name' then changes->>'official_api_name' else a.official_api_name end,
           official_company_name = case when changes ? 'official_company_name' then changes->>'official_company_name' else a.official_company_name end,
           category = effective_category,
           category_other = effective_category_other,
           communication_direction = effective_communication_direction,
           country_region = case when changes ? 'country_region' then changes->>'country_region' else a.country_region end,
           http_method = case when changes ? 'http_method' then changes->>'http_method' else a.http_method end,
           authentication_details = case when changes ? 'authentication_details' then changes->>'authentication_details' else a.authentication_details end,
           client_types = case when changes ? 'client_types' then array(select jsonb_array_elements_text(changes->'client_types')) else a.client_types end,
           network = case when changes ? 'network' then changes->>'network' else a.network end,
           input_formats = case when changes ? 'input_formats' then array(select jsonb_array_elements_text(changes->'input_formats')) else a.input_formats end,
           output_formats = case when changes ? 'output_formats' then array(select jsonb_array_elements_text(changes->'output_formats')) else a.output_formats end,
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
  'Atomically applies administrator-curated metadata, including explicit empty lists, validates list elements, preserves category-specific invariants, and retains structured provenance without claiming manual verification.';

revoke all on function public.admin_bulk_update_api_metadata(jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_bulk_update_api_metadata(jsonb, uuid, text) to service_role;
