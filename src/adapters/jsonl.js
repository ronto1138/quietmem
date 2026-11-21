// Generic adapter: one conversation per file, one JSON message per line.
//
//   {"role": "user", "content": "...", "ts": "2026-11-20T10:00:00Z", "cwd": "/path/to/project"}
//   {"role": "assistant", "content": "...", "ts": "2026-11-20T10:00:05Z"}
//
// Accepted aliases: text for content, timestamp for ts, project instead of cwd. The session id is the
// file name. Any harness can feed quietmem by exporting to this format; a native adapter is nicer (see
// docs/adapters.md), but this one is the lowest common denominator.

import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export default {
  name: 'jsonl',
  defaultDirs: [],

  listFiles(dir) {
    try { return readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f)); } catch { return []; }
  },

  sessionId: path => basename(path, '.jsonl'),
  fallbackProject: () => 'default',

  parseLine(d) {
    if (d.role !== 'user' && d.role !== 'assistant') return null;
    const raw = d.content ?? d.text;
    const text = typeof raw === 'string' ? raw
      : Array.isArray(raw) ? raw.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '';
    if (!text.trim()) return null;
    return { role: d.role, text: text.trim(), ts: d.ts || d.timestamp || null, cwd: d.cwd || null, project: d.project || null };
  },

  stopEvent: ev => (ev.path ? { path: ev.path, sessionId: ev.session_id || basename(ev.path, '.jsonl'), cwd: ev.cwd } : null),
  promptEvent: ev => ({ prompt: String(ev.prompt || '').trim(), sessionId: ev.session_id || null, cwd: ev.cwd || null }),
};
