-- 0039  Business rules for Validation APIs and network types for
--       Communication APIs (issue #54).
--
-- At the 3 October 2026 client meeting the client asked for two fields every
-- record of these categories should carry:
--
--   * a Validation API states its business rules: the rule set or the record
--     check it applies. Ten active Validation records had none, including the
--     ESS Schematron API added on 1 October, whose company name was also empty;
--   * a Communication API states its network type, "for example Email or
--     Peppol". Six active records named Peppol; the other 114 said
--     'N/A — direct API', which reads as not recorded. None of them is an
--     e-mail or Peppol channel: 107 submit to or query a tax authority's own
--     platform (KSeF, SEF, Chorus Pro, IRP, myDATA, ...) and 7 call a
--     provider's own platform (SAP Concur, Link4, INFast). The type is
--     recorded as one of 'Peppol', 'Email', 'Tax authority platform' or
--     'Provider platform'.
--
-- Each business rule restates the record's own description or the provider's
-- specification; nothing is added that the source does not say. The ESS rule
-- sets are the six its OpenAPI document lists
-- (https://edi-services.ebxcloud.com/ess-schematron/v3/api-docs/full, read
-- 6 October 2026); the company name follows the provider's site,
-- ebsoftwareservices.com.au, titled "ESS".
--
-- Neither network nor business_rules is a field clear_verification_on_change
-- watches, so verified records stay verified. company_name is, but the ESS
-- record is Published, not Verified: an administrator verifies it in the
-- application, which records who did.
--
-- Every target is pinned to its observed state; the migration aborts rather
-- than overwrite a record that changed since.

-- ------------------------------------------------- Validation: business rules

create temporary table _0039_rules (
  api_id uuid primary key,
  expected_api_name text not null,
  rules text[] not null
) on commit drop;

insert into _0039_rules (api_id, expected_api_name, rules) values
  ('10feb4e1-16d8-4f67-8463-99d44565580d', 'E-Invoicing Schematron Validation API and Online Tool validate', array[
    'AUNZ_PEPPOL_1_0_10',
    'AUNZ_PEPPOL_SB_1_0_10',
    'AUNZ_UBL_1_0_10',
    'FR_EN16931_CII_1_3_14',
    'FR_EN16931_UBL_1_3_14',
    'RO_RO16931_UBL_1_0_8'
  ]),
  ('772b5d5e-11db-495e-a70c-85f4a3028959', 'Peppol Validator API validateInvoice', array[
    'EN 16931 (CEN) business rules',
    'Peppol BIS Billing 3.0 Schematron rules'
  ]),
  ('e180f63b-f8e1-4680-83db-6f2fe0c681f8', 'Chile SII DTE Document Status Query API', array[
    'The DTE must match the SII record exactly: issuer, recipient, document type, folio, date and amount.'
  ]),
  ('3c9c49ae-379b-4079-b154-d84b205bfbf5', 'Ecuador SRI Electronic Document Validation API', array[
    'A digitally signed electronic voucher under the SRI offline scheme (XML 2.32/2.34); RECIBIDA or DEVUELTA with rejection reasons, before the separate authorisation step.'
  ]),
  ('beb87f41-33b3-4823-afd9-d8e2e44c87ea', 'Mexico SAT CFDI Status Query API', array[
    'The CFDI must be registered with SAT under the given issuer RFC, receiver RFC, total and UUID; returns its status, cancellability and cancellation status.'
  ]),
  ('e0f9f9a6-68f7-406c-ac7e-cef54fee8a63', 'Hungary NAV Online Invoice Validity Check API v3', array[
    'The invoice number must exist as a valid invoice in NAV; only a party to the invoice may query it.'
  ]),
  ('6ee75c97-2b06-462d-86d3-e26a5af1ba99', 'Peru SUNAT Validate CPE by Criteria API', array[
    'The CPE must be registered with SUNAT with a matching issuer, voucher identity, recipient, date and amount, and authorisation data when given.'
  ]),
  ('47dd1ba1-50f6-491d-8630-74c390728802', 'Peru SUNAT Validate CPE File API', array[
    'SUNAT electronic payment voucher (CPE) rules for a UBL 2.1 file; returns a status or validation report without issuing the voucher.'
  ]),
  ('51159b5c-b30b-45bf-9e36-c630d4a95120', 'Taiwan MOF Invoice Header Query API', array[
    'The invoice must exist on the MOF e-Invoice platform for the given number and date; returns its summary and current status.'
  ]),
  ('af7f1908-1ed4-4b93-be3d-3a6b4cc32ded', 'Saudi Arabia ZATCA Fatoora Clearance API', array[
    'ZATCA XML Implementation Standard v1.2 (UBL 2.1) validation for a standard invoice, credit note or debit note; on clearance ZATCA applies its cryptographic stamp and QR code.'
  ]);

do $$
declare matched integer;
begin
  select count(*) into matched
    from _0039_rules target
    join public.apis api on api.id = target.api_id
   where api.api_name = target.expected_api_name
     and api.category = 'Validation'
     and api.is_active
     and api.duplicate_of is null
     and cardinality(api.business_rules) = 0;
  if matched <> 10 then
    raise exception '0039 precondition failed: expected 10 active Validation records with no business rules, found %.', matched;
  end if;

  if not exists (
    select 1 from public.apis
     where id = '10feb4e1-16d8-4f67-8463-99d44565580d'
       and coalesce(company_name, '') = ''
       and coalesce(website_url, '') = ''
       and review_status <> 'Verified'
  ) then
    raise exception '0039 precondition failed: the ESS record changed (company, website or review status).';
  end if;
end
$$;

with changed as (
  update public.apis api
     set business_rules = target.rules,
         updated_at = clock_timestamp()
    from _0039_rules target
   where api.id = target.api_id
  returning api.id, api.api_name, api.company_name, target.rules
)
insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select id,
       api_name,
       coalesce(company_name, ''),
       'edit',
       'System migration',
       null,
       jsonb_build_object(
         'type', 'business_rules_filled',
         'issue', 54,
         'requested', '2026-10-03 client meeting',
         'fields', jsonb_build_object('business_rules', jsonb_build_object('from', '[]'::jsonb, 'to', to_jsonb(rules))),
         'summary', 'Business rules recorded from the record''s description or the provider''s specification.'
       )::text
  from changed;

with changed as (
  update public.apis
     set company_name = 'EB Software Services (ESS)',
         website_url = 'https://www.ebsoftwareservices.com.au/',
         invoice_standard = array['Peppol BIS Billing 3.0', 'EN 16931', 'UBL 2.1', 'UN/CEFACT CII'],
         invoice_standard_source = 'confirmed',
         updated_at = clock_timestamp()
   where id = '10feb4e1-16d8-4f67-8463-99d44565580d'
  returning id, api_name, company_name
)
insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select id,
       api_name,
       company_name,
       'edit',
       'System migration',
       null,
       jsonb_build_object(
         'type', 'provider_details_filled',
         'issue', 54,
         'fields', jsonb_build_object(
           'company_name', jsonb_build_object('from', '', 'to', 'EB Software Services (ESS)'),
           'website_url', jsonb_build_object('from', '', 'to', 'https://www.ebsoftwareservices.com.au/'),
           'invoice_standard', jsonb_build_object('from', '[]'::jsonb, 'to', jsonb_build_array('Peppol BIS Billing 3.0', 'EN 16931', 'UBL 2.1', 'UN/CEFACT CII'))
         ),
         'summary', 'Provider and invoice standards from the ESS OpenAPI document and site: A-NZ Peppol BIS Billing 3.0, French EN 16931 (UBL and CII) and Romanian RO16931 (UBL) rule sets. Verification is left to an administrator.'
       )::text
  from changed;

-- --------------------------------------------- Communication: network types

create temporary table _0039_provider_platform (
  api_id uuid primary key
) on commit drop;

insert into _0039_provider_platform (api_id)
select id
  from public.apis
 where is_active
   and duplicate_of is null
   and category = 'Communication'
   and network = 'N/A — direct API'
   and company_name in ('SAP', 'Link4', 'Intia Dev Team');

do $$
declare
  na_total integer;
  providers integer;
begin
  select count(*) into na_total
    from public.apis
   where is_active and duplicate_of is null and category = 'Communication'
     and network = 'N/A — direct API';
  select count(*) into providers from _0039_provider_platform;
  if na_total <> 114 or providers <> 7 then
    raise exception '0039 precondition failed: expected 114 Communication records with N/A network, 7 of them provider platforms; found % and %.', na_total, providers;
  end if;
end
$$;

with changed as (
  update public.apis api
     set network = case when provider.api_id is null then 'Tax authority platform' else 'Provider platform' end,
         updated_at = clock_timestamp()
    from public.apis before_update
    left join _0039_provider_platform provider on provider.api_id = before_update.id
   where api.id = before_update.id
     and before_update.is_active
     and before_update.duplicate_of is null
     and before_update.category = 'Communication'
     and before_update.network = 'N/A — direct API'
  returning api.id, api.api_name, api.company_name, api.network
)
insert into public.api_audit_events (
  api_id, api_name, company_name, action, actor_name, actor_user_id, details
)
select id,
       api_name,
       coalesce(company_name, ''),
       'edit',
       'System migration',
       null,
       jsonb_build_object(
         'type', 'network_type_filled',
         'issue', 54,
         'requested', '2026-10-03 client meeting',
         'fields', jsonb_build_object('network', jsonb_build_object('from', 'N/A — direct API', 'to', network)),
         'summary', 'Network type recorded as one of Peppol, Email, Tax authority platform or Provider platform.'
       )::text
  from changed;

-- -------------------------------------------------------------- postcondition

do $$
declare
  missing_rules integer;
  missing_network integer;
begin
  select count(*) into missing_rules
    from public.apis
   where is_active and duplicate_of is null and category = 'Validation'
     and cardinality(business_rules) = 0;
  select count(*) into missing_network
    from public.apis
   where is_active and duplicate_of is null and category = 'Communication'
     and network not in ('Peppol', 'Peppol / InvoiceNow', 'Email', 'Tax authority platform', 'Provider platform');
  if missing_rules <> 0 or missing_network <> 0 then
    raise exception '0039 postcondition failed: % Validation record(s) without rules, % Communication record(s) without a network type.', missing_rules, missing_network;
  end if;
end
$$;
