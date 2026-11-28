# quietmem

[![npm](https://img.shields.io/npm/v/quietmem)](https://www.npmjs.com/package/quietmem) [![ci](https://github.com/ronto1138/quietmem/actions/workflows/ci.yml/badge.svg)](https://github.com/ronto1138/quietmem/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/quietmem)](LICENSE)

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
- **Your data, your rules.** Exclude projects from indexing, keep client work private to its own project,
  forget sessions or whole projects, and mask secrets in everything it prints.
- **Memory you approve.** An optional nightly job reads the day's conversations and *proposes* durable
  memories (decisions, preferences, references) as Markdown files. Nothing is written until you accept it.
- **Any language.** Terms and entity names work in any alphabet, and in Chinese, Japanese and Thai, which are
  written without spaces. Phrases like "what did we decide" are recognized in ten languages (English,
  Spanish, Portuguese, French, German, Italian, Russian, Chinese, Japanese, Korean); in others, entities
  open the gate. See [docs/design.md](docs/design.md#languages).
- **Any harness, any model.** Hooks for Claude Code; an MCP server for Cursor, Codex CLI, Windsurf, Zed,
  Claude Desktop and any other MCP client; a plain JSONL format for everything else. Embeddings from
  Ollama or any OpenAI-compatible endpoint; proposals from whatever command you configure.

## What it looks like

You type, in a new session:

> how did the billing-service retry change go? I want to apply the same thing to the importer

Before the model sees your message, the `UserPromptSubmit` hook adds:

```text
[quietmem] Fragments from past sessions that may be relevant. Retrieved automatically: they may be
outdated or tangential. Use them only if they apply, and verify before relying on them.

— 2026-10-14 · billing-service · similarity 0.81
USER: the retries are hammering the payment provider ... ASSISTANT: Decision: exponential backoff with
jitter, max 5 attempts, then the dead-letter queue; the provider's 429s are now treated as retryable ...
```

And for "run the tests" or "yes, go ahead", it adds nothing at all. `quietmem stats` shows how often each
happens on your machine.

## Quick start

Requirements: Node 20+, Docker (or any Postgres 15+ with pgvector), and [Ollama](https://ollama.com).

```bash
npm install -g quietmem
ollama pull nomic-embed-text:v1.5

# the database: docker-compose.yml ships with the package
cd "$(npm root -g)/quietmem"
export QUIETMEM_DB_PASSWORD="$(openssl rand -hex 16)"
docker compose up -d
export QUIETMEM_DATABASE_URL="postgresql://quietmem:${QUIETMEM_DB_PASSWORD}@localhost:5433/quietmem"

quietmem setup --hooks   # config, schema, index your Claude Code history, term frequencies, hooks
quietmem doctor          # checks everything and times each phase
```

Keep both variables in your shell profile (not in a config file), so the password never lands in a file
you might share. To hack on it instead: `git clone https://github.com/ronto1138/quietmem && cd quietmem && npm install -g .`

Then tell it the names that matter to you (`recall.entities` in `~/.quietmem/config.json`): clients,
services, tools, people. Project labels already count. Entities are what open the gate.

### Claude Code

`quietmem setup --hooks` installs two hooks: `UserPromptSubmit` runs recall, and `Stop` indexes what was
just said, in the background. To do it separately: `quietmem install claude-code --write` (or without
`--write` to print the JSON and add it yourself).

### Any MCP client

```json
{ "mcpServers": { "quietmem": { "command": "quietmem", "args": ["mcp"],
  "env": { "QUIETMEM_DATABASE_URL": "postgresql://quietmem:...@localhost:5433/quietmem" } } } }
```

Tools: `search_memory` (plain search the model can call when the user refers to earlier work) and
`recall_memory` (the same gated recall the hooks use). Clients without hooks cannot inject automatically,
so indexing their conversations needs an adapter or an export to the [JSONL format](docs/adapters.md).
The server takes its project from the folder it is started in (or `QUIETMEM_PROJECT`), which decides what
private projects it can see.

## Privacy controls

| You want | Config |
|---|---|
| Never index a project (client under NDA) | `"index": { "exclude": ["client-x"] }` |
| Index it, but recall it only inside that project | `"recall": { "private": ["client-x"] }` |
| Recall only from the current project, never across | `"recall": { "scope": "project" }` |
| Delete what is already indexed | `quietmem forget --project client-x --yes` (also `--session`, `--before YYYY-MM-DD`) |

Labels come from the session's working directory (last folder name, or `projects.rules` to map paths to
labels). Logs hold counts and timings only, never prompt or fragment text. See
[docs/configuration.md](docs/configuration.md#privacy).

## Commands

| Command | What it does |
|---|---|
| `quietmem setup [--hooks]` | First run: config, schema, index, term frequencies, and optionally the hooks |
| `quietmem doctor` | Check config, embedder and database; time a cold and a warm vector query |
| `quietmem index --sweep` | Index everything new in the configured sources |
| `quietmem index <file> [--adapter jsonl]` | Index one transcript |
| `quietmem tf` | Rebuild term frequencies (after big corpus changes) |
| `quietmem recall "text" [--debug] [--project p]` | See what the gates would do with a message |
| `quietmem search "text" [--project p]` | Plain semantic search, no gates |
| `quietmem stats [--days n] [--json]` | How often recall searched, injected or stayed quiet, and how fast |
| `quietmem forget ... [--yes]` | Delete indexed chunks by session, project or date (dry run without `--yes`) |
| `quietmem mcp` | MCP server over stdio |
| `quietmem distill [--date d] [--project p]` | Propose memories from a day of conversation |
| `quietmem proposals status` | Pending proposals per project, and which are near or at `maxPending` |
| `quietmem proposals expire` | Move stale pending proposals to `expired/` |
| `quietmem install claude-code [--write \| --remove]` | Print, merge or remove the Claude Code hooks |

## How it compares

quietmem does one thing: bring back *your own past conversations* at the moment they matter, without
being asked and without noise. It is not a knowledge base or an agent framework.

- **Agent memory frameworks** (mem0, Letta, Zep) give an agent a memory API, usually with an LLM in the loop
  to extract and update facts, and often a server or a cloud service. quietmem calls no LLM to recall,
  runs no server, and can stay fully offline.
- **Note-based memory for agents** (Markdown memory files, Basic Memory, Claude Code's own memory files) holds
  what someone chose to write down. quietmem covers what nobody wrote down, and its optional proposals help
  turn the important part into notes.
- **Plain RAG over transcripts** injects the top-k most similar chunks every time. That is the noise quietmem
  was built to avoid: the gates are the product.

## Uninstall

```bash
quietmem install claude-code --remove   # take the hooks out of ~/.claude/settings.json (keeps a backup)
docker compose down -v                  # in "$(npm root -g)/quietmem": delete the database and its volume
rm -rf ~/.quietmem                      # config, logs, term frequencies, proposals
npm uninstall -g quietmem
```

## Documentation

- [Configuration](docs/configuration.md): every option, privacy, entities, project labels, embedders
- [Design](docs/design.md): the gates, why they exist, how to tune them on your corpus
- [Adapters](docs/adapters.md): add support for another harness (the best first contribution)
- [Performance](docs/performance.md): the recall budget and keeping the index warm

## Status

v0.2. Used daily by its author since September 2026 across a dozen projects (50k+ chunks, Spanish and
English); the generalized packaging is new. Expect rough edges, and please open issues. Contributions are
very welcome, especially adapters for other harnesses and calibration results on corpora in other
languages: see [CONTRIBUTING.md](CONTRIBUTING.md) and the issues labeled `good first issue`.

## License

[MIT](LICENSE)
