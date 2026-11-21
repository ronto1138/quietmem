# Design

## The problem with "just embed and retrieve"

A memory that injects past fragments into every prompt has two failure modes. Too little, and it is
useless. Too much, and it is worse than useless: it fills the context with tangents and nudges the model
toward stale decisions. The second failure is the common one, because cosine similarity is a poor judge
of relevance for short conversational messages:

- "yes, go ahead" scores ~0.74 against hundreds of past fragments that also say "yes";
- "how did the backfill go?" and "check the file and fix it" are indistinguishable by similarity,
  word rarity or word concentration (we measured all three on a labeled battery of real prompts);
- a brand-new proper name ("zorvantil") embeds poorly, so the one fragment that mentions it may not even
  be among the 30 nearest vectors.

So quietmem treats retrieval as a precision problem and stacks cheap filters.

## The gates

In order, for every prompt (`src/recall.js`):

0. **Machine events never search.** Harnesses deliver task notifications and system reminders as if they
   were user messages; searching with them only retrieves other notifications, at 0.90+ similarity.
1. **Short prompts never search** (`minChars`, `minWords`).
2. **The entity gate.** The prompt must name a configured entity (a project, client, service, person) or
   explicitly ask to remember ("what did we decide", "last time", "remind me", and Spanish equivalents).
   This is the filter that does most of the work. With no entities configured, any rare term opens the
   gate instead, which is noticeably looser.
3. **Candidates** come from two queries merged: the top `candidates` by vector distance, and up to 10 by
   exact text match on the prompt's *very rare* terms (the fix for new names).
4. **A fragment passes** by one of three paths:
   - a) similarity ≥ `minSimilarity` (0.72), ≥ `minSharedTerms` (2) shared terms, at least one *rare*;
   - b) ≥ 2 shared *very rare* terms, whatever the similarity above `lowSimilarity` (0.5);
   - c) the prompt names an entity, similarity ≥ `minSimilarity` and ≥ 1 shared very rare term.
5. **Exclusions:** the current session (already in context), duplicates, fragments that are themselves
   machine events.
6. **Budgets:** at most `maxFragments` fragments, `fragmentChars` each, `maxChars` total (~1,200 tokens),
   and a hard wall-clock limit `budgetMs`.

"Rare" and "very rare" come from document frequency over your own corpus (`quietmem tf`): a term is rare if it
appears in fewer than `rarePct` (3%) of chunks, very rare under `veryRarePct` (0.3%). Any term seen in
fewer than `minDf` (30) chunks counts as both, so a young corpus still works.

## Tuning on your corpus

The defaults were calibrated on one corpus: ~50k chunks, Spanish and English, software and business work.
Yours will differ. To tune:

1. Write 30–50 real prompts you would have wanted memory for, and 30–50 you would not ("run the tests",
   "fix the typo"). Real ones, from your history, not invented.
2. Run `quietmem recall "<prompt>" --debug` on each. The debug lines show, per candidate, the similarity and
   the shared and rare terms, so you can see which gate decided.
3. Adjust `minSimilarity` first, then `lowSimilarity`, then the rarity percentages. Add entities before
   touching thresholds: a missing entity is the most common cause of a miss.

If you do this on a corpus in another language, please share the numbers in an issue: it is the most
useful contribution after adapters.

## Indexing

Transcripts are read incrementally from the last byte offset (`index_state`), in 64 MB blocks, so a
long-lived session of hundreds of MB costs only its new lines. Messages become chunks of ~1,200 characters
with 150 of overlap; tool results and machine tags are dropped; degenerate text (base64, repeated logs) is
detected by compression ratio and skipped. Embedding batches split in half on failure.

## Proposals

`quietmem distill` reads one day of conversation per project and asks a model, through the command you
configure, to propose at most 5 memories in a fixed JSON shape (`prompts/distill.md`). Proposals that look
like secrets are discarded. Output is one Markdown file per project and day, each proposal ending in
`**Decision:** pending`. A project with `maxPending` undecided proposals is skipped (no point generating
more nobody reads), and proposals pending for `expireDays` move to `expired/` so a busy week does not stop
distillation forever.
