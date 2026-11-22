// End to end against a real Postgres + pgvector, with a fake embedder (no Ollama needed).
//
//   QUIETMEM_TEST_DATABASE_URL=postgresql://... npm test
//
// WARNING: the test drops and recreates the quietmem tables in that database. Point it at a throwaway one
// (CI uses a service container). Without the variable, the test is skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createHash } from 'node:crypto';

const URL_ = process.env.QUIETMEM_TEST_DATABASE_URL;
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quietmem.js');
const DIMS = 64;

// Bag-of-words embedder that speaks the Ollama API: texts that share words are close.
function embed(text) {
  const v = new Array(DIMS).fill(0);
  for (const w of String(text).toLowerCase().replace(/^search_(query|document): /, '').match(/[a-z0-9]{3,}/g) || []) {
    v[createHash('md5').update(w).digest()[0] % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

function startEmbedder() {
  const server = http.createServer((req, res) => {
    let s = ''; req.on('data', d => s += d);
    req.on('end', () => {
      const { input } = JSON.parse(s);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ embeddings: (Array.isArray(input) ? input : [input]).map(embed) }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

const session = (cwd, lines) => lines.map(([role, content], i) =>
  JSON.stringify({ role, content, ts: `2026-11-1${i}T10:00:00Z`, cwd })).join('\n') + '\n';

test('e2e: index, exclusion, private projects, recall, forget, stats', { skip: !URL_ && 'set QUIETMEM_TEST_DATABASE_URL' }, async () => {
  const emb = await startEmbedder();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'quietmem-e2e-'));
    const src = join(dir, 'sessions'); mkdirSync(src);
    writeFileSync(join(src, 's-acme.jsonl'), session('/work/acme', [
      ['user', 'For the zorvantil importer in acme we need retries with exponential backoff, what do you suggest for the queue?'],
      ['assistant', 'Decision for acme: zorvantil importer retries five times with exponential backoff and a dead letter queue after that.'],
    ]));
    writeFileSync(join(src, 's-client.jsonl'), session('/work/client-x', [
      ['user', 'Client X confidential: the zorvantil retries contract pays per retry and the backoff must stay hidden from them.'],
      ['assistant', 'Understood, client X zorvantil retries stay confidential, backoff details only in the private repository.'],
    ]));
    writeFileSync(join(src, 's-secret.jsonl'), session('/work/secret-proj', [
      ['user', 'This secret project must never be indexed: zorvantil retries backoff details for the secret project only.'],
      ['assistant', 'Agreed, nothing from the secret project about zorvantil retries should ever be stored anywhere at all.'],
    ]));
    const cfgFile = join(dir, 'config.json');
    writeFileSync(cfgFile, JSON.stringify({
      dataDir: join(dir, 'data'),
      embedder: { provider: 'ollama', url: `http://127.0.0.1:${emb.address().port}`, dimensions: DIMS },
      index: { sources: [{ adapter: 'jsonl', dir: src }], exclude: ['secret-proj'] },
      recall: { private: ['client-x'], lowSimilarity: 0.1, budgetMs: 30000 },   // generous: slow CI disks, not latency, are being tested
    }));
    const env = { ...process.env, QUIETMEM_DATABASE_URL: URL_ };
    delete env.QUIETMEM_DISABLE;
    // Async on purpose: the fake embedder runs in this process, so a blocking spawn would deadlock.
    const q = (args, input = '') => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [BIN, '--config', cfgFile, ...args], { env });
      let out = '', err = '';
      p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
      const timer = setTimeout(() => p.kill(), 60000);
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`quietmem ${args.join(' ')} exited ${code}:\n${out}\n${err}`)); });
      p.stdin.end(input);
    });
    const psql = async sql => {
      const { default: pg } = await import('pg');
      const c = new pg.Client({ connectionString: URL_ }); await c.connect();
      try { return (await c.query(sql)).rows; } finally { await c.end(); }
    };

    await psql('DROP TABLE IF EXISTS chunks, index_state');
    await q(['init']);
    assert.match(await q(['index', '--sweep']), /0 errors/);
    const byProject = Object.fromEntries((await psql('SELECT project, count(*)::int n FROM chunks GROUP BY 1')).map(r => [r.project, r.n]));
    assert.ok(byProject.acme > 0 && byProject['client-x'] > 0, JSON.stringify(byProject));
    assert.equal(byProject['secret-proj'], undefined, 'excluded project was indexed');
    const [ex] = await psql(`SELECT excluded FROM index_state WHERE session_id = 's-secret'`);
    assert.equal(ex.excluded, true);
    assert.match(await q(['index', '--sweep']), /0 transcripts with news/);               // nothing re-read

    assert.match(await q(['tf']), /projects=2/);
    const ask = (cwd, session_id = 'now') => q(['recall', '--hook', 'jsonl'],
      JSON.stringify({ prompt: 'what did we decide about the zorvantil retries and the backoff?', session_id, cwd }));
    const fromAcme = await ask('/work/acme');
    const logTail = () => readFileSync(join(dir, 'data', 'recall.log.jsonl'), 'utf8').trim().split('\n').slice(-3).join('\n');
    assert.match(fromAcme, /acme/, logTail());
    assert.doesNotMatch(fromAcme, /client X|confidential/i, 'private project leaked into another project');
    const fromClient = await ask('/work/client-x');
    assert.match(fromClient, /confidential/i, logTail());                                    // visible in its own project
    assert.doesNotMatch(await ask(null), /confidential/i);                                    // unknown project: hidden

    assert.match(await q(['forget', '--project', 'acme']), /would delete \d+ chunks/);       // dry run by default
    assert.ok((await psql(`SELECT count(*)::int n FROM chunks WHERE project = 'acme'`))[0].n > 0);
    await q(['forget', '--project', 'acme', '--yes']);
    assert.equal((await psql(`SELECT count(*)::int n FROM chunks WHERE project = 'acme'`))[0].n, 0);
    assert.match(await q(['index', '--sweep']), /0 transcripts with news/);               // forgotten stays forgotten

    assert.ok(existsSync(join(dir, 'data', 'recall.log.jsonl')));
    const stats = JSON.parse(await q(['stats', '--json']));
    assert.equal(stats.total, 3);
    assert.ok(stats.injected >= 2);
    assert.doesNotMatch(readFileSync(join(dir, 'data', 'recall.log.jsonl'), 'utf8'), /zorvantil/, 'log must not hold prompt text');
  } finally { emb.close(); }
});
