// Database access. `pg` is imported lazily so commands that never touch the database stay fast.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export async function connect(cfg, { timeoutMs = 5000, statementTimeoutMs } = {}) {
  const { default: pg } = await import('pg');
  const db = new pg.Client({
    connectionString: cfg.database.url,
    connectionTimeoutMillis: timeoutMs,
    ...(statementTimeoutMs ? { statement_timeout: statementTimeoutMs } : {}),
  });
  await db.connect();
  return db;
}

// Per-connection search settings for the configured vector index.
export const searchSettings = cfg => cfg.database.index === 'ivfflat'
  ? `SET ivfflat.probes = ${Number(cfg.database.probes) | 0}`
  : `SET hnsw.ef_search = ${Number(cfg.database.efSearch) | 0}`;

export function schemaSql(cfg) {
  const dims = Number(cfg.embedder.dimensions) | 0;
  if (!dims) throw new Error('embedder.dimensions must be a positive integer');
  const index = cfg.database.index === 'ivfflat'
    ? 'USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)'
    : 'USING hnsw (embedding vector_cosine_ops)';
  return readFileSync(join(HERE, '..', 'sql', 'schema.sql'), 'utf8')
    .replaceAll('{{DIMENSIONS}}', String(dims))
    .replaceAll('{{VECTOR_INDEX}}', index);
}

// Text-search expression shared by the index (schema.sql) and the lexical query. Must match exactly,
// or Postgres will not use the GIN index.
export const FTS = `to_tsvector('simple', translate(lower(content), 'áéíóúüñàèìòùâêîôûç', 'aeiouunaeiouaeiouc'))`;
