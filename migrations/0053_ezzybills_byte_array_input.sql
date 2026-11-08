-- 0053  Correct EzzyBills' file representation using the J1 live-call evidence.
--
-- 0052 is already applied; do not rewrite it. With the same test PDF, account,
-- endpoint and query parameters (doc_type=1, tag supplied), uploadInvoiceImage2
-- rejected a base64 string with HTTP 400 and accepted a JSON byte array with
-- HTTP 200 on 20 October 2026 (Australia/Sydney). The developer example also
-- serializes bytes as integers: https://developer.ezzydoc.com/docs
-- The imported string/byte reference conflicts with this observed wire format.
--
-- x-document-carrier is a local, reviewed annotation, not a provider keyword.
-- It prevents ordinary numeric arrays from being mistaken for document files.
-- Login session plus APIKey was tested, not the catalogue's OAuth flow.
-- Only application/json was exercised; the two equivalent stored JSON media
-- variants are kept consistent without claiming they were separately tested.
-- This migration records evidence, not a person's schema-verification signoff.
-- Apply through scripts/migrate.sh in a transaction.

create temporary table _0053_schema on commit drop as
select * from jsonb_to_recordset($schemas0053$
[
  {
    "api_id": "1d04401c-5c74-43ca-8adc-b65235f874ec",
    "raw": {
      "type": "object",
      "properties": {
        "PictureName": {
          "type": "string"
        },
        "PictureStream": {
          "type": "array",
          "items": {
            "type": "integer",
            "minimum": 0,
            "maximum": 255
          },
          "x-document-carrier": "byte-array",
          "description": "Invoice PDF or image bytes as a JSON array of integers from 0 to 255. Observed accepted by uploadInvoiceImage2 in J1; a base64 string was rejected. Required for the file-upload composition branch."
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
    "content_hash": "2145d03e3513a955bbdf71152854cbbce50156c88c302817860d1e74a1f00da7",
    "previous_raw": {
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
    "previous_hash": "93c69e6b33dacb2767efd4ae3c49a2411b3ed10be1c3c3c329c0bdd50cbb9cd2",
    "previous_warning": "PictureStream (string/byte) describes base64 file bytes. Required is inferred for the file-upload composition branch, not explicitly stated in the provider schema. All three JSON request media types are updated. The endpoint remains uploadInvoiceImage2; success on uploadInvoiceImage does not verify it. No live-call verification is asserted.",
    "warning": "J1 live test, 20 October 2026 (Australia/Sydney), CS95-PDF-0001: uploadInvoiceImage2 accepted integer byte-array PictureStream (HTTP 200) and rejected a base64 string (HTTP 400), using doc_type=1 and a tag with Login session plus APIKey. OAuth bearer was not tested. Required is retained for the file-upload branch. Only application/json was exercised; text/json and application/*+json are kept consistent, not separately verified. Extraction and complete downstream conversion are not certified by this request-schema correction."
  }
]
$schemas0053$::jsonb) as t(
  api_id uuid, raw jsonb, content_hash text, previous_raw jsonb,
  previous_hash text, previous_warning text, warning text
);

do $$
begin
  if not exists (
    select 1 from public.apis
     where id = '1d04401c-5c74-43ca-8adc-b65235f874ec'
       and api_name = 'EzzyBills Upload Invoice Image API'
       and api_endpoint = 'https://app.ezzydoc.com/EzzyService.svc/Rest/uploadInvoiceImage2'
       and http_method = 'POST' and category = 'Transformation'
       and is_active and duplicate_of is null
  ) then
    raise exception '0053 precondition failed: the target operation changed or is inactive.';
  end if;
  if (select count(*) from public.api_schema
       where api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec' and direction = 'request') <> 3
     or (select count(*) from public.api_schema s join _0053_schema n on n.api_id = s.api_id
          where s.direction = 'request' and s.status_code is null
            and s.media_type in ('application/json', 'text/json', 'application/*+json')
            and s.raw = n.previous_raw and s.content_hash = n.previous_hash) <> 3 then
    raise exception '0053 precondition failed: EzzyBills request schemas differ from 0052.';
  end if;
  if (select count(*) from public.api_schema_field f
       join public.api_schema s on s.id = f.schema_id
       join _0053_schema n on n.api_id = s.api_id
       where s.direction = 'request' and f.path = 'PictureStream'
         and f.json_type = 'string' and f.format = 'byte' and f.is_required
         and not f.is_array_item and f.depth = 0 and f.enum_values is null
         and f.leaf_name = 'PictureStream' and f.leaf_name_norm = 'picturestream'
         and f.description = n.previous_raw #>> '{properties,PictureStream,description}') <> 3
     or exists (
       select 1 from public.api_schema_field f join public.api_schema s on s.id = f.schema_id
        where s.api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec' and s.direction = 'request'
          and (f.path like 'PictureStream[%' or f.path like 'PictureStream.%')
     ) then
    raise exception '0053 precondition failed: EzzyBills flattened file fields differ from 0052.';
  end if;
end
$$;

update public.api_schema s
   set raw = n.raw, content_hash = n.content_hash,
       source_url = 'https://developer.ezzydoc.com/docs',
       warnings = array_append(array_remove(s.warnings, n.previous_warning), n.warning)
  from _0053_schema n
 where s.api_id = n.api_id and s.direction = 'request';

update public.api_schema_field f
   set json_type = 'array', format = null,
       description = s.raw #>> '{properties,PictureStream,description}'
  from public.api_schema s
 where f.schema_id = s.id and f.path = 'PictureStream'
   and s.api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec' and s.direction = 'request';

insert into public.api_schema_field (
  schema_id, path, leaf_name, leaf_name_norm, json_type, format,
  is_required, is_array_item, depth, enum_values, description
)
select s.id, 'PictureStream[]', 'PictureStream', 'picturestream', 'integer', null,
       true, true, 0, null, ''
  from public.api_schema s
 where s.api_id = '1d04401c-5c74-43ca-8adc-b65235f874ec' and s.direction = 'request';

insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select a.id, a.api_name, a.company_name, 'edit', 'System migration', null,
       'Migration 0053 (J2): ' || n.warning || ' Source: https://developer.ezzydoc.com/docs'
  from public.apis a join _0053_schema n on n.api_id = a.id;

do $$
begin
  if (select count(*) from public.api_schema s join _0053_schema n on n.api_id = s.api_id
       join public.api_schema_field f on f.schema_id = s.id and f.path = 'PictureStream'
       join public.api_schema_field i on i.schema_id = s.id and i.path = 'PictureStream[]'
       where s.direction = 'request' and s.raw = n.raw and s.content_hash = n.content_hash
         and f.json_type = 'array' and f.format is null and f.is_required and not f.is_array_item
         and f.description = n.raw #>> '{properties,PictureStream,description}'
         and i.json_type = 'integer' and i.format is null and i.is_required and i.is_array_item
         and i.depth = 0) <> 3 then
    raise exception '0053 postcondition failed: all JSON variants must carry the byte-array file.';
  end if;
end
$$;
