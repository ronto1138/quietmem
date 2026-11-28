# Changelog

## Unreleased

- **Multi-word entities now open the gate.** `"Juan Pérez"`, `"billing service"` or `"acme.io"` in
  `recall.entities` never matched before, because prompts were compared one word at a time. They now match
  when their words appear in a row. Single-word matching is unchanged.
- **`quietmem search` and the MCP `search_memory` tool use the exact-match lane.** It was only used by gated
  recall, so a plain search for a brand-new name could miss the one fragment that contains it. Exact hits on
  very rare terms now take up to half of the results.
- **`quietmem tf` reads the corpus in pages** of 5,000 chunks instead of loading all of it at once, so memory
  stays flat as the index grows.
- Recall never injects the header alone when no fragment fits in `maxChars`.
- Tests: unit tests for the above; the end-to-end test also runs `quietmem search`.

## 0.2.2 — 2026-11-25

- **Indexing skips repeats within a session.** A scheduled prompt (a `/loop` or cron watcher) sends the same
  message every few minutes; one real session stored 717 copies of one chunk, which crowded out recall.
  Chunks the session already has, and repeats inside a block, are neither embedded nor stored. Existing
  databases can drop old repeats with:
  `DELETE FROM chunks c USING chunks d WHERE c.session_id = d.session_id AND c.content = d.content AND c.id > d.id;`
- **`database.efSearch` default 40 → 100.** Measured on 58k chunks against an exact scan: 40 found 85% of the
  true top 30, 100 found 92–95%, still at 15–40 ms. Numbers and the IVFFlat comparison in `docs/performance.md`.
- **`quietmem proposals status`**: pending proposals per project, flagged near (two thirds) or at
  `maxPending`. At the cap the nightly run skips the project without saying so; `doctor` now warns too.

## 0.2.1 — 2026-11-22

- README: install from npm, badges. Publish workflow stages releases on npm for a maintainer to approve.

## 0.2.0 — 2026-11-22

First version on npm: `npm install -g quietmem`.

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
