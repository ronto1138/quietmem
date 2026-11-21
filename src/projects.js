// Project label for a session, from its working directory.
// First matching rule in config.projects.rules wins; otherwise the last path segment.

const lastSegment = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

export function projectOf(cwd, cfg, fallback = 'default') {
  if (!cwd) return fallback;
  const p = String(cwd).replace(/\\/g, '/');
  for (const r of cfg.projects.rules || []) {
    if (new RegExp(r.match, 'i').test(p)) return r.label;
  }
  return lastSegment(p) || fallback;
}
