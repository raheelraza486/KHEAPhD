-- 0021  Two media types the format table never learned
--
-- 0004 built format_alias so that a spelling found in the data is mapped once,
-- in one place, rather than records being edited by hand -- and v_unmapped_formats
-- to show the spellings it has not learned yet. That view has been reporting
-- two of them ever since:
--
--   application/json                    44 records
--   application/x-www-form-urlencoded    1 record
--
-- These are media types, written where the catalogue wants a format name. The
-- comparison engine has been reading them correctly all along -- its token
-- rule matches anything containing "json" -- so no verdict was wrong. What is
-- wrong is the data: 44 records say `application/json` and 140 say `JSON` for
-- the same thing, and a person filtering or grouping on the column gets two
-- answers.
--
-- Mapped, not edited by hand, and applied the same way 0004 applied its own:
-- input_formats and output_formats take the canonical spelling and
-- input_formats_original / output_formats_original keep what the import
-- supplied, so nothing about the client's data is lost.
--
-- Not mapped here: the eight records reading `Form URL encoded`, which is
-- already the canonical name 0004 chose for that family.

insert into public.format_alias (alias, canonical, note) values
  ('application/json',                  'JSON',
   'media type written where a format name belongs; same format'),
  ('application/x-www-form-urlencoded', 'Form URL encoded',
   'media type written where a format name belongs; same format')
on conflict (alias) do nothing;

-- ------------------------------------------------------------- apply mappings

update public.apis a
   set input_formats = mapped.formats
  from (
    select a2.id,
           array_agg(distinct coalesce(fa.canonical, f) order by coalesce(fa.canonical, f)) as formats
      from public.apis a2
      cross join lateral unnest(a2.input_formats) as f
      left join public.format_alias fa on fa.alias = f
     group by a2.id
  ) as mapped
 where mapped.id = a.id
   and a.input_formats is distinct from mapped.formats;

update public.apis a
   set output_formats = mapped.formats
  from (
    select a2.id,
           array_agg(distinct coalesce(fa.canonical, f) order by coalesce(fa.canonical, f)) as formats
      from public.apis a2
      cross join lateral unnest(a2.output_formats) as f
      left join public.format_alias fa on fa.alias = f
     group by a2.id
  ) as mapped
 where mapped.id = a.id
   and a.output_formats is distinct from mapped.formats;
