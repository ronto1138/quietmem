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
const WITH_VALUE = new Set(['--config', '--adapter', '--session', '--limit', '--project', '--date', '--hook', '--min', '--days', '--before']);
const positional = () => argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !WITH_VALUE.has(all[i - 1]));

const { loadConfig, maskUrl } = await import('../src/config.js');
const cfg = loadConfig({ file: CONFIG_FILE });
const readStdin = () => { try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return null; } };

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
if (cmd === '--version' || cmd === '-v' || cmd === 'version') { console.log(VERSION); process.exit(0); }

const HELP = `quietmem ${VERSION} — local, precision-first memory for AI coding agents

Setup
  quietmem setup [--hooks]              first run: config, schema, index, term frequencies (and hooks)
  quietmem init                         create tables and indexes (needs pgvector)
  quietmem doctor                       check config, database and embedder; time each recall phase
  quietmem install claude-code [--write | --remove]   print, merge or remove the Claude Code hooks

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

Your data
  quietmem stats [--days n] [--json]    how often recall searched, injected or stayed quiet, and how fast
  quietmem forget --session id | --project p | --before YYYY-MM-DD [--yes]   delete indexed chunks

Proposals
  quietmem distill [--date YYYY-MM-DD] [--project p] [--force]
  quietmem proposals expire [--dry-run]

Options: --config <file>, --version. Config: $QUIETMEM_CONFIG, ./quietmem.config.json or ~/.quietmem/config.json.
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
  const { projectOf } = await import('../src/projects.js');
  const current = cwd ? projectOf(cwd, cfg) : null;
  const tf = R.loadTermFrequencies(cfg);
  const q = R.prepare(prompt, cfg, { entities: R.loadEntities(cfg, tf), tf });
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
  try { rows = await R.candidates(db, cfg, vec, { sessionId, lexTerms: q.lexTerms, current }); mark('query'); db.end().catch(() => {}); }
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
        const { isExcluded } = await import('../src/indexer.js');
        const { rows } = await db.query('SELECT session_id, byte_offset, project, excluded FROM index_state');
        // A session excluded before whose project is no longer excluded must be read again from the start.
        const seen = new Map(rows.filter(r => !(r.excluded && !isExcluded(cfg, r.project))).map(r => [r.session_id, Number(r.byte_offset)]));
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
    if (!prompt) throw new Error('usage: quietmem recall "text" [--debug] [--project p]');
    const tf = R.loadTermFrequencies(cfg);
    const q = R.prepare(prompt, cfg, { entities: R.loadEntities(cfg, tf), tf });
    if (q.stop) { console.log(`no recall: ${q.stop}`); return; }
    console.error(`terms=${[...q.qTerms].join(',')} named=${q.named.join(',')} intent=${q.intent} lex=${q.lexTerms.join(',')}`);
    const { makeEmbedder } = await import('../src/embedder.js');
    const vec = await makeEmbedder(cfg).query(prompt.slice(0, 2000));
    const rows = await withDb(async db => { await db.query(R.searchSettings(cfg)); return R.candidates(db, cfg, vec, { lexTerms: q.lexTerms, ...(opt('project') ? { current: opt('project') } : {}) }); });
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
    let projects = {};
    const rows = await withDb(async db => {
      await db.query('SET statement_timeout = 0');
      const { rows: pr } = await db.query('SELECT project, count(*)::int n FROM chunks GROUP BY project ORDER BY 2 DESC');
      projects = Object.fromEntries(pr.map(r => [r.project, r.n]));
      return (await db.query('SELECT content FROM chunks')).rows;
    });
    const df = new Map();
    for (const { content } of rows) for (const t of terms(content)) df.set(t, (df.get(t) || 0) + 1);
    const kept = Object.fromEntries([...df].filter(([, n]) => n >= MIN_KEEP).sort((a, b) => b[1] - a[1]));
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(join(cfg.dataDir, 'term-frequencies.json'), JSON.stringify({ built: new Date().toISOString(), chunks: rows.length, min_keep: MIN_KEEP, projects, df: kept }));
    console.log(`chunks=${rows.length} projects=${Object.keys(projects).length} vocabulary=${df.size} kept(df>=${MIN_KEEP})=${Object.keys(kept).length}`);
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
    if (argv[1] === 'status') {
      const { status } = await import('../src/proposals.js');
      const rows = status(cfg.distill.outDir, cfg.distill.maxPending);
      if (!rows.length) return console.log('no pending proposals');
      const tag = { full: `FULL: no new proposals until reviewed`, near: 'near the cap', ok: '' };
      for (const r of rows) console.log(`${r.project.padEnd(24)} ${String(r.pending).padStart(3)}/${cfg.distill.maxPending}  ${tag[r.level]}`);
      return;
    }
    if (argv[1] !== 'expire') throw new Error('usage: quietmem proposals status | quietmem proposals expire [--dry-run]');
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
    const ents = R.loadEntities(cfg, tf);
    ents.size ? ok(`${ents.size} entities (configured and project labels)`) : console.log('  warn  no entities configured: recall gate is looser (see docs/configuration.md)');
    const { status: pstatus } = await import('../src/proposals.js');
    for (const r of pstatus(cfg.distill.outDir, cfg.distill.maxPending).filter(r => r.level !== 'ok'))
      console.log(`  warn  ${r.project}: ${r.pending}/${cfg.distill.maxPending} pending proposals${r.level === 'full' ? ', distill skips it until they are reviewed' : ', near the cap'}`);
    const { makeEmbedder } = await import('../src/embedder.js');
    const { connect } = await import('../src/db.js');
    const emb = makeEmbedder(cfg);
    let vec;
    try { let a = performance.now(); vec = await emb.query('quietmem doctor probe'); const cold = performance.now() - a;
      a = performance.now(); await emb.query('quietmem doctor probe two'); ok(`embedder: ${vec.length} dims, first ${Math.round(cold)} ms, warm ${Math.round(performance.now() - a)} ms`);
      if (vec.length !== Number(cfg.embedder.dimensions)) bad(`embedder returns ${vec.length} dims but config says ${cfg.embedder.dimensions}`);
    } catch (e) {
      bad(`embedder: ${errMsg(e)}`);
      if (cfg.embedder.provider === 'ollama') console.log(`        is Ollama running, and is the model pulled? ollama pull ${cfg.embedder.model}`);
    }
    let db;
    try { const a = performance.now(); db = await connect(cfg); await db.query(R.searchSettings(cfg)); ok(`database connect: ${Math.round(performance.now() - a)} ms`); }
    catch (e) { bad(`database: ${errMsg(e)}`); const h = hint(e); if (h) console.log(`        ${h}`); return; }
    try {
      const { rows: [n] } = await db.query('SELECT count(*)::int n FROM chunks');
      ok(`${n.n} chunks indexed`);
      if (!vec) return;
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
    } catch (e) { bad(`query: ${errMsg(e)}`); }
    finally { await db.end().catch(() => {}); }
    console.log(`recall budget: ${cfg.recall.budgetMs} ms · scope: ${cfg.recall.scope}` +
      (cfg.recall.private.length ? ` · private: ${cfg.recall.private.join(', ')}` : '') +
      (cfg.index.exclude.length ? ` · never indexed: ${cfg.index.exclude.join(', ')}` : ''));
  },

  async install() {
    if (argv[1] !== 'claude-code') throw new Error('usage: quietmem install claude-code [--write | --remove]');
    await installClaudeCode({ write: flag('write'), remove: flag('remove') });
  },

  async stats() {
    const { summarize } = await import('../src/stats.js');
    const file = join(cfg.dataDir, 'recall.log.jsonl');
    if (!existsSync(file)) { console.log(`no recall log yet (${file}): it fills as the hooks run`); return; }
    const s = summarize(readFileSync(file, 'utf8'), { days: Number(opt('days', 7)) });
    if (flag('json')) { console.log(JSON.stringify(s, null, 2)); return; }
    console.log(`last ${s.days} days: ${s.total} prompts, ${s.searched} searched, ${s.injected} injected ` +
      `(${s.injectedPct}% of prompts, ${s.injectedOfSearchedPct}% of searches)`);
    console.log('outcomes:   ' + Object.entries(s.reasons).map(([k, v]) => `${k} ${v}`).join(' · '));
    if (s.searched) {
      console.log(`latency:    p50 ${s.ms.p50} ms · p90 ${s.ms.p90} ms · max ${s.ms.max} ms · over budget ${s.overBudget}`);
      console.log('phases p50: ' + Object.entries(s.phases).map(([k, v]) => `${k} ${v}`).join(' · ') + '  (ms since start)');
    }
  },

  async forget() {
    const session = opt('session'), project = opt('project'), before = opt('before');
    if (!session && !project && !before) throw new Error('usage: quietmem forget --session id | --project p | --before YYYY-MM-DD [--yes]');
    if (before && !/^\d{4}-\d\d-\d\d$/.test(before)) throw new Error('--before must be YYYY-MM-DD');
    const params = [], where = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (session) add('session_id = ?', session);
    if (project) add('project = ?', project);
    if (before) add('ts < ?::date', before);
    const w = where.join(' AND ');
    await withDb(async db => {
      const { rows: [c] } = await db.query(`SELECT count(*)::int n, count(DISTINCT session_id)::int s FROM chunks WHERE ${w}`, params);
      if (!flag('yes')) { console.log(`would delete ${c.n} chunks from ${c.s} sessions. Rerun with --yes to delete them.`); return; }
      await db.query(`DELETE FROM chunks WHERE ${w}`, params);
      console.log(`deleted ${c.n} chunks from ${c.s} sessions.`);
      // index_state stays on purpose: those transcripts are not read again, only lines appended later.
      if (project) {
        const { isExcluded } = await import('../src/indexer.js');
        if (!isExcluded(cfg, project)) console.log(`new sessions of "${project}" will still be indexed: add it to index.exclude to stop that.`);
      }
      console.log('run `quietmem tf` to refresh term frequencies.');
    });
  },

  async setup() {
    const { homedir } = await import('node:os');
    console.log(`quietmem ${VERSION} setup\n`);
    if (cfg.path) console.log(`1. config: ${cfg.path}`);
    else {
      const p = join(homedir(), '.quietmem', 'config.json');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({
        index: { sources: [{ adapter: 'claude-code', dir: '~/.claude/projects' }], exclude: [] },
        recall: { entities: [], private: [] },
        projects: { rules: [] },
      }, null, 2) + '\n');
      console.log(`1. config: created ${p} (edit it later: entities, private projects, exclusions)`);
    }
    const { connect } = await import('../src/db.js');
    try { const db = await connect(cfg); await db.end(); console.log(`2. database: ${maskUrl(cfg.database.url)} ok`); }
    catch (e) {
      console.log(`2. database: ${maskUrl(cfg.database.url)} FAILED: ${errMsg(e)}`);
      console.log(`   ${hint(e) || 'check QUIETMEM_DATABASE_URL'}`);
      console.log('   To start one, in the quietmem folder:');
      console.log('     export QUIETMEM_DB_PASSWORD="$(openssl rand -hex 16)" && docker compose up -d');
      console.log('     export QUIETMEM_DATABASE_URL="postgresql://quietmem:${QUIETMEM_DB_PASSWORD}@localhost:5433/quietmem"');
      process.exitCode = 1; return;
    }
    const { makeEmbedder } = await import('../src/embedder.js');
    try {
      const v = await makeEmbedder(cfg).query('quietmem setup');
      console.log(`3. embedder: ${cfg.embedder.model}, ${v.length} dimensions ok`);
      if (v.length !== Number(cfg.embedder.dimensions)) {
        console.log(`   but embedder.dimensions is ${cfg.embedder.dimensions}: fix the config first`);
        process.exitCode = 1; return;
      }
    } catch (e) {
      console.log(`3. embedder: FAILED: ${errMsg(e)}`);
      if (cfg.embedder.provider === 'ollama') console.log(`   install Ollama (https://ollama.com), then: ollama pull ${cfg.embedder.model}`);
      process.exitCode = 1; return;
    }
    process.stdout.write('4. schema: '); await commands.init();
    process.stdout.write('5. index: '); argv.push('--sweep'); await commands.index();
    process.stdout.write('6. term frequencies: '); await commands.tf();
    if (flag('hooks')) { process.stdout.write('7. hooks: '); await installClaudeCode({ write: true }); }
    else console.log('7. hooks: run `quietmem install claude-code --write` for automatic recall in Claude Code (MCP clients: see README)');
    console.log('\nDone. Try: quietmem recall "what did we decide about <something you worked on>" --debug');
  },

  async mcp() { await import('../src/mcp.js').then(m => m.serve(cfg)); },
};

async function installClaudeCode({ write = false, remove = false } = {}) {
    const cmdLine = `node "${SELF.replace(/\\/g, '/')}"`;
    const hooks = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${cmdLine} recall --hook claude-code`, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${cmdLine} index --hook claude-code`, timeout: 5 }] }],
    };
    if (!write && !remove) { console.log(JSON.stringify({ hooks }, null, 2)); console.error('\nAdd this to ~/.claude/settings.json, or rerun with --write to merge it.'); return; }
    const { homedir } = await import('node:os');
    const p = join(homedir(), '.claude', 'settings.json');
    const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    if (existsSync(p)) writeFileSync(p + '.bak-quietmem', readFileSync(p));
    s.hooks = s.hooks || {};
    for (const [ev, entries] of Object.entries(hooks)) {
      const cur = (s.hooks[ev] || []).filter(e => !JSON.stringify(e).includes(' recall --hook claude-code') && !JSON.stringify(e).includes(' index --hook claude-code'));
      s.hooks[ev] = remove ? cur : [...cur, ...entries];
      if (!s.hooks[ev].length) delete s.hooks[ev];
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
    console.log(`hooks ${remove ? 'removed from' : 'written to'} ${p} (backup: settings.json.bak-quietmem)`);
}
// Node reports a refused connection to both ::1 and 127.0.0.1 as an AggregateError with an empty message.
const errMsg = e => e?.message || e?.errors?.map(x => x.message).filter(Boolean).join('; ') || e?.code || String(e);

// One-line advice for the errors people hit first.
function hint(e) {
  const m = errMsg(e) + ' ' + (e?.code || '') + ' ' + (e?.errors?.map(x => x.code).join(' ') || '');
  if (/password authentication failed|28P01/.test(m)) return 'the database rejected the login: QUIETMEM_DATABASE_URL must carry the same QUIETMEM_DB_PASSWORD the database was created with';
  if (/ECONNREFUSED/.test(m)) return 'nothing is listening there: is the database running? (docker compose up -d in the quietmem folder)';
  if (/relation "(chunks|index_state)" does not exist|42P01/.test(m)) return 'no schema yet: run `quietmem init` (or `quietmem setup`)';
  if (/type "vector" does not exist|extension "vector"/.test(m)) return 'this Postgres lacks pgvector: use the pgvector/pgvector image from docker-compose.yml';
  return null;
}

const run = commands[cmd] || (cmd ? null : commands.help);
if (!run) { console.error(`unknown command "${cmd}"\n\n${HELP}`); process.exit(2); }
try { await run(); }
catch (e) { const h = hint(e); console.error(`quietmem ${cmd}: ${errMsg(e)}${h ? `\n  ${h}` : ''}`); process.exit(1); }
