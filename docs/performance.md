# Performance

Recall runs inside a prompt hook, so it has a hard budget (`recall.budgetMs`, 500 ms). Past it, quietmem
injects nothing and the message goes through. Every recall writes its phase timings to
`recall.log.jsonl` (`ph`: milliseconds since start when stdin was read, the embedding arrived, the
database connection was ready and the query returned), including the ones that ran out of budget, so a
slowdown is visible instead of silent.

Measured on the author's laptop (Windows host; Postgres and Ollama on GPU inside WSL; ~52k chunks; warm
index): total 210–500 ms, median ~320 ms. Embedding and connection run in parallel; the connection across
the VM boundary is the largest phase (110–330 ms), the vector query itself 10–70 ms. Please share your
numbers (`quietmem doctor`) in an issue, especially on macOS and native Linux.

## Keep the vector index in memory

This is the one that bit us. The vector query is fast only if the index pages are in memory. If the index
does not fit in Postgres `shared_buffers`, each query after a pause reads it from disk: we measured
280–2,300 ms cold against 10–70 ms warm, and recall silently stopped working for days. It gets worse on
machines that reclaim the OS page cache aggressively (WSL with `autoMemoryReclaim`, laptops under memory
pressure).

- The bundled `docker-compose.yml` sets `shared_buffers=512MB` and enables `pg_prewarm` with autoprewarm,
  which reloads the cached pages after a restart.
- `quietmem doctor` prints the index size, `shared_buffers`, and how many blocks a cold query read from disk.
- Rough sizing with 768-dim embeddings: we measured ~4 KB of IVFFlat index per chunk (204 MB for 52k
  chunks); HNSW is larger because it also stores graph links. Check the real size with `quietmem doctor` and
  keep `shared_buffers` comfortably above it.
- To warm it by hand: `SELECT pg_prewarm('chunks_embedding_idx');`

## HNSW over IVFFlat, and `efSearch`

On a 57,830-chunk corpus (768 dims) we measured 30 queries against an exact scan:

| Index | Share of the true top 30 found | Warm query |
|---|---|---|
| IVFFlat, `lists=100`, `probes=10` | 84% | 80–100 ms |
| HNSW, `ef_search=40` | 85% | 10–30 ms |
| HNSW, `ef_search=100` (default since 0.2.2) | 92–95% | 15–40 ms |
| HNSW, `ef_search=200` | 96–97% | 20–55 ms |

IVFFlat also has to be rebuilt as the corpus grows: its centroids are fixed at build time. HNSW updates on
insert. A rebuild of HNSW is only worth it after deleting or reloading a large share of rows:
`REINDEX INDEX CONCURRENTLY chunks_embedding_idx` keeps recall working while it runs. Building it on 58k
chunks took about 6 minutes with `maintenance_work_mem=1GB`; with the default 64 MB it is much slower.
After a large delete, run `VACUUM ANALYZE chunks`: until then, queries can miss the latency budget.

## The embedding model must stay loaded

Ollama unloads idle models; loading one takes seconds, far over budget. quietmem asks Ollama to keep the model
loaded (`embedder.keepAlive`, 4 h). When an embedding misses the budget anyway, quietmem starts a detached
`quietmem warm` so the next prompt finds the model loaded.

## Connection cost

Opening a Postgres connection is a large part of the budget, especially across a VM boundary (Windows to
WSL, a container on another host). Run the database on the same side as the agent when you can.
