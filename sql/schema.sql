-- quietmem schema. Applied by `quietmem init`; safe to run more than once.
-- {{DIMENSIONS}} and {{VECTOR_INDEX}} are filled in from the config (embedder.dimensions, database.index).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,              -- adapter that produced it: 'claude-code', 'jsonl', ...
  project     text NOT NULL,
  path        text,
  session_id  text,
  ts          timestamptz,
  content     text NOT NULL,
  embedding   vector({{DIMENSIONS}})
);

-- 0.3.0: bigrams and words of scripts written without spaces (Chinese, Japanese, Thai...), which text search
-- cannot split. NULL for chunks without them. `quietmem tf` fills it for chunks indexed before.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS dense text[];
CREATE INDEX IF NOT EXISTS chunks_dense_idx ON chunks USING gin (dense);

CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks {{VECTOR_INDEX}};
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (
  to_tsvector('simple', translate(lower(content), 'áéíóúüñàèìòùâêîôûç', 'aeiouunaeiouaeiouc')));
CREATE INDEX IF NOT EXISTS chunks_project_idx ON chunks (project);
CREATE INDEX IF NOT EXISTS chunks_session_idx ON chunks (session_id);
CREATE INDEX IF NOT EXISTS chunks_ts_idx ON chunks (ts);

-- Incremental indexing: how far into each transcript we have read.
CREATE TABLE IF NOT EXISTS index_state (
  session_id   text PRIMARY KEY,
  path         text NOT NULL,
  project      text NOT NULL,
  byte_offset  bigint NOT NULL DEFAULT 0,
  baseline_ts  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- 0.2.0: sessions of a project in index.exclude are tracked (so they are not re-read) but never indexed.
ALTER TABLE index_state ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;
