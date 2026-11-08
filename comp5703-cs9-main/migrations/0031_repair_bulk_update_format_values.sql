-- Repair format values the administrator bulk update wrote in a broken shape.
--
-- Three separate problems, found by v_unmapped_formats, which 0004 created for
-- exactly this and which was reporting all of them:
--
--   format_value    records
--   null              38     the four-character string 'null'
--   JSON, XML          6     several formats joined by a comma in ONE element
--   JSON, PDF          3     the same
--   PDF, XML, ZIP      1     the same
--   NULL               1     the string 'NULL'
--   ZIP                3     a real format with no alias row -- see below
--
-- 1. 'null' and 'NULL' are not formats. The audit for those 38 records says
--    {"type": "admin_metadata_bulk_update", "fields": ["input_formats"]}, so
--    the update deliberately targeted the column and the writer serialised an
--    absent value as the string instead of writing an empty array. The column
--    is `not null default '{}'`, so an empty array is this schema's own way of
--    saying nothing is stated, and that is what those elements become.
--
--    Consequence worth stating: 38 records will then declare no input format,
--    so the compatibility format gate cannot pass them -- which is already
--    true today, because 'null' matches nothing either. This migration makes
--    the representation honest, it does not change what can be decided.
--
--    It deliberately does NOT re-derive the formats. api_schema.media_type
--    holds `application/json` for many of these records, so the evidence for
--    a real value exists; using it is a separate decision about what the
--    catalogue's directional format fields mean, and it belongs with whoever
--    owns the bulk-update workflow rather than in a repair.
--
-- 2. A comma-joined element cannot match anything either: the gate compares
--    whole elements, so 'JSON, XML' is neither JSON nor XML. Split on commas.
--
-- 3. ZIP is a real format -- Mexico SAT returns a ZIP package -- and only
--    lacks an alias row, which is why v_unmapped_formats listed it beside the
--    genuine defects. Added, following 0004's and 0021's pattern.
--
-- `*_original` is never touched: it is what the client's import supplied.
--
-- This updates input_formats and output_formats, which migration 0023 treats
-- as verification-covered, so its trigger will clear any verification on the
-- rows it touches. Nothing is lost: 0029 has already returned every record to
-- 'Published' with no verification.

-- ---------------------------------------------------------------- 3. the alias
insert into public.format_alias (alias, canonical)
values ('ZIP', 'ZIP')
on conflict (alias) do nothing;

-- ------------------------------------------------- 1 and 2. the broken values
--
-- One pass per column. unnest → split → trim → drop the placeholders →
-- array_agg, keeping the document's own order and dropping duplicates only
-- where splitting produced them.
with repaired as (
  select a.id,
         coalesce((
           select array_agg(distinct piece order by piece)
             from (
               select btrim(piece) as piece
                 from unnest(a.input_formats) element,
                      unnest(string_to_array(element, ',')) piece
             ) parts
            where btrim(piece) <> ''
              and lower(btrim(piece)) <> 'null'
         ), '{}'::text[]) as input_repaired
    from public.apis a
   where exists (
           select 1 from unnest(a.input_formats) f
            where f like '%,%' or lower(btrim(f)) = 'null' or btrim(f) = ''
         )
)
update public.apis a
   set input_formats = repaired.input_repaired
  from repaired
 where a.id = repaired.id
   and a.input_formats is distinct from repaired.input_repaired;

with repaired as (
  select a.id,
         coalesce((
           select array_agg(distinct piece order by piece)
             from (
               select btrim(piece) as piece
                 from unnest(a.output_formats) element,
                      unnest(string_to_array(element, ',')) piece
             ) parts
            where btrim(piece) <> ''
              and lower(btrim(piece)) <> 'null'
         ), '{}'::text[]) as output_repaired
    from public.apis a
   where exists (
           select 1 from unnest(a.output_formats) f
            where f like '%,%' or lower(btrim(f)) = 'null' or btrim(f) = ''
         )
)
update public.apis a
   set output_formats = repaired.output_repaired
  from repaired
 where a.id = repaired.id
   and a.output_formats is distinct from repaired.output_repaired;

-- Every remaining value must be one the alias table knows, or the format gate
-- silently cannot match it -- the failure this migration exists to repair.
do $$
declare unmapped text;
begin
  select string_agg(format_value || ' (' || records || ')', ', ')
    into unmapped
    from public.v_unmapped_formats;
  if unmapped is not null then
    raise exception 'format values with no alias row remain: %', unmapped;
  end if;
end
$$;
