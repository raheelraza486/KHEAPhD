-- 0050  What e-invoice conversion's convertInvoice reads: not any PDF.
--
-- The record (e-invoice conversion API convertInvoice, api.myinvoice.llc)
-- gives its input only as multipart/form-data. Its request has one binary
-- "file" field, and Check 1 reads a Transformation's file upload as a PDF or
-- an image when the record names no document format. Composition therefore
-- offered it for "convert PDF to UBL XML" and, when the step named no formats,
-- marked chains starting with it feasible.
--
-- The provider's own list of input formats (GET /v1/formats, read on
-- 14 October 2026, linked from the record's OpenAPI document as "Supported
-- input formats and output profiles") is:
--
--   csv        CSV or Excel spreadsheet
--   ubl        UBL 2.1 Invoice or CreditNote XML
--   cii        UN/CEFACT CII XML or a ZUGFeRD / Factur-X PDF (embedded XML extracted)
--   edifact    EDIFACT D.96A INVOIC message
--   fatturapa, facturae, ksef-fa3, mydata, eslog, legacy-xml   national or proprietary XML
--
-- A PDF is read only for the CII XML embedded in it; an ordinary PDF is not
-- read. input_formats becomes XML, CSV and EDIFACT, and a business rule says
-- what happens to a PDF. input_formats_original keeps what the document says.
-- CSV and EDIFACT get aliases of their own, as 0043 did for values
-- format_alias did not know; nothing is merged into an existing format.
--
-- The application now lets document formats a record declares replace the
-- guess from its category (lib/checks/documents.ts), and the candidate search
-- takes PDF evidence from the declared formats before the description
-- (lib/composition/task-candidates.ts). On the 14 October catalogue this
-- record is the only one either change affects.
--
-- Changing a record's formats returns it to Published (the verification
-- triggers); an administrator verifies it again against /v1/formats.

-- ----------------------------------------------------------------- preconditions

do $$
begin
  if not exists (
    select 1 from public.apis
     where id = 'cdbcc6ac-ad26-47a5-8497-c308e1296826' and is_active
       and api_name = 'e-invoice conversion API convertInvoice'
       and input_formats = array['multipart/form-data']
  ) then
    raise exception '0050 precondition failed: the e-invoice conversion record changed.';
  end if;
end
$$;

-- ----------------------------------------------------------------- format names

insert into public.format_alias (alias, canonical, note) values
  ('CSV', 'CSV', 'canonical; comma-separated values (e-invoice conversion also reads Excel under this id)'),
  ('EDIFACT', 'EDIFACT', 'canonical; UN/EDIFACT message, e.g. INVOIC D.96A')
on conflict (alias) do nothing;

-- ----------------------------------------------------------------------- record

update public.apis
   set input_formats = array['XML', 'CSV', 'EDIFACT'],
       business_rules = array_append(business_rules,
         'A PDF is read only as ZUGFeRD / Factur-X (format=cii): the embedded CII XML is extracted. An ordinary PDF or an image is not read; extract it first.'),
       updated_at = clock_timestamp()
 where id = 'cdbcc6ac-ad26-47a5-8497-c308e1296826';

-- --------------------------------------------------------------------- audit

insert into public.api_audit_events (api_id, api_name, company_name, action, actor_name, actor_user_id, details)
select id, api_name, company_name, 'edit', 'System migration', null,
       'Input formats set to XML, CSV and EDIFACT by migration 0050, from the provider''s GET /v1/formats (14 Oct 2026); a PDF is read only as ZUGFeRD / Factur-X, which a business rule now states.'
  from public.apis where id = 'cdbcc6ac-ad26-47a5-8497-c308e1296826';

-- ------------------------------------------------------------------ postcondition

do $$
declare unmapped integer;
begin
  select count(*) into unmapped from public.v_unmapped_formats;
  if unmapped <> 0 then
    raise exception '0050 postcondition failed: % format value(s) have no alias.', unmapped;
  end if;
  if not exists (select 1 from public.apis where id = 'cdbcc6ac-ad26-47a5-8497-c308e1296826' and input_formats = array['XML', 'CSV', 'EDIFACT']) then
    raise exception '0050 postcondition failed: the input formats were not set.';
  end if;
end
$$;
