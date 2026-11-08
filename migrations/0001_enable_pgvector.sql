-- Enable the pgvector extension. Discovery's similarity search depends on
-- this regardless of which backend framework the group ends up on.
CREATE EXTENSION IF NOT EXISTS vector;
