# Configuration

quietmem reads JSON from the first of: `$QUIETMEM_CONFIG`, `./quietmem.config.json`, `~/.quietmem/config.json`, or the
file given with `--config`. Anything you leave out keeps its default (`src/config.js` is the reference).
Start from [`quietmem.config.example.json`](../quietmem.config.example.json).

## Secrets

- `QUIETMEM_DATABASE_URL` overrides `database.url`. Prefer it: the config file then holds no password.
- For an embedding API, set `embedder.apiKeyEnv` to the *name* of the variable that holds the key.
- `quietmem.config.json`, `.env` and all logs are git-ignored in this repo.

## Environment variables

| Variable | Effect |
|---|---|
| `QUIETMEM_CONFIG` | Path of the config file |
| `QUIETMEM_DATABASE_URL` | Database URL (overrides `database.url`) |
| `QUIETMEM_EMBEDDER_URL` | Embedder base URL (overrides `embedder.url`) |
| `QUIETMEM_BUDGET_MS` | Recall budget (overrides `recall.budgetMs`) |
| `QUIETMEM_PROJECT` | Project the MCP server works for (default: label of the folder it starts in) |
| `QUIETMEM_DISABLE=1` | quietmem does nothing in this process (used for the distiller's own session) |

## Privacy

Three controls, all by **project label** (see `projects.rules` below for how a session gets one):

- `index.exclude`: labels that are never indexed. Their sessions are tracked so they are not re-read, but
  no text is stored. Remove a label from the list and the next `quietmem index --sweep` indexes those
  sessions from the start.
- `recall.private`: labels whose fragments are recalled only in a session of that same project. Any other
  project, an unknown project, or an MCP server started elsewhere never sees them. A human at the terminal
  (`quietmem search`, `quietmem recall`) sees everything; `quietmem recall --project p` simulates a session in p.
- `recall.scope`: `"all"` (default) recalls across projects; `"project"` only from the current one.

To remove what is already indexed: `quietmem forget --project p` (or `--session id`, `--before YYYY-MM-DD`,
combinable). It is a dry run until you add `--yes`. Forgotten transcripts are not read again; only lines
appended later get indexed, so add the label to `index.exclude` if you want nothing new either. Run
`quietmem tf` afterwards.

## Sections

**`dataDir`** (`~/.quietmem`): logs (`recall.log.jsonl`, `index.log.jsonl`, `distill.log.jsonl`) and
`term-frequencies.json`. Logs hold counts and timings, never prompt or fragment text.

**`database`**: `url`; `index` is `hnsw` (default) or `ivfflat`; `efSearch` / `probes` tune them.
Changing `index` or `embedder.dimensions` after `quietmem init` needs a new database (or a manual migration).

**`embedder`**:

| Setup | Config |
|---|---|
| Ollama (default) | `{"provider": "ollama", "url": "http://localhost:11434", "model": "nomic-embed-text:v1.5", "dimensions": 768}` |
| OpenAI | `{"provider": "openai", "url": "https://api.openai.com", "model": "text-embedding-3-small", "dimensions": 1536, "apiKeyEnv": "OPENAI_API_KEY", "queryPrefix": "", "documentPrefix": ""}` |
| LM Studio / vLLM / llama.cpp | `{"provider": "openai", "url": "http://localhost:1234", "model": "<name>", "dimensions": <n>, "queryPrefix": "", "documentPrefix": ""}` |

`queryPrefix` / `documentPrefix` are the task prefixes some models expect (nomic: `search_query: ` and
`search_document: `). Set them to `""` for models that do not use them. Thresholds depend on the model:
re-tune after switching (see [design.md](design.md#tuning-on-your-corpus)).

**`recall`**: `budgetMs`, the gates and the size limits (see [design.md](design.md)). `entities` and
`entitiesFile` list the names that open the gate: project names, clients, services, tools, people. Matching
is case- and accent-insensitive; a hyphenated entity also matches its parts, and a multi-word one
(`"Juan Pérez"`, `"billing service"`, `"acme.io"`) matches when its words appear in a row. With `projectsAsEntities`
(default `true`), the project labels found by `quietmem tf` count too, except labels that are common words in
your corpus ("app", "src"). `intentPatterns` replaces the
built-in "do you remember" regexes (English and Spanish) with your own list.

**`index`**: chunk sizes, `batch` (embeddings per request), `skipSubagents`, `exclude` (see Privacy), and `sources`:

```json
"sources": [
  { "adapter": "claude-code", "dir": "~/.claude/projects" },
  { "adapter": "jsonl", "dir": "~/exports/my-harness" }
]
```

Without `sources`, `quietmem index --sweep` reads `~/.claude/projects`.

**`projects.rules`**: the project label of a session comes from its working directory: the first rule
whose `match` (a case-insensitive regex on the path, with forward slashes) matches, else the last path
segment.

**`distill`**: `command` is an argv array; the prompt goes to its stdin and it must print JSON. Examples:

```json
"command": ["claude", "-p", "--output-format", "text"]
"command": ["codex", "exec", "-"]
"command": ["ollama", "run", "qwen3:14b"]
```

`shell: true` is needed on Windows for `.cmd` shims. `scrubEnv` lists variables removed from the
command's environment (by default the Anthropic API key variables, so `claude -p` uses your subscription
login and never a pay-per-token key by accident). `timezone` decides what "a day" is. `contextFiles` are
included in every prompt (for example a global notes file), and `memoryIndex` is a path template
(`{project}` is replaced) of each project's existing memory index, so the model proposes updates instead
of duplicates. `language` is the language the proposals are written in.
