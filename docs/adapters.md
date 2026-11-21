# Adapters

An adapter teaches quietmem to read one harness's transcripts and hook events. Adding one is the most useful
first contribution: each harness stores conversations differently, and quietmem only needs a few functions.

## The interface

An adapter is a plain object (see `src/adapters/claude-code.js` and `src/adapters/jsonl.js`):

| Member | Purpose |
|---|---|
| `name` | Identifier used in config and on the command line (`--adapter`, `--hook`) |
| `listFiles(dir, cfg)` | Transcript files under a source directory |
| `sessionId(path)` | Stable session id for a file |
| `fallbackProject(path)` | Project label when no message carries a working directory |
| `parseLine(obj)` | One parsed JSON line → `{ role: 'user'\|'assistant', text, ts, cwd?, project? }` or `null` |
| `stopEvent(ev)` | End-of-turn hook payload → `{ path, sessionId, cwd }` or `null` |
| `promptEvent(ev)` | Prompt hook payload → `{ prompt, sessionId, cwd }` |

Rules for `parseLine`:

- keep only what a human or the assistant actually wrote; drop tool calls, tool results and anything the
  harness injected (system reminders, notifications, command output);
- return `null` for lines that are not messages;
- `ts` is an ISO timestamp if the format has one (it drives incremental indexing and daily distillation).

Transcripts must be JSON Lines (one JSON object per line) and append-only: indexing resumes from the last
byte offset. If a harness rewrites its files or uses another format, the adapter can't be a pure line
parser yet; open an issue and let's design it together.

## Registering

Add it to `src/adapters/index.js`, add a fixture under `test/fixtures/` with a few synthetic lines
(**never real transcripts**), and a test in `test/unit.test.js` that checks what `parseLine` keeps and drops.

## Harnesses without hooks

quietmem can still index their transcripts (with an adapter, via `quietmem index --sweep`), and the model can query
memory through the MCP server (`quietmem mcp`). Automatic injection needs a prompt hook; where the harness has
none, the MCP `recall_memory` tool is the fallback.

## Wanted

Adapters for Codex CLI, Gemini CLI, Cursor, Aider, opencode, Continue and Cline are all open: see the
issues labeled `adapter`.
