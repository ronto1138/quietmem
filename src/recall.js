// Proactive recall: given the user's prompt, find past conversation fragments worth injecting.
//
// The design goal is precision, not recall. Injecting a wrong fragment costs more than injecting
// nothing: it wastes context and can mislead the model. So a fragment has to clear several gates:
//
//   0. Machine events (task notifications, system reminders) never search.
//   1. Short prompts never search ("yes", "go ahead").
//   1b. Gate: the prompt must name a known entity (config.recall.entities) or ask to remember
//       ("what did we decide", "last time"...). Similarity alone cannot tell "how did the backfill go?"
//       from "check the file and fix it" — we measured it.
//   Candidates: top-N by vector + up to 10 by exact match on the prompt's very rare terms
//   (a brand-new name embeds poorly and may not be among the nearest vectors).
//   2. A fragment passes through one of three paths:
//      a) similarity >= minSimilarity, >= minSharedTerms shared terms, at least one of them rare;
//      b) >= 2 shared very rare terms (proper names that the embedding scores low);
//      c) the prompt names an entity, similarity >= minSimilarity and one shared very rare term.
//   3. The current session is excluded (it is already in context); duplicates are dropped.
//   4. Everything injected is passed through redact().
//
// Thresholds are defaults calibrated on one real corpus (Spanish/English, ~50k chunks). Tune them on
// yours with `quietmem recall "..." --debug` (see docs/design.md, "Tuning on your corpus").

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { terms, tokens, norm } from './terms.js';
import { redact } from './redact.js';
import { FTS, searchSettings } from './db.js';

export const MACHINE = /<\/?(task-notification|system-reminder|local-command-[a-z]+|command-(name|message|args)|bash-(input|stdout|stderr)|user-prompt-submit-hook|agent-message|cross-session-message)\b|^Another Claude session sent a message/;

export const DEFAULT_INTENT = [
  // English
  'what (did|have) we (decide|agree|say|do|conclude)', '\\bremember\\b', '\\bremind me\\b', '\\brecall\\b', 'last time',
  'where (did )?we (leave|left) off', 'how did .{1,40} (go|end up|turn out)', 'what happened (with|to)',
  'we (already|previously) (discussed|decided|did|talked)', 'when did we',
  // Spanish
  'qu[eé] (decidimos|acordamos|quedamos|dijimos|hicimos|hab[ií]amos)', 'recu[eé]rda(me)?\\b', 'acu[eé]rdate',
  'te acuerdas', 'c[oó]mo qued[oó]', 'qu[eé] pas[oó] con', 'la [uú]ltima vez', 'ya (vimos|hablamos|hicimos)',
  'd[oó]nde (nos )?quedamos', 'en qu[eé] qued', 'cu[aá]ndo (vimos|hicimos|decidimos)',
];

export function loadEntities(cfg) {
  const list = [...(cfg.recall.entities || [])];
  const f = cfg.recall.entitiesFile;
  if (f && existsSync(f)) list.push(...readFileSync(f, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()));
  return new Set(list.map(e => norm(e).trim()).filter(Boolean));
}

export function loadTermFrequencies(cfg) {
  const p = join(cfg.dataDir, 'term-frequencies.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Gates that run before any I/O. Returns { stop: reason } or the prepared query. */
export function prepare(prompt, cfg, { entities, tf }) {
  const r = cfg.recall;
  if (MACHINE.test(prompt.slice(0, 400))) return { stop: 'machine_event' };
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (prompt.length < r.minChars || words < r.minWords) return { stop: 'short' };
  const qTerms = terms(prompt);
  const intentRe = new RegExp((r.intentPatterns || DEFAULT_INTENT).join('|'), 'i');
  const named = tokens(prompt).filter(w => entities.has(w) || w.split('-').some(p => entities.has(p)));
  const intent = intentRe.test(prompt);

  // A term seen in fewer than minDf chunks is always rare and very rare. That keeps a small, young
  // corpus usable (otherwise every word of a 10-chunk corpus is "common") and matches `quietmem tf`, which
  // only stores terms with df >= minDf.
  const chunks = tf?.chunks || 0, df = tf?.df || {}, minDf = r.minDf ?? 30;
  const isCommon = t => (df[t] || 0) >= Math.max(minDf, chunks * r.rarePct);
  const isVeryRare = t => (df[t] || 0) < Math.max(minDf, chunks * r.veryRarePct);
  const rare = [...qTerms].filter(t => !isCommon(t));

  // With no entities configured, a rare term stands in for a named entity (less precise; configure entities).
  const gateOpen = named.length > 0 || intent || (entities.size === 0 && rare.length > 0);
  if (!gateOpen) return { stop: 'no_entity' };
  if (qTerms.size < (named.length ? 1 : r.minSharedTerms)) return { stop: 'few_terms' };
  if (!rare.length) return { stop: 'no_rare_terms' };

  const lexTerms = [...new Set([...qTerms].flatMap(t => t.split(/[-_.]/)))]
    .filter(t => /^[a-z0-9]{4,}$/.test(t) && isVeryRare(t)).slice(0, 8);
  return { qTerms, named, intent, rare, lexTerms, isCommon, isVeryRare };
}

/** Vector + lexical candidates. `vec` is the query embedding. */
export async function candidates(db, cfg, vec, { sessionId, lexTerms, project }) {
  const lit = '[' + vec.join(',') + ']';
  const where = `session_id IS DISTINCT FROM $2 ${project ? 'AND project = $4' : ''}`;
  const extra = project ? [project] : [];
  const { rows } = await db.query(
    `SELECT id, project, to_char(ts,'YYYY-MM-DD') d, 1 - (embedding <=> $1::vector) AS s, content
       FROM chunks WHERE ${where}
      ORDER BY embedding <=> $1::vector LIMIT $3`, [lit, sessionId || null, cfg.recall.candidates, ...extra]);
  let all = rows;
  if (lexTerms.length) {
    const { rows: lex } = await db.query(
      `SELECT id, project, to_char(ts,'YYYY-MM-DD') d, 1 - (embedding <=> $1::vector) AS s, content
         FROM chunks WHERE ${where} AND embedding IS NOT NULL AND ${FTS} @@ to_tsquery('simple', $3)
        ORDER BY embedding <=> $1::vector LIMIT 10`, [lit, sessionId || null, lexTerms.join(' | '), ...extra]);
    const have = new Set(all.map(r => String(r.id)));
    all = all.concat(lex.filter(r => !have.has(String(r.id))));
  }
  return all.map(r => ({ ...r, s: Number(r.s) })).sort((a, b) => b.s - a.s);
}

/** Apply the similarity/term filters to candidate rows. */
export function pick(rows, cfg, q, debug = null) {
  const r = cfg.recall;
  const seen = new Set(), picked = [];
  for (const row of rows) {
    if (row.s < r.lowSimilarity) continue;
    if (MACHINE.test(row.content)) continue;
    const key = norm(row.content).replace(/\s+/g, ' ').slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    const cTerms = terms(row.content);
    const shared = [...q.qTerms].filter(t => cTerms.has(t));
    const sharedRare = shared.filter(t => !q.isCommon(t));
    const sharedVeryRare = shared.filter(q.isVeryRare);
    debug?.(`[${row.s.toFixed(3)}] ${row.project} ${row.d} shared=${shared.join(',')} rare=${sharedRare.join(',')}`);
    const pass = (row.s >= r.minSimilarity && shared.length >= r.minSharedTerms && sharedRare.length >= 1)
              || sharedVeryRare.length >= 2
              || (q.named.length > 0 && row.s >= r.minSimilarity && sharedVeryRare.length >= 1);
    if (!pass) continue;
    picked.push(row);
    if (picked.length >= r.maxFragments) break;
  }
  return picked;
}

export function render(picked, cfg) {
  const r = cfg.recall;
  let out = '[quietmem] Fragments from past sessions that may be relevant. Retrieved automatically: they may be ' +
    'outdated or tangential. Use them only if they apply, and verify before relying on them.\n';
  let n = 0;
  for (const p of picked) {
    const txt = redact(p.content.replace(/\s+/g, ' ').trim()).slice(0, r.fragmentChars);
    const block = `\n— ${p.d} · ${p.project} · similarity ${p.s.toFixed(2)}\n${txt}\n`;
    if (out.length + block.length > r.maxChars) break;
    out += block; n++;
  }
  return { text: out, count: n };
}

export { searchSettings };
