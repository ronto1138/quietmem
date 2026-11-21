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

## The embedding model must stay loaded

Ollama unloads idle models; loading one takes seconds, far over budget. quietmem asks Ollama to keep the model
loaded (`embedder.keepAlive`, 4 h). When an embedding misses the budget anyway, quietmem starts a detached
`quietmem warm` so the next prompt finds the model loaded.

## Connection cost

Opening a Postgres connection is a large part of the budget, especially across a VM boundary (Windows to
WSL, a container on another host). Run the database on the same side as the agent when you can.
