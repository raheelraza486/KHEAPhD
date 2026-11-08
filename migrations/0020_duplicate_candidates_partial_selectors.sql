-- 0020  The duplicate view must see a record that has not been described yet
--
-- 0018 added operation_selector and had v_duplicate_candidates compare it with
-- `is not distinct from`, so two records at one endpoint and method are
-- reported only when their selectors agree, or when neither has one.
--
-- That leaves out the shape which is actually dangerous. Consider a service
-- with five SOAP operations at one address, four of them carrying a SOAPAction
-- and a fifth added later whose discriminator nobody has recorded yet:
--
--   POST .../WcfDianCustomerServices.svc   SOAPAction=.../SendBillSync
--   POST .../WcfDianCustomerServices.svc   (nothing recorded)
--
-- Those two differ under `is not distinct from`, so the view stays silent --
-- and the second record may well *be* the first one, entered twice. Nothing
-- in the catalogue says otherwise, which is precisely the condition this view
-- exists to surface.
--
-- The mixture is not forbidden, and deliberately so: a trigger banning it
-- would make it impossible to record a record whose selector is not yet known
-- at an address where others are, which is a normal state of partial
-- knowledge. What is wrong is not the mixture; it is the mixture going
-- unreported.
--
-- So the rule becomes: a pair is a candidate unless BOTH records state a
-- selector AND the two selectors differ. `selector_state` says which of the
-- three cases a reported pair is, because they need different work -- one
-- needs a decision, the other needs somebody to write down a value that the
-- provider's document already states.

-- Dropped and recreated rather than replaced: `create or replace view`
-- cannot add a column before an existing one, and the two new selector
-- columns belong beside the one they explain.
drop view if exists public.v_duplicate_candidates;

create view public.v_duplicate_candidates as
  select a.id as candidate_id, b.id as other_id,
         a.company_name, a.api_name as candidate_name, b.api_name as other_name,
         a.api_endpoint, a.http_method,
         a.operation_selector,
         b.operation_selector as other_operation_selector,
         case
           when a.operation_selector is null and b.operation_selector is null
             then 'neither states one'
           when a.operation_selector is null or b.operation_selector is null
             then 'one states one, the other does not'
           else 'both state the same one'
         end as selector_state,
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
     and a.id < b.id
   where a.is_active and b.is_active
     and a.api_endpoint <> ''
     and a.duplicate_of is null and b.duplicate_of is null
     -- Not a candidate only when both sides say what they are, differently.
     and not (a.operation_selector is not null
              and b.operation_selector is not null
              and a.operation_selector <> b.operation_selector);

comment on view public.v_duplicate_candidates is
  'Records at one endpoint and method that nothing tells apart, for a person to
   judge. selector_state says why each pair is here: neither states a selector,
   or one does and the other has not been described yet. A pair whose two
   selectors differ is not reported -- those are distinct operations.
   same_stored_schema says whether their stored schemas agree too. It proposes;
   it never sets duplicate_of. Detection by name similarity is deliberately
   absent -- see the header of 0007.';

grant select on public.v_duplicate_candidates to authenticated;
