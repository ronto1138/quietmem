# Changelog

## 0.1.0 — unreleased

First public version, generalized from the author's private setup.

- Recall with precision gates, hard time budget and per-phase timing logs.
- Incremental indexing by byte offset; adapters for Claude Code and a generic JSONL format.
- MCP server (`search_memory`, `recall_memory`).
- Embedders: Ollama and any OpenAI-compatible endpoint.
- Memory proposals through any configured command, with expiry.
- `quietmem doctor`, `quietmem install claude-code`, secret checks for contributors.
