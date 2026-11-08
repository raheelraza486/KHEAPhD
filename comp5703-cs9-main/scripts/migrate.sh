#!/usr/bin/env bash
# Apply the .sql files in migrations/ in filename order, recording what has been
# applied in a schema_migrations table so that running twice is safe.
#
# Supabase is the project's database. Today its schema is kept in a single
# schema.sql that someone pastes into the Supabase SQL editor by hand, which
# means there is no record of what has actually been run against it, no way to
# tell whether the deployed database matches the repository, and no rehearsal
# before a change reaches the database the client looks at.
#
# This changes only how the SQL is applied, not where the data lives.
#
#   ./scripts/migrate.sh                     # Supabase, from DATABASE_URL
#   ./scripts/migrate.sh --target local      # the docker compose Postgres
#   ./scripts/migrate.sh --dry-run           # list pending files, change nothing
#   ./scripts/migrate.sh --to 0002           # stop after the matching migration
#
# The local target is optional. It exists so a migration can be rehearsed
# against an empty database before it is applied to Supabase; nobody has to use
# it, and the same files run either way.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# MIGRATIONS_DIR can be overridden to rehearse a set of migrations elsewhere.
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$ROOT_DIR/migrations}"
TARGET="supabase"
DRY_RUN=0
TO_VERSION=""
PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:16-alpine}"

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ -n "${2:-}" ] && [[ "$2" != -* ]] || {
        echo "--target requires 'supabase' or 'local'." >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    --to)
      [ -n "${2:-}" ] && [[ "$2" != -* ]] || {
        echo "--to requires a migration version or filename." >&2; exit 2; }
      TO_VERSION="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
  # Windows editors normally save CRLF. Strip the trailing carriage return so
  # connection strings are identical in PowerShell, Git Bash and Unix shells.
  #
  # Do not write this as `. <(sed ...)`: macOS ships bash 3.2, where sourcing a
  # process substitution silently reads nothing, so DATABASE_URL was never set
  # on a Mac. eval parses the text exactly as sourcing the file would, and the
  # contents are read before `set -a` so they are not themselves exported.
  # scripts/check.sh rejects the process-substitution form.
  env_contents="$(sed 's/\r$//' "$ENV_FILE")"
  # A value already in the environment wins over .env.
  #
  # It did not, and that made this script's own rehearsal feature dangerous:
  #   MIGRATIONS_DIR=/tmp/set DATABASE_URL=postgresql://...disposable ./scripts/migrate.sh
  # ran against whatever .env named -- the shared database -- while the caller
  # believed it was rehearsing on a throwaway one. On 15 September that happened
  # and wrote nothing only because every migration in the set was already
  # applied there. A destructive rehearsal would not have been so lucky.
  #
  # printf %q quotes each remembered value so that re-evaluating it cannot
  # split or expand; the restore happens inside `set -a` so the values stay
  # exported exactly as sourcing would have left them.
  restore=""
  while IFS= read -r assignment; do
    case "$assignment" in
      [A-Za-z_]*=*) name="${assignment%%=*}" ;;
      *) continue ;;
    esac
    already=""
    eval "already=\${$name+yes}"
    [ -n "$already" ] || continue
    quoted="$(eval "printf '%q' \"\$$name\"")"
    restore="$restore $name=$quoted"
  done <<EOF
$env_contents
EOF
  set -a
  eval "$env_contents"
  [ -z "$restore" ] || eval "$restore"
  set +a
  unset env_contents restore assignment name already quoted
fi

case "$TARGET" in
  supabase)
    if [ -z "${DATABASE_URL:-}" ]; then
      cat >&2 <<'MSG'
DATABASE_URL is not set.

Supabase dashboard → Project Settings → Database → Connection string → URI.
Put it in .env, which is not committed:

  DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres

Use the session connection string rather than the pooled one: migrations run
DDL, and the transaction pooler does not support it.
MSG
      exit 1
    fi
    if command -v psql >/dev/null 2>&1; then
      psql_exec() {
        psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
      }
    elif command -v docker >/dev/null 2>&1; then
      docker info >/dev/null 2>&1 || {
        echo "psql is not installed and Docker is not running." >&2; exit 1; }
      echo "psql is not installed; using $PSQL_DOCKER_IMAGE through Docker."
      psql_exec() {
        # DATABASE_URL is forwarded by name, so its value is not exposed in the
        # host's docker command line or printed in logs.
        (
          export DATABASE_URL
          MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
          docker run --rm -i -e DATABASE_URL "$PSQL_DOCKER_IMAGE" \
            sh -c '[ -n "$DATABASE_URL" ] || { echo "DATABASE_URL was not forwarded to psql." >&2; exit 1; }; exec psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"' \
            sh "$@"
        )
      }
    else
      echo "psql is not installed and Docker is unavailable." >&2
      exit 1
    fi
    ;;
  local)
    psql_exec() {
      docker compose exec -T postgres psql -X \
        -U "${POSTGRES_USER:-cs9}" -d "${POSTGRES_DB:-cs9}" -v ON_ERROR_STOP=1 "$@"
    }
    ;;
  *) echo "--target must be 'supabase' or 'local'." >&2; exit 2 ;;
esac

echo "Target: $TARGET"

shopt -s nullglob
migration_files=("$MIGRATIONS_DIR"/*.sql)
[ "${#migration_files[@]}" -gt 0 ] || {
  echo "No migration files found in $MIGRATIONS_DIR." >&2
  exit 1
}

target_matches() {
  local version="$1"
  local without_extension="${version%.sql}"
  local requested_without_extension="${TO_VERSION%.sql}"
  [ -n "$TO_VERSION" ] && {
    [ "$version" = "$TO_VERSION" ] ||
    [ "$without_extension" = "$requested_without_extension" ] ||
    [[ "$version" == "${TO_VERSION}_"*.sql ]]
  }
}

if [ -n "$TO_VERSION" ]; then
  target_found=0
  resolved_target=""
  for file in "${migration_files[@]}"; do
    if target_matches "$(basename "$file")"; then
      target_found=$((target_found + 1))
      resolved_target="$(basename "$file")"
    fi
  done
  [ "$target_found" -gt 0 ] || {
    echo "No migration matches --to $TO_VERSION." >&2
    exit 2
  }
  [ "$target_found" -eq 1 ] || {
    echo "--to $TO_VERSION matches more than one migration; use the full filename." >&2
    exit 2
  }
  TO_VERSION="$resolved_target"
  echo "Through: $TO_VERSION"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  # A dry run reads migration state when the ledger exists, but never creates or
  # changes anything in the target database.
  ledger_exists="$(psql_exec -tAc \
    "select to_regclass('public.schema_migrations') is not null;" | tr -d '[:space:]')"
else
  psql_exec -q -c "
    create table if not exists public.schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    );
    alter table public.schema_migrations enable row level security;
    revoke all on table public.schema_migrations from public;" >/dev/null
  ledger_exists="t"
fi

pending=0
for file in "${migration_files[@]}"; do
  version="$(basename "$file")"
  stop_after=0
  target_matches "$version" && stop_after=1
  applied=""
  if [ "$ledger_exists" = "t" ]; then
    applied="$(printf \
      "select 1 from public.schema_migrations where version = :'migration_version';\n" | \
      psql_exec -tA -v "migration_version=$version" | tr -d '[:space:]')"
  fi
  if [ "$applied" = "1" ]; then
    echo "skip   $version"
    [ "$stop_after" -eq 1 ] && break
    continue
  fi
  pending=$((pending + 1))
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would apply  $version"
    [ "$stop_after" -eq 1 ] && break
    continue
  fi
  echo "apply  $version"
  # Fed on stdin rather than with -f: for the local target psql runs inside the
  # container and cannot see a path on this machine. -1 wraps each migration in
  # one transaction, so a failure half way leaves nothing
  # behind, and the version is only recorded if the whole file succeeded.
  # The migration and its ledger record commit together. A lost connection can
  # no longer leave the schema changed but the version unrecorded.
  {
    cat "$file"
    printf "\ninsert into public.schema_migrations (version) values (:'migration_version');\n"
  } | psql_exec -1 -q -v "migration_version=$version"
  [ "$stop_after" -eq 1 ] && break
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "done — $pending migration(s) would be applied"
else
  echo "done"
fi
