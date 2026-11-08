# Migrations that are written but must not be applied yet

`scripts/migrate.sh` globs `migrations/*.sql` and does not recurse, so nothing in
this directory is ever applied. That is the point: some migrations are correct
but would break work in progress if they landed today.

Moving one into `migrations/` is a deliberate act. When you do:

1. give it the next free number at that moment, not the number it was drafted
   with, so it sorts after anything written in the meantime;
2. read the conditions at the top of the file and confirm every one;
3. rehearse it against an empty local database first —
   `./scripts/migrate.sh --target local`;
4. say in the pull request why the conditions are now met.

| File | Blocked on | Raised by |
| --- | --- | --- |
| `enforce_verification_admin.sql` | Sign-in must exist, and one `app_user` row must hold `role = 'admin'` | Pod A, 1 September 2026 |
