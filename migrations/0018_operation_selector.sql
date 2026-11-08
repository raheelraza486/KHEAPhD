-- 0018  What tells two records on one endpoint apart
--
-- 0007 made an operation's identity (api_endpoint, http_method), and said why:
-- an endpoint alone does not identify an operation. 0008 built the import's
-- uniqueness on the same idea, as (documentation_url, api_endpoint,
-- http_method), and its comment records the known consequence -- filling
-- http_method on a record that collides with another is refused, so that the
-- duplicate gets resolved before the column is filled.
--
-- Four providers in the live catalogue break that model, and none of them is a
-- duplicate:
--
--   * Taiwan's MOF platform answers eight operations at four URLs. Which one
--     runs is decided by an `action` field in the form body -- qryInvHeader,
--     qryInvDetail, carrierInvChk -- and the specification states the value
--     for each.
--   * Malaysia's MyInvois and Egypt's ETA both document *cancel* and *reject*
--     as one operation, PUT /documents/state/{uuid}/state, differing only by
--     `status` being "cancelled" or "rejected". Each has its own
--     documentation page saying which.
--   * The 31 SOAP records answer every operation at one address over POST;
--     the operation is the element inside soap:Body, and usually a SOAPAction
--     header as well.
--   * Mexico's SolicitaDescargaService exposes three near-identical
--     operations at one address.
--
-- For all of these, (documentation_url, api_endpoint, http_method) is not an
-- identity, and the consequences were visible in three separate places:
-- http_method could not be filled for 43 records whose documents plainly
-- state it; v_duplicate_candidates reported nothing at all, because it
-- requires http_method to be known, so the one *genuine* duplicate pair in
-- the catalogue (Malaysia's, and Egypt's) stayed invisible; and two records
-- describing different operations held byte-identical schemas with nothing to
-- say why.
--
-- What was missing is the discriminator itself. This migration adds it as a
-- column, puts it into the import identity, and lets the duplicate view use
-- it. A record with no selector behaves exactly as before.
--
-- Deliberately not done: guessing selectors. The column is filled only from a
-- provider's own document, one record at a time, which is why it is nullable
-- and why the view treats "both unknown" as a duplicate candidate rather than
-- as distinct.

-- ------------------------------------------------------- operation_selector

alter table public.apis
  add column if not exists operation_selector text;

comment on column public.apis.operation_selector is
  'What picks this operation out of the others at the same endpoint and
   method, written as name=value exactly as the provider''s document states
   it: action=qryInvHeader, status=cancelled,
   SOAPAction=http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync.
   Null means the endpoint and method identify the operation on their own, or
   that nothing is known yet -- never that the records are the same.';

alter table public.apis
  drop constraint if exists apis_operation_selector_shape;

-- name=value, with a value. An empty string would be a third state meaning
-- the same as null, which is what this rejects.
alter table public.apis
  add constraint apis_operation_selector_shape
  check (operation_selector is null
         or operation_selector ~ '^[A-Za-z_][A-Za-z0-9_.:-]*=.+$');

-- ---------------------------------------------------------- import identity

-- Same identity as 0008, plus the selector. coalesce keeps the null case
-- behaving as it did: two records with no selector still collide.
drop index if exists apis_import_identity_idx;

create unique index apis_import_identity_idx
  on public.apis (documentation_url, api_endpoint, http_method,
                  coalesce(operation_selector, ''))
  where http_method is not null;

-- ------------------------------------------------------------------- view

-- Records that agree on endpoint, on method and on what distinguishes them --
-- which, when neither states a selector, means nothing distinguishes them.
--
-- 0007 required http_method to be known and said an empty view was the honest
-- state. It is not any longer: with the selector in play, the noise that the
-- requirement was guarding against is gone (the SOAP records at one address
-- differ by selector and are no longer reported), and the pairs left are the
-- ones a person should actually look at.
create or replace view public.v_duplicate_candidates as
  select a.id as candidate_id, b.id as other_id,
         a.company_name, a.api_name as candidate_name, b.api_name as other_name,
         a.api_endpoint, a.http_method, a.operation_selector,
         -- Whether the stored schemas agree as well. A pair that agrees here
         -- is one operation held twice; a pair that does not may still be two
         -- records of one operation, described differently.
         exists (
           select 1
             from public.api_schema sa
             join public.api_schema sb
               on sa.direction = sb.direction
              and sa.content_hash is not null
              and sa.content_hash = sb.content_hash
            where sa.api_id = a.id and sb.api_id = b.id
         ) as same_stored_schema
    from public.apis a
    join public.apis b
      on a.api_endpoint = b.api_endpoint
     and a.http_method is not distinct from b.http_method
     and a.operation_selector is not distinct from b.operation_selector
     and a.id < b.id
   where a.is_active and b.is_active
     and a.api_endpoint <> ''
     and a.duplicate_of is null and b.duplicate_of is null;

comment on view public.v_duplicate_candidates is
  'Records agreeing on endpoint, method and operation_selector, for a person
   to judge. It proposes; it never sets duplicate_of. same_stored_schema says
   whether their stored schemas agree too. Detection by name similarity is
   deliberately absent -- see the header of 0007.';

grant select on public.v_duplicate_candidates to authenticated;
