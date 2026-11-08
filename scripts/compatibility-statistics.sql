-- Compatibility statistics with media-type variants counted once.
--
-- api_schema intentionally stores one physical row per media type. When the
-- provider publishes the same schema under several media types, those rows
-- must remain available to format negotiation. Reporting, however, uses one
-- representative for each (API, direction, status, content) tuple so schema,
-- field, and field-name occurrence totals are not inflated.
--
-- This file is read-only: it never deletes or updates api_schema rows.

begin transaction read only;

-- Physical catalogue rows versus logical definitions used in reports.
with ranked_schema as (
  select schema_row.*,
         row_number() over (
           partition by
             schema_row.api_id,
             schema_row.direction,
             coalesce(schema_row.status_code, ''),
             coalesce(schema_row.content_hash, 'schema-id:' || schema_row.id::text)
           order by schema_row.media_type, schema_row.id
         ) as reporting_rank
    from public.api_schema schema_row
),
logical_schema as (
  select * from ranked_schema where reporting_rank = 1
)
select
  (select count(*) from public.api_schema) as physical_schema_rows,
  (select count(*) from logical_schema) as logical_schema_definitions,
  (select count(*) from public.api_schema) - (select count(*) from logical_schema)
    as media_type_variant_rows_excluded_from_statistics,
  (select count(*) from public.api_schema_field) as physical_schema_field_rows,
  (select count(*)
     from public.api_schema_field field_row
     join logical_schema schema_row on schema_row.id = field_row.schema_id)
    as logical_schema_field_occurrences;

-- Breakdown used by the compatibility manuals.
with ranked_schema as (
  select schema_row.*,
         row_number() over (
           partition by
             schema_row.api_id,
             schema_row.direction,
             coalesce(schema_row.status_code, ''),
             coalesce(schema_row.content_hash, 'schema-id:' || schema_row.id::text)
           order by schema_row.media_type, schema_row.id
         ) as reporting_rank
    from public.api_schema schema_row
),
logical_schema as (
  select * from ranked_schema where reporting_rank = 1
)
select
  schema_row.direction,
  count(distinct schema_row.id) as logical_schemas,
  count(field_row.id) as logical_field_occurrences
  from logical_schema schema_row
  left join public.api_schema_field field_row on field_row.schema_id = schema_row.id
 group by schema_row.direction
 order by schema_row.direction;

-- Source rows for refreshing field_semantics.csv occurrence evidence. Schema
-- fields use the logical representatives above; parameters are already one
-- row per operation/location/name and are therefore included as stored.
with ranked_schema as (
  select schema_row.*,
         row_number() over (
           partition by
             schema_row.api_id,
             schema_row.direction,
             coalesce(schema_row.status_code, ''),
             coalesce(schema_row.content_hash, 'schema-id:' || schema_row.id::text)
           order by schema_row.media_type, schema_row.id
         ) as reporting_rank
    from public.api_schema schema_row
),
logical_schema as (
  select * from ranked_schema where reporting_rank = 1
),
occurrence_row as (
  select field_row.leaf_name_norm as normalized_name,
         field_row.leaf_name as original_spelling,
         api.company_name as vendor
    from logical_schema schema_row
    join public.api_schema_field field_row on field_row.schema_id = schema_row.id
    join public.apis api on api.id = schema_row.api_id
  union all
  select coalesce(
           nullif(parameter_row.name_norm, ''),
           regexp_replace(lower(parameter_row.name), '[^a-z0-9]', '', 'g')
         ) as normalized_name,
         parameter_row.name as original_spelling,
         api.company_name as vendor
    from public.api_parameter parameter_row
    join public.apis api on api.id = parameter_row.api_id
),
spelling_count as (
  select normalized_name, original_spelling, count(*) as occurrences
    from occurrence_row
   group by normalized_name, original_spelling
),
name_total as (
  select normalized_name, count(*) as occurrences
    from occurrence_row
   group by normalized_name
),
spellings as (
  select normalized_name,
         string_agg(
           format('%s (%s)', original_spelling, occurrences),
           '|' order by occurrences desc, original_spelling
         ) as original_spellings
    from spelling_count
   group by normalized_name
),
vendors as (
  select normalized_name,
         string_agg(distinct vendor, '|' order by vendor) as vendors
    from occurrence_row
   group by normalized_name
)
select total.normalized_name,
       total.occurrences,
       spellings.original_spellings,
       vendors.vendors
  from name_total total
  join spellings using (normalized_name)
  join vendors using (normalized_name)
 order by total.normalized_name;

commit;
