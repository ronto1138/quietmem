// Turn a conversation (a list of messages) into overlapping text chunks for embedding.
// Lengths are measured in code points, not UTF-16 units, so an emoji counts as one character.
// Degenerate text (base64 blobs, repeated logs) is dropped: it compresses to < 10% of its size.

import { deflateSync } from 'node:zlib';

const cpLen = s => { let n = 0; for (const _ of s) n++; return n; };
const cpSlice = (s, a, b) => Array.from(s).slice(a, b).join('');

export function splitLong(text, size, overlap) {
  const cps = Array.from(text);
  if (cps.length <= size) return [text];
  const lastIn = (lo, hi, pat) => {
    for (let k = hi - pat.length; k >= lo; k--) {
      let hit = true;
      for (let m = 0; m < pat.length; m++) if (cps[k + m] !== pat[m]) { hit = false; break; }
      if (hit) return k - lo;
    }
    return -1;
  };
  const out = [];
  let i = 0;
  while (i < cps.length) {
    let end = Math.min(i + size, cps.length);
    if (end < cps.length) {
      const cut = Math.max(lastIn(i, end, '\n'), lastIn(i, end, '. '), lastIn(i, end, ' '));
      if (cut > size * 0.5) end = i + cut + 1;
    }
    out.push(cps.slice(i, end).join('').trim());
    if (end >= cps.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out.filter(c => c.trim());
}

export const degenerate = t => {
  const n = cpLen(t);
  return n >= 200 && deflateSync(Buffer.from(t, 'utf8'), { level: 6 }).length / n < 0.10;
};

/**
 * @param {Array<{role:'user'|'assistant', text:string, ts?:string|null}>} messages
 * @param {{chunkChars:number, hardMax:number, overlap:number, minChars:number}} opt
 * @param {Date|null} skipBefore  messages at or before this time are already indexed
 * @returns {Array<{ts:string|null, content:string}>}
 */
export function chunkMessages(messages, opt, skipBefore = null) {
  const { chunkChars, hardMax, overlap, minChars } = opt;
  const chunks = [];
  let buf = [], size = 0, ts = null;
  const flush = () => {
    if (!buf.length) return;
    const body = buf.join('\n').trim().replace(/\n{3,}/g, '\n\n');
    if (cpLen(body) >= minChars && !degenerate(body)) chunks.push({ ts, content: cpSlice(body, 0, hardMax) });
    buf = []; size = 0;
  };
  for (const m of messages) {
    if (skipBefore && m.ts && new Date(m.ts) <= skipBefore) continue;
    const t = (m.text || '').trim();
    if (!t) continue;
    const tag = m.role === 'user' ? 'USER' : 'ASSISTANT';
    splitLong(t, chunkChars, overlap).forEach((p, k) => {
      // Measure degeneracy per piece, before merging: junk glued to real text would otherwise pass.
      if (degenerate(p)) return;
      const piece = k === 0 ? `${tag}: ${p}` : `${tag} (cont.): ${p}`;
      const plen = cpLen(piece);
      if (size + plen > chunkChars && buf.length) flush();
      if (ts === null || !buf.length) ts = m.ts || null;
      buf.push(piece); size += plen;
      if (size >= chunkChars) flush();
    });
  }
  flush();
  return chunks;
}
