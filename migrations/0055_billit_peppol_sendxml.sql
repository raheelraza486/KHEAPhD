-- 0055  Billit Peppol Send XML: the endpoint the real Peppol send of
--       21 October 2026 used.
--
-- Billit is one of the thirteen APIs the client designated on 6 October 2026.
-- Migration 0040 imported Billit's Swagger document, which holds
-- POST /v1/peppol/sendOrder (Billit's own Order model, about 400 optional
-- fields). The documented way to put a finished UBL file on Peppol is
-- POST /v1/peppol/sendxml, whose body is { "XML": "<UBL>" }; it is absent from
-- the Swagger document, so the catalogue did not hold it.
--
-- On 21 October 2026 the group sent invoice CS95-BL-1848 through it on the
-- sandbox (api.sandbox.billit.be): HTTP 200, InboxItemID 1130933, shown as
-- Sent in MyBillit (OneDrive, BP-Builder 组/Y1-Billit-Peppol-send-CS95-BL-1848-2026-10-21).
-- The engine's comparison of real runs (Y2) found that the pairs
-- ESS SmartDocFlow -> Billit and Peppol Validator -> Billit were judged on
-- the sendOrder record, an interface the run did not use.
--
-- The group wrote an OpenAPI document from Billit's documentation and that call
-- (frontend/public/specs/billit-peppol-sendxml-openapi.json,
-- sha256 76b1f926f63d53c871474cc032862fab7b76817c69b4eef84f4cc17e95210b0a), and built the rows with the importer's own field model,
-- as migrations 0040, 0045, 0048 and 0049 did.
--
-- Set by hand: the readable name, the website, the instructions and the
-- authentication details (the sandbox accepted an apiKey header; OAuth 2.0 is
-- the documented alternative).
--
-- The sendOrder record stays: it describes another input (the Order model).
-- The new record arrives as Published; an administrator verifies it in the
-- application. The engine takes the request's one required XML string as the
-- whole document (lib/checks/documents.ts, same pull request).

-- ----------------------------------------------------------------- preconditions

create temporary table _0055_api on commit drop as
select * from jsonb_populate_recordset(null::public.apis, $rows0055$[{"api_name": "Billit Peppol Send XML API", "official_api_name": "Peppol_SendXml", "description": "Sends one UBL 2.1 document (Peppol BIS Billing 3.0 invoice or credit note) to the receiver named inside the document. The sending party is the company of the API key; the receiver is resolved from the document's AccountingCustomerParty endpoint identifier, which must be registered on Peppol. The whole UBL document is passed as a string in the single field XML. Returns the identifier of the created inbox item.", "api_endpoint": "https://api.billit.be/v1/peppol/sendxml", "company_name": "Billit", "company_name_original": "", "official_company_name": "", "documentation_url": "https://docs.billit.be/docs/peppol-sendxml", "source_url": "https://docs.billit.be/docs/peppol-sendxml", "http_method": "POST", "category": "Communication", "communication_direction": "Send", "authentication_method": "API Key", "authentication_other": "", "input_formats": ["JSON"], "input_formats_original": ["application/json"], "output_formats": ["JSON"], "output_formats_original": ["application/json"], "data_quality": "ok", "access_scope": "public", "review_status": "Published", "id": "dd6f7bec-14c8-49ca-be7e-14f653225602", "website_url": "https://www.billit.be", "network": "Peppol", "authentication_details": "Request header apiKey with the key from MyBillit Profile > Users & API Key, plus header partyID when the account holds several companies (verified on the sandbox 2026-10-21). OAuth 2.0 client credentials, requested from Billit support, work as well (docs.billit.be/docs/authentication).", "instructions": "POST the whole UBL 2.1 document (Peppol BIS Billing 3.0 Invoice or CreditNote) as a string in the one field XML. The receiver is read from the document's AccountingCustomerParty endpoint identifier and must be registered on Peppol; the sender is the company of the API key. Before any send the company's Business number (ABN) must be filled in MyBillit, otherwise the call fails with 400 GenericError. Sandbox host api.sandbox.billit.be. Verified 2026-10-21: invoice CS95-BL-1848 accepted (InboxItemID 1130933) and shown as Sent."}]$rows0055$::jsonb);

do $$
declare clash integer;
begin
  select count(*) into clash
    from _0055_api new_api
    join public.apis api
      on (lower(api.company_name) = lower(new_api.company_name) and lower(api.api_name) = lower(new_api.api_name))
      or (api.api_endpoint = new_api.api_endpoint and api.http_method = new_api.http_method);
  if clash <> 0 then
    raise exception '0055 precondition failed: the Billit sendxml operation already exists.';
  end if;
end
$$;

-- ----------------------------------------------------------------------- inserts

insert into public.apis (api_name, official_api_name, description, api_endpoint, instructions, company_name, company_name_original, official_company_name, website_url, documentation_url, source_url, http_method, category, communication_direction, authentication_method, authentication_other, authentication_details, input_formats, input_formats_original, output_formats, output_formats_original, data_quality, access_scope, review_status, id, network)
select api_name, official_api_name, description, api_endpoint, instructions, company_name, company_name_original, official_company_name, website_url, documentation_url, source_url, http_method, category, communication_direction, authentication_method, authentication_other, authentication_details, input_formats, input_formats_original, output_formats, output_formats_original, data_quality, access_scope, review_status, id, network from _0055_api;

insert into public.api_schema (id, api_id, direction, media_type, status_code, origin, source_url, content_hash, raw, warnings, created_by)
select id, api_id, direction, media_type, status_code, origin, source_url, content_hash, raw, warnings, created_by
  from jsonb_populate_recordset(null::public.api_schema, $rows0055$[{"api_id": "dd6f7bec-14c8-49ca-be7e-14f653225602", "direction": "request", "media_type": "application/json", "status_code": null, "origin": "extracted", "source_url": "https://docs.billit.be/docs/peppol-sendxml", "content_hash": "82b0addc7a87422c66c0eed76bf948768bdeee770e5e32eddd9e998ec463b994", "raw": {"type": "object", "required": ["XML"], "properties": {"XML": {"type": "string", "description": "The complete UBL 2.1 XML document (Peppol BIS Billing 3.0 Invoice or CreditNote) as a string, including the XML declaration."}}}, "warnings": [], "created_by": "", "id": "6e823d28-991f-42db-bb9a-348b375884e2"}, {"api_id": "dd6f7bec-14c8-49ca-be7e-14f653225602", "direction": "response", "media_type": "application/json", "status_code": "200", "origin": "extracted", "source_url": "https://docs.billit.be/docs/peppol-sendxml", "content_hash": "70f57c8e12f5815dc8a5b283724fadc2716fddb59735f750506dd22c1a1bcedd", "raw": {"type": "integer", "format": "int64", "description": "InboxItemID of the created send record."}, "warnings": [], "created_by": "", "id": "24c6d02d-21d5-4670-ba69-d2b83f372a71"}]$rows0055$::jsonb);

insert into public.api_schema_field (path, leaf_name, leaf_name_norm, json_type, format, is_required, is_array_item, depth, enum_values, description, schema_id)
select path, leaf_name, leaf_name_norm, json_type, format, is_required, is_array_item, depth, enum_values, description, schema_id
  from jsonb_populate_recordset(null::public.api_schema_field, $rows0055$[{"path": "XML", "leaf_name": "XML", "leaf_name_norm": "xml", "json_type": "string", "format": null, "is_required": true, "is_array_item": false, "depth": 0, "enum_values": null, "description": "The complete UBL 2.1 XML document (Peppol BIS Billing 3.0 Invoice or CreditNote) as a string, including the XML declaration.", "schema_id": "6e823d28-991f-42db-bb9a-348b375884e2"}]$rows0055$::jsonb);

insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select id, api_name, company_name, 'upload', 'System migration', null,
       'API added by migration 0055 from the OpenAPI document the group wrote from Billit''s documentation and the real Peppol send of 21 October 2026 (Billit is one of the thirteen designated APIs).'
  from _0055_api;

-- ------------------------------------------------------------------ postcondition

do $$
declare
  added integer;
  schema_rows integer;
  field_rows integer;
begin
  select count(*) into added from public.apis where id in (select id from _0055_api);
  select count(*) into schema_rows from public.api_schema where api_id in (select id from _0055_api);
  select count(*) into field_rows
    from public.api_schema_field f join public.api_schema s on s.id = f.schema_id
   where s.api_id in (select id from _0055_api);
  if added <> 1 or schema_rows <> 2 or field_rows <> 1 then
    raise exception '0055 postcondition failed: % APIs, % schemas, % fields.', added, schema_rows, field_rows;
  end if;
end
$$;
