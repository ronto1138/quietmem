#!/usr/bin/env node
// quietmem — local, precision-first memory for AI coding agents. Run `quietmem help`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// QUIETMEM_DISABLE=1: a session that should neither be recalled into nor indexed (e.g. the distiller itself).
if (process.env.QUIETMEM_DISABLE) process.exit(0);

const T0 = performance.now();
const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
// --config <file> is global and may come before the command.
const raw = process.argv.slice(2);
const ci = raw.indexOf('--config');
const CONFIG_FILE = ci >= 0 ? raw[ci + 1] : undefined;
const argv = ci >= 0 ? [...raw.slice(0, ci), ...raw.slice(ci + 2)] : raw;
const cmd = argv[0];
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const WITH_VALUE = new Set(['--config', '--adapter', '--session', '--limit', '--project', '--date', '--hook', '--min']);
const positional = () => argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !WITH_VALUE.has(all[i - 1]));

const { loadConfig, maskUrl } = await import('../src/config.js');
const cfg = loadConfig({ file: CONFIG_FILE });
const readStdin = () => { try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return null; } };

const HELP = `quietmem — local, precision-first memory for AI coding agents

Setup
  quietmem init                         create tables and indexes (needs pgvector)
  quietmem doctor                       check config, database and embedder; time each recall phase
  quietmem install claude-code [--write] print (or merge into ~/.claude/settings.json) the hooks

Indexing
  quietmem index --sweep                index everything new in the configured sources
  quietmem index <file> [--adapter a]   index one transcript
  quietmem index --hook <adapter>       hook mode: read the event on stdin, index in the background
  quietmem tf                           rebuild term frequencies (run after big corpus changes)

Recall
  quietmem recall --hook <adapter>      hook mode: read the prompt event on stdin, print fragments (or nothing)
  quietmem recall "text" [--debug]      try the gates on a prompt
  quietmem search "text" [--limit n] [--project p]   plain semantic search, no gates
  quietmem mcp                          MCP server over stdio (search_memory, recall_memory)

Proposals
  quietmem distill [--date YYYY-MM-DD] [--project p] [--force]
  quietmem proposals expire [--dry-run]

Options: --config <file>. Config: $QUIETMEM_CONFIG, ./quietmem.config.json or ~/.quietmem/config.json.
`;

// ---------------------------------------------------------------- recall (hook)

async function recallHook(adapterName) {
  const { getAdapter } = await import('../src/adapters/index.js');
  const { makeLog } = await import('../src/log.js');
  const log = makeLog(cfg, 'recall', T0);
  const budget = cfg.recall.budgetMs;
  const ph = {};
  const mark = k => { ph[k] = Math.round(performance.now() - T0); };
  let embedded = false, writing = false;
  const bail = (reason, extra = {}) => { log({ injected: 0, reason, ...extra }); process.exit(0); };

  // Hard budget: whatever happens, at budget ms we exit without injecting. If the embedding had not
  // arrived, the model is probably unloaded; closing our request would cancel the load, so a detached
  // `quietmem warm` finishes loading it and the next prompt arrives warm.
  setTimeout(() => {
    if (writing) return;
    if (!embedded) {
      try { spawn(process.execPath, [SELF, 'warm', ...(CONFIG_FILE ? ['--config', CONFIG_FILE] : [])], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
    }
    bail('budget', { budget_ms: budget, embedded, ph });
  }, budget).unref();

  const ev = readStdin();
  if (!ev) bail('bad_stdin');
  mark('stdin');
  const adapter = getAdapter(adapterName);
  const { prompt, sessionId, cwd } = adapter.promptEvent(ev);
  const R = await import('../src/recall.js');
  const q = R.prepare(prompt, cfg, { entities: R.loadEntities(cfg), tf: R.loadTermFrequencies(cfg) });
  if (q.stop) bail(q.stop);

  const { makeEmbedder } = await import('../src/embedder.js');
  const { connect } = await import('../src/db.js');
  const emb = makeEmbedder(cfg);
  let vec, db;
  try {
    [vec, db] = await Promise.all([
      emb.query(prompt.slice(0, 2000), budget).then(v => { embedded = true; mark('embed'); return v; }),
      connect(cfg, { timeoutMs: budget, statementTimeoutMs: budget })
        .then(async c => { await c.query(R.searchSettings(cfg)); mark('connect'); return c; }),
    ]);
  } catch (e) { bail('prep_fail', { err: e.code || e.name, ph }); }

  let rows;
  try { rows = await R.candidates(db, cfg, vec, { sessionId, lexTerms: q.lexTerms }); mark('query'); db.end().catch(() => {}); }
  catch (e) { bail('db_fail', { err: e.code || e.name, ph }); }

  const picked = R.pick(rows, cfg, q);
  const stats = { top: rows[0] ? Number(rows[0].s.toFixed(3)) : null, q_terms: q.qTerms.size, rare: q.rare.length,
    named: q.named.length, intent: q.intent, lex: q.lexTerms.length, ph };
  if (!picked.length) bail('no_match', stats);
  const { text, count } = R.render(picked, cfg);
  writing = true;
  log({ injected: count, chars: text.length, sims: picked.slice(0, count).map(p => Number(p.s.toFixed(3))), ...stats });
  // Exit only after stdout drained: on Windows pipe writes are async and an early exit can truncate.
  setTimeout(() => process.exit(0), 1500).unref();
  await new Promise(r => process.stdout.write(text, r));
  process.exit(0);
}

// ---------------------------------------------------------------- commands

async function withDb(fn, opts) {
  const { connect } = await import('../src/db.js');
  const db = await connect(cfg, opts);
  try { return await fn(db); } finally { await db.end().catch(() => {}); }
}

const commands = {
  help: () => console.log(HELP),

  async init() {
    const { schemaSql } = await import('../src/db.js');
    await withDb(db => db.query(schemaSql(cfg)));
    console.log(`schema ready (${cfg.embedder.dimensions} dimensions, ${cfg.database.index} index) at ${maskUrl(cfg.database.url)}`);
  },

  async index() {
    const { getAdapter } = await import('../src/adapters/index.js');
    if (flag('hook')) {
      // Never block the agent: hand the work to a detached process and exit.
      const adapter = getAdapter(opt('hook'));
      const target = adapter.stopEvent(readStdin() || {});
      if (target) spawn(process.execPath, [SELF, 'index', target.path, '--adapter', adapter.name, '--session', target.sessionId,
        ...(CONFIG_FILE ? ['--config', CONFIG_FILE] : [])], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return;
    }
    const { makeLog } = await import('../src/log.js');
    const { makeEmbedder } = await import('../src/embedder.js');
    const { indexFile, listSources } = await import('../src/indexer.js');
    const log = makeLog(cfg, 'index', T0);
    const emb = makeEmbedder(cfg);
    await withDb(async db => {
      if (flag('sweep')) {
        const { rows } = await db.query('SELECT session_id, byte_offset FROM index_state');
        const seen = new Map(rows.map(r => [r.session_id, Number(r.byte_offset)]));
        let files = 0, chunks = 0, errors = 0;
        for (const s of listSources(cfg, getAdapter)) {
          const sid = s.adapter.sessionId(s.path);
          if (seen.has(sid) && seen.get(sid) >= s.size) continue;
          try { const r = await indexFile(db, cfg, emb, s.adapter, s.path, sid); log({ mode: 'sweep', ...r }); if (r.chunks) { files++; chunks += r.chunks; } }
          catch (e) { errors++; log({ mode: 'sweep', session: sid, reason: 'error', err: String(e.message || e).slice(0, 200) }); }
        }
        const { rows: [t] } = await db.query('SELECT count(*)::int n FROM chunks');
        console.log(`sweep: ${files} transcripts with news, ${chunks} new chunks, ${errors} errors, ${t.n} chunks total`);
        if (errors) process.exitCode = 1;
        return;
      }
      const [file] = positional();
      if (!file) throw new Error('usage: quietmem index <file> | --sweep | --hook <adapter>');
      const adapter = getAdapter(opt('adapter', 'claude-code'));
      try { const r = await indexFile(db, cfg, emb, adapter, file, opt('session')); log({ mode: 'file', ...r }); if (!flag('session')) console.log(JSON.stringify(r)); }
      catch (e) { log({ mode: 'file', reason: 'error', err: String(e.message || e).slice(0, 200) }); throw e; }
    });
  },

  async recall() {
    if (flag('hook')) return recallHook(opt('hook'));
    const prompt = positional().join(' ');
    const R = await import('../src/recall.js');
    const q = R.prepare(prompt, cfg, { entities: R.loadEntities(cfg), tf: R.loadTermFrequencies(cfg) });
    if (q.stop) { console.log(`no recall: ${q.stop}`); return; }
    console.error(`terms=${[...q.qTerms].join(',')} named=${q.named.join(',')} intent=${q.intent} lex=${q.lexTerms.join(',')}`);
    const { makeEmbedder } = await import('../src/embedder.js');
    const vec = await makeEmbedder(cfg).query(prompt.slice(0, 2000));
    const rows = await withDb(async db => { await db.query(R.searchSettings(cfg)); return R.candidates(db, cfg, vec, { lexTerms: q.lexTerms }); });
    const picked = R.pick(rows, cfg, q, flag('debug') ? m => console.error(m) : null);
    console.log(picked.length ? R.render(picked, cfg).text : 'no recall: no_match');
  },

  async search() {
    const text = positional().join(' ');
    if (!text) throw new Error('usage: quietmem search "text" [--limit n] [--project p]');
    const R = await import('../src/recall.js');
    const { redact } = await import('../src/redact.js');
    const { makeEmbedder } = await import('../src/embedder.js');
    const vec = await makeEmbedder(cfg).query(text);
    const rows = await withDb(async db => { await db.query(R.searchSettings(cfg)); return R.candidates(db, cfg, vec, { lexTerms: [], project: opt('project') }); });
    for (const r of rows.slice(0, Number(opt('limit', 8)))) console.log(`\n— ${r.d} · ${r.project} · ${r.s.toFixed(3)}\n${redact(r.content).slice(0, 600)}`);
  },

  async tf() {
    const { terms } = await import('../src/terms.js');
    const MIN_KEEP = Number(opt('min', 30));
    const rows = await withDb(async db => { await db.query('SET statement_timeout = 0'); return (await db.query('SELECT content FROM chunks')).rows; });
    const df = new Map();
    for (const { content } of rows) for (const t of terms(content)) df.set(t, (df.get(t) || 0) + 1);
    const kept = Object.fromEntries([...df].filter(([, n]) => n >= MIN_KEEP).sort((a, b) => b[1] - a[1]));
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(join(cfg.dataDir, 'term-frequencies.json'), JSON.stringify({ built: new Date().toISOString(), chunks: rows.length, min_keep: MIN_KEEP, df: kept }));
    console.log(`chunks=${rows.length} vocabulary=${df.size} kept(df>=${MIN_KEEP})=${Object.keys(kept).length}`);
  },

  async warm() {
    const { makeEmbedder } = await import('../src/embedder.js');
    await makeEmbedder(cfg).warm().catch(() => {});
  },

  async distill() {
    const { distill, dayKey } = await import('../src/distill.js');
    const { makeLog } = await import('../src/log.js');
    const day = opt('date') || dayKey(new Date(Date.now() - 86400000), cfg.distill.timezone);
    const log = makeLog(cfg, 'distill', T0);
    await withDb(db => distill(db, cfg, { day, project: opt('project'), force: flag('force'), log: r => log({ day, ...r }) }));
  },

  async proposals() {
    if (argv[1] !== 'expire') throw new Error('usage: quietmem proposals expire [--dry-run]');
    const { expire } = await import('../src/proposals.js');
    const moved = expire(cfg.distill.outDir, { days: cfg.distill.expireDays, dryRun: flag('dry-run') });
    console.log(`${flag('dry-run') ? '[dry run] ' : ''}${moved.length} files expired, ${moved.reduce((a, m) => a + m.pending, 0)} proposals`);
  },

  async doctor() {
    const ok = (m) => console.log(`  ok    ${m}`), bad = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };
    console.log(`config: ${cfg.path || '(defaults only)'}`);
    console.log(`database: ${maskUrl(cfg.database.url)} · embedder: ${cfg.embedder.provider} ${cfg.embedder.model} at ${cfg.embedder.url}`);
    const R = await import('../src/recall.js');
    const tf = R.loadTermFrequencies(cfg);
    tf ? ok(`term frequencies: ${tf.chunks} chunks (built ${tf.built.slice(0, 10)})`) : bad('no term frequencies yet: run `quietmem tf` after indexing');
    const ents = R.loadEntities(cfg);
    ents.size ? ok(`${ents.size} entities`) : console.log('  warn  no entities configured: recall gate is looser (see docs/configuration.md)');
    const { makeEmbedder } = await import('../src/embedder.js');
    const { connect } = await import('../src/db.js');
    const emb = makeEmbedder(cfg);
    let vec;
    try { let a = performance.now(); vec = await emb.query('quietmem doctor probe'); const cold = performance.now() - a;
      a = performance.now(); await emb.query('quietmem doctor probe two'); ok(`embedder: ${vec.length} dims, first ${Math.round(cold)} ms, warm ${Math.round(performance.now() - a)} ms`);
      if (vec.length !== Number(cfg.embedder.dimensions)) bad(`embedder returns ${vec.length} dims but config says ${cfg.embedder.dimensions}`);
    } catch (e) { bad(`embedder: ${e.message}`); return; }
    let db;
    try { const a = performance.now(); db = await connect(cfg); await db.query(R.searchSettings(cfg)); ok(`database connect: ${Math.round(performance.now() - a)} ms`); }
    catch (e) { bad(`database: ${e.message}`); return; }
    try {
      const { rows: [n] } = await db.query('SELECT count(*)::int n FROM chunks');
      ok(`${n.n} chunks indexed`);
      const lit = '[' + vec.join(',') + ']';
      const sql = 'SELECT id FROM chunks ORDER BY embedding <=> $1::vector LIMIT 30';
      for (const run of [1, 2]) {
        const a = performance.now();
        const { rows } = await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, [lit]);
        const p = rows[0]['QUERY PLAN'][0];
        ok(`vector query run ${run}: ${Math.round(performance.now() - a)} ms client, ${Math.round(p['Execution Time'])} ms server, ` +
          `${p.Plan['Shared Read Blocks'] ?? 0} blocks read from disk`);
      }
      const { rows: [sz] } = await db.query(`SELECT pg_size_pretty(pg_relation_size('chunks_embedding_idx')) idx, current_setting('shared_buffers') sb`);
      console.log(`  info  vector index ${sz.idx}, shared_buffers ${sz.sb}: if the index does not fit, cold queries read from disk (docs/performance.md)`);
    } catch (e) { bad(`query: ${e.message}`); }
    finally { await db.end().catch(() => {}); }
    console.log(`recall budget: ${cfg.recall.budgetMs} ms`);
  },

  async install() {
    if (argv[1] !== 'claude-code') throw new Error('usage: quietmem install claude-code [--write]');
    const cmdLine = `node "${SELF.replace(/\\/g, '/')}"`;
    const hooks = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${cmdLine} recall --hook claude-code`, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${cmdLine} index --hook claude-code`, timeout: 5 }] }],
    };
    if (!flag('write')) { console.log(JSON.stringify({ hooks }, null, 2)); console.error('\nAdd this to ~/.claude/settings.json, or rerun with --write to merge it.'); return; }
    const { homedir } = await import('node:os');
    const p = join(homedir(), '.claude', 'settings.json');
    const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    if (existsSync(p)) writeFileSync(p + '.bak-quietmem', readFileSync(p));
    s.hooks = s.hooks || {};
    for (const [ev, entries] of Object.entries(hooks)) {
      const cur = (s.hooks[ev] || []).filter(e => !JSON.stringify(e).includes(' recall --hook claude-code') && !JSON.stringify(e).includes(' index --hook claude-code'));
      s.hooks[ev] = [...cur, ...entries];
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
    console.log(`hooks written to ${p} (backup: settings.json.bak-quietmem)`);
  },

  async mcp() { await import('../src/mcp.js').then(m => m.serve(cfg)); },
};

const run = commands[cmd] || (cmd ? null : commands.help);
if (!run) { console.error(`unknown command "${cmd}"\n\n${HELP}`); process.exit(2); }
try { await run(); }
catch (e) { console.error(`quietmem ${cmd}: ${e.message}`); process.exit(1); }
