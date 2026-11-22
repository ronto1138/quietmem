// Summary of recall.log.jsonl: how often recall searched, injected or stayed quiet, and how fast.
// The log holds counts and timings only (never prompt or fragment text), so this is safe to share.

const SEARCHED = new Set(['no_match', 'budget', 'db_fail', 'prep_fail']);

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);

export function summarize(text, { days = 7, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const recs = [];
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (Date.parse(r.ts) >= since) recs.push(r); } catch {}
  }
  const reasons = {};
  const searched = recs.filter(r => r.injected > 0 || SEARCHED.has(r.reason));
  for (const r of recs) { const k = r.injected > 0 ? 'injected' : r.reason || 'unknown'; reasons[k] = (reasons[k] || 0) + 1; }
  const phaseKeys = [...new Set(searched.flatMap(r => Object.keys(r.ph || {})))];
  const phases = Object.fromEntries(phaseKeys.map(k => [k, quantile(searched.map(r => r.ph?.[k]).filter(v => v != null), 0.5)]));
  const ms = searched.map(r => r.ms).filter(v => v != null);
  const injected = recs.filter(r => r.injected > 0).length;
  return {
    days, total: recs.length, searched: searched.length, injected,
    injectedPct: pct(injected, recs.length), injectedOfSearchedPct: pct(injected, searched.length),
    reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    ms: { p50: quantile(ms, 0.5), p90: quantile(ms, 0.9), max: ms.length ? Math.max(...ms) : null },
    overBudget: recs.filter(r => r.reason === 'budget').length,
    phases,
  };
}
