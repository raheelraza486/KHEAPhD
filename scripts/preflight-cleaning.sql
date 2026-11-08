-- Read-only pre-flight for 0004_normalise_reference_data.sql
--
-- Run this BEFORE applying 0004, so it deliberately does not depend on the
-- tables that 0004 creates. The provider mappings are inlined below and must be
-- kept in step with the ones in the migration.
--
-- It reads and changes nothing.
--
--   set -a && . ./.env && set +a
--   psql "$DATABASE_URL" -f scripts/preflight-cleaning.sql
--
-- Two empty result sets mean 0004 will apply cleanly.

\echo '--- 1. Collisions that would make 0004 fail ---'
\echo '    (normalising a company name can make two records collide on the'
\echo '     unique index over lower(company_name), lower(api_name))'
\echo ''

with alias(alias, canonical) as (
  values ('ECOSIO','Ecosio'), ('Ecosio GmbH','Ecosio'),
         ('StoreCove','Storecove'), ('Storecove','Storecove'),
         ('Ezzy Bills','EzzyBills'), ('EzzyBills','EzzyBills')
),
resolved as (
  select lower(coalesce(al.canonical, a.company_name)) as company_key,
         lower(a.api_name)                             as api_key,
         a.company_name
    from public.apis a
    left join alias al on al.alias = a.company_name
)
select company_key,
       api_key,
       count(*)                        as records,
       string_agg(distinct company_name, ' | ') as spellings_involved
  from resolved
 group by company_key, api_key
having count(*) > 1
 order by count(*) desc, company_key;

\echo ''
\echo '--- 2. Every format spelling in the data, with its record count ---'
\echo '    (used to seed format_alias; anything unexpected needs a decision)'
\echo ''

select f as format_value, count(*) as records
  from public.apis
  cross join lateral unnest(coalesce(input_formats,'{}') || coalesce(output_formats,'{}')) as f
 where f is not null and btrim(f) <> ''
 group by f
 order by count(*) desc, f;

\echo ''
\echo '--- 3. Company name spellings ---'
\echo ''

select company_name, count(*) as records
  from public.apis
 group by company_name
 order by lower(company_name);

\echo ''
\echo '--- 4. Records 0004 would flag ---'
\echo ''

select count(*) filter (where api_endpoint ~* '://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|/|$)')
         as would_be_restricted,
       count(*) filter (where documentation_url ~* '(^|\.)example\.(com|net|org)(/|$|:)'
                           or source_url        ~* '(^|\.)example\.(com|net|org)(/|$|:)')
         as unreachable_documentation
  from public.apis;
