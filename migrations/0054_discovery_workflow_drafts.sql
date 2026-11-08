-- Private, versioned workspaces. Algorithms and the Process JSON contract are unchanged.
begin;
create table public.workspace_draft (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.app_user(id) on delete cascade,
  kind text not null check (kind in ('discovery', 'workflow')),
  source_discovery_id uuid references public.workspace_draft(id) on delete set null,
  revision integer not null default 0 check (revision >= 0),
  title text not null default '' check (length(title) <= 120),
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workspace_draft_owner_recent on public.workspace_draft(owner_id, kind, updated_at desc);
alter table public.workspace_draft enable row level security;
-- Writes go through owner-checked server routes and compare-and-swap revisions.
revoke all on public.workspace_draft from anon, authenticated;
grant all on public.workspace_draft to service_role;

-- Deliberately separate from drafts. Only validated model output is cached;
-- live catalogue matching and technical evidence are never model-cache entries.
create table public.discovery_model_cache (
  owner_id uuid not null references public.app_user(id) on delete cascade,
  cache_key text not null,
  result jsonb not null,
  expires_at timestamptz not null,
  primary key (owner_id, cache_key)
);
alter table public.discovery_model_cache enable row level security;
revoke all on public.discovery_model_cache from anon, authenticated;
grant all on public.discovery_model_cache to service_role;

-- No public reads or browser policies: the application checks draft ownership
-- before retrieving an object with its server credential.
do $$
begin
  -- Plain Postgres rehearsals have no Storage service. Supabase owns this table.
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('workspace-files', 'workspace-files', false, 10485760)
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
  end if;
end
$$;
commit;
