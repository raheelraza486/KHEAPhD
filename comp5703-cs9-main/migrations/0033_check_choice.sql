-- 0033  Answer history of the BP-Builder compatibility check
--
-- Check item 2.2 (Compatibility Check Manual v1.0 §7.5; Semantic Check Manual
-- v1.0 rules S-8 and step 2.2c) hands two kinds of target field to the page:
-- ambiguous fields (several source candidates) and required fields that were
-- not found. The user picks a candidate, "None of the above" or "Provided
-- externally". Every such answer is one row here, and rows are never updated
-- or deleted: the table is the history, and the check reads the history.
--
-- Per (pair, target field) the check merges the rows into one of three states:
--
--   agreed    every user answer is the same. Applied at once, to everyone who
--             checks that pair afterwards; nobody reviews it.
--   conflict  users disagree, or a user answer disagrees with the automatic
--             match the registry now produces. Nothing is applied; the pair's
--             verdict is 'pending_admin' and the field is listed for an
--             administrator. Users cannot change it any more.
--   resolved  an administrator answered (kind = 'admin'). Final: applied over
--             every user answer and over the registry, until an administrator
--             answers again.
--
-- An answer stops applying when a schema it was given against changes (the
-- content hashes recorded here no longer match); the check reports it as stale
-- and the page asks again.
--
-- The rows are also evidence for the field-semantics registry (Semantic Check
-- Manual §7.6): an administrator running a registration batch reads the view
-- v_registry_candidates below -- aggregated agreed and resolved answers, never
-- individual rows, and never as a queue that has to be emptied. Registering is
-- done in field_semantics.csv (the registry lives with the code); once a name
-- is registered the check no longer asks about it, so it drops out of the
-- view by itself. No status column is needed for that.
--
-- Nothing existing changes. One new table and two views, closed to the browser
-- roles exactly as 0016/0017 close the schema tables: the application's API
-- routes read and write them with the service key. The table starts empty and
-- is never seeded.

create table if not exists public.check_choice (
  id                   uuid primary key default gen_random_uuid(),

  -- The ordered pair the answer belongs to.
  source_api_id        uuid not null references public.apis (id) on delete cascade,
  target_api_id        uuid not null references public.apis (id) on delete cascade,

  -- The target field the page asked about: api_schema_field.path, or the
  -- parameter name for a parameters-only input. target_name_norm is the
  -- normalised leaf name (the registry key) so the views can group by it.
  target_path          text not null,
  target_name_norm     text not null,

  -- 'user'   an answer given in the drop-down
  -- 'admin'  an administrator settling a conflict; final
  kind                 text not null default 'user',

  -- 'candidate'  a source field was chosen (chosen_source_path set)
  -- 'none'       "None of the above": the field has no source in this pair
  -- 'external'   "Provided externally": out-of-chain input, not counted against the pair
  option               text not null,
  chosen_source_path   text,
  chosen_source_norm   text not null default '',

  -- Which schemas the answer was given against.
  source_content_hash  text not null default '',
  target_content_hash  text not null default '',

  chosen_by            uuid references public.app_user (id) on delete set null,
  chosen_at            timestamptz not null default now(),
  note                 text not null default ''
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'check_choice_kind_check') then
    alter table public.check_choice add constraint check_choice_kind_check
      check (kind in ('user', 'admin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'check_choice_option_check') then
    alter table public.check_choice add constraint check_choice_option_check
      check (option in ('candidate', 'none', 'external'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'check_choice_candidate_path_check') then
    alter table public.check_choice add constraint check_choice_candidate_path_check
      check ((option = 'candidate') = (chosen_source_path is not null and chosen_source_path <> ''));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'check_choice_distinct_pair_check') then
    alter table public.check_choice add constraint check_choice_distinct_pair_check
      check (source_api_id <> target_api_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'check_choice_target_path_check') then
    alter table public.check_choice add constraint check_choice_target_path_check
      check (target_path <> '' and target_name_norm <> '');
  end if;
end
$$;

-- History: the same field of the same pair may have any number of rows.
create index if not exists check_choice_pair_field_idx
  on public.check_choice (source_api_id, target_api_id, target_path, chosen_at);

create index if not exists check_choice_name_idx
  on public.check_choice (target_name_norm, chosen_source_norm);

comment on table public.check_choice is
  'Append-only history of the answers given in the compatibility check''s
   drop-downs, one row per answer for one target field of one ordered API
   pair (Compatibility Check Manual v1.0 step 2.2c). The check merges a
   field''s rows into agreed / conflict / resolved; see v_check_choice_current.';
comment on column public.check_choice.kind is
  'user = an answer from the drop-down; admin = an administrator settling a
   conflict, which is final.';
comment on column public.check_choice.option is
  'candidate = a source field was chosen; none = "None of the above";
   external = "Provided externally" (out-of-chain input, not a failure).';
comment on column public.check_choice.source_content_hash is
  'api_schema.content_hash of the source response schema the check compared
   when the answer was given; a different hash at the next check makes the
   answer stale and the page asks again.';

-- ------------------------------------------------- current state per field

-- The merged state of every (pair, target field), as the check computes it
-- from the history. The registry-versus-user comparison is not visible here
-- (it needs the schemas), so a field shown as 'agreed' can still be reported
-- as a conflict by the check; the check's report is authoritative.
create or replace view public.v_check_choice_current as
  with admin_latest as (
    select distinct on (source_api_id, target_api_id, target_path)
           source_api_id, target_api_id, target_path, option, chosen_source_path, chosen_by, chosen_at
      from public.check_choice
     where kind = 'admin'
     order by source_api_id, target_api_id, target_path, chosen_at desc
  ),
  user_agg as (
    select source_api_id, target_api_id, target_path, target_name_norm,
           count(distinct option || '|' || coalesce(chosen_source_path, '')) as distinct_answers,
           count(*)                                                          as answers,
           min(option)                                                       as any_option,
           min(coalesce(chosen_source_path, ''))                             as any_source_path,
           max(chosen_at)                                                    as last_chosen_at
      from public.check_choice
     where kind = 'user'
     group by source_api_id, target_api_id, target_path, target_name_norm
  )
  select u.source_api_id, u.target_api_id, u.target_path, u.target_name_norm,
         case when a.chosen_at is not null then 'resolved'
              when u.distinct_answers = 1 then 'agreed'
              else 'conflict' end                                                     as state,
         coalesce(a.option, case when u.distinct_answers = 1 then u.any_option end)  as option,
         coalesce(a.chosen_source_path,
                  case when u.distinct_answers = 1 and u.any_source_path <> '' then u.any_source_path end)
                                                                                     as chosen_source_path,
         u.answers, u.distinct_answers, u.last_chosen_at,
         a.chosen_by as resolved_by, a.chosen_at as resolved_at
    from user_agg u
    left join admin_latest a
      on a.source_api_id = u.source_api_id and a.target_api_id = u.target_api_id and a.target_path = u.target_path;

comment on view public.v_check_choice_current is
  'One row per (pair, target field) with the state the history merges to:
   agreed (users concur), conflict (users disagree, no administrator answer
   yet -- the administrator''s work list), resolved (administrator answered).';

-- --------------------------------------------------- registration evidence

-- What an administrator looks at when running a registration batch
-- (Semantic Check Manual §7.6): each combination of target name and applied
-- answer, with how many pairs and how many different people chose it. Only
-- agreed and resolved answers count; conflicts do not. The batch rule is a
-- threshold on these counts (v1.0: at least 3 pairs or at least 2 people).
-- 'external' and 'none' answers are grouped too: a target name mostly
-- answered 'external' is evidence that no source is expected to supply it,
-- which is input for Check 0 rather than for the registry.
create or replace view public.v_registry_candidates as
  select cur.target_name_norm,
         cur.option,
         coalesce(lower(regexp_replace(cur.chosen_source_path, '.*[.]', '')), '') as chosen_source_norm,
         count(*)                                                                as pairs,
         count(distinct c.chosen_by)                                             as people,
         count(distinct t.company_name)                                          as target_vendors,
         count(distinct s.company_name)                                          as source_vendors,
         min(cur.last_chosen_at)                                                 as first_chosen_at,
         max(cur.last_chosen_at)                                                 as last_chosen_at,
         array_agg(distinct cur.target_path)                                     as target_paths,
         array_agg(distinct cur.chosen_source_path)
           filter (where cur.chosen_source_path is not null)                     as source_paths
    from public.v_check_choice_current cur
    join public.check_choice c
      on c.source_api_id = cur.source_api_id and c.target_api_id = cur.target_api_id and c.target_path = cur.target_path
    join public.apis s on s.id = cur.source_api_id
    join public.apis t on t.id = cur.target_api_id
   where cur.state in ('agreed', 'resolved')
   group by cur.target_name_norm, cur.option, coalesce(lower(regexp_replace(cur.chosen_source_path, '.*[.]', '')), '');

comment on view public.v_registry_candidates is
  'Aggregated agreed and resolved answers, one row per (target name, answer,
   chosen source name), for registration batches of the field-semantics
   registry. Read only when maintaining the registry; nothing to process or
   clear.';

-- Closed to the public roles exactly as 0016/0017 close the schema tables:
-- read and written through the application's own API routes, never straight
-- from the browser. The service key the server holds is unaffected.
alter table public.check_choice enable row level security;
revoke all on table public.check_choice from anon, authenticated;
revoke all on public.v_check_choice_current from anon, authenticated;
revoke all on public.v_registry_candidates from anon, authenticated;
