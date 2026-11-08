-- 0051  Hybrid PDF: the PDF that beliq and e-invoice conversion read.
--
-- A ZUGFeRD / Factur-X invoice is a PDF with the invoice XML embedded in it.
-- Two catalogue converters read a PDF only in that form; neither reads an
-- ordinary PDF or a scan. The format list had only "PDF", so the composition
-- engine offered beliq convertInvoice for "convert PDF to UBL XML" and built
-- chains starting with it for an ordinary PDF.
--
--   beliq API convertInvoice     docs.beliq.eu/api-reference/convert (read on
--                                14 October 2026): "XML or hybrid PDF in";
--                                application/pdf "for a hybrid ZUGFeRD/Factur-X
--                                PDF"; the source PDF comes back only when
--                                nothing in it has to change, and an XML source
--                                is never wrapped into a PDF.
--   e-invoice conversion API     GET /v1/formats (14 October 2026): cii is "CII
--     convertInvoice             XML or a ZUGFeRD / Factur-X PDF (embedded XML
--                                extracted)"; with profile facturx-en16931 and
--                                output=pdf it returns the Factur-X container.
--                                Migration 0050 left the PDF out of its inputs.
--
-- "Hybrid PDF" becomes a format of its own, with the spellings ZUGFeRD PDF and
-- Factur-X PDF. The application reads it as a PDF to any side that takes a PDF
-- (as UBL is XML to a side that takes XML), but a side that takes only a
-- Hybrid PDF is not given a plain PDF (lib/checks/check1-format.ts,
-- documents.ts, media-types.ts; the candidate search in task-candidates.ts).
-- On the 14 October catalogue the change of these two records alters the
-- verdict of no pair; three pairs that already failed (government PDF
-- printouts into beliq) now also fail the format check.
--
-- Both records keep their *_formats_original. Changing a record's formats
-- returns it to Published (the verification triggers); an administrator
-- verifies both again.

-- ----------------------------------------------------------------- preconditions

do $$
begin
  if not exists (
    select 1 from public.apis
     where id = '74ee6b3b-9c7c-4cf6-ac18-03b77a5c26ce' and is_active
       and api_name = 'beliq API convertInvoice'
       and input_formats = array['application/xml', 'text/xml', 'application/octet-stream', 'application/pdf']
       and output_formats = array['application/xml', 'application/pdf']
  ) then
    raise exception '0051 precondition failed: the beliq convertInvoice record changed.';
  end if;
  if not exists (
    select 1 from public.apis
     where id = 'cdbcc6ac-ad26-47a5-8497-c308e1296826' and is_active
       and input_formats = array['XML', 'CSV', 'EDIFACT']
       and output_formats = array['XML', 'PDF']
  ) then
    raise exception '0051 precondition failed: the e-invoice conversion record is not as 0050 left it.';
  end if;
end
$$;

-- ----------------------------------------------------------------- format names

insert into public.format_alias (alias, canonical, note) values
  ('Hybrid PDF', 'Hybrid PDF', 'canonical; a PDF with the invoice XML embedded (ZUGFeRD / Factur-X); a PDF to a side that takes any PDF'),
  ('ZUGFeRD PDF', 'Hybrid PDF', 'same format, named by its German specification'),
  ('Factur-X PDF', 'Hybrid PDF', 'same format, named by its French specification'),
  ('ZUGFeRD / Factur-X PDF', 'Hybrid PDF', 'same format, both names')
on conflict (alias) do nothing;

-- ---------------------------------------------------------------------- records

update public.apis
   set input_formats = array['XML', 'Hybrid PDF'],
       output_formats = array['XML', 'Hybrid PDF'],
       business_rules = array_append(business_rules,
         'Reads XML or a hybrid ZUGFeRD / Factur-X PDF, whose embedded CII is extracted; an ordinary PDF or a scan is not read. A PDF comes back only when the source PDF needs no change; an XML source is never wrapped into a PDF.'),
       updated_at = clock_timestamp()
 where id = '74ee6b3b-9c7c-4cf6-ac18-03b77a5c26ce';

update public.apis
   set input_formats = array['XML', 'CSV', 'EDIFACT', 'Hybrid PDF'],
       output_formats = array['XML', 'Hybrid PDF'],
       updated_at = clock_timestamp()
 where id = 'cdbcc6ac-ad26-47a5-8497-c308e1296826';

-- --------------------------------------------------------------------- audit

insert into public.api_audit_events (api_id, api_name, company_name, action, actor_name, actor_user_id, details)
select id, api_name, company_name, 'edit', 'System migration', null,
       case when id = '74ee6b3b-9c7c-4cf6-ac18-03b77a5c26ce'
         then 'Input and output formats set to XML and Hybrid PDF by migration 0051, from the provider''s convert reference ("XML or hybrid PDF in"); an ordinary PDF is not read, which a business rule now states.'
         else 'Hybrid PDF added to the input and output formats by migration 0051, from GET /v1/formats (cii: a ZUGFeRD / Factur-X PDF) and the Factur-X container it returns.'
       end
  from public.apis where id in ('74ee6b3b-9c7c-4cf6-ac18-03b77a5c26ce', 'cdbcc6ac-ad26-47a5-8497-c308e1296826');

-- ------------------------------------------------------------------ postcondition

do $$
declare unmapped integer;
begin
  select count(*) into unmapped from public.v_unmapped_formats;
  if unmapped <> 0 then
    raise exception '0051 postcondition failed: % format value(s) have no alias.', unmapped;
  end if;
  if (select count(*) from public.apis
       where id in ('74ee6b3b-9c7c-4cf6-ac18-03b77a5c26ce', 'cdbcc6ac-ad26-47a5-8497-c308e1296826')
         and 'Hybrid PDF' = any(input_formats) and 'Hybrid PDF' = any(output_formats)) <> 2 then
    raise exception '0051 postcondition failed: the formats were not set.';
  end if;
end
$$;
