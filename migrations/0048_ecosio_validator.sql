-- 0048  ECOSIO's validator, from the group's own test of its web tool.
--
-- ECOSIO is one of the thirteen APIs the client designated on 6 October 2026.
-- Migration 0040 left it out because it publishes no specification. The client
-- wrote on 11 October: "ECOSIO doesnot have a open api spec, it's only a tool
-- so you can extract important information manually after you test it".
--
-- On 13 October 2026 the group tested the tool as the client did, in a browser
-- at https://ecosio.com/en/peppol-e-invoice-xml-document-validator/, with two
-- of its own test invoices under the rule set "Peppol PINT A-NZ Invoice (UBL)
-- 1.1.3":
--
--   the invoice the designated chain produces    valid, no findings
--   a copy with three things broken              invalid, four findings
--     (no buyer reference, no seller ABN,        (aligned-ibrp-003,
--      a wrong tax total)                         aligned-ibr-001-aunz,
--                                                 ibr-co-14, ibr-co-15)
--
-- The same valid invoice passes ESS SmartDocFlow's PINT A-NZ check, so the two
-- designated validators agree on it.
--
-- The tool is a page that calls an HTTP interface of the provider without
-- credentials: POST the XML document to a path ending with the rule set's
-- identifier, receive the verdict and the findings as JSON. The group wrote an
-- OpenAPI document from the two requests and answers it observed
-- (frontend/public/specs/ecosio-validator-openapi.json,
-- sha256 57a0032aadfc28deca5d2ba489f7fbe0ccddb973c01ff405525c8f6e5a678081),
-- and built the rows with the importer's own code -- detect, parseOpenApi3,
-- toApiRow, extractDocumentSchemas, toSchemaRows, toFieldRows,
-- toParameterRows -- as migrations 0040 and 0045 did.
--
-- Set by hand: the readable name; the company name, to match the provider
-- alias; the official company name and website; the instructions; the rule
-- sets (business rules), named as the service lists them; and the invoice
-- standard, which the test confirms.
--
-- Limits, stated in the document and in the record:
--   * ecosio offers the validator as a RESTful web service on request. The
--     path recorded is the one its own web tool calls; it is not a published
--     integration interface and may change without notice.
--   * One rule set was tested. The service listed 1066 current rule sets on
--     13 October; five are named in the record.
--   * The response schema lists what the two answers contained. A warning, a
--     malformed document and an unknown rule set were not tried.
--   * The document's second operation, which lists the rule sets, is not
--     added: it is not a step of an invoice process.
--
-- The two older records ECOSIO and ECOSIOValidator (inactive: no schema, the
-- first with a sample endpoint) are left as they are. The new record arrives
-- as Published; an administrator verifies it in the application.

-- ----------------------------------------------------------------- preconditions

create temporary table _0048_api on commit drop as
select * from jsonb_populate_recordset(null::public.apis, $rows0048$[{"api_name":"ECOSIO Validator Validate XML Document API","official_api_name":"validateDocument","description":"Checks the XML document in the request body against the rule set named in the path: well-formedness, the XML schema, and the rule set's Schematron rules. The verdict is in the body, not in the status: a valid and an invalid invoice were both answered with status 200. Called on 13 October 2026 through the provider's web tool with the rule set for Australia and New Zealand, Peppol PINT A-NZ Invoice (UBL) 1.1.3 (org.peppol.pint.aunz:invoice:1.1.3).","api_endpoint":"https://validator.ecosio.com/api/v1/open/validate/{vesid}","company_name":"Ecosio","company_name_original":"ecosio","official_company_name":"ecosio GmbH","documentation_url":"https://ecosio.com/en/peppol-e-invoice-xml-document-validator/","source_url":"https://ecosio.com/en/peppol-e-invoice-xml-document-validator/","http_method":"POST","category":"Validation","communication_direction":"","authentication_method":"None","authentication_other":"","input_formats":["XML"],"input_formats_original":["application/xml"],"output_formats":["JSON"],"output_formats_original":["application/json"],"data_quality":"ok","access_scope":"public","review_status":"Published","id":"45720e27-fcc9-49c3-b4b6-7c8a392f5a1d","website_url":"https://ecosio.com","network":"","authentication_details":"No credential is sent: the provider's free web tool calls this path without signing in. ecosio offers the validator as a RESTful web service on request and asks to be contacted for details, so the path recorded here is not a published integration interface.","instructions":"POST the XML document as the whole body, with Content-Type application/xml, to the path that ends with the rule set's identifier (vesid). GET /api/v1/open/vesids on the same host lists the identifiers. The verdict is the boolean success in the JSON body; a valid and an invalid document are both answered with status 200. The group tested one rule set, Peppol PINT A-NZ Invoice (UBL) 1.1.3; the other rule sets are named as the service lists them.","business_rules":["Peppol PINT A-NZ Invoice (UBL) 1.1.3 (org.peppol.pint.aunz:invoice:1.1.3)","A-NZ Peppol BIS3 Invoice (UBL) 1.0.12 (eu.peppol.bis3.aunz.ubl:invoice:1.0.12)","OpenPeppol UBL Invoice 2026.5, BIS Billing 3.0.21 (eu.peppol.bis3:invoice:latest)","EN 16931 UBL Invoice 1.3.16 (eu.cen.en16931:ubl:latest)","XRechnung UBL Invoice 3.0.2 (de.xrechnung:ubl-invoice:latest)"],"invoice_standard":["Peppol PINT A-NZ 1.1.3","UBL 2.1"],"invoice_standard_source":"confirmed"}]$rows0048$::jsonb);

do $$
declare clash integer;
begin
  select count(*) into clash
    from _0048_api new_api
    join public.apis api
      on (lower(api.company_name) = lower(new_api.company_name) and lower(api.api_name) = lower(new_api.api_name))
      or (api.api_endpoint = new_api.api_endpoint and api.http_method = new_api.http_method);
  if clash <> 0 then
    raise exception '0048 precondition failed: the ECOSIO validation operation already exists.';
  end if;
end
$$;

-- ----------------------------------------------------------------------- inserts

insert into public.apis (api_name, official_api_name, description, api_endpoint, instructions, company_name, company_name_original, official_company_name, website_url, documentation_url, source_url, http_method, category, communication_direction, authentication_method, authentication_other, authentication_details, input_formats, input_formats_original, output_formats, output_formats_original, business_rules, invoice_standard, invoice_standard_source, data_quality, access_scope, review_status, id, network)
select api_name, official_api_name, description, api_endpoint, instructions, company_name, company_name_original, official_company_name, website_url, documentation_url, source_url, http_method, category, communication_direction, authentication_method, authentication_other, authentication_details, input_formats, input_formats_original, output_formats, output_formats_original, business_rules, invoice_standard, invoice_standard_source, data_quality, access_scope, review_status, id, network from _0048_api;

insert into public.api_schema (id, api_id, direction, media_type, status_code, origin, source_url, content_hash, raw, warnings, created_by)
select id, api_id, direction, media_type, status_code, origin, source_url, content_hash, raw, warnings, created_by
  from jsonb_populate_recordset(null::public.api_schema, $rows0048$[{"api_id":"45720e27-fcc9-49c3-b4b6-7c8a392f5a1d","direction":"request","media_type":"application/xml","status_code":null,"origin":"extracted","source_url":"https://ecosio.com/en/peppol-e-invoice-xml-document-validator/","content_hash":"4e013c5210c379d17809f9f951e521f6e984772f228002d26c7892cad74f17ca","raw":{"type":"string","description":"An XML business document, for example a UBL 2.1 invoice."},"warnings":[],"created_by":"","id":"058f57e6-2a59-4b72-88eb-98cf3701282a"},{"api_id":"45720e27-fcc9-49c3-b4b6-7c8a392f5a1d","direction":"response","media_type":"application/json","status_code":"200","origin":"extracted","source_url":"https://ecosio.com/en/peppol-e-invoice-xml-document-validator/","content_hash":"dd2608054b23d793ed4219c45ffa49ec9b271d6ced30581957fa1f7c3d1e088d","raw":{"type":"object","required":["durationMS","interrupted","mostSevereErrorLevel","results","success","ves"],"properties":{"success":{"type":"boolean","description":"The verdict: true when the document passed every check of the rule set."},"mostSevereErrorLevel":{"type":"string","description":"The highest severity among the findings. SUCCESS for the valid invoice and ERROR for the broken one are the two values the group has seen.","example":"SUCCESS"},"interrupted":{"type":"boolean","description":"false in both answers the group has seen."},"durationMS":{"type":"integer","description":"How long the validation took, in milliseconds.","example":70},"ves":{"allOf":[{"type":"object","description":"One rule set.","required":["deprecated","name","vesid"],"properties":{"deprecated":{"type":"boolean","description":"Whether the provider marks the rule set as deprecated."},"name":{"type":"string","description":"The rule set's name with its version.","example":"Peppol PINT A-NZ Invoice (UBL) 1.1.3"},"vesid":{"type":"string","description":"The rule set's identifier, used in the path of the validation call.","example":"org.peppol.pint.aunz:invoice:1.1.3"}}}],"description":"The rule set the document was validated against."},"results":{"type":"array","description":"One entry per check, in the order they ran. For Peppol PINT A-NZ Invoice 1.1.3 there were four: xml, xsd, and two schematron-xslt2 checks (the PINT shared rules and the A-NZ jurisdiction-aligned rules).","items":{"type":"object","required":["artifactPath","artifactType","items","success"],"properties":{"artifactType":{"type":"string","description":"The kind of check. The group has seen xml (well-formedness), xsd and schematron-xslt2.","example":"schematron-xslt2"},"artifactPath":{"type":"string","description":"The schema or rule file the check used; empty for the well-formedness check.","example":"external/schematron/pint-aunz/1.1.3/xslt/billing/PINT-jurisdiction-aligned-rules.xslt"},"success":{"type":"string","description":"Whether this check passed, as text. The group has seen TRUE and FALSE.","example":"TRUE"},"items":{"type":"array","description":"The findings of this check; empty when it passed.","items":{"type":"object","description":"One finding. No finding appeared in the response for the valid invoice; four appeared for the broken one, all with errorLevel ERROR.","required":["errorFieldName","errorID","errorLevel","errorText","violatedRule"],"properties":{"errorFieldName":{"type":"string","description":"Where in the document the rule failed, as an XPath-like location.","example":"/:Invoice[1]/cac:TaxTotal[1]"},"errorID":{"type":"string","description":"The identifier of the rule that failed.","example":"aligned-ibrp-003"},"errorLevel":{"type":"string","description":"The severity of the finding. ERROR is the only value the group has seen.","example":"ERROR"},"errorLocationObj":{"type":"object","nullable":true,"description":"null in every finding the group has seen."},"errorText":{"type":"string","description":"The rule's message, starting with its identifier in square brackets.","example":"[aligned-ibrp-003]-A buyer reference (ibt-010) or purchase order reference (ibt-013) MUST be provided."},"exception":{"type":"string","nullable":true,"description":"null in every finding the group has seen."},"violatedRule":{"type":"string","description":"The test of the rule, as an XPath expression.","example":"cbc:BuyerReference or cac:OrderReference/cbc:ID"}}}}}}}}},"warnings":[],"created_by":"","id":"071fa338-5d6e-409c-8be9-2a49b7e21747"}]$rows0048$::jsonb);

insert into public.api_schema_field (path, leaf_name, leaf_name_norm, json_type, format, is_required, is_array_item, depth, enum_values, description, schema_id)
select path, leaf_name, leaf_name_norm, json_type, format, is_required, is_array_item, depth, enum_values, description, schema_id
  from jsonb_populate_recordset(null::public.api_schema_field, $rows0048$[{"path":"success","leaf_name":"success","leaf_name_norm":"success","json_type":"boolean","format":null,"is_required":true,"is_array_item":false,"depth":0,"enum_values":null,"description":"The verdict: true when the document passed every check of the rule set.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"mostSevereErrorLevel","leaf_name":"mostSevereErrorLevel","leaf_name_norm":"mostsevereerrorlevel","json_type":"string","format":null,"is_required":true,"is_array_item":false,"depth":0,"enum_values":null,"description":"The highest severity among the findings. SUCCESS for the valid invoice and ERROR for the broken one are the two values the group has seen.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"interrupted","leaf_name":"interrupted","leaf_name_norm":"interrupted","json_type":"boolean","format":null,"is_required":true,"is_array_item":false,"depth":0,"enum_values":null,"description":"false in both answers the group has seen.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"durationMS","leaf_name":"durationMS","leaf_name_norm":"durationms","json_type":"integer","format":null,"is_required":true,"is_array_item":false,"depth":0,"enum_values":null,"description":"How long the validation took, in milliseconds.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"ves","leaf_name":"ves","leaf_name_norm":"ves","json_type":"object","format":null,"is_required":true,"is_array_item":false,"depth":0,"enum_values":null,"description":"The rule set the document was validated against.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"ves.deprecated","leaf_name":"deprecated","leaf_name_norm":"deprecated","json_type":"boolean","format":null,"is_required":true,"is_array_item":false,"depth":1,"enum_values":null,"description":"Whether the provider marks the rule set as deprecated.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"ves.name","leaf_name":"name","leaf_name_norm":"name","json_type":"string","format":null,"is_required":true,"is_array_item":false,"depth":1,"enum_values":null,"description":"The rule set's name with its version.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"ves.vesid","leaf_name":"vesid","leaf_name_norm":"vesid","json_type":"string","format":null,"is_required":true,"is_array_item":false,"depth":1,"enum_values":null,"description":"The rule set's identifier, used in the path of the validation call.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results","leaf_name":"results","leaf_name_norm":"results","json_type":"array","format":null,"is_required":true,"is_array_item":false,"depth":0,"enum_values":null,"description":"One entry per check, in the order they ran. For Peppol PINT A-NZ Invoice 1.1.3 there were four: xml, xsd, and two schematron-xslt2 checks (the PINT shared rules and the A-NZ jurisdiction-aligned rules).","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[]","leaf_name":"results","leaf_name_norm":"results","json_type":"object","format":null,"is_required":true,"is_array_item":true,"depth":0,"enum_values":null,"description":"","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].artifactType","leaf_name":"artifactType","leaf_name_norm":"artifacttype","json_type":"string","format":null,"is_required":true,"is_array_item":true,"depth":1,"enum_values":null,"description":"The kind of check. The group has seen xml (well-formedness), xsd and schematron-xslt2.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].artifactPath","leaf_name":"artifactPath","leaf_name_norm":"artifactpath","json_type":"string","format":null,"is_required":true,"is_array_item":true,"depth":1,"enum_values":null,"description":"The schema or rule file the check used; empty for the well-formedness check.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].success","leaf_name":"success","leaf_name_norm":"success","json_type":"string","format":null,"is_required":true,"is_array_item":true,"depth":1,"enum_values":null,"description":"Whether this check passed, as text. The group has seen TRUE and FALSE.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items","leaf_name":"items","leaf_name_norm":"items","json_type":"array","format":null,"is_required":true,"is_array_item":true,"depth":1,"enum_values":null,"description":"The findings of this check; empty when it passed.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items[]","leaf_name":"items","leaf_name_norm":"items","json_type":"object","format":null,"is_required":true,"is_array_item":true,"depth":1,"enum_values":null,"description":"One finding. No finding appeared in the response for the valid invoice; four appeared for the broken one, all with errorLevel ERROR.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items[].errorFieldName","leaf_name":"errorFieldName","leaf_name_norm":"errorfieldname","json_type":"string","format":null,"is_required":true,"is_array_item":true,"depth":2,"enum_values":null,"description":"Where in the document the rule failed, as an XPath-like location.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items[].errorID","leaf_name":"errorID","leaf_name_norm":"errorid","json_type":"string","format":null,"is_required":true,"is_array_item":true,"depth":2,"enum_values":null,"description":"The identifier of the rule that failed.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items[].errorLevel","leaf_name":"errorLevel","leaf_name_norm":"errorlevel","json_type":"string","format":null,"is_required":true,"is_array_item":true,"depth":2,"enum_values":null,"description":"The severity of the finding. ERROR is the only value the group has seen.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items[].errorLocationObj","leaf_name":"errorLocationObj","leaf_name_norm":"errorlocationobj","json_type":"object","format":null,"is_required":false,"is_array_item":true,"depth":2,"enum_values":null,"description":"null in every finding the group has seen.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items[].errorText","leaf_name":"errorText","leaf_name_norm":"errortext","json_type":"string","format":null,"is_required":true,"is_array_item":true,"depth":2,"enum_values":null,"description":"The rule's message, starting with its identifier in square brackets.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items[].exception","leaf_name":"exception","leaf_name_norm":"exception","json_type":"string","format":null,"is_required":false,"is_array_item":true,"depth":2,"enum_values":null,"description":"null in every finding the group has seen.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"},{"path":"results[].items[].violatedRule","leaf_name":"violatedRule","leaf_name_norm":"violatedrule","json_type":"string","format":null,"is_required":true,"is_array_item":true,"depth":2,"enum_values":null,"description":"The test of the rule, as an XPath expression.","schema_id":"071fa338-5d6e-409c-8be9-2a49b7e21747"}]$rows0048$::jsonb);

insert into public.api_parameter (api_id, name, location, is_required, schema, json_type, format, enum_values, name_norm, description, origin, source_url, created_by)
select api_id, name, location, is_required, schema, json_type, format, enum_values, name_norm, description, origin, source_url, created_by
  from jsonb_populate_recordset(null::public.api_parameter, $rows0048$[{"api_id":"45720e27-fcc9-49c3-b4b6-7c8a392f5a1d","name":"vesid","location":"path","is_required":true,"schema":{"type":"string"},"json_type":"string","format":null,"enum_values":null,"name_norm":"vesid","description":"The identifier of the rule set, as listed by /api/v1/open/vesids. Its form is group:name:version; a version of \"latest\" is listed for each rule set.","origin":"extracted","source_url":"https://ecosio.com/en/peppol-e-invoice-xml-document-validator/","created_by":""}]$rows0048$::jsonb);

insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select id, api_name, company_name, 'upload', 'System migration', null,
       'API added by migration 0048 from the OpenAPI document the group wrote after testing the provider''s web validator on 13 October 2026 (ECOSIO is one of the thirteen designated APIs).'
  from _0048_api;

-- ------------------------------------------------------------------ postcondition

do $$
declare
  added integer;
  schema_rows integer;
  field_rows integer;
  parameter_rows integer;
begin
  select count(*) into added from public.apis where id in (select id from _0048_api);
  select count(*) into schema_rows from public.api_schema where api_id in (select id from _0048_api);
  select count(*) into field_rows
    from public.api_schema_field f join public.api_schema s on s.id = f.schema_id
   where s.api_id in (select id from _0048_api);
  select count(*) into parameter_rows from public.api_parameter where api_id in (select id from _0048_api);
  if added <> 1 or schema_rows <> 2 or field_rows <> 22 or parameter_rows <> 1 then
    raise exception '0048 postcondition failed: % APIs, % schemas, % fields, % parameters.', added, schema_rows, field_rows, parameter_rows;
  end if;
end
$$;
