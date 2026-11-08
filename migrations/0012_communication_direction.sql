-- Split the Communication capability by business direction while preserving
-- Communication as the catalogue's top-level category.
--
-- Direction is stated from the API caller's perspective. Existing records do
-- not contain enough evidence to distinguish Send from Receive, so they are
-- retained honestly as Unspecified rather than inferred from an HTTP method.

alter table public.apis
  add column if not exists communication_direction text not null default '';

update public.apis
set communication_direction = 'Unspecified'
where category = 'Communication'
  and coalesce(communication_direction, '') not in
    ('Send', 'Receive', 'Send and receive', 'Unspecified');

update public.apis
set communication_direction = ''
where category <> 'Communication'
  and coalesce(communication_direction, '') <> '';

update public.apis
set communication_direction = ''
where category <> 'Communication'
  and communication_direction is null;

alter table public.apis
  alter column communication_direction set default '',
  alter column communication_direction set not null;

alter table public.apis
  drop constraint if exists apis_communication_direction_check;

alter table public.apis
  add constraint apis_communication_direction_check
  check (
    (category = 'Communication' and communication_direction in
      ('Send', 'Receive', 'Send and receive', 'Unspecified'))
    or
    (category <> 'Communication' and communication_direction = '')
  );

create index if not exists apis_active_communication_direction_idx
  on public.apis (communication_direction)
  where is_active and category = 'Communication';

comment on column public.apis.communication_direction is
  'Communication subcategory from the API caller business-document perspective: Send, Receive, Send and receive, or Unspecified. Empty for every non-Communication category; HTTP methods are not direction evidence.';
