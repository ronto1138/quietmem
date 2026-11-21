// Append-only JSONL logs in dataDir. Never log prompt text or fragment content: only counts and timings.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function makeLog(cfg, name, t0 = performance.now()) {
  const file = join(cfg.dataDir, `${name}.log.jsonl`);
  return rec => {
    try {
      mkdirSync(cfg.dataDir, { recursive: true });
      // One write call per line: appends under PIPE_BUF are atomic on POSIX, so concurrent hooks don't interleave.
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ms: Math.round(performance.now() - t0), ...rec }) + '\n');
    } catch {}
  };
}
