-- Run on a disposable database with schema migrations through 0028 and 0044:
-- psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/tests/bulk-metadata-lists.sql
-- All fixtures and helper functions are rolled back, including on disconnect.
begin;

insert into auth.users (id, email) values
  ('21000000-0000-4000-8000-000000000001', 'bulk-admin@example.test'),
  ('21000000-0000-4000-8000-000000000002', 'bulk-viewer@example.test');
insert into public.app_user (id, email, display_name, role) values
  ('21000000-0000-4000-8000-000000000001', 'bulk-admin@example.test', 'Bulk test admin', 'admin'),
  ('21000000-0000-4000-8000-000000000002', 'bulk-viewer@example.test', 'Bulk test viewer', 'viewer');
insert into public.apis (
  id, api_name, company_name, description, api_endpoint, documentation_url,
  category, authentication_method, input_formats, output_formats, client_types,
  invoice_standard, review_status, verified_by, verified_by_user, verification_notes, network
) values
  ('21000000-0000-4000-8000-000000000011', 'Bulk list fixture one', 'Issue 21 test', 'Test only',
   'https://example.test/one', 'https://example.test/docs', 'Validation', 'None',
   array['XML'], array['JSON'], array['REST'], array['UBL'], 'Verified', 'Bulk test admin',
   '21000000-0000-4000-8000-000000000001', 'Checked against official documentation', 'Original network'),
  ('21000000-0000-4000-8000-000000000012', 'Bulk list fixture two', 'Issue 21 test', 'Test only',
   'https://example.test/two', 'https://example.test/docs', 'Validation', 'None',
   array['XML'], array['JSON'], array['REST'], array['UBL'], 'Published', '', null, '', 'Original network');

create function pg_temp.bulk_test_update(p_id uuid, p_changes jsonb) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', a.id, 'expected_updated_at', a.updated_at, 'changes', p_changes,
    'fields', (select jsonb_agg(key) from jsonb_object_keys(p_changes) as keys(key)),
    'source_rows', jsonb_build_array(17), 'evidence_urls', jsonb_build_array('https://example.test/docs'),
    'evidence', jsonb_build_array(jsonb_build_object('source_row', 17, 'statement', 'Official guide'))
  ) from public.apis a where a.id = p_id;
$$;

do $$
declare
  admin_id constant uuid := '21000000-0000-4000-8000-000000000001';
  first_id constant uuid := '21000000-0000-4000-8000-000000000011';
  second_id constant uuid := '21000000-0000-4000-8000-000000000012';
  saved public.apis%rowtype;
  field text;
  bad jsonb;
  audit_count bigint;
  rejected integer := 0;
  updates jsonb;
begin
  -- Legitimate prose can contain commas; bookkeeping keeps a real verification.
  perform * from public.admin_bulk_update_api_metadata(jsonb_build_array(pg_temp.bulk_test_update(first_id,
    '{"client_types":[],"business_rules":["For invoices, validate tax totals."]}'::jsonb)), admin_id, 'Bulk test admin');
  select * into saved from public.apis where id = first_id;
  assert saved.client_types = '{}'::text[], '[] must become an empty PostgreSQL array';
  assert saved.business_rules = array['For invoices, validate tax totals.'], 'prose punctuation must survive';
  assert saved.input_formats = array['XML'], 'omitted fields must be preserved';
  assert saved.review_status = 'Verified' and saved.verified_by_user = admin_id, 'bookkeeping must preserve verification';

  -- Clearing a verified format follows the existing verification trigger.
  perform * from public.admin_bulk_update_api_metadata(jsonb_build_array(pg_temp.bulk_test_update(first_id,
    '{"input_formats":[],"output_formats":[],"invoice_standard":[],"business_rules":[]}'::jsonb)), admin_id, 'Bulk test admin');
  select * into saved from public.apis where id = first_id;
  assert saved.input_formats = '{}'::text[] and saved.output_formats = '{}'::text[], 'formats must be cleared';
  assert saved.invoice_standard = '{}'::text[] and saved.business_rules = '{}'::text[], 'other lists must be cleared';
  assert saved.review_status = 'Published' and saved.verified_by_user is null and saved.verified_at is null,
    'a changed verified format must return to review';
  assert saved.network = 'Original network', 'unrelated metadata must be preserved';
  assert exists (select 1 from public.api_audit_events where api_id = first_id and actor_user_id = admin_id
    and details::jsonb->'source_rows' = '[17]'::jsonb
    and details::jsonb->'evidence_urls' = '["https://example.test/docs"]'::jsonb
    and details::jsonb->'evidence'->0->>'statement' = 'Official guide'), 'audit provenance must be retained';

  -- Direct RPC callers must not bypass element validation. Test every list field.
  select count(*) into audit_count from public.api_audit_events where api_id in (first_id, second_id);
  foreach field in array array['client_types', 'input_formats', 'output_formats', 'invoice_standard', 'business_rules'] loop
    for bad in select value from jsonb_array_elements(
      '[null,"XML",{},[null],[4],[true],[{}],[[]],[""],["  "],["NULL"],[" NuLl "],["XML","null"],["XML","\t"],["XML\nPDF"],["[]"],["{}"]]'::jsonb
    ) loop
      begin
        perform * from public.admin_bulk_update_api_metadata(jsonb_build_array(pg_temp.bulk_test_update(first_id,
          jsonb_build_object(field, bad))), admin_id, 'Bulk test admin');
        raise exception 'Invalid value was accepted for %: %', field, bad;
      exception when sqlstate '22023' then
        rejected := rejected + 1;
      end;
    end loop;
  end loop;
  foreach field in array array['client_types', 'input_formats', 'output_formats', 'invoice_standard'] loop
    begin
      perform * from public.admin_bulk_update_api_metadata(jsonb_build_array(pg_temp.bulk_test_update(first_id,
        jsonb_build_object(field, jsonb_build_array('UBL, CII')))), admin_id, 'Bulk test admin');
      raise exception 'Comma-joined value was accepted for %', field;
    exception when sqlstate '22023' then
      rejected := rejected + 1;
    end;
  end loop;
  assert rejected = 89, 'all malformed direct-RPC cases must be rejected';
  assert (select count(*) from public.api_audit_events where api_id in (first_id, second_id)) = audit_count,
    'rejected values must not create audits';

  -- A malformed second update rolls back the first update and its audit event.
  begin
    perform * from public.admin_bulk_update_api_metadata(jsonb_build_array(
      pg_temp.bulk_test_update(first_id, '{"network":"Should roll back"}'::jsonb),
      pg_temp.bulk_test_update(second_id, '{"output_formats":["null"]}'::jsonb)
    ), admin_id, 'Bulk test admin');
    raise exception 'Invalid second update was accepted';
  exception when sqlstate '22023' then null;
  end;
  assert (select network from public.apis where id = first_id) = 'Original network', 'the first update must roll back';
  assert (select count(*) from public.api_audit_events where api_id in (first_id, second_id)) = audit_count,
    'the first audit must also roll back';

  -- Stale previews and unauthorized callers retain their existing protections.
  updates := jsonb_build_array(pg_temp.bulk_test_update(second_id, '{"output_formats":[]}'::jsonb)
    || jsonb_build_object('expected_updated_at', '2000-01-01T00:00:00Z'));
  begin
    perform * from public.admin_bulk_update_api_metadata(updates, admin_id, 'Bulk test admin');
    raise exception 'Stale preview was accepted';
  exception when sqlstate '40001' then null;
  end;
  updates := jsonb_build_array(pg_temp.bulk_test_update(second_id, '{"output_formats":[]}'::jsonb));
  begin
    perform * from public.admin_bulk_update_api_metadata(updates,
      '21000000-0000-4000-8000-000000000002', 'Bulk test viewer');
    raise exception 'Non-admin caller was accepted';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform * from public.admin_bulk_update_api_metadata(updates, admin_id, 'Forged administrator');
    raise exception 'Forged attribution was accepted';
  exception when sqlstate '42501' then null;
  end;
  assert not has_function_privilege('authenticated', 'public.admin_bulk_update_api_metadata(jsonb,uuid,text)', 'EXECUTE');
  assert not has_function_privilege('anon', 'public.admin_bulk_update_api_metadata(jsonb,uuid,text)', 'EXECUTE');
  assert has_function_privilege('service_role', 'public.admin_bulk_update_api_metadata(jsonb,uuid,text)', 'EXECUTE');

  -- Valid separate elements still work after the rejected batches.
  perform * from public.admin_bulk_update_api_metadata(jsonb_build_array(pg_temp.bulk_test_update(second_id,
    '{"input_formats":["XML","JSON"],"output_formats":["PDF"]}'::jsonb)), admin_id, 'Bulk test admin');
  select * into saved from public.apis where id = second_id;
  assert saved.input_formats = array['XML','JSON'] and saved.output_formats = array['PDF'];
  assert saved.review_status = 'Published', 'metadata curation must not grant verification';
end;
$$;

rollback;
select 'Bulk metadata SQL regression checks passed' as result;
