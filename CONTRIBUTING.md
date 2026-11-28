# Contributing

Thanks for helping. quietmem is small on purpose: a few files, three dependencies, no build step. Please keep
it that way.

## Good first contributions

- **An adapter for another harness** (Codex CLI, Gemini CLI, Cursor, Aider, opencode, Continue, Cline...).
  See [docs/adapters.md](docs/adapters.md). Issues labeled `adapter`.
- **Calibration on your corpus**, especially in a language other than English or Spanish: run the tuning
  procedure in [docs/design.md](docs/design.md#tuning-on-your-corpus) and share what you changed and why.
- **Stopwords and intent patterns** for more languages (`src/terms.js`, `DEFAULT_INTENT` in `src/recall.js`).
  Ten are covered; Arabic, Hindi, Turkish, Polish, Dutch, Vietnamese... are not yet. Check that the new
  patterns open the gate for none of the everyday prompts in the tests, and that no stopword is a content
  word in another language.
- **Secret patterns** you have seen leak (`src/redact.js`), each with a test.
- **Performance numbers** from `quietmem doctor` on your machine.

## Ground rules

1. **Measure before and after.** A change to the gates or thresholds comes with numbers: which prompts
   recalled what before and after, on a real corpus. "Feels better" is not enough; the whole design rests
   on precision.
2. **Never commit real transcripts**, logs, configs with URLs or anything from your `~/.quietmem`. Fixtures are
   synthetic. Run `npm run check-secrets` before you push (CI runs it too).
3. **No resident processes and no network calls by default.** Anything that needs a server or a cloud API
   must be opt-in through config.
4. **Hooks never block the user.** Anything slow happens in a detached process or behind the budget.
5. Tests: `npm test`. Add one for every behavior you change.

## Pull requests

Small and focused. Describe the problem, what you measured, and what changed. English, please, in code
and docs (issues in Spanish are welcome too).

## Releases

Maintainers: bump `version` in package.json and CHANGELOG.md, then create a GitHub release `vX.Y.Z`. The
`publish` workflow stages the package on npm through trusted publishing; a maintainer approves it on
npmjs.com with 2FA. CI cannot publish on its own.
