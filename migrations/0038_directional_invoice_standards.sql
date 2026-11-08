-- An operation can accept and produce different invoice standards. A provider
-- claim is useful for discovery, but cannot establish compatibility until an
-- administrator checks evidence. The old apis.invoice_standard array remains
-- as legacy catalogue metadata; it is not silently split into directions.

create table if not exists public.api_invoice_standard_capability (
  id uuid primary key default gen_random_uuid(),
  api_id uuid not null references public.apis(id) on delete cascade,
  direction text not null check (direction in ('input', 'output')),
  standard text not null check (length(btrim(standard)) between 2 and 120),
  version text not null check (length(btrim(version)) between 1 and 80),
  profile text not null default '' check (length(profile) <= 120),
  condition text not null default '' check (length(condition) <= 500),
  status text not null default 'reported' check (status in ('reported', 'confirmed', 'rejected')),
  evidence_url text not null default '' check (length(evidence_url) <= 2000),
  evidence_note text not null default '' check (length(evidence_note) <= 2000),
  submitted_by uuid references public.app_user(id),
  reviewed_by uuid references public.app_user(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capability_confirmation_evidence check (
    status <> 'confirmed' or
    (evidence_url ~* '^https?://[^[:space:]]+$' and reviewed_by is not null and reviewed_at is not null)
  )
);

create index if not exists api_invoice_standard_capability_api_idx
  on public.api_invoice_standard_capability(api_id, direction, status);

drop trigger if exists set_api_invoice_standard_capability_updated_at on public.api_invoice_standard_capability;
create trigger set_api_invoice_standard_capability_updated_at
before update on public.api_invoice_standard_capability
for each row execute function public.set_updated_at();

alter table public.api_invoice_standard_capability enable row level security;
revoke all on public.api_invoice_standard_capability from public, anon, authenticated;
grant select, insert, update on public.api_invoice_standard_capability to service_role;

comment on table public.api_invoice_standard_capability is
  'Directional, versioned invoice-standard claims for one API operation. Reported claims never become confirmed merely because they were entered manually; admin review with a source is required. A version of the API service itself does not belong here.';
