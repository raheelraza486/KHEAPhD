-- 0052  J2: expose the file inputs of the two extraction candidates from 0040.
--
-- Official references, read 19 October 2026:
-- https://docs.nanonets.com/reference/ocrmodellabelfilebymodelidpost-1
-- https://apidocs.ezzydoc.com/mintlify/docs/ezzyrest/uploadinvoiceimage2
--
-- Nanonets' LabelFile request was absent. Transcribe its multipart file branch;
-- file is required in the reference, with optional base64_data, request_metadata
-- and pages_to_process. This is the catalogue OCR API, not Nanonets Agents.
--
-- EzzyBills already describes PictureStream as string/byte, but neither marks
-- it required nor describes it. Require it for the file-upload composition
-- branch and explain the base64 content. This required flag is an inference
-- for that branch, NOT an explicit requirement in the provider's schema.
-- Update all three JSON request media types, otherwise one still looks like
-- ordinary JSON to effectiveFormats. Keep uploadInvoiceImage2: a successful
-- call to the different uploadInvoiceImage endpoint does not verify this one.
--
-- Only request schemas/fields change. Responses, endpoints and parameters stay
-- as imported. Hashes use schemaContentHash in frontend/lib/schema/extract.ts.
-- Existing review triggers return changed APIs to Published; old schema
-- verification hashes no longer match. No live-call verification is asserted.
-- Apply through scripts/migrate.sh, which wraps each file in one transaction.

create temporary table _0052_schemas on commit drop as
select * from jsonb_to_recordset($schemas0052$
[
  {
    "api_id": "b1c13a58-0c0a-42ab-a161-1330f9c50859",
    "source_url": "https://docs.nanonets.com/reference/ocrmodellabelfilebymodelidpost-1",
    "raw": {
      "type": "object",
      "required": [
        "file"
      ],
      "properties": {
        "file": {
          "type": "string",
          "format": "binary",
          "description": "Local PDF or image file uploaded as a multipart file part for OCR prediction."
        },
        "base64_data": {
          "type": "string",
          "description": "Optional base64 input described by the provider. This schema models the multipart file branch and still requires file."
        },
        "request_metadata": {
          "type": "string",
          "description": "Optional metadata stored with the uploaded document."
        },
        "pages_to_process": {
          "type": "string",
          "description": "Optional comma-separated page numbers to process, for example 1,2."
        }
      }
    },
    "content_hash": "c71430d2f355e7e5308d6b5bdd825bf1f3e0ab1e6896f6543382c0e567bf8f4f",
    "previous_raw": null,
    "previous_hash": null,
    "warning": "Request schema transcribed from the official LabelFile reference for the multipart file branch (required file; optional base64_data, request_metadata and pages_to_process). Base64-only requests are not modelled by this branch. This is the catalogue OCR API, not Nanonets Agents; no live-call verification is asserted."
  },
  {
    "api_id": "1d04401c-5c74-43ca-8adc-b65235f874ec",
    "source_url": "https://apidocs.ezzydoc.com/mintlify/docs/ezzyrest/uploadinvoiceimage2",
    "raw": {
      "type": "object",
      "properties": {
        "PictureName": {
          "type": "string"
        },
        "PictureStream": {
          "type": "string",
          "format": "byte",
          "description": "Base64-encoded bytes of the invoice PDF or image, sent as a JSON string. Required for the file-upload composition branch; the provider schema states string/byte but does not explicitly mark this field required."
        },
        "service_status": {
          "type": "object",
          "properties": {
            "invoice_id": {
              "type": "integer"
            },
            "message": {
              "type": "string"
            },
            "status": {
              "type": "integer",
              "enum": [
                0,
                1,
                2,
                3
              ],
              "x-enumNames": [
                "OK",
                "FAILED",
                "NO_MORE_INVOICES",
                "NOT_PERMITTED"
              ]
            }
          }
        }
      },
      "required": [
        "PictureStream"
      ]
    },
    "content_hash": "93c69e6b33dacb2767efd4ae3c49a2411b3ed10be1c3c3c329c0bdd50cbb9cd2",
    "previous_raw": {
      "type": "object",
      "properties": {
        "PictureName": {
          "type": "string"
        },
        "PictureStream": {
          "type": "string",
          "format": "byte"
        },
        "service_status": {
          "type": "object",
          "properties": {
            "invoice_id": {
              "type": "integer"
            },
            "message": {
              "type": "string"
            },
            "status": {
              "type": "integer",
              "enum": [
                0,
                1,
                2,
                3
              ],
              "x-enumNames": [
                "OK",
                "FAILED",
                "NO_MORE_INVOICES",
                "NOT_PERMITTED"
              ]
            }
          }
        }
      }
    },
    "previous_hash": "282ebb1cb0f5b4769fc73ceebd06e99c6ce11ed1a4cb5de8c9989c4fb2cb2e57",
    "warning": "PictureStream (string/byte) describes base64 file bytes. Required is inferred for the file-upload composition branch, not explicitly stated in the provider schema. All three JSON request media types are updated. The endpoint remains uploadInvoiceImage2; success on uploadInvoiceImage does not verify it. No live-call verification is asserted."
  }
]
$schemas0052$::jsonb) as t(
  api_id uuid, source_url text, raw jsonb, content_hash text,
  previous_raw jsonb, previous_hash text, warning text
);

-- Refuse to overwrite a different operation or a schema someone has edited.
do $$
begin
  if not exists (
    select 1 from public.apis
     where id = 'b1c13a58-0c0a-42ab-a161-1330f9c50859'
       and api_name = 'Nanonets OCR Extract From File API'
       and api_endpoint = 'https://app.nanonets.com/api/v2/OCR/Model/{model_id}/LabelFile/'
       and http_method = 'POST' and category = 'Transformation'
       and is_active and duplicate_of is null
  ) or not exists (
    select 1 from public.apis
     where id = '1d04401c-5c74-43ca-8adc-b65235f874ec'
       and api_name = 'EzzyBills Upload Invoice Image API'
       and api_endpoint = 'https://app.ezzydoc.com/EzzyService.svc/Rest/uploadInvoiceImage2'
       and http_method = 'POST' and category = 'Transformation'
       and is_active and duplicate_of is null
  ) then
    raise exception '0052 precondition failed: a target operation changed or is inactive.';
  end if;
  if exists (
    select 1 from public.api_schema
     where api_id = 'b1c13a58-0c0a-42ab-a161-1330f9c50859' and direction = 'request'
  ) then
    raise exception '0052 precondition failed: Nanonets already has a request schema.';
  end if;
  if (select count(*) from public.api_schema
       where api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec' and direction = 'request') <> 3
     or (select count(*) from public.api_schema s join _0052_schemas n on n.api_id = s.api_id
          where s.api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec'
            and s.direction = 'request' and s.status_code is null
            and s.media_type in ('application/json', 'text/json', 'application/*+json')
            and s.raw = n.previous_raw and s.content_hash = n.previous_hash) <> 3 then
    raise exception '0052 precondition failed: EzzyBills request schemas changed since 0040.';
  end if;
  if (select count(*) from public.api_schema s
        join public.api_schema_field f on f.schema_id = s.id
       where s.api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec' and s.direction = 'request'
         and f.path = 'PictureStream' and f.json_type = 'string' and f.format = 'byte'
         and not f.is_required and coalesce(f.description, '') = '') <> 3 then
    raise exception '0052 precondition failed: EzzyBills PictureStream fields changed since 0040.';
  end if;
end
$$;

insert into public.api_schema (
  api_id, direction, media_type, status_code, origin, source_url, raw, content_hash, warnings
)
select api_id, 'request', 'multipart/form-data', null, 'extracted', source_url,
       raw, content_hash, array[warning]
  from _0052_schemas where api_id = 'b1c13a58-0c0a-42ab-a161-1330f9c50859';

-- All four Nanonets properties are top-level strings. Derive their field rows
-- from raw so required, descriptions and types have only one source of truth.
insert into public.api_schema_field (
  schema_id, path, leaf_name, leaf_name_norm, json_type, format,
  is_required, is_array_item, depth, enum_values, description
)
select s.id, p.key, p.key, regexp_replace(lower(p.key), '[^a-z0-9]', '', 'g'),
       p.value->>'type', p.value->>'format', s.raw->'required' ? p.key,
       false, 0, null, coalesce(p.value->>'description', '')
  from public.api_schema s
  cross join lateral jsonb_each(s.raw->'properties') p
 where s.api_id = 'b1c13a58-0c0a-42ab-a161-1330f9c50859' and s.direction = 'request';

update public.api_schema s
   set raw = n.raw, content_hash = n.content_hash,
       warnings = array_append(s.warnings, n.warning)
  from _0052_schemas n
 where s.api_id = n.api_id and s.api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec'
   and s.direction = 'request';

update public.api_schema_field f
   set is_required = true,
       description = s.raw #>> '{properties,PictureStream,description}'
  from public.api_schema s
 where f.schema_id = s.id and f.path = 'PictureStream'
   and s.api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec' and s.direction = 'request';

insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select a.id, a.api_name, a.company_name, 'edit', 'System migration', null,
       'Migration 0052 (J2): ' || n.warning || ' Source: ' || n.source_url
  from public.apis a join _0052_schemas n on n.api_id = a.id;

do $$
begin
  if (select count(*) from public.api_schema s
        join public.api_schema_field f on f.schema_id = s.id
       where s.api_id = 'b1c13a58-0c0a-42ab-a161-1330f9c50859'
         and s.direction = 'request' and s.media_type = 'multipart/form-data'
         and f.path = 'file' and f.is_required and f.format = 'binary') <> 1 then
    raise exception '0052 postcondition failed: Nanonets has no required file carrier.';
  end if;
  if (select count(*) from public.api_schema s
        join public.api_schema_field f on f.schema_id = s.id
       where s.api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec' and s.direction = 'request'
         and s.raw->'required' ? 'PictureStream'
         and f.path = 'PictureStream' and f.is_required and f.format = 'byte'
         and f.description = s.raw #>> '{properties,PictureStream,description}'
         and f.description <> '') <> 3 then
    raise exception '0052 postcondition failed: EzzyBills file carriers are incomplete.';
  end if;
end
$$;
