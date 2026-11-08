#!/usr/bin/env bash
# One-off check, not a migration: proves the vector extension is actually
# usable — creates a table, inserts rows, builds an HNSW index, and runs a
# similarity query — all inside a transaction that's rolled back, so
# nothing is left in the database.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Read the same .env that docker compose does.
ENV_FILE="$ROOT_DIR/.env"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

SERVICE="postgres"
DB_USER="${POSTGRES_USER:-cs9}"
DB_NAME="${POSTGRES_DB:-cs9}"

docker compose exec -T "$SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

CREATE TABLE _pgvector_probe (
    id serial PRIMARY KEY,
    embedding vector(3)
);

INSERT INTO _pgvector_probe (embedding)
SELECT ARRAY[random(), random(), random()]::vector
FROM generate_series(1, 100);

CREATE INDEX ON _pgvector_probe USING hnsw (embedding vector_cosine_ops);

\echo '-- index actually built:'
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '_pgvector_probe';

\echo '-- similarity query actually runs:'
SELECT id FROM _pgvector_probe ORDER BY embedding <=> '[0.1,0.2,0.3]' LIMIT 3;

ROLLBACK;
SQL

echo "pgvector + HNSW index verified. Nothing persisted (transaction rolled back)."
