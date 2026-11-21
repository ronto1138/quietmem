#!/usr/bin/env node
// Refuses to let a secret or a private file into the repository. Runs in CI and as a pre-commit hook:
//   npm run check-secrets             scan every tracked or staged file
//   ln -s ../../scripts/pre-commit .git/hooks/pre-commit
//
// Checks: forbidden file names (configs, env files, logs, transcripts), the secret patterns quietmem itself
// redacts, and database URLs carrying a password other than the documented placeholders.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { SECRET_PATTERNS } from '../src/redact.js';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).filter(f => existsSync(f) && statSync(f).isFile());

const FORBIDDEN_NAMES = [/(^|\/)quietmem\.config\.json$/, /(^|\/)\.env(\.|$)(?!example)/, /\.log(\.jsonl)?$/, /term-frequencies\.json$/,
  /(^|\/)proposals\//, /\.(pem|key|p12|pfx)$/];
// Placeholders that may appear in docs and examples.
const ALLOWED = [
  /postgresql:\/\/quietmem:(CHANGE_ME|quietmem|\.\.\.|\$\{QUIETMEM_DB_PASSWORD\}|\[REDACTED\]|\*\*\*|s3cret)@/,
  /PASSWORD[:=]\s*"?\$[({]/,                 // PASSWORD: ${VAR} / PASSWORD="$(openssl rand ...)": a reference, not a value
  /"integrity":\s*"sha(256|384|512)-/,       // package-lock.json integrity hashes
];
// Files that contain example secrets on purpose (tests of the redactor itself).
// .gitleaksignore holds commit:file:rule fingerprints (40-hex commit ids), not secrets.
const SELF_TESTS = new Set(['test/unit.test.js', 'src/redact.js', 'scripts/check-secrets.js', '.gitleaksignore']);
// Personal or machine-specific markers that should never ship. Extend locally via QUIETMEM_PRIVATE_MARKERS="a,b".
const PRIVATE = (process.env.QUIETMEM_PRIVATE_MARKERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const problems = [];
for (const f of files) {
  if (FORBIDDEN_NAMES.some(re => re.test(f)) && !f.endsWith('.example.json')) problems.push(`${f}: file must not be committed`);
  if (f.startsWith('node_modules/')) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;   // binary
  // Lockfile integrity hashes are long base64 by design; blank them (line numbers stay the same).
  if (f.endsWith('package-lock.json')) text = text.replace(/"integrity": "sha\d+-[^"]+"/g, '"integrity": ""');
  const lower = text.toLowerCase();
  for (const m of PRIVATE) if (lower.includes(m)) problems.push(`${f}: contains private marker "${m}"`);
  if (SELF_TESTS.has(f)) continue;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (const hit of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      const around = text.slice(Math.max(0, hit.index - 40), hit.index + hit[0].length + 40);
      if (ALLOWED.some(a => a.test(around))) continue;
      const line = text.slice(0, hit.index).split('\n').length;
      problems.push(`${f}:${line}: looks like a secret (pattern ${re.source.slice(0, 30)}...)`);   // never print the match
    }
  }
}

if (problems.length) {
  console.error('check-secrets: refusing\n  ' + [...new Set(problems)].join('\n  '));
  process.exit(1);
}
console.log(`check-secrets: ${files.length} files clean`);
