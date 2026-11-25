// Memory proposals: markdown files in distill.outDir, one per project and day, each proposal ending in
// a "**Decision:** pending" line that the reviewer changes to accepted/rejected.
//
// Proposals that stay pending for distill.expireDays move to <outDir>/expired/. Without expiry, a project
// nobody reviews hits maxPending and stops getting proposals forever (it happened: every project at once).

import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const PENDING = /^\*\*Decision:\*\* pending$/gm;

export const countPending = text => (text.match(PENDING) || []).length;

export function pendingFor(outDir, project) {
  if (!existsSync(outDir)) return 0;
  return readdirSync(outDir).filter(f => f.endsWith(`-${project}.md`))
    .reduce((a, f) => a + countPending(readFileSync(join(outDir, f), 'utf8')), 0);
}

// Pending proposals per project, with how close each is to maxPending. At the cap the nightly run skips the
// project silently (recall keeps working; only new proposals stop), so warn from two thirds of the way.
export function status(outDir, maxPending) {
  if (!existsSync(outDir)) return [];
  const by = {};
  for (const f of readdirSync(outDir)) {
    const m = f.match(/^\d{4}-\d\d-\d\d-(.+)\.md$/);
    if (m) by[m[1]] = (by[m[1]] || 0) + countPending(readFileSync(join(outDir, f), 'utf8'));
  }
  const near = Math.ceil(maxPending * 2 / 3);
  return Object.entries(by).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([project, pending]) => ({ project, pending, level: pending >= maxPending ? 'full' : pending >= near ? 'near' : 'ok' }));
}

export function expire(outDir, { days, today = new Date(), dryRun = false }) {
  if (!existsSync(outDir)) return [];
  const limit = new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
  const dest = join(outDir, 'expired');
  const moved = [];
  for (const f of readdirSync(outDir)) {
    const m = f.match(/^(\d{4}-\d\d-\d\d)-.+\.md$/);
    if (!m || m[1] > limit) continue;
    const n = countPending(readFileSync(join(outDir, f), 'utf8'));
    if (!n) continue;
    if (!dryRun) { mkdirSync(dest, { recursive: true }); renameSync(join(outDir, f), join(dest, f)); }
    moved.push({ file: f, pending: n });
  }
  return moved;
}
