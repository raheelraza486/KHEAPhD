-- 0034  Targeted catalogue data repairs for the 2026-09-19 snapshot.
--
-- Scope:
--   * soft-inactivate the 34 active operations with no request schema,
--     parameters, or response schema, while preserving a visible reason;
--   * D9: repair four Taiwan MOF fields merged during transcription;
--   * D10: fill the 13 required request-field types that are still unknown;
--   * D11: record the official-source finding that all request members in the
--     17 reviewed uploaded schemas are optional;
--   * D12: mark four operations whose successful response has no body;
--   * D13 is a reporting-query correction and lives in
--     scripts/compatibility-statistics.sql. No media-type schema is deleted.
--
-- Every target is pinned to stable IDs and the observed pre-migration state.
-- Abort rather than applying a stale correction if the live catalogue moved.

-- ---------------------------------------------------------- scope reduction

create temporary table _0034_inactive_api (
  api_id uuid primary key,
  expected_api_name text not null
) on commit drop;

insert into _0034_inactive_api (api_id, expected_api_name) values
  ('f5e76a40-f7e8-487f-bec1-deb579a5026b', 'Brazil NF-e National Distribution API'),
  ('d113e7ee-85a6-4d37-bf2f-97254387652a', 'Brazil NF-e National Event Registration API v4'),
  ('8f909570-a626-405d-ae8a-e97750141bf9', 'AmitTransform'),
  ('37d0c073-4bd3-48b5-a6fd-edc8cb6ffdc8', 'ECOSIOValidator'),
  ('8ff75c0c-0334-459f-bc00-ebb1092f0db6', 'EzzyBillsOCR'),
  ('45f7e624-9f99-4737-b507-75978f81cbe6', 'Link4 Payment API'),
  ('a5ee4c94-b7c9-4f1b-93ac-b0a293737304', 'Link4 Webhook API'),
  ('9fb93f47-5e6a-4696-8d30-be1471673c3a', 'MYOB Item Invoice API'),
  ('096a2c5f-0cd8-4506-86c7-f289de5af568', 'MYOB Miscellaneous Invoice API'),
  ('34c57ab7-8f72-4d31-98d6-31525b2be755', 'MYOB Professional Invoice API'),
  ('9abdf4e1-f64d-47ab-a206-fcdfc942d8d1', 'MYOB Service Invoice API'),
  ('88bf1f31-d61b-4b7c-a458-588738669287', 'OZEDI Account Balance API'),
  ('b8e8d77e-5cf8-4c8b-a378-d8923513f1fb', 'OZEDI Attachment Download API'),
  ('7b234844-c55b-4a9e-b205-65b51d220c41', 'OZEDI Authentication API'),
  ('b15fc131-6a05-4751-b675-256b4ccd3096', 'OZEDI Client Deactivation API'),
  ('fd40ebac-4714-45ab-bda0-8bb0023a7318', 'OZEDI Client Registration API'),
  ('b8962713-9991-4c2a-a5ec-d5a40ffdc5ed', 'OZEDI Client Update API'),
  ('7b0a0c3f-f6e5-4049-8de4-bcc9d2073b44', 'OZEDI Document Receive API'),
  ('cc2512e9-c745-4d33-9393-ffe0eed209b3', 'OZEDI Document Send API'),
  ('6c71d514-2443-45c0-9204-e6ae27b3c934', 'OZEDI Message Filter API'),
  ('a2c15941-2e2e-4174-8bf3-7e4bf8a53787', 'OZEDI Message Status API'),
  ('8b87827b-45c0-4f9b-b960-b805ec2057e3', 'OZEDI Participant Lookup API'),
  ('e3c4a2bc-1a05-4411-912b-5875323c64d8', 'OZEDI PDF Conversion API'),
  ('3d551adc-a793-43e6-be2e-355d7c93abbc', 'OZEDI Pending Messages API'),
  ('07ef3cc4-8b27-4297-a33a-70cb4a383fed', 'OZEDI Receive Confirmation API'),
  ('426c9048-1ed3-4482-8e47-d62c46069b54', 'OZEDI Upload Token API'),
  ('faba0c1f-cc49-4713-9663-6acbc82242f0', 'OZEDI Validation Errors API'),
  ('db96990d-4755-46c9-8a54-a54140d083f7', 'OZEDI Webhook Management API'),
  ('988f91a3-9562-4466-8fb3-662f8c4d78b8', 'OZEDI Webhook Registration API'),
  ('389b0c1b-ca91-4b47-bdc0-da89e9895746', 'StoreCoveAPI'),
  ('8c27c29f-4b75-4ca7-bcf6-e2dae86d0616', 'TradeshiftTransform'),
  ('bbd78835-4e72-41e2-917b-db25873677d2', 'UpbrainsXtract'),
  ('32b59932-2124-49c3-ac30-98fccba43cb0', 'XeroAPI'),
  ('a5fd51cc-186b-416a-a6ec-c30a3a1cc76d', 'Saudi Arabia ZATCA Fatoora Compliance Check API');

do $$
declare matched integer;
begin
  select count(*) into matched from _0034_inactive_api;
  if matched <> 34 then
    raise exception '0034 expected 34 inactive targets, found %.', matched;
  end if;

  select count(*) into matched
    from _0034_inactive_api target
    join public.apis api on api.id = target.api_id
   where api.api_name = target.expected_api_name
     and api.is_active
     and api.duplicate_of is null
     and not exists (select 1 from public.api_schema schema_row where schema_row.api_id = api.id)
     and not exists (select 1 from public.api_parameter parameter_row where parameter_row.api_id = api.id);
  if matched <> 34 then
    raise exception '0034 inactive target precondition failed: expected 34 active, unique APIs with no schema or parameter; found %.', matched;
  end if;
end
$$;

with changed as (
  update public.apis api
     set is_active = false,
         verification_notes = concat_ws(
           E'\n',
           nullif(btrim(api.verification_notes), ''),
           '[2026-09-19] Soft-inactivated from the active conversion catalogue: no request schema, request parameters, or response schema were available in the 2026-09-19 snapshot. The record is retained and may be restored after structured metadata is supplied and verified.'
         ),
         updated_at = clock_timestamp()
    from _0034_inactive_api target
   where api.id = target.api_id
  returning api.id, api.api_name, api.company_name
)
insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select id,
       api_name,
       coalesce(company_name, ''),
       'status_change',
       'System migration',
       null,
       jsonb_build_object(
         'type', 'conversion_scope_deactivation',
         'reason_code', 'insufficient_structured_definition',
         'snapshot_date', '2026-09-19',
         'reversible', true,
         'missing', jsonb_build_array('request_schema', 'request_parameters', 'response_schema'),
         'summary', 'Soft-inactivated because the operation has no request schema, request parameters, or response schema; retained for restoration after data completion.'
       )::text
  from changed;

-- ---------------------------------------------------------- D9 merged fields

do $$
declare matched integer;
begin
  select count(*) into matched
    from public.api_schema
   where (id, content_hash) in (
     ('815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'de5fea6077cf637bf3e3373bcf926f505a24694aae558e91230eeb4bd0f27f8c'),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, '9cb62e7499c60d2f3dda63fad4432307b03417ec6ea0db1e362ec5fa27e8dfec'),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, '7110de3cdc1d34ae8ebc45791a52bd33410b9d950d33b4fc22baefa78e94462a')
   ) and verified_at is null;
  if matched <> 3 then
    raise exception '0034 D9 precondition failed: one of the three Taiwan schemas changed or was verified.';
  end if;

  if not exists (
    select 1 from public.api_schema
     where id = '815d58de-0144-47f7-9594-d738a02c0fa9'
       and warnings @> array[
         'The response sample shows details.currency, which the table does not list; it is recorded with no type.',
         'The response sample shows onlyWinningInv, which the table does not list; it is recorded with no type.'
       ]::text[]
  ) or not exists (
    select 1 from public.api_schema
     where id = 'a3b335e2-c154-484b-b74d-ec8ceefc9f4f'
       and warnings @> array[
         'The response sample shows msg, which the table does not list; it is recorded with no type.'
       ]::text[]
  ) then
    raise exception '0034 D9 precondition failed: the expected stale type warnings changed.';
  end if;

  select count(*) into matched
    from public.api_schema_field
   where (id, schema_id, path) in (
     ('8263e115-4806-48bb-a128-0fae80898bae'::uuid, '815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'currencyinvDate'),
     ('0914b8eb-49a2-4bd2-8159-4d6cbccda7f6'::uuid, '815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'onlyWinningInvdetails'),
     ('8397b740-548b-42ff-bd9c-98e11b3420dd'::uuid, 'a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, 'msgdetails'),
     ('960a3ca8-2286-423f-832b-283da7604dc2'::uuid, 'cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'buyerTypedetails')
   );
  if matched <> 4 then
    raise exception '0034 D9 precondition failed: expected four merged field rows; found %.', matched;
  end if;
end
$$;

do $$
declare patched jsonb;
begin
  select raw into patched from public.api_schema
   where id = '815d58de-0144-47f7-9594-d738a02c0fa9' for update;
  patched := patched #- '{properties,currencyinvDate}' #- '{properties,onlyWinningInvdetails}';
  patched := jsonb_set(patched, '{properties,onlyWinningInv}',
    '{"enum":["Y","N"],"type":"string","description":"僅中獎發票資訊","x-stated-format":"特定字串(Y/N)"}'::jsonb, false);
  patched := jsonb_set(patched, '{properties,details,description}', '"發票明細"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,details,items,properties,currency}',
    '{"type":"string","description":"幣別","x-stated-format":"字串"}'::jsonb, false);
  patched := jsonb_set(patched, '{properties,details,items,properties,invDate,description}', '"發票時間"'::jsonb, true);
  patched := jsonb_set(patched, '{required}',
    '["v","code","msg","onlyWinningInv","details","buyerType"]'::jsonb, false);
  patched := jsonb_set(patched, '{properties,details,items,required}',
    '["invPeriod","sellerBan","invoiceTime"]'::jsonb, true);
  update public.api_schema
     set raw = patched,
         content_hash = 'b9890c130315fc47958e6ec95580e873359af26369a0a40e4172beafd7c004bc',
         warnings = array_remove(
           array_remove(
             warnings,
             'The response sample shows details.currency, which the table does not list; it is recorded with no type.'
           ),
           'The response sample shows onlyWinningInv, which the table does not list; it is recorded with no type.'
         )
   where id = '815d58de-0144-47f7-9594-d738a02c0fa9';

  select raw into patched from public.api_schema
   where id = 'a3b335e2-c154-484b-b74d-ec8ceefc9f4f' for update;
  patched := patched #- '{properties,msgdetails}';
  patched := jsonb_set(patched, '{properties,msg}',
    '{"type":"string","description":"系統回應訊息","x-stated-format":"字串"}'::jsonb, false);
  patched := jsonb_set(patched, '{properties,details,description}', '"受捐贈機關或團體明細"'::jsonb, true);
  patched := jsonb_set(patched, '{required}', '["v","code","msg","details"]'::jsonb, false);
  patched := jsonb_set(patched, '{properties,details,items,required}',
    '["rowNum","SocialWelfareBAN","LoveCode","SocialWelfareName"]'::jsonb, true);
  update public.api_schema
     set raw = patched,
         content_hash = '997da4a05aa5dd7bd196b994dcd9bc6cce46105ef5da24c9e190ee1a68ff9d4f',
         warnings = array_remove(
           warnings,
           'The response sample shows msg, which the table does not list; it is recorded with no type.'
         )
   where id = 'a3b335e2-c154-484b-b74d-ec8ceefc9f4f';

  select raw into patched from public.api_schema
   where id = 'cfcb510b-6ca4-4979-9912-1fe7f2285aa8' for update;
  patched := patched #- '{properties,buyerTypedetails}';
  patched := jsonb_set(patched, '{properties,buyerType}',
    '{"enum":["0","1"],"type":"string","description":"買方類型（當買方類型為營業人或機關團體時，僅回覆 v、code、msg、invNum、invDate、invoiceTime、invStatus 及 buyerType；details 參數均不回覆）","x-stated-format":"特定字串(0/1)"}'::jsonb, true);
  patched := jsonb_set(patched, '{properties,details,description}', '"發票明細"'::jsonb, true);
  patched := jsonb_set(patched, '{required}',
    '["v","code","msg","invNum","invDate","sellerName","invStatus","invPeriod","sellerBan","invoiceTime","amount","buyerType","details"]'::jsonb, false);
  patched := jsonb_set(patched, '{properties,details,items,required}',
    '["rowNum","description","quantity","unitPrice","amount"]'::jsonb, true);
  update public.api_schema
     set raw = patched,
         content_hash = '36493fe5eb1d09c4ee6bb87d23f6aae069ea829052558254527d1f40b7683276'
   where id = 'cfcb510b-6ca4-4979-9912-1fe7f2285aa8';
end
$$;

delete from public.api_schema_field
 where id in (
   '8263e115-4806-48bb-a128-0fae80898bae',
   '0914b8eb-49a2-4bd2-8159-4d6cbccda7f6',
   '8397b740-548b-42ff-bd9c-98e11b3420dd',
   '960a3ca8-2286-423f-832b-283da7604dc2'
 );

update public.api_schema_field set
  json_type = 'string', is_required = true, enum_values = array['Y','N'],
  description = '僅中獎發票資訊'
where schema_id = '815d58de-0144-47f7-9594-d738a02c0fa9' and path = 'onlyWinningInv';
update public.api_schema_field set is_required = true, description = '發票明細'
where schema_id = '815d58de-0144-47f7-9594-d738a02c0fa9' and path = 'details';
update public.api_schema_field set is_required = true
where schema_id = '815d58de-0144-47f7-9594-d738a02c0fa9' and path = 'details[]';
update public.api_schema_field set json_type = 'string', description = '幣別'
where schema_id = '815d58de-0144-47f7-9594-d738a02c0fa9' and path = 'details[].currency';
update public.api_schema_field set description = '發票時間'
where schema_id = '815d58de-0144-47f7-9594-d738a02c0fa9' and path = 'details[].invDate';
update public.api_schema_field set is_required = true
where schema_id = '815d58de-0144-47f7-9594-d738a02c0fa9'
  and path in ('details[].invPeriod', 'details[].sellerBan', 'details[].invoiceTime');

update public.api_schema_field set
  json_type = 'string', is_required = true, description = '系統回應訊息'
where schema_id = 'a3b335e2-c154-484b-b74d-ec8ceefc9f4f' and path = 'msg';
update public.api_schema_field set is_required = true, description = '受捐贈機關或團體明細'
where schema_id = 'a3b335e2-c154-484b-b74d-ec8ceefc9f4f' and path = 'details';
update public.api_schema_field set is_required = true
where schema_id = 'a3b335e2-c154-484b-b74d-ec8ceefc9f4f' and path = 'details[]';
update public.api_schema_field set is_required = true
where schema_id = 'a3b335e2-c154-484b-b74d-ec8ceefc9f4f'
  and path in ('details[].rowNum', 'details[].SocialWelfareBAN', 'details[].LoveCode', 'details[].SocialWelfareName');

insert into public.api_schema_field (
  id, schema_id, path, leaf_name, leaf_name_norm, json_type, format,
  is_required, is_array_item, depth, enum_values, description
) values (
  '30562336-4dfe-40d1-ba94-650f3032d9dd',
  'cfcb510b-6ca4-4979-9912-1fe7f2285aa8',
  'buyerType', 'buyerType', 'buyertype', 'string', null,
  true, false, 0, array['0','1'],
  '買方類型（當買方類型為營業人或機關團體時，僅回覆 v、code、msg、invNum、invDate、invoiceTime、invStatus 及 buyerType；details 參數均不回覆）'
);
update public.api_schema_field set is_required = true, description = '發票明細'
where schema_id = 'cfcb510b-6ca4-4979-9912-1fe7f2285aa8' and path = 'details';
update public.api_schema_field set is_required = true
where schema_id = 'cfcb510b-6ca4-4979-9912-1fe7f2285aa8' and path = 'details[]';
update public.api_schema_field set is_required = true
where schema_id = 'cfcb510b-6ca4-4979-9912-1fe7f2285aa8'
  and path in ('details[].rowNum', 'details[].description', 'details[].quantity', 'details[].unitPrice', 'details[].amount');

insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select api.id, api.api_name, coalesce(api.company_name, ''), 'edit', 'System migration', null,
       jsonb_build_object(
         'type', 'schema_data_correction',
         'backlog_item', 'D9',
         'reason_code', 'transcribed_fields_merged',
         'summary', 'Removed merged Taiwan MOF field names and restored the separate fields and parent-relative required flags.'
       )::text
  from public.apis api
 where api.id in (
   '3312282e-a077-4697-a68a-c6e2e717fa79',
   '9115caf0-702e-4ed2-a025-9f400043f0d4',
   '1bb954e1-19b8-4638-995d-7a28c0248526'
 );

-- -------------------------------------------------- D10 required field types

create temporary table _0034_d10_type (
  field_id uuid primary key,
  schema_id uuid not null,
  path text not null,
  corrected_type text not null
) on commit drop;

insert into _0034_d10_type values
  ('58bbcb8c-a126-45d0-b128-d3b45e863f7e', '70df0a61-aa54-458f-91a4-999ead8fc500', 'output', 'string'),
  ('76da8c1d-2a14-4969-94ee-154a481aa8e4', '70df0a61-aa54-458f-91a4-999ead8fc500', 'standard', 'string'),
  ('20c4353b-a591-44c8-9c20-e6c137fc8ffa', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'archivo.SetDTE.DTE[].Documento.TED.DD.CAF.version', 'number'),
  ('20ae2ad5-69ce-4498-b1c1-0596ee525655', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'archivo.SetDTE.DTE[].Documento.TED.version', 'number'),
  ('b5dab36d-8822-49ea-a705-f1d40c6187b3', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'archivo.SetDTE.DTE[].Exportaciones.TED.DD.CAF.version', 'number'),
  ('9c9fbaf0-cc90-4bc4-a1ee-9c49a4aed385', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'archivo.SetDTE.DTE[].Exportaciones.TED.version', 'number'),
  ('3beb3874-78cf-41f4-901a-cf909c8e9d72', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'archivo.SetDTE.DTE[].Liquidacion.TED.DD.CAF.version', 'number'),
  ('ce6b4aa5-49b0-4953-98cf-43ff07c7d3de', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'archivo.SetDTE.DTE[].Liquidacion.TED.version', 'number'),
  ('163b2d51-690c-4b6a-83c0-3d2e3edd3a96', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'dvCompany', 'string'),
  ('2184e49b-51e0-4ab8-b06c-539d7b2dab06', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'dvSender', 'string'),
  ('ca1eec28-c01a-4c85-8f6f-54cf5268726e', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'rutCompany', 'string'),
  ('84fb17c9-7a0f-4f9b-bf4c-41cf1b48ca94', '61f286c6-d082-4f47-9a2f-b51bebd23eb0', 'rutSender', 'string'),
  ('35794c9e-84f8-4dc1-a249-a45b97186da1', '63fb0e80-55e3-4143-a06d-2599839d165a', 'lines[]', 'object');

do $$
declare matched integer;
begin
  select count(*) into matched
    from _0034_d10_type correction
    join public.api_schema_field field_row
      on field_row.id = correction.field_id
     and field_row.schema_id = correction.schema_id
     and field_row.path = correction.path
   where field_row.json_type = 'unknown'
     and field_row.is_required;
  if matched <> 13 then
    raise exception '0034 D10 precondition failed: expected 13 required unknown fields; found %.', matched;
  end if;

  if not exists (
    select 1 from public.api_schema
     where id = '70df0a61-aa54-458f-91a4-999ead8fc500'
       and content_hash = '137b24f083eb4d5ad2910dc95ca0f7b269295a106517e46a566088f1592eb548'
       and verified_at is null
  ) or not exists (
    select 1 from public.api_schema
     where id = '61f286c6-d082-4f47-9a2f-b51bebd23eb0'
       and content_hash = 'f1f72d4469cc8f1f53e1bd14ec2ee8d640b3be38d0eef6ecd9442fe2c8d05921'
       and verified_at is null
  ) then
    raise exception '0034 D10 precondition failed: a raw schema changed or was verified.';
  end if;

  if not exists (
    select 1 from public.api_schema
     where id = '61f286c6-d082-4f47-9a2f-b51bebd23eb0'
       and warnings @> array[
         'The schema states no type for version; the field is recorded without one.',
         'The manual states no type for the five form parts or the six response fields; they are recorded with no type rather than one being guessed from the printed examples.'
       ]::text[]
  ) then
    raise exception '0034 D10 precondition failed: the expected Chile type warnings changed.';
  end if;

  if not exists (
    select 1 from public.api_schema
     where id = '63fb0e80-55e3-4143-a06d-2599839d165a'
       and content_hash = '834c6a121eedf46c32c4739fe0c792465bb40ee8dff8dfc3fad25cd0be98f5bf'
       and verified_at is null
  ) then
    raise exception '0034 D10 precondition failed: the INFast raw schema changed or was verified.';
  end if;
end
$$;

update public.api_schema_field field_row
   set json_type = correction.corrected_type
  from _0034_d10_type correction
 where field_row.id = correction.field_id;

do $$
declare patched jsonb;
begin
  select raw into patched from public.api_schema
   where id = '70df0a61-aa54-458f-91a4-999ead8fc500' for update;
  patched := jsonb_set(patched, '{properties,output,type}', '"string"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,standard,type}', '"string"'::jsonb, true);
  update public.api_schema
     set raw = patched,
         content_hash = 'e3bed4edb5af2d46a5751ed448adb569f5f0081de9e39ae88d17d7aaf85ec256'
   where id = '70df0a61-aa54-458f-91a4-999ead8fc500';

  select raw into patched from public.api_schema
   where id = '61f286c6-d082-4f47-9a2f-b51bebd23eb0' for update;
  patched := jsonb_set(patched, '{properties,archivo,properties,SetDTE,properties,DTE,items,properties,Documento,properties,TED,properties,DD,properties,CAF,properties,version,type}', '"number"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,archivo,properties,SetDTE,properties,DTE,items,properties,Documento,properties,TED,properties,version,type}', '"number"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,archivo,properties,SetDTE,properties,DTE,items,properties,Exportaciones,properties,TED,properties,DD,properties,CAF,properties,version,type}', '"number"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,archivo,properties,SetDTE,properties,DTE,items,properties,Exportaciones,properties,TED,properties,version,type}', '"number"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,archivo,properties,SetDTE,properties,DTE,items,properties,Liquidacion,properties,TED,properties,DD,properties,CAF,properties,version,type}', '"number"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,archivo,properties,SetDTE,properties,DTE,items,properties,Liquidacion,properties,TED,properties,version,type}', '"number"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,rutCompany,type}', '"string"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,rutSender,type}', '"string"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,dvCompany,type}', '"string"'::jsonb, true);
  patched := jsonb_set(patched, '{properties,dvSender,type}', '"string"'::jsonb, true);
  update public.api_schema
     set raw = patched,
         content_hash = '5f567467762a302fe1c3e0b4733057f5e743c98528f8eb5cf943bd8dfb8a3e82',
         warnings = array_remove(
           array_remove(
             warnings,
             'The schema states no type for version; the field is recorded without one.'
           ),
           'The manual states no type for the five form parts or the six response fields; they are recorded with no type rather than one being guessed from the printed examples.'
         )
   where id = '61f286c6-d082-4f47-9a2f-b51bebd23eb0';

  select raw into patched from public.api_schema
   where id = '63fb0e80-55e3-4143-a06d-2599839d165a' for update;
  patched := jsonb_set(patched, '{properties,lines,items,type}', '"object"'::jsonb, true);
  update public.api_schema
     set raw = patched,
         content_hash = '14cdc99faf98f292d8806dfc9cbd653eb34653223790d1c71716945a3487d261'
   where id = '63fb0e80-55e3-4143-a06d-2599839d165a';
end
$$;

insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select api.id, api.api_name, coalesce(api.company_name, ''), 'edit', 'System migration', null,
       jsonb_build_object(
         'type', 'schema_data_correction',
         'backlog_item', 'D10',
         'reason_code', 'required_field_type_completed',
         'summary', 'Filled documented types for the 13 required request fields that previously normalised to unknown.'
       )::text
  from public.apis api
 where api.id in (
   '245d788e-2bd5-436c-8e87-5f223def527b',
   '14942a33-20b8-410c-9e04-f62c86a5c1e6',
   'a1caabdf-abed-43c1-8591-0c0fbdaeeec1'
 );

-- ----------------------------------------- D11 confirmed all-optional inputs

create temporary table _0034_d11_optional (
  schema_id uuid primary key,
  api_id uuid not null,
  expected_hash text not null,
  corrected_hash text not null
) on commit drop;

insert into _0034_d11_optional values
  ('139bc690-ec20-4540-be79-f0565cbb2127', 'f5fd0ebc-69fd-417c-9eb0-aedab32e2cc2', '44c2706d44d361419b67194e7c7ec79f089e9fc9fb9c9b2c6cebfca185b27ea7', 'b5c11882a1ef96ba97f222ab228b470dee30ce39bc824f77aa66e8191d34ed05'),
  ('1b4457a7-0038-4c91-baf5-7614837c0803', '16c2c4b1-bb50-43b5-99bf-52d9b9ca8809', '136e693bca57b5d36fcdd83412aefd7e6fd28cd136fd74140ec25702da704d57', '4693a42072ba43e7adf780bb285b6d82cb860f30c9877578948a512f3f4ff803'),
  ('4b751c88-864a-4345-959e-bf4c92736fb2', '98db1950-87ec-4dff-9db9-840122f30265', '7fd1e297e1b07c3541f214532da20219cd18103a94fd04aadf2d24b84af6689b', 'e936b6ad9c4003a46b800ea5c5c080fb25e7bbc5aed95a478e64ada3ab21d9a4'),
  ('5b1f3229-8992-41a7-97e9-95a6115147a2', '0eb0ef0f-54fb-4933-ae1e-76fa86b8ffa0', 'eb742b3cfa49ee1f1ec86d4cd3e24effbc9042b9ca35c3a7a76d2875e02c96db', 'aa7014492c3b580242fd6731e392effbdbfb5550183299ca52dff838c92186f0'),
  ('5d7159b3-05de-48ef-a143-ac67944e8f7c', 'beb87f41-33b3-4823-afd9-d8e2e44c87ea', '20fefaddc0f64a1debe31d377ec0f53d573c4e917a749f2c843c5b217438172a', '15827ab2298d247e8e80964479d43fb29a2ede3166ed133419f3a4974e01846f'),
  ('5e57a89e-4098-4b89-9bfb-551f42c0f13e', '47dd1ba1-50f6-491d-8630-74c390728802', 'b706a93dda0c112bba614fc92109fdc69e86c4bdfe44f3539a59701aaafc40a8', 'b95bf2f9e0618c1f47789a190bd615cd5126c1a6ecf54c357aad922e3e06ee6c'),
  ('73e36f15-48b6-4131-b511-cb01d6988a01', '091885c5-dca7-45e3-90c1-90c1a697f4bb', 'e3a33b8119bc31b1c1c7fa783f1e2f3bac67849a6253179cde96f715ffb96589', '269b99e37f7bca37733e0b7fdfd426e2bea644db1f165e28297cb69ff7dd97fa'),
  ('78c5e31d-6afe-4f4c-a4a9-bf696fa948e4', '3c9c49ae-379b-4079-b154-d84b205bfbf5', '9f380e3f966f9e45c73a6be3b3c08b57b51bed7028c34a34fa4f2c13a9ae904c', '26bd3dd831caecfae87654b739c21c428e6cb1f5a3d1bc61964943ee0c6bf9b7'),
  ('7a3f30f8-9795-4aac-9f7c-f75651cd5f48', '2126b60b-0c51-4623-8fe7-30be847524ab', '7a75fcc2428130846d93f6fe96c0b2c971e32c122284e1993497dd0beef72405', '5480663c114cdf818fb55ac2e39c48565a2b8022a89dbfbb67667a8c291d15c9'),
  ('7d223528-434f-4405-9d53-652989059a0d', 'b5d33625-2789-4cea-b601-6714082fdd98', 'e44fa3beb201746190f5e2faa45c53d82a0900785e2913f7d6a8363011d9d6e5', '07b21969c0b8ae4dd150cd2c932c6e0c09d7fa38eb0ba9d4269bce0f74a01671'),
  ('93bea300-e771-4cde-bccf-dc58f51fa773', '399d960e-a23a-49f3-9839-510452c24749', '34bd26c9a0dc2099f2006b16da3e952d4527c8aafd6d0b675cabebaeb245ced8', '7cdceed51952b26a0fc3de5a73d2cb1eb1774b04de80224e54b4302949c064c7'),
  ('a0cec009-e407-4316-a898-89316068a702', '5896b0da-94e2-4ee9-88d6-876441b9cac3', '6ba5259338a2d2f9d0d709a69b56889e42a14e0094e84fed4fff05fcf78442eb', '7be7405b25545f8e5534fc922fce90815af3d0a455b50e7c4bedd3be9631ccb9'),
  ('ab83b47a-6d38-48f6-965d-1c4f69a23cfa', '6ee75c97-2b06-462d-86d3-e26a5af1ba99', '0382baf6dbe201f7c2f95b10a60293f4f91c48994430240af9e5e21972021a86', '7fdf6a82c7f5d90e69ccb286e4e13a84c68ae3975d70147af91be8913d651b16'),
  ('b29d5f4f-fb89-4853-8234-173b4b0ad2e5', '4b5af7e9-8052-4e36-b542-9954020ce7ec', '2c931c998969ee386cbc6ae42e2268453aa460b30bb8ce27f61fcf1b682c0a0f', 'ca8f8b57a216503fa59789c8cbdd2c16cfde2572a2a691c24664c15e381488ea'),
  ('b32117d3-3832-4463-8148-316f641146af', '613c2e5e-8ab1-4a02-9b09-10a14fe5dc04', '7dd5ab147d6baf3fe12c0bd20834ddb4227f65713662c75228cc29b78e436d2b', 'd5e2781fee1105be469e83caf11173a192a8675527fd8362508af40a04b1b333'),
  ('ba02d804-c732-47dc-9f19-ec89119bac58', '379336f6-cabc-4c65-b2cb-39645258feb9', '9767e16b0314a581c882a63f323ae0df3dbb92e2e9c5072b2292dfc7ac696296', '5ee6b190992b6ba204aad59367d5ecabea0422d13bfbc9c45d0834b985722bc2'),
  ('e54706ad-ea41-44f0-94e0-86722e4c58d0', '52b78a45-e86a-4ae7-b000-0995d6014955', '008506de503f40b052b0cbdd56c7d80aa12458454c189fbf269c909af3d636ec', 'e5f9b02f9ace9522f064340408327c7f8307939cfd5beb899f444fdc75286255');

do $$
declare matched integer;
begin
  select count(*) into matched
    from _0034_d11_optional correction
    join public.api_schema schema_row
      on schema_row.id = correction.schema_id
     and schema_row.api_id = correction.api_id
     and schema_row.content_hash = correction.expected_hash
   where schema_row.direction = 'request'
     and schema_row.origin = 'uploaded'
     and schema_row.verified_at is null
     and not (schema_row.raw ? 'required')
     and exists (select 1 from public.api_schema_field field_row where field_row.schema_id = schema_row.id)
     and not exists (
       select 1 from public.api_schema_field field_row
        where field_row.schema_id = schema_row.id and field_row.is_required
     );
  if matched <> 17 then
    raise exception '0034 D11 precondition failed: expected 17 unchanged uploaded all-optional request schemas; found %.', matched;
  end if;
end
$$;

update public.api_schema schema_row
   set raw = jsonb_set(schema_row.raw, '{required}', '[]'::jsonb, true),
       content_hash = correction.corrected_hash
  from _0034_d11_optional correction
 where schema_row.id = correction.schema_id;

insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select api.id, api.api_name, coalesce(api.company_name, ''), 'edit', 'System migration', null,
       jsonb_build_object(
         'type', 'schema_data_correction',
         'backlog_item', 'D11',
         'reason_code', 'required_fields_confirmed_optional',
         'source_url', schema_row.source_url,
         'summary', 'Official WSDL/XSD review found every request member optional (minOccurs=0/no required use). is_required remains false and raw.required is now explicitly empty.'
       )::text
  from _0034_d11_optional correction
  join public.api_schema schema_row on schema_row.id = correction.schema_id
  join public.apis api on api.id = correction.api_id;

-- ------------------------------------------------------- D12 no output body

create temporary table _0034_d12_no_body (
  api_id uuid primary key,
  expected_api_name text not null
) on commit drop;

insert into _0034_d12_no_body values
  ('53fbc9be-a6a7-4837-9714-b9ce7afbd6ae', 'Egypt ETA Cancel Document API'),
  ('8c8be6fd-643d-407b-9578-6b04c831ddc1', 'Egypt ETA Reject Document API'),
  ('97ce335d-ae3b-4f04-8440-5cd79302933e', 'Malaysia MyInvois Validate Taxpayer TIN API'),
  ('1571e563-08cb-4196-b69c-5ee35802e41b', 'Poland KSeF 2.0 Close Online Session API');

do $$
declare matched integer;
begin
  if not exists (select 1 from public.format_alias where canonical = 'Status Codes') then
    raise exception '0034 D12 requires the Status Codes format alias.';
  end if;
  select count(*) into matched
    from _0034_d12_no_body correction
    join public.apis api on api.id = correction.api_id
   where api.api_name = correction.expected_api_name
     and api.is_active
     and api.output_formats = array['JSON']::text[]
     and not exists (
       select 1 from public.api_schema schema_row
        where schema_row.api_id = api.id and schema_row.direction = 'response'
     );
  if matched <> 4 then
    raise exception '0034 D12 precondition failed: expected four active JSON-labelled operations with no response schema; found %.', matched;
  end if;
end
$$;

with changed as (
  update public.apis api
     set output_formats = array['Status Codes']::text[],
         updated_at = clock_timestamp()
    from _0034_d12_no_body correction
   where api.id = correction.api_id
  returning api.id, api.api_name, api.company_name
)
insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select id, api_name, coalesce(company_name, ''), 'edit', 'System migration', null,
       jsonb_build_object(
         'type', 'metadata_data_correction',
         'backlog_item', 'D12',
         'reason_code', 'successful_response_has_no_body',
         'summary', 'Successful responses are represented only by HTTP status codes; output_formats changed from JSON to Status Codes.'
       )::text
  from changed;

-- ----------------------------------------------------------- final assertions

do $$
declare matched integer;
begin
  select count(*) into matched
    from _0034_inactive_api target
    join public.apis api on api.id = target.api_id
   where not api.is_active
     and api.verification_notes like '%Soft-inactivated from the active conversion catalogue:%';
  if matched <> 34 then
    raise exception '0034 postcondition failed: only % of 34 APIs were soft-inactivated with a reason.', matched;
  end if;

  if exists (
    select 1 from public.api_schema_field
     where path in ('currencyinvDate', 'onlyWinningInvdetails', 'msgdetails', 'buyerTypedetails')
       and schema_id in (
         '815d58de-0144-47f7-9594-d738a02c0fa9',
         'a3b335e2-c154-484b-b74d-ec8ceefc9f4f',
         'cfcb510b-6ca4-4979-9912-1fe7f2285aa8'
       )
  ) then
    raise exception '0034 postcondition failed: a D9 merged field remains.';
  end if;

  select count(*) into matched
    from public.api_schema
   where (id, content_hash) in (
     ('815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'b9890c130315fc47958e6ec95580e873359af26369a0a40e4172beafd7c004bc'),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, '997da4a05aa5dd7bd196b994dcd9bc6cce46105ef5da24c9e190ee1a68ff9d4f'),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, '36493fe5eb1d09c4ee6bb87d23f6aae069ea829052558254527d1f40b7683276')
   );
  if matched <> 3 then
    raise exception '0034 postcondition failed: only % of three D9 raw schemas have the corrected hash.', matched;
  end if;

  select count(*) into matched
    from public.api_schema_field
   where (schema_id, path, json_type, is_required) in (
     ('815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'onlyWinningInv', 'string', true),
     ('815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'details', 'array', true),
     ('815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'details[]', 'object', true),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, 'msg', 'string', true),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, 'details', 'array', true),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, 'details[]', 'object', true),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'buyerType', 'string', true),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'details', 'array', true),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'details[]', 'object', true)
   );
  if matched <> 9 then
    raise exception '0034 postcondition failed: only % of nine D9 restored/parent rows are consistent.', matched;
  end if;

  select count(*) into matched
    from public.api_schema_field
   where (schema_id, path, is_required) in (
     ('815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'details[].invPeriod', true),
     ('815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'details[].sellerBan', true),
     ('815d58de-0144-47f7-9594-d738a02c0fa9'::uuid, 'details[].invoiceTime', true),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, 'details[].rowNum', true),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, 'details[].SocialWelfareBAN', true),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, 'details[].LoveCode', true),
     ('a3b335e2-c154-484b-b74d-ec8ceefc9f4f'::uuid, 'details[].SocialWelfareName', true),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'details[].rowNum', true),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'details[].description', true),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'details[].quantity', true),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'details[].unitPrice', true),
     ('cfcb510b-6ca4-4979-9912-1fe7f2285aa8'::uuid, 'details[].amount', true)
   );
  if matched <> 12 then
    raise exception '0034 postcondition failed: only % of 12 D9 child required flags were restored.', matched;
  end if;

  if not exists (
    select 1 from public.api_schema_field
     where schema_id = '815d58de-0144-47f7-9594-d738a02c0fa9'
       and path = 'details[].currency' and json_type = 'string' and description = '幣別'
  ) or not exists (
    select 1 from public.api_schema_field
     where schema_id = '815d58de-0144-47f7-9594-d738a02c0fa9'
       and path = 'details[].invDate' and description = '發票時間'
  ) then
    raise exception '0034 postcondition failed: the D9 currency type or invDate description was not restored.';
  end if;

  if exists (
    select 1 from public.api_schema
     where id in (
       '815d58de-0144-47f7-9594-d738a02c0fa9',
       'a3b335e2-c154-484b-b74d-ec8ceefc9f4f'
     )
       and exists (
         select 1 from unnest(warnings) warning
          where warning like '%recorded with no type%'
       )
  ) then
    raise exception '0034 postcondition failed: a resolved D9 no-type warning remains.';
  end if;

  select count(*) into matched
    from _0034_d10_type correction
    join public.api_schema_field field_row on field_row.id = correction.field_id
   where field_row.json_type = correction.corrected_type;
  if matched <> 13 then
    raise exception '0034 postcondition failed: only % of 13 D10 field types were corrected.', matched;
  end if;

  select count(*) into matched
    from public.api_schema
   where (id, content_hash) in (
     ('70df0a61-aa54-458f-91a4-999ead8fc500'::uuid, 'e3bed4edb5af2d46a5751ed448adb569f5f0081de9e39ae88d17d7aaf85ec256'),
     ('61f286c6-d082-4f47-9a2f-b51bebd23eb0'::uuid, '5f567467762a302fe1c3e0b4733057f5e743c98528f8eb5cf943bd8dfb8a3e82'),
     ('63fb0e80-55e3-4143-a06d-2599839d165a'::uuid, '14cdc99faf98f292d8806dfc9cbd653eb34653223790d1c71716945a3487d261')
   );
  if matched <> 3 then
    raise exception '0034 postcondition failed: only % of three D10 raw schemas have the corrected hash.', matched;
  end if;

  if exists (
    select 1 from public.api_schema
     where id = '61f286c6-d082-4f47-9a2f-b51bebd23eb0'
       and exists (
         select 1 from unnest(warnings) warning
          where warning in (
            'The schema states no type for version; the field is recorded without one.',
            'The manual states no type for the five form parts or the six response fields; they are recorded with no type rather than one being guessed from the printed examples.'
          )
       )
  ) then
    raise exception '0034 postcondition failed: a resolved D10 no-type warning remains.';
  end if;

  if not exists (
    select 1 from public.api_schema
     where id = '63fb0e80-55e3-4143-a06d-2599839d165a'
       and content_hash = '14cdc99faf98f292d8806dfc9cbd653eb34653223790d1c71716945a3487d261'
       and raw #>> '{properties,lines,items,type}' = 'object'
  ) then
    raise exception '0034 postcondition failed: the INFast lines[] object type is not reflected in raw.';
  end if;

  select count(*) into matched
    from _0034_d11_optional correction
    join public.api_schema schema_row on schema_row.id = correction.schema_id
   where schema_row.content_hash = correction.corrected_hash
     and schema_row.raw->'required' = '[]'::jsonb
     and not exists (
       select 1 from public.api_schema_field field_row
        where field_row.schema_id = schema_row.id and field_row.is_required
     );
  if matched <> 17 then
    raise exception '0034 postcondition failed: only % of 17 D11 schemas record confirmed all-optional request fields.', matched;
  end if;

  select count(*) into matched
    from _0034_d12_no_body correction
    join public.apis api on api.id = correction.api_id
   where api.output_formats = array['Status Codes']::text[];
  if matched <> 4 then
    raise exception '0034 postcondition failed: only % of four D12 APIs use Status Codes.', matched;
  end if;
end
$$;
