// Adapter for Claude Code transcripts (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl).
//
// Each line is a JSON event. We keep user and assistant text, drop tool results, and strip the
// machine-generated tags Claude Code places inside "user" messages (system reminders, task
// notifications, command output): the human did not write those.

import { readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

const MACHINE_BLOCK = /<(system-reminder|task-notification|local-command-[a-z]+|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|user-prompt-submit-hook|ide_[a-z_]+)>[\s\S]*?<\/\1>/g;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some(b => b && b.type === 'tool_result')) return null;
  const parts = content.filter(b => b && b.type === 'text').map(b => b.text || '').filter(s => s.trim());
  return parts.length ? parts.join('\n') : null;
}

export default {
  name: 'claude-code',
  defaultDirs: ['~/.claude/projects'],

  listFiles(dir, cfg) {
    const out = [];
    let subs = [];
    try { subs = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(dir, d.name)); } catch {}
    for (const sub of subs) {
      let files = [];
      try { files = readdirSync(sub); } catch {}
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        if (cfg.index.skipSubagents && f.startsWith('agent-')) continue;
        out.push(join(sub, f));
      }
    }
    return out;
  },

  sessionId: path => basename(path, '.jsonl'),

  // Used when no message carries a cwd: the encoded folder name, e.g. "-home-me-acme".
  fallbackProject: path => basename(dirname(path)).replace(/^-+/, '') || 'default',

  parseLine(d) {
    if (d.type !== 'user' && d.type !== 'assistant') return null;
    const msg = d.message || {};
    if (msg.role !== 'user' && msg.role !== 'assistant') return null;
    let t = textOf(msg.content);
    if (!t) return null;
    if (msg.role === 'user') t = t.replace(MACHINE_BLOCK, '');
    t = t.trim();
    if (!t) return null;
    return { role: msg.role, text: t, ts: d.timestamp || null, cwd: d.cwd || null };
  },

  // Stop hook event: { session_id, transcript_path, cwd, ... }
  stopEvent: ev => (ev.transcript_path && ev.session_id ? { path: ev.transcript_path, sessionId: ev.session_id, cwd: ev.cwd } : null),

  // UserPromptSubmit hook event: { prompt, session_id, cwd, ... }. Whatever we print on stdout is
  // added to the model's context for that turn.
  promptEvent: ev => ({ prompt: String(ev.prompt || '').trim(), sessionId: ev.session_id || null, cwd: ev.cwd || null }),
};
