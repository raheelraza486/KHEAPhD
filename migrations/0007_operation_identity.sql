-- Give an operation an identity, and give a duplicate somewhere to point
--
-- Two gaps the existing data made visible.
--
-- First, a URL does not identify an operation. Ten groups of records share a
-- complete endpoint and are told apart only by wording inside api_name:
--
--   https://vpfe.dian.gov.co/WcfDianCustomerServices.svc        5 operations
--   https://api.einvoice.nat.gov.tw/PB2CAPIVAN/invapp/InvApp    3 operations
--   https://servicos.portaldasfinancas.gov.pt:423/.../ws/       3 operations
--
-- These are SOAP services and action-parameter APIs: one address, many
-- operations. OpenAPI keys an operation by path *and* method, so without a
-- method column an imported document cannot say that GET /invoices and POST
-- /invoices are two different records.
--
-- Second, there is nowhere to record that one record duplicates another. Two
-- rows cannot share a primary key -- that is what a primary key means -- so a
-- duplicate keeps its own identity and points at the record it duplicates.
-- Nothing is deleted and the judgement is reversible.
--
-- What this deliberately does NOT add is duplicate detection by name
-- similarity. It was measured against this data and it does not work:
--
--   Kenya Revenue Authority (KRA)   vs Rwanda Revenue Authority (RRA)   0.54
--   Rwanda Revenue Authority (RRA)  vs Zambia Revenue Authority (ZRA)   0.53
--   Chile Internal Revenue Service  vs Ecuador Internal Revenue Service 0.56
--
-- Every pair above scores as a near-match and every pair is three different
-- countries' tax authorities. In this domain names are structurally alike
-- because the institutions are alike, so similarity measures naming convention
-- rather than identity, and a threshold high enough to catch real variants
-- would merge national revenue authorities. It would also look entirely
-- plausible afterwards, which is what makes it dangerous.
--
-- The variants that did exist -- Ecosio GmbH, ECOSIO, StoreCove -- were
-- normalised in 0004, no domain now maps to more than one company name, and
-- the (company_name, api_name) unique key has no violations.

-- ------------------------------------------------------------------ method

alter table public.apis
  add column if not exists http_method text;

alter table public.apis drop constraint if exists apis_http_method_check;
alter table public.apis add constraint apis_http_method_check
  check (http_method is null or http_method in
    ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE'));

comment on column public.apis.http_method is
  'The HTTP method this record''s operation uses. Null on every record that
   predates OpenAPI import: it is left empty rather than guessed, because a
   SOAP service is reached by POST while the operation it performs may be a
   read, and inferring one from the other would put a wrong fact in the
   repository. Import fills it; a person fills the rest.';

-- ------------------------------------------------------------------ duplicates

alter table public.apis
  add column if not exists duplicate_of uuid;

alter table public.apis drop constraint if exists apis_duplicate_of_fkey;
alter table public.apis add constraint apis_duplicate_of_fkey
  foreign key (duplicate_of) references public.apis (id) on delete set null;

alter table public.apis drop constraint if exists apis_duplicate_not_self;
alter table public.apis add constraint apis_duplicate_not_self
  check (duplicate_of is null or duplicate_of <> id);

comment on column public.apis.duplicate_of is
  'Set when this record duplicates another. The row keeps its own id and its
   own history; it is hidden from the catalogue and kept in the table, so the
   judgement can be undone. Never a chain -- it points at the record that is
   kept, which must not itself be a duplicate.';

create index if not exists apis_duplicate_of_idx
  on public.apis (duplicate_of) where duplicate_of is not null;

-- A duplicate must point at a record that is kept, not at another duplicate.
-- Chains make "which one is canonical" unanswerable without walking the graph.
create or replace function public.check_duplicate_target()
returns trigger language plpgsql as $$
begin
  if new.duplicate_of is not null then
    if exists (select 1 from public.apis
                where id = new.duplicate_of and duplicate_of is not null) then
      raise exception
        'duplicate_of must point at a record that is kept, but % is itself a duplicate',
        new.duplicate_of;
    end if;
    if exists (select 1 from public.apis
                where duplicate_of = new.id) then
      raise exception
        'record % is already the target of another duplicate and cannot become one itself',
        new.id;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists apis_duplicate_target on public.apis;
create trigger apis_duplicate_target
  before insert or update of duplicate_of on public.apis
  for each row execute function public.check_duplicate_target();

-- ------------------------------------------------------------------ views

create or replace view public.v_catalogue as
  select * from public.apis
   where is_active and duplicate_of is null;

comment on view public.v_catalogue is
  'What the catalogue shows: active records that are not duplicates. Reading
   public.apis directly still returns duplicates, which is what an
   administrator reviewing them needs.';

grant select on public.v_catalogue to anon, authenticated;

-- Candidates for a person to judge. Exact agreement on endpoint and method,
-- which is a fact rather than a guess. Empty until http_method is populated,
-- and that is the honest state -- an endpoint alone does not identify an
-- operation, which is the reason this migration exists.
create or replace view public.v_duplicate_candidates as
  select a.id as candidate_id, b.id as other_id,
         a.company_name, a.api_name as candidate_name, b.api_name as other_name,
         a.api_endpoint, a.http_method
    from public.apis a
    join public.apis b
      on a.api_endpoint = b.api_endpoint
     and a.http_method is not distinct from b.http_method
     and a.id < b.id
   where a.is_active and b.is_active
     and a.api_endpoint <> ''
     and a.http_method is not null
     and a.duplicate_of is null and b.duplicate_of is null;

comment on view public.v_duplicate_candidates is
  'Records agreeing on both endpoint and method, for a person to judge. It
   proposes; it never sets duplicate_of. Detection by name similarity is
   deliberately absent -- see the header of 0007.';
