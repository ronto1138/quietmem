import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terms, norm } from '../src/terms.js';
import { redact, looksLikeSecret } from '../src/redact.js';
import { chunkMessages, splitLong, degenerate } from '../src/chunker.js';
import { DEFAULTS, merge, maskUrl } from '../src/config.js';
import { prepare, pick, render } from '../src/recall.js';
import { projectOf } from '../src/projects.js';
import claudeCode from '../src/adapters/claude-code.js';
import jsonl from '../src/adapters/jsonl.js';
import { parseProposals, renderProposals } from '../src/distill.js';
import { countPending } from '../src/proposals.js';

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

test('redact: masks common key formats and keeps the label', () => {
  const s = 'key sk-ant-abcdefghijklmnopqrstuv and postgresql://user:hunter2hunter2@localhost:5432/db token=abcd1234efgh5678';
  const r = redact(s);
  assert.ok(!r.includes('abcdefghijklmnop'));
  assert.ok(!r.includes('hunter2'));
  assert.ok(r.includes('postgresql://user:[REDACTED]@localhost'));
  assert.ok(r.includes('token=[REDACTED]'));
  assert.ok(looksLikeSecret('ghp_abcdefghijklmnopqrstuvwxyz0123'));
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
  const raw = 'noise {"proposals":[{"action":"new","file":"retry policy.md","name":"retry-policy","description":"d","type":"project","body":"Retries are capped at 3.","evidence":"10:00 — cap at 3"},{"action":"new","file":"k.md","name":"k","description":"d","type":"reference","body":"key is sk-abcdefghijklmnopqrstu"},{"file":"x.md","name":"x","type":"bogus","body":"b"}]} trailing';
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
