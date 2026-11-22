# Changelog

## 0.2.0 — 2026-11-22

- **Privacy controls**: `index.exclude` (never index a project), `recall.private` (recall a project only
  inside itself), `recall.scope: "project"`, and `quietmem forget` (by session, project or date; dry run
  by default). The MCP server applies them using the folder it starts in or `QUIETMEM_PROJECT`.
- Project labels count as entities (`recall.projectsAsEntities`), unless the label is a common word.
- `quietmem setup`: config, schema, index, term frequencies and hooks in one command.
- `quietmem stats`: injection ratio, outcomes, latency and per-phase timings from the recall log.
- `quietmem install claude-code --remove`, `quietmem --version`.
- `doctor` keeps checking the database when the embedder fails; common errors come with a hint.
- End-to-end test against a real pgvector in CI, with a fake embedder.
- Schema: `index_state.excluded` (added by `quietmem init`, safe on existing databases).

## 0.1.0 — 2026-11-21

First public version, generalized from the author's private setup.

- Recall with precision gates, hard time budget and per-phase timing logs.
- Incremental indexing by byte offset; adapters for Claude Code and a generic JSONL format.
- MCP server (`search_memory`, `recall_memory`).
- Embedders: Ollama and any OpenAI-compatible endpoint.
- Memory proposals through any configured command, with expiry.
- `quietmem doctor`, `quietmem install claude-code`, secret checks for contributors.
