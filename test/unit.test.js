import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terms, norm, tokens } from '../src/terms.js';
import { redact, looksLikeSecret } from '../src/redact.js';
import { chunkMessages, splitLong, degenerate } from '../src/chunker.js';
import { DEFAULTS, merge, maskUrl } from '../src/config.js';
import { prepare, pick, render, namedEntities, lexicalTerms, rarity, search, DEFAULT_INTENT } from '../src/recall.js';
import { projectOf } from '../src/projects.js';
import claudeCode from '../src/adapters/claude-code.js';
import jsonl from '../src/adapters/jsonl.js';
import { parseProposals, renderProposals } from '../src/distill.js';
import { countPending, status } from '../src/proposals.js';

const cfg = merge(DEFAULTS, { recall: { entities: ['acme-api', 'zorvantil'] } });
const tf = { chunks: 10000, df: { memory: 900, deploy: 400, staging: 20, migration: 350, importer: 120 } };

test('terms: distinctive words, hyphen parts, digits, accents folded', () => {
  const t = terms('¿Cómo quedó el ledger-sync en k8s con gpt5? sesión');
  assert.ok(t.has('ledger-sync') && t.has('ledger'));
  assert.ok(t.has('k8s') && t.has('gpt5'));
  assert.ok(t.has('sesion'));
  assert.ok(!t.has('como'));
  assert.equal(norm('Ñandú'), 'nandu');
});

// Fake secrets are assembled at runtime so no secret scanner (gitleaks, GitHub) sees a literal.
const fake = (...parts) => parts.join('');

test('redact: masks common key formats and keeps the label', () => {
  const s = `key ${fake('sk', '-ant-', 'abcdefghijklmnopqrstuv')} and ${fake('postgresql://user:', 'hunter2hunter2', '@localhost:5432/db')} ${fake('token', '=', 'abcd1234efgh5678')}`;
  const r = redact(s);
  assert.ok(!r.includes('abcdefghijklmnop'));
  assert.ok(!r.includes('hunter2'));
  assert.ok(r.includes('postgresql://user:[REDACTED]@localhost'));
  assert.ok(r.includes('token=[REDACTED]'));
  assert.ok(looksLikeSecret(fake('ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123')));
  assert.ok(!looksLikeSecret('plain words about a deploy'));
  assert.equal(redact('/home/me/projects/some/long/path/file.js'), '/home/me/projects/some/long/path/file.js');
});

test('chunker: splits long text with overlap and drops degenerate blobs', () => {
  const long = 'word '.repeat(600).trim();
  const parts = splitLong(long, 1200, 150);
  assert.ok(parts.length >= 3 && parts.every(p => p.length <= 1200));
  assert.ok(degenerate('A'.repeat(500)));
  const chunks = chunkMessages([
    { role: 'user', text: 'We decided the billing service moves to the new queue on 2026-11-20 because of retries.', ts: '2026-11-20T10:00:00Z' },
    { role: 'assistant', text: 'Noted: billing moves to the new queue; retries were the reason. ' + 'x'.repeat(10), ts: '2026-11-20T10:00:05Z' },
    { role: 'user', text: 'B'.repeat(3000) },
  ], DEFAULTS.index);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /^USER: We decided/);
  assert.match(chunks[0].content, /ASSISTANT: Noted/);
  assert.equal(chunks[0].ts, '2026-11-20T10:00:00Z');
});

test('chunker: skipBefore drops already-indexed messages', () => {
  const msgs = [
    { role: 'user', text: 'old message about the staging database migration plan, long enough to count', ts: '2026-11-01T10:00:00Z' },
    { role: 'user', text: 'new message about the staging database migration plan, long enough to count', ts: '2026-11-03T10:00:00Z' },
  ];
  const c = chunkMessages(msgs, DEFAULTS.index, new Date('2026-11-02T00:00:00Z'));
  assert.equal(c.length, 1);
  assert.match(c[0].content, /new message/);
});

test('gate: short prompts, machine events and prompts without entity or intent stop', () => {
  const ents = new Set(['acme-api', 'zorvantil']);
  assert.equal(prepare('yes go', cfg, { entities: ents, tf }).stop, 'short');
  assert.equal(prepare('<system-reminder>something long enough here</system-reminder>', cfg, { entities: ents, tf }).stop, 'machine_event');
  assert.equal(prepare('please check the file and fix the failing test now', cfg, { entities: ents, tf }).stop, 'no_entity');
  assert.ok(!prepare('how is the acme-api rollout to staging going', cfg, { entities: ents, tf }).stop);
  assert.ok(!prepare('what did we decide about the retry policy last week', cfg, { entities: ents, tf }).stop);
  assert.ok(!prepare('¿qué decidimos sobre la política de reintentos?', cfg, { entities: ents, tf }).stop);
});

test('gate: with no entities configured, a rare term opens it', () => {
  const q = prepare('please check the staging pipeline for the zorvantil job', cfg, { entities: new Set(), tf });
  assert.ok(!q.stop);
});

test('pick: similarity alone is not enough; very rare shared names are', () => {
  const ents = new Set(['acme-api']);
  const q = prepare('what did we decide about zorvantil and the quibbix migration', cfg, { entities: ents, tf });
  const rows = [
    { id: 1, project: 'p', d: '2026-11-01', s: 0.90, content: 'USER: yes go ahead with that' },
    { id: 2, project: 'p', d: '2026-11-02', s: 0.55, content: 'USER: zorvantil depends on the quibbix migration finishing first' },
    { id: 3, project: 'p', d: '2026-11-03', s: 0.40, content: 'USER: zorvantil quibbix again but far away' },
  ];
  const picked = pick(rows, cfg, q);
  assert.deepEqual(picked.map(p => p.id), [2]);
  const { text, count } = render(picked, cfg);
  assert.equal(count, 1);
  assert.match(text, /similarity 0\.55/);
});

test('projects: rules first, then last path segment', () => {
  const c = merge(DEFAULTS, { projects: { rules: [{ match: '/work/acme', label: 'acme' }] } });
  assert.equal(projectOf('/home/me/work/acme/api', c), 'acme');
  assert.equal(projectOf('C:\\Users\\me\\code\\billing\\', c), 'billing');
  assert.equal(projectOf(null, c), 'default');
});

test('claude-code adapter: keeps text, drops tool results and machine tags', () => {
  const u = claudeCode.parseLine({ type: 'user', timestamp: 't', cwd: '/x', message: { role: 'user', content: 'hello <system-reminder>noise</system-reminder> world' } });
  assert.equal(u.text, 'hello  world');
  assert.equal(u.cwd, '/x');
  assert.equal(claudeCode.parseLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }), null);
  const a = claudeCode.parseLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'tool_use' }] } });
  assert.equal(a.text, 'done');
  assert.equal(claudeCode.parseLine({ type: 'summary' }), null);
});

test('jsonl adapter: aliases', () => {
  const m = jsonl.parseLine({ role: 'user', text: 'hi there', timestamp: 'T', project: 'acme' });
  assert.deepEqual([m.text, m.ts, m.project], ['hi there', 'T', 'acme']);
});

test('distill: parses proposals, drops secrets and bad types, renders pending decisions', () => {
  const raw = 'noise {"proposals":[{"action":"new","file":"retry policy.md","name":"retry-policy","description":"d","type":"project","body":"Retries are capped at 3.","evidence":"10:00 — cap at 3"},{"action":"new","file":"k.md","name":"k","description":"d","type":"reference","body":"key is ' + fake('sk', '-', 'abcdefghijklmnopqrstu') + '"},{"file":"x.md","name":"x","type":"bogus","body":"b"}]} trailing';
  const p = parseProposals(raw);
  assert.equal(p.length, 1);
  assert.equal(p[0].file, 'retry_policy.md');
  const md = renderProposals('acme', '2026-11-20', p, { chunks: 3, chars: 1000, truncated: false });
  assert.equal(countPending(md), 1);
});

test('config: deep merge and masked URLs', () => {
  const c = merge(DEFAULTS, { recall: { budgetMs: 800 } });
  assert.equal(c.recall.budgetMs, 800);
  assert.equal(c.recall.minSimilarity, DEFAULTS.recall.minSimilarity);
  assert.equal(maskUrl('postgresql://quietmem:s3cret@localhost:5433/quietmem'), 'postgresql://quietmem:***@localhost:5433/quietmem');
});

test('scope: private projects are hidden from other sessions, visible in their own', async () => {
  const { scopeWhere } = await import('../src/recall.js');
  const c = merge(DEFAULTS, { recall: { private: ['client-x'] } });
  let p = [];
  assert.equal(scopeWhere(c, { sessionId: 's1' }, p), 'session_id IS DISTINCT FROM $1');          // human at the terminal
  p = [];
  assert.match(scopeWhere(c, { sessionId: 's1', current: 'acme' }, p), /project <> ALL\(\$2::text\[\]\)/);
  assert.deepEqual(p[1], ['client-x']);
  p = [];
  assert.doesNotMatch(scopeWhere(c, { current: 'client-x' }, p), /ALL/);                        // inside client-x itself
  p = ['vec'];
  const only = merge(DEFAULTS, { recall: { scope: 'project' } });
  assert.equal(scopeWhere(only, { current: null }, p), 'session_id IS DISTINCT FROM $2 AND project = $3');
  assert.equal(p[2], null);                                                                      // unknown project: nothing
});

test('entities: project labels count, unless they are common words', async () => {
  const { loadEntities } = await import('../src/recall.js');
  const t = { chunks: 10000, projects: { 'acme-api': 50, app: 4000, default: 3 }, df: { app: 2000 } };
  const e = loadEntities(DEFAULTS, t);
  assert.ok(e.has('acme-api'));
  assert.ok(!e.has('app') && !e.has('default'));
  assert.equal(loadEntities(merge(DEFAULTS, { recall: { projectsAsEntities: false } }), t).size, 0);
});

test('index: exclusion is by project label, case-insensitive', async () => {
  const { isExcluded } = await import('../src/indexer.js');
  const c = merge(DEFAULTS, { index: { exclude: ['Client-X'] } });
  assert.ok(isExcluded(c, 'client-x'));
  assert.ok(!isExcluded(c, 'acme') && !isExcluded(c, null));
});

test('stats: outcomes, injection ratio and latency from the recall log', async () => {
  const { summarize } = await import('../src/stats.js');
  const now = Date.parse('2026-11-22T12:00:00Z');
  const L = (ts, o) => JSON.stringify({ ts, ...o });
  const log = [
    L('2026-11-22T10:00:00Z', { ms: 40, injected: 0, reason: 'short' }),
    L('2026-11-22T10:01:00Z', { ms: 200, injected: 2, ph: { embed: 80, vec: 150 } }),
    L('2026-11-22T10:02:00Z', { ms: 300, injected: 0, reason: 'no_match', ph: { embed: 90, vec: 250 } }),
    L('2026-11-22T10:03:00Z', { ms: 501, injected: 0, reason: 'budget', ph: { embed: 400 } }),
    L('2026-10-01T10:00:00Z', { ms: 10, injected: 1 }),                                          // outside the window
    'not json',
  ].join('\n');
  const s = summarize(log, { days: 7, now });
  assert.equal(s.total, 4);
  assert.equal(s.searched, 3);
  assert.equal(s.injected, 1);
  assert.equal(s.injectedPct, 25);
  assert.equal(s.overBudget, 1);
  assert.equal(s.ms.max, 501);
  assert.equal(s.phases.embed, 90);
});

test('proposals: status counts pending per project and flags near and full', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'quietmem-prop-'));
  const p = n => Array.from({ length: n }, () => '**Decision:** pending').join('\n\n');
  writeFileSync(join(dir, '2026-11-20-acme.md'), p(9));
  writeFileSync(join(dir, '2026-11-21-acme.md'), p(6) + '\n\n**Decision:** accepted');
  writeFileSync(join(dir, '2026-11-21-beta.md'), p(10));
  writeFileSync(join(dir, '2026-11-21-gamma.md'), p(2));
  writeFileSync(join(dir, '2026-11-21-done.md'), '**Decision:** rejected');
  assert.deepEqual(status(dir, 15), [
    { project: 'acme', pending: 15, level: 'full' },
    { project: 'beta', pending: 10, level: 'near' },
    { project: 'gamma', pending: 2, level: 'ok' },
  ]);
  assert.deepEqual(status(join(dir, 'missing'), 15), []);
});

test('entities: multi-word and dotted names match the same words in a row', () => {
  const ents = new Set(['juan perez', 'billing service', 'acme.io', 'zorvantil']);
  assert.deepEqual(namedEntities('¿Qué le dijimos a Juan Pérez sobre el contrato?', ents), ['juan perez']);
  assert.deepEqual(namedEntities('the Billing  Service retries', ents), ['billing service']);
  assert.deepEqual(namedEntities('deploy acme.io tonight', ents), ['acme.io']);
  assert.deepEqual(namedEntities('juan wrote the billing code for perez', ents), []);   // not in a row
  assert.deepEqual(namedEntities('zorvantil-importer is slow', ents), ['zorvantil-importer']);
  assert.ok(!prepare('how did the call with Juan Pérez end up going', cfg, { entities: ents, tf }).stop);
});

test('render: returns nothing, not a bare header, when no fragment fits', () => {
  const tight = merge(cfg, { recall: { maxChars: 50 } });
  const out = render([{ d: '2026-11-01', project: 'p', s: 0.9, content: 'USER: zorvantil depends on quibbix' }], tight);
  assert.deepEqual(out, { text: '', count: 0 });
});

test('search: exact matches on very rare names survive a low vector rank', async () => {
  const { isVeryRare } = rarity(cfg, tf);
  assert.deepEqual(lexicalTerms('zorvantil memory acme-api', isVeryRare), ['zorvantil', 'acme']);   // 'api' is too short for the exact-match lane
  const near = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), project: 'p', d: '2026-11-01', s: 0.9 - i / 100, content: `near ${i}` }));
  const db = { query: async sql => ({ rows: sql.includes('to_tsquery')
    ? [{ id: '99', project: 'p', d: '2026-11-02', s: 0.3, content: 'USER: the zorvantil job' }] : sql.startsWith('SET') ? [] : near }) };
  const rows = await search(db, cfg, [0.1, 0.2], 'zorvantil memory', { tf, limit: 4 });
  assert.equal(rows.length, 4);
  assert.ok(rows.some(r => r.id === '99'), 'the only fragment naming zorvantil was dropped');
  assert.deepEqual(rows.map(r => r.id), ['1', '2', '3', '99']);                           // still ordered by similarity
});

test('terms: any alphabet; Chinese and Japanese as bigrams; Thai segmented; hiragana skipped', () => {
  const t = x => [...terms(x)];
  assert.deepEqual(t('Was hat die Straßenbahn-Gruppe gesagt?'), ['strassenbahn-gruppe', 'strassenbahn', 'gruppe', 'gesagt']);
  assert.deepEqual(t('Co mówił Łukasz Nowak?'), ['mowil', 'lukasz', 'nowak']);
  assert.deepEqual(t('Что решили с Петровым про миграцию?'), ['решили', 'петровым', 'миграцию']);
  assert.deepEqual(t('नमस्ते दुनिया योजना'), ['नमस्ते', 'दुनिया', 'योजना']);          // vowel signs stay inside the word
  assert.deepEqual(t('김민수와 회의에서 결정한 것'), ['김민수와', '회의에서', '결정한']);   // Hangul from 2 syllables
  assert.deepEqual(t('王伟决定'), ['王伟', '伟决', '决定']);
  assert.ok(!terms('我们和王伟').has('我们'));                                         // common pair
  assert.deepEqual(t('田中さんとサーバーを'), ['田中', 'サー', 'ーバ', 'バー']);
  assert.ok(terms('สวัสดีครับเราตัดสินใจ').has('ตัดสิน'));
  assert.deepEqual(t('the billing-service with gpt5を使った'), ['billing-service', 'billing', 'service', 'gpt5']);
  assert.equal(norm('が'), 'が');                                                     // dakuten survives accent folding
  assert.deepEqual(tokens('Иван Петров'), ['иван', 'петров']);
});

test('lexical lane: database form for spaced scripts, substrings for the rest', () => {
  const { isVeryRare } = rarity(cfg, tf);
  assert.deepEqual(lexicalTerms('Co mówił Łukasz o migracji?', isVeryRare), ['mowił', 'łukasz', 'migracji']);   // ó folded like the index folds it, ł kept
  assert.deepEqual(lexicalTerms('Qué pasó con la migración?', isVeryRare), ['migracion']);   // folded as FTS folds it
  assert.deepEqual(lexicalTerms('我们和王伟决定', isVeryRare), ['们和', '和王', '王伟', '伟决', '决定']);   // 我们 is a stop pair; 们和 is not
});

test('entities: names in other scripts', () => {
  const ents = new Set([norm('Иван Петров'), norm('王伟'), norm('田中'), norm('Łukasz')]);
  assert.deepEqual(namedEntities('Что мы решили с Иван Петров?', ents), ['иван петров']);
  assert.deepEqual(namedEntities('我们和王伟决定了什么', ents), ['王伟']);
  assert.deepEqual(namedEntities('田中さんと何を決めましたか', ents), ['田中']);
  assert.deepEqual(namedEntities('co mówił Łukasz', ents), ['lukasz']);
  const q = prepare('我们和王伟决定了什么', cfg, { entities: ents, tf });
  assert.ok(!q.stop, q.stop);
});

test('intent: asking to remember, in ten languages; everyday prompts do not count', () => {
  const re = new RegExp(DEFAULT_INTENT.join('|'), 'i');
  for (const p of [
    'what did we decide about the retry policy?', '¿qué decidimos sobre los reintentos?',
    'O que decidimos sobre a fila?', 'Você se lembra do problema com o importador?',
    "Qu'est-ce qu'on a décidé pour les retries ?", 'Qu’est-ce qu’on a décidé ?', 'Où en étions-nous ?',
    'Was haben wir zur Retry-Strategie beschlossen?', 'Weißt du noch, wie wir das gelöst haben?',
    'Cosa abbiamo deciso per la coda?', 'Com’è andato il rilascio?',
    'Что мы решили по поводу очереди?', 'На чём мы остановились?',
    '我们上次怎么决定的？', '数据迁移怎么样了？', '前回何を決めた？', 'インポートの件、どうなった？',
    '지난번에 어떻게 결정했지?', '마이그레이션 어떻게 됐어?',
  ]) assert.ok(re.test(p), p);
  for (const p of [
    'run the tests and fix whatever fails', 'please add a retry with exponential backoff to the importer',
    'corre los tests y arregla lo que falle', 'la política de privacidad dice que no guardamos datos',
    'translate this paragraph into French', 'set the budget to 800 ms for slow laptops',
  ]) assert.ok(!re.test(p), p);
});

test('stopwords: function words of more languages, written with accents, never content words', () => {
  assert.ok(!terms('pourquoi toujours maintenant').size);
  assert.ok(!terms('können vielleicht wirklich').size);
  assert.ok(!terms('perché abbiamo sempre').size);
  assert.ok(!terms('сейчас пожалуйста спасибо').size);
  assert.ok(!terms('그리고 그래서 감사합니다').size);
  assert.deepEqual([...terms('la prima del seguro y la factura')], ['prima', 'seguro', 'factura']);   // Spanish content words stay
});
