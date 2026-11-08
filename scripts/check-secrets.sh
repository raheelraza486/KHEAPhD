#!/usr/bin/env bash
# Refuse to commit a live credential.
#
# On 31 August a real Supabase database password reached .env.example, which is
# a file we commit on purpose. It was replaced with a placeholder the next day,
# but a later commit does not remove anything from history: the password stayed
# readable on the remote until it was rotated. The lesson is not that someone
# was careless -- .env.example is exactly the file where a working value gets
# pasted while testing and then forgotten -- it is that nothing was watching.
#
# Install once:
#   ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit
#
# Run over the whole tree:
#   ./scripts/check-secrets.sh --all

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ "${1:-}" = "--all" ]; then
  files=$(git ls-files)
else
  files=$(git diff --cached --name-only --diff-filter=ACM)
fi
[ -z "$files" ] && exit 0

# A password inside a connection string, a JWT, or an AWS key id. Placeholders
# in angle brackets, ${...} and the local development password are all allowed.
patterns='postgres(ql)?://[^ "'"'"']*:(?!<|\$\{|cs9_dev_only)[^ :@"'"'"']{8,}@|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|sb_secret_[A-Za-z0-9_-]{20,}'

hits=""
for f in $files; do
  [ -f "$f" ] || continue
  case "$f" in scripts/check-secrets.sh) continue;; esac
  m=$(grep -nPI "$patterns" "$f" 2>/dev/null | head -3) || true
  [ -n "$m" ] && hits="$hits\n$f\n$(echo "$m" | sed 's/^/  /')"
done

if [ -n "$hits" ]; then
  printf 'A live credential looks like it is about to be committed:\n'
  printf "$hits\n"
  cat <<'MSG'

Replace it with a placeholder. If it has already been pushed, changing it in a
later commit is not enough -- the value stays in history and must be rotated at
the provider.

To commit anyway: git commit --no-verify
MSG
  exit 1
fi
exit 0
