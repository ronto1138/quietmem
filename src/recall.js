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
import { terms, tokens, norm, words, NOSPACE } from './terms.js';
import { redact } from './redact.js';
import { FTS, ftsForm, searchSettings } from './db.js';

const NOSPACE_G = new RegExp(NOSPACE.source, 'gu');

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
  // Portuguese
  'o que (n[oó]s )?(decidimos|combinamos|dissemos|fizemos|t[ií]nhamos)', 'lembr[ae]-?me\\b', 'voc[eê] (se )?lembra',
  'da [uú]ltima vez', 'onde (n[oó]s )?paramos', 'como ficou', 'o que aconteceu com', 'j[aá] (falamos|discutimos|vimos|fizemos)',
  // French and Italian: straight or curly apostrophe (phone keyboards type ’)
  "qu['’]est-ce qu['’]on (a|avait) (d[eé]cid[eé]|dit|convenu|fait)", "qu['’]avons-nous (d[eé]cid[eé]|dit|convenu|fait)",
  'on (avait|a d[eé]j[aà]) (d[eé]cid[eé]|dit|convenu|parl[eé])', 'rappelle-moi', 'tu te (souviens|rappelles)',
  'la derni[eè]re fois', 'o[uù] (on |nous )?en ([eé]tions|[eé]tait|sommes)', "comment (s['’]est pass[eé]|[cç]a s['’]est pass[eé])",
  "qu['’]est-ce qui s['’]est pass[eé] avec",
  // German
  'was haben wir .{0,40}(beschlossen|entschieden|besprochen|vereinbart|gesagt|gemacht)', 'erinner(e|st) (mich|dich)',
  'wei(ß|ss)t du noch', 'letzte(s|n)? mal', 'wo (waren|sind) wir stehen', 'wie (ist|lief|war) .{1,40} (gelaufen|ausgegangen)',
  'was ist (mit|aus) .{1,40} (passiert|geworden)', 'hatten wir (schon|bereits)',
  // Italian
  'cosa (abbiamo )?(deciso|detto|concordato|stabilito)', 'ricordami', 'ti ricordi', "l['’]ultima volta",
  'dove eravamo rimasti', "com['’][eè] andat[oa]", 'cosa [eè] successo (con|a)', 'ne abbiamo gi[aà] (parlato|discusso)',
  // Russian (no \b: without the u flag it only knows ASCII letters)
  'что мы (решили|обсуждали|обсудили|договорились|говорили|сделали)', 'напомни', 'помнишь', 'в прошлый раз',
  'на ч[её]м (мы )?останов', 'как (прош[её]л|прошла|прошло|закончил)', 'что случилось с', 'мы (уже )?(обсуждали|решали)',
  // Chinese
  '上次', '之前.{0,8}(决定|讨论|说|商量|约定|做)', '我们.{0,6}(决定|商量|讨论|说好|约定)(了|过)', '还记得', '记得.{0,10}吗',
  '提醒我', '怎么样了', '进展如何', '结果如何', '后来怎么',
  // Japanese
  '前回', 'この前', '覚えて', '思い出', '何を決め', '決めた(っけ|の)', 'どうなった', '話した(っけ|こと)', 'どこまで',
  // Korean
  '지난번', '저번에', '기억(나|해|하)', '뭐라고 했', '결정했(던|지|나)', '어떻게 됐', '어디까지', '이야기했(던|지)',
];

export function loadEntities(cfg, tf = null) {
  const list = [...(cfg.recall.entities || [])];
  const f = cfg.recall.entitiesFile;
  if (f && existsSync(f)) list.push(...readFileSync(f, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()));
  // Project labels found by `quietmem tf` count as entities, unless the label is itself a common word
  // ("app", "src", "code" would open the gate for almost anything).
  if (cfg.recall.projectsAsEntities !== false && tf?.projects) {
    const common = t => (tf.df?.[t] || 0) >= Math.max(cfg.recall.minDf ?? 30, (tf.chunks || 0) * cfg.recall.rarePct);
    for (const p of Object.keys(tf.projects)) {
      const n = norm(p).trim();
      if (n.length >= 3 && n !== 'default' && !common(n)) list.push(n);
    }
  }
  return new Set(list.map(e => norm(e).trim()).filter(Boolean));
}

/**
 * WHERE clause that decides which projects a query may see. Appends its values to `params`.
 *   project   explicit filter (CLI or MCP argument)
 *   current   project of the session asking; undefined = a human at the terminal (no privacy filter),
 *             null = unknown session (private projects are hidden)
 */
export function scopeWhere(cfg, { sessionId, project, current } = {}, params) {
  const p = v => { params.push(v); return `$${params.length}`; };
  const w = [`session_id IS DISTINCT FROM ${p(sessionId || null)}`];
  if (project) w.push(`project = ${p(project)}`);
  if (current !== undefined) {
    // Unknown project with scope 'project': `project = NULL` matches nothing, which is the safe answer.
    if (cfg.recall.scope === 'project') w.push(`project = ${p(current)}`);
    const priv = (cfg.recall.private || []).filter(x => x !== current);
    if (priv.length) w.push(`project <> ALL(${p(priv)}::text[])`);
  }
  return w.join(' AND ');
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
  // Scripts without spaces: a character carries about as much as three Latin ones, and two make a word.
  const dense = (prompt.match(NOSPACE_G) || []).length;
  const words = prompt.split(/\s+/).filter(Boolean).length + (dense >> 1);
  if (prompt.length + 2 * dense < r.minChars || words < r.minWords) return { stop: 'short' };
  const qTerms = terms(prompt);
  const intentRe = new RegExp((r.intentPatterns || DEFAULT_INTENT).join('|'), 'i');
  const named = namedEntities(prompt, entities);
  const intent = intentRe.test(prompt);
  const { isCommon, isVeryRare } = rarity(cfg, tf);
  const rare = [...qTerms].filter(t => !isCommon(t));

  // With no entities configured, a rare term stands in for a named entity (less precise; configure entities).
  const gateOpen = named.length > 0 || intent || (entities.size === 0 && rare.length > 0);
  if (!gateOpen) return { stop: 'no_entity' };
  if (qTerms.size < (named.length ? 1 : r.minSharedTerms)) return { stop: 'few_terms' };
  if (!rare.length) return { stop: 'no_rare_terms' };

  return { qTerms, named, intent, rare, lexTerms: lexicalTerms(prompt, isVeryRare, qTerms), isCommon, isVeryRare };
}

/**
 * Entities the text names. Single-word entities match a token (or a part of a hyphenated one);
 * multi-word ones ("Juan Pérez", "billing service", "acme.io") match the same tokens in a row; names in a
 * script written without spaces ("王伟", "田中") match anywhere in the text.
 */
export function namedEntities(text, entities) {
  const toks = tokens(text);
  const named = toks.filter(w => entities.has(w) || w.split('-').some(p => entities.has(p)));
  const line = ` ${toks.join(' ')} `;
  let flat;
  for (const e of entities) {
    if (NOSPACE.test(e)) { if ((flat ??= norm(text)).includes(e)) named.push(e); continue; }
    const et = tokens(e);
    if (et.length > 1 && line.includes(` ${et.join(' ')} `)) named.push(e);
  }
  return named;
}

/**
 * Rarity tests over the corpus' document frequencies. A term seen in fewer than minDf chunks is always
 * rare and very rare. That keeps a small, young corpus usable (otherwise every word of a 10-chunk corpus
 * is "common") and matches `quietmem tf`, which only stores terms with df >= minDf.
 */
export function rarity(cfg, tf) {
  const r = cfg.recall;
  const chunks = tf?.chunks || 0, df = tf?.df || {}, minDf = r.minDf ?? 30;
  return {
    isCommon: t => (df[t] || 0) >= Math.max(minDf, chunks * r.rarePct),
    isVeryRare: t => (df[t] || 0) < Math.max(minDf, chunks * r.veryRarePct),
  };
}

/**
 * Very rare words of `text` for the exact-match lane (new names embed poorly), in the form the database
 * holds them: words of spaced scripts go to the full-text index (accents folded as FTS folds them),
 * bigrams and words of scripts without spaces to the chunks.dense index (Postgres sees a whole sentence
 * there as one word). Only letters, marks and digits, so safe in a tsquery.
 */
export function lexicalTerms(text, isVeryRare, qTerms = terms(text)) {
  const out = new Set();
  for (const { kind, raw, key } of words(text)) {
    if (kind === 'cjk') { if (qTerms.has(key) && isVeryRare(key)) out.add(key); continue; }
    // Parts of a term word: "billing-service" -> billing, service; "acme.io" -> acme.
    if (!qTerms.has(key) && !key.split('-').some(p => qTerms.has(p))) continue;
    for (const part of raw.split(/[-_.]/)) {
      const k = norm(part), n = Array.from(k).length;
      if (/^[\p{L}\p{M}\p{N}]+$/u.test(part) && n >= (/\p{sc=Hangul}/u.test(k) ? 2 : 4) && isVeryRare(k)) out.add(ftsForm(part));
    }
  }
  return [...out].slice(0, 8);
}

/**
 * Plain search (no gates), for `quietmem search` and the MCP search_memory tool. Exact-match hits on very
 * rare terms are kept even when the vector ranks them low: whoever searches for a name wants the fragments
 * that contain it. They take at most half of the results.
 */
export async function search(db, cfg, vec, text, { tf, limit = 8, ...opts } = {}) {
  const lexTerms = lexicalTerms(text, rarity(cfg, tf).isVeryRare);
  const rows = await candidates(db, cfg, vec, { ...opts, lexTerms });
  const lex = rows.filter(r => r.lex).slice(0, Math.ceil(limit / 2));
  const keep = new Set(lex.map(r => r.id));
  for (const r of rows) { if (keep.size >= limit) break; keep.add(r.id); }
  return rows.filter(r => keep.has(r.id));
}

/** Vector + lexical candidates. `vec` is the query embedding. */
export async function candidates(db, cfg, vec, { sessionId, lexTerms = [], project, current } = {}) {
  const lit = '[' + vec.join(',') + ']';
  const params = [lit];
  const where = scopeWhere(cfg, { sessionId, project, current }, params);
  const { rows } = await db.query(
    `SELECT id, project, to_char(ts,'YYYY-MM-DD') d, 1 - (embedding <=> $1::vector) AS s, content
       FROM chunks WHERE ${where}
      ORDER BY embedding <=> $1::vector LIMIT ${Number(cfg.recall.candidates) | 0}`, params);
  const all = rows;
  const have = new Set(rows.map(r => String(r.id)));
  const add = lex => { for (const r of lex) if (!have.has(String(r.id))) { have.add(String(r.id)); all.push({ ...r, lex: true }); } };
  const fts = lexTerms.filter(t => !NOSPACE.test(t)), dense = lexTerms.filter(t => NOSPACE.test(t));
  if (fts.length) {
    const lp = [...params, fts.join(' | ')];
    add((await db.query(
      `SELECT id, project, to_char(ts,'YYYY-MM-DD') d, 1 - (embedding <=> $1::vector) AS s, content
         FROM chunks WHERE ${where} AND embedding IS NOT NULL AND ${FTS} @@ to_tsquery('simple', $${lp.length})
        ORDER BY embedding <=> $1::vector LIMIT 10`, lp)).rows);
  }
  if (dense.length) {
    // MATERIALIZED: rank the (few) chunks holding the words, instead of letting the planner walk the vector
    // index and filter, which finds nothing for a rare word.
    const lp = [...params, dense];
    try {
      add((await db.query(
        `WITH hits AS MATERIALIZED (SELECT id, project, ts, content, embedding FROM chunks
            WHERE ${where} AND embedding IS NOT NULL AND dense && $${lp.length}::text[] LIMIT 200)
         SELECT id, project, to_char(ts,'YYYY-MM-DD') d, 1 - (embedding <=> $1::vector) AS s, content
           FROM hits ORDER BY embedding <=> $1::vector LIMIT 10`, lp)).rows);
    } catch (e) { if (e.code !== '42703') throw e; }   // no dense column yet (`quietmem init`): vector and FTS only
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
  // Nothing fit (maxChars smaller than one fragment): the header alone would be noise.
  return n ? { text: out, count: n } : { text: '', count: 0 };
}

export { searchSettings };
