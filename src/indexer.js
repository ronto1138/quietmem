// Incremental indexing, transcript by transcript.
//
// We read only the complete lines appended since the last run (index_state.byte_offset), in blocks:
// a long-lived transcript can be hundreds of MB, more than fits in one JS string. Re-embedding a whole
// session on every change was what made the first version of this slow (23k chunks, 9 minutes a night).

import { openSync, readSync, fstatSync, closeSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chunkMessages } from './chunker.js';
import { projectOf } from './projects.js';
import { expandHome } from './config.js';

const BLOCK = 64 * 1024 * 1024;

export function readBlock(path, offset, max = BLOCK) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { lines: [], next: offset, size };
    const len = Math.min(size - offset, max);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) { const n = readSync(fd, buf, got, len - got, offset + got); if (!n) break; got += n; }
    const last = buf.lastIndexOf(0x0a, got - 1);
    if (last < 0) {
      // A single line bigger than the block: try once with 4x before giving up.
      if (len === max && max === BLOCK) return readBlock(path, offset, BLOCK * 4);
      return { lines: [], next: offset, size };
    }
    const lines = buf.subarray(0, last).toString('utf8').split('\n').filter(Boolean);
    return { lines, next: offset + last + 1, size };
  } finally { closeSync(fd); }
}

export function parseLines(lines, adapter) {
  const out = [];
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = adapter.parseLine(d);
    if (m) out.push(m);
  }
  return out;
}

export async function indexFile(db, cfg, embedder, adapter, rawPath, sessionId = adapter.sessionId(rawPath)) {
  const path = resolve(rawPath);
  if (!existsSync(path)) return { session: sessionId, reason: 'no_file' };
  const { rows: [lock] } = await db.query('SELECT pg_try_advisory_lock(hashtext($1)) ok', [sessionId]);
  if (!lock.ok) return { session: sessionId, reason: 'locked' };
  try {
    const { rows: [st] } = await db.query('SELECT byte_offset, baseline_ts, project FROM index_state WHERE session_id=$1', [sessionId]);
    let offset = st ? Number(st.byte_offset) : 0;
    let skipBefore = st ? st.baseline_ts : null;
    let project = st?.project || null;
    if (!st) {
      // Session already in the corpus without saved progress (e.g. imported): skip what it has.
      const { rows: [m] } = await db.query('SELECT max(ts) mx FROM chunks WHERE session_id=$1', [sessionId]);
      skipBefore = m.mx;
    }
    let total = 0, bytes = 0;
    for (let round = 0; round < 1000; round++) {
      const { lines, next } = readBlock(path, offset);
      if (next === offset) break;
      const messages = parseLines(lines, adapter);
      if (!project) {
        const withDir = messages.find(m => m.project || m.cwd);
        project = withDir ? (withDir.project || projectOf(withDir.cwd, cfg)) : adapter.fallbackProject(path);
      }
      const chunks = chunkMessages(messages, cfg.index, skipBefore);
      await db.query('BEGIN');
      try {
        for (let i = 0; i < chunks.length; i += cfg.index.batch) {
          const b = chunks.slice(i, i + cfg.index.batch);
          const vecs = await embedder.documents(b.map(c => c.content));
          const vals = [], params = [];
          b.forEach((c, j) => {
            const k = j * 7;
            vals.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5},$${k + 6},$${k + 7}::vector)`);
            params.push(adapter.name, project, path, sessionId, c.ts, c.content, '[' + vecs[j].join(',') + ']');
          });
          await db.query(`INSERT INTO chunks(source,project,path,session_id,ts,content,embedding) VALUES ${vals.join(',')}`, params);
        }
        await db.query(
          `INSERT INTO index_state(session_id,path,project,byte_offset,baseline_ts,updated_at) VALUES ($1,$2,$3,$4,$5,now())
           ON CONFLICT (session_id) DO UPDATE SET path=$2, project=$3, byte_offset=$4, baseline_ts=$5, updated_at=now()`,
          [sessionId, path, project, next, skipBefore]);
        await db.query('COMMIT');
      } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      total += chunks.length; bytes += next - offset; offset = next;
    }
    return { session: sessionId, project, chunks: total, bytes };
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtext($1))', [sessionId]).catch(() => {});
  }
}

/** All transcript files from the configured sources, with what is already indexed. */
export function listSources(cfg, getAdapter) {
  const sources = cfg.index.sources.length ? cfg.index.sources
    : [{ adapter: 'claude-code', dir: '~/.claude/projects' }];
  const out = [];
  for (const s of sources) {
    const adapter = getAdapter(s.adapter);
    for (const f of adapter.listFiles(expandHome(s.dir), cfg)) {
      let size; try { size = statSync(f).size; } catch { continue; }
      out.push({ adapter, path: f, size });
    }
  }
  return out;
}
