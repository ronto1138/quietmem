# Security

quietmem indexes your conversations with AI agents, and those often contain secrets you pasted: API keys,
database URLs, tokens. Treat the quietmem database like the transcripts themselves.

- The database is bound to `127.0.0.1` by the bundled `docker-compose.yml`. Keep it off the network.
- Everything quietmem prints or injects goes through `src/redact.js`. It masks common key formats, but no
  pattern list is complete: rotate any key you pasted into an agent session, memory or not.
- Logs (`~/.quietmem/*.log.jsonl`) contain counts and timings only, never prompt or fragment text.
- The distiller discards proposals that look like secrets.
- Keep the database password in `QUIETMEM_DATABASE_URL`, not in the config file.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository
("Security" tab → "Report a vulnerability"). You will get an answer within a week.
