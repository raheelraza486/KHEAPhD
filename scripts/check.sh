#!/usr/bin/env bash
# Run this before opening a pull request.
#
# This repository has no continuous integration: Actions is not available on
# github.sydney.edu.au, so nothing runs automatically on push. These checks
# therefore have to be run by hand. The reasoning is in the decision log, which
# lives in the shared project folder on OneDrive rather than in this repository.
#
# Keep this script fast and dependency-light so that running it stays a habit
# rather than a chore. Add a check whenever a class of mistake gets through.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

echo "Shell syntax"
for f in scripts/*.sh; do
  if bash -n "$f" 2>/dev/null; then pass "$f"; else fail "$f"; fi
done

echo "Shell scripts work on macOS bash 3.2"
# Sourcing a process substitution, `. <(...)` or `source <(...)`, reads nothing
# under bash 3.2, which is what /usr/bin/env bash finds on a Mac.
if grep -nE '(^|[;&|({[:space:]])(\.|source)[[:space:]]+<\(' scripts/*.sh; then
  fail "source a variable or a temporary file instead of <(...)"
else
  pass "no script sources a process substitution"
fi

echo "Shell scripts are executable"
for f in scripts/*.sh; do
  if [ -x "$f" ]; then pass "$f"; else fail "$f is not executable (chmod +x)"; fi
done

echo "Compose file"
if [ ! -f .env ]; then
  fail ".env is missing (cp .env.example .env)"
else
  if docker compose config --quiet 2>/dev/null; then
    pass "docker-compose.yml parses and every variable resolves"
  else
    fail "docker compose config rejected the file"
  fi
fi

echo "Migrations"
if [ -d migrations ] && ls migrations/*.sql >/dev/null 2>&1; then
  bad=0
  for f in migrations/*.sql; do
    case "$(basename "$f")" in
      [0-9][0-9][0-9][0-9]_*.sql) ;;
      *) fail "$f does not match NNNN_name.sql"; bad=1 ;;
    esac
  done
  duplicate_versions="$(
    for f in migrations/*.sql; do basename "$f" | cut -d_ -f1; done |
      sort | uniq -d
  )"
  if [ -n "$duplicate_versions" ]; then
    # Not a failure here: with no database this cannot tell a mistake from
    # history. Two files sharing a number matter while one is still unapplied
    # and can be renumbered; once both are applied the order is fixed by their
    # full filenames and renumbering would break whatever depends on them. The
    # "Migrations match the database" section below has the ledger and decides.
    for version in $duplicate_versions; do
      printf '  note  version %s is used by more than one migration file\n' "$version"
    done
    printf '        Whether that is a mistake depends on what is applied; the ledger\n'
    printf '        check below says. Never pick a number that is already used.\n'
  fi
  [ "$bad" -eq 0 ] && pass "filenames are ordered NNNN_name.sql"
else
  fail "migrations/ has no .sql files"
fi

# The ledger against the files. migrate.sh exists because a schema applied by
# hand leaves no record of what was actually run; the ledger is that record,
# and nobody was comparing it. On 14 September the database had applied
# 0017_admin_submission_notifications.sql, which is in no branch of this
# repository -- while committed code (app/api/notifications/route.ts) reads the
# table it creates. A clone that runs migrate.sh gets a database without it.
#
# Skipped, not failed, when no database is reachable: most runs of this script
# are on a laptop with no credentials, and a check that cannot run must not
# look like a check that failed.
echo "Migrations match the database"
ledger_url=""
if [ -n "${DATABASE_URL:-}" ]; then
  ledger_url="$DATABASE_URL"
elif [ -f .env ]; then
  env_contents="$(sed 's/\r$//' .env)"
  # eval, not `. <(...)`: see the bash 3.2 check above.
  ledger_url="$(eval "$env_contents"; printf '%s' "${DATABASE_URL:-}")"
fi
if [ -z "$ledger_url" ]; then
  printf '  skip  DATABASE_URL is not set; cannot compare the ledger\n'
elif ! command -v psql >/dev/null 2>&1; then
  printf '  skip  psql is not installed; cannot compare the ledger\n'
else
  applied="$(psql -X -q -t -A "$ledger_url" \
    -c "select version from public.schema_migrations order by version;" 2>/dev/null)"
  if [ -z "$applied" ]; then
    printf '  skip  the database is unreachable or has no ledger yet\n'
  else
    missing=""
    for version in $applied; do
      [ -f "migrations/$version" ] || missing="$missing $version"
    done
    if [ -n "$missing" ]; then
      for version in $missing; do
        fail "the database has applied $version, which is not in migrations/"
      done
      printf '        Whoever applied it needs to commit the file: without it this\n'
      printf '        repository cannot rebuild the deployed schema.\n'
    else
      pass "every migration the database has applied is in migrations/"
    fi
    # The objects, not just the filenames. The ledger check above compares
    # names; it cannot see a migration that was applied under a name this
    # repository does have. On 15 September the database was found to carry
    # five functions and five triggers that appear in no migration file --
    # including invalidate_api_schema_review, which returns a *verified*
    # record to 'Published' whenever its schemas change. That rule is real,
    # it fires on every schema write, and it is written down nowhere in this
    # repository: a clone rebuilt from migrations/ behaves differently from
    # the deployed database and nothing said so.
    #
    # Three kinds of object are excluded because no migration will ever
    # declare them: extension-owned functions (pgvector alone installs about a
    # hundred), schema_migrations, which migrate.sh creates itself, and any
    # function behind an event trigger -- Supabase installs `ensure_rls` /
    # rls_auto_enable to turn RLS on for each new public table, and this
    # repository's migrations create no event triggers at all.
    undeclared="$(psql -X -q -t -A "$ledger_url" -c "
      select 'function ' || p.proname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and not exists (select 1 from pg_depend d
                          where d.objid = p.oid and d.deptype = 'e')
         and not exists (select 1 from pg_event_trigger e where e.evtfoid = p.oid)
      union all
      select 'trigger ' || tg.tgname from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where not tg.tgisinternal and n.nspname = 'public'
      union all
      select case c.relkind when 'v' then 'view ' else 'table ' end || c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'v')
         and c.relname <> 'schema_migrations'
      order by 1;")"
    # An empty answer is not a pass. The database always has tables, so
    # nothing here means the query itself failed -- which is how the first
    # version of this check reported "ok" while ten objects were undeclared:
    # it sent psql's errors to /dev/null and read the empty output as success.
    if [ -z "$undeclared" ]; then
      fail "the object list came back empty; the query above did not run"
    else
    reported=0
    while IFS= read -r object; do
      [ -n "$object" ] || continue
      name="${object##* }"
      if ! grep -rqs -e "$name" migrations/; then
        fail "the database has $object, which no migration file mentions"
        reported=$((reported + 1))
      fi
    done <<EOF
$undeclared
EOF
    if [ "$reported" -gt 0 ]; then
      printf '        Whoever added them needs to commit the migration: these objects\n'
      printf '        change what the database does, and a clone will not have them.\n'
    else
      pass "every function, trigger, table and view is declared in migrations/"
    fi
    fi

    # A version number used twice, counting what is applied as well as what is
    # in the directory. Two files can both be applied and both be legal in the
    # ledger, whose key is the filename -- the number is what people collide on.
    names="$( { printf '%s\n' $applied; for f in migrations/*.sql; do basename "$f"; done; } | sort -u )"
    clash="$(printf '%s\n' "$names" | cut -d_ -f1 | sort | uniq -d)"
    if [ -z "$clash" ]; then
      pass "no version number is used twice"
    else
      # A collision whose every file is already applied is history: the apply
      # order is fixed by the full filenames, and renumbering one would move it
      # past a later migration that depends on it (0022 comments on a view
      # 0017_api_parameter.sql creates). Those are reported, not failed. A
      # collision involving a file nobody has applied yet can still be
      # renumbered, which is the case worth stopping for.
      for version in $clash; do
        colliding="$(printf '%s\n' "$names" | grep "^${version}_" || true)"
        unapplied=""
        for name in $colliding; do
          printf '%s\n' $applied | grep -qx "$name" || unapplied="$unapplied $name"
        done
        if [ -n "$unapplied" ]; then
          fail "version $version is used twice and$unapplied is not applied yet; renumber it"
        else
          printf '  note  version %s is used by two applied migrations: %s\n' \
            "$version" "$(printf '%s\n' "$colliding" | tr '\n' ' ')"
          printf '        Both are history now. They apply in filename order, which is\n'
          printf '        the order they were applied in. Do not reuse %s for anything new.\n' "$version"
        fi
      done
    fi

    # Format values no alias recognises. v_unmapped_formats (0004) was built to
    # be this signal, and twice nobody read it. 0021 found it had been listing
    # application/json on 44 records "ever since". On 16 September it was
    # listing the literal string 'null' on 38 records and comma-joined values
    # such as 'UBL, CII' on 10 more, all written by an administrator bulk
    # update. The format gate treats an unrecognised value as no format at all,
    # so each one silently turned a decidable pair into "unknown" (0031
    # repaired them). A view nobody runs is not a check; this makes it one.
    #
    # count(*) first, and its answer must be a number: an empty view and a
    # query that failed both print nothing, and only one of them is a pass.
    unmapped_count="$(psql -X -q -t -A "$ledger_url" \
      -c "select count(*) from public.v_unmapped_formats;" 2>&1)"
    case "$unmapped_count" in
      ''|*[!0-9]*)
        fail "could not read v_unmapped_formats: $(printf '%s\n' "${unmapped_count:-no output}" | head -n 1)"
        ;;
      0)
        pass "every stored format value has an alias"
        ;;
      *)
        fail "$unmapped_count format value(s) have no alias in format_alias"
        psql -X -q -t -A -F ' x ' "$ledger_url" \
          -c "select records, format_value from public.v_unmapped_formats;" 2>&1 |
          sed 's/^/        /'
        printf '        A real new spelling needs an alias row in a migration. A value\n'
        printf '        like null, an empty string or two formats joined by a comma is\n'
        printf '        a writer bug: fix the writer, then repair the rows.\n'
        ;;
    esac

    # Fields the client called basic on 3 October 2026 (#54, 0039): a
    # Validation API states its business rules, a Communication API its
    # network type. A new record arrives without them, so this is where a
    # gap shows before the client finds it.
    basic_gaps="$(psql -X -q -t -A "$ledger_url" -c "
      select count(*) from public.apis
       where is_active and duplicate_of is null
         and ((category = 'Validation' and cardinality(business_rules) = 0)
           or (category = 'Communication'
               and network not in ('Peppol', 'Peppol / InvoiceNow', 'Email',
                                   'Tax authority platform', 'Provider platform')));" 2>&1)"
    case "$basic_gaps" in
      ''|*[!0-9]*)
        fail "could not read business rules and network types: $(printf '%s\n' "${basic_gaps:-no output}" | head -n 1)"
        ;;
      0)
        pass "every Validation API has business rules and every Communication API a network type"
        ;;
      *)
        fail "$basic_gaps active record(s) lack business rules (Validation) or a network type (Communication)"
        psql -X -q -t -A -F ' | ' "$ledger_url" -c "
          select category, api_name from public.apis
           where is_active and duplicate_of is null
             and ((category = 'Validation' and cardinality(business_rules) = 0)
               or (category = 'Communication'
                   and network not in ('Peppol', 'Peppol / InvoiceNow', 'Email',
                                       'Tax authority platform', 'Provider platform')))
           order by 1, 2;" 2>&1 | sed 's/^/        /'
        ;;
    esac
  fi
fi

echo "Nothing secret is staged"
staged_env_files="$(
  git diff --cached --name-only --diff-filter=ACMR 2>/dev/null |
    grep -E '(^|/)\.env($|\.)' |
    grep -Ev '(^|/)\.env\.example$' || true
)"
if [ -n "$staged_env_files" ]; then
  fail "a non-example environment file is staged"
else
  pass "no private environment file is staged"
fi
if git grep --cached -q -E 'sb_secret_[A-Za-z0-9_-]{20,}' -- . 2>/dev/null; then
  fail "a Supabase secret key is present in staged content"
else
  pass "no Supabase secret key is present in staged content"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
  exit 1
fi
