# quietmem

**Local, precision-first memory for AI coding agents.** quietmem indexes your past conversations with your
agents and, when a new message clearly relates to something you discussed before, quietly hands the
relevant fragments to the model. When it is not confident, it injects nothing.

- **Everything local.** Postgres + pgvector and a local embedding model (Ollama by default). No API keys
  needed, no cloud, no telemetry.
- **No resident process.** Hooks start, do their work and exit. Recall has a hard time budget (500 ms by
  default): if it cannot answer in time, the message goes through untouched.
- **Precision over recall.** Similarity alone is a bad signal: "yes, go ahead" scores 0.74 against half
  your history. quietmem requires the message to name something known (a project, a client, a tool) or to
  ask to remember, and every fragment must share distinctive terms with it. See [docs/design.md](docs/design.md).
- **Secrets stay masked.** Transcripts contain pasted keys. Everything quietmem prints goes through a redactor.
- **Memory you approve.** An optional nightly job reads the day's conversations and *proposes* durable
  memories (decisions, preferences, references) as Markdown files. Nothing is written until you accept it.
- **Any harness, any model.** Hooks for Claude Code; an MCP server for Cursor, Codex CLI, Windsurf, Zed,
  Claude Desktop and any other MCP client; a plain JSONL format for everything else. Embeddings from
  Ollama or any OpenAI-compatible endpoint; proposals from whatever command you configure (`claude -p`,
  `codex exec`, `ollama run`, your own script).

## Why

quietmem started as a replacement for a third-party memory plugin that injected too much, ran a resident
server, and quietly spent a lot of API tokens. The goal was the opposite on every axis: local, silent when
unsure, measurable, and free to run. It has been in daily use across a dozen projects since September 2026,
on a corpus of 50k+ chunks in Spanish and English.

## Quick start

Requirements: Node 20+, Docker (or any Postgres 15+ with pgvector), and [Ollama](https://ollama.com).

```bash
git clone https://github.com/ronto1138/quietmem && cd quietmem && npm install
ollama pull nomic-embed-text:v1.5

export QUIETMEM_DB_PASSWORD="$(openssl rand -hex 16)"
docker compose up -d

mkdir -p ~/.quietmem && cp quietmem.config.example.json ~/.quietmem/config.json   # edit it: entities, sources
export QUIETMEM_DATABASE_URL="postgresql://quietmem:${QUIETMEM_DB_PASSWORD}@localhost:5433/quietmem"

node bin/quietmem.js init            # tables and indexes
node bin/quietmem.js index --sweep   # index your existing Claude Code transcripts
node bin/quietmem.js tf              # term frequencies used by the precision filters
node bin/quietmem.js doctor          # checks everything and times each phase
```

Keep `QUIETMEM_DATABASE_URL` in your shell profile (not in the config file), so the password never lands in a
file you might share.

### Claude Code

```bash
node bin/quietmem.js install claude-code          # prints the hooks to add to ~/.claude/settings.json
node bin/quietmem.js install claude-code --write  # or merges them for you (keeps a backup)
```

That adds two hooks: `UserPromptSubmit` runs recall, and `Stop` indexes what was just said, in the background.

### Any MCP client

```json
{ "mcpServers": { "quietmem": { "command": "node", "args": ["/path/to/quietmem/bin/quietmem.js", "mcp"],
  "env": { "QUIETMEM_DATABASE_URL": "postgresql://quietmem:...@localhost:5433/quietmem" } } } }
```

Tools: `search_memory` (plain search the model can call when the user refers to earlier work) and
`recall_memory` (the same gated recall the hooks use). Clients without hooks cannot inject automatically,
so indexing their conversations needs an adapter or an export to the [JSONL format](docs/adapters.md).

## Commands

| Command | What it does |
|---|---|
| `quietmem init` | Create tables and indexes (dimensions and index type from the config) |
| `quietmem doctor` | Check config, embedder and database; time a cold and a warm vector query |
| `quietmem index --sweep` | Index everything new in the configured sources |
| `quietmem index <file> [--adapter jsonl]` | Index one transcript |
| `quietmem tf` | Rebuild term frequencies (after big corpus changes) |
| `quietmem recall "text" [--debug]` | See what the gates would do with a message |
| `quietmem search "text" [--project p]` | Plain semantic search, no gates |
| `quietmem mcp` | MCP server over stdio |
| `quietmem distill [--date d] [--project p]` | Propose memories from a day of conversation |
| `quietmem proposals expire` | Move stale pending proposals to `expired/` |

## Documentation

- [Configuration](docs/configuration.md): every option, entities, project labels, embedders
- [Design](docs/design.md): the gates, why they exist, how to tune them on your corpus
- [Adapters](docs/adapters.md): add support for another harness (the best first contribution)
- [Performance](docs/performance.md): the recall budget and keeping the index warm

## Status

v0.1. Used daily by its author; the generalized packaging is new. Expect rough edges, and please open
issues. Contributions are very welcome, especially adapters for other harnesses and calibration results
on corpora in other languages: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
