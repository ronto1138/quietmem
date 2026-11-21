// Mask anything that looks like a secret before it is printed or injected.
// Transcripts often contain pasted keys; recall must never become a way to leak them.
// Add patterns here (with a test) when you meet a new key format.

export const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,                    // OpenAI, Anthropic (sk-ant-...), Stripe
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/g,              // Stripe, underscore form
  /\b(whsec|re|sb_secret|sb_publishable)_[A-Za-z0-9_-]{16,}/g, // webhooks, Resend, Supabase
  /\bEAA[A-Za-z0-9]{60,}/g,                               // Meta
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]{1,}(?=@)/g,      // password inside a database URL
  /\b(xai|gsk|pplx|nvapi|ghp|gho|ghs|github_pat|glpat|xox[abps])[-_][A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,                            // Google
  /\bAKIA[0-9A-Z]{16}\b/g,                                // AWS access key id
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{8,}/g,              // JWT
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g,                       // Telegram bot token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:api[_-]?key|token|secret|password|passwd|contrase(?:ñ|n)a|pwd)["']?\s*[:=]\s*["']?)[^\s"',;|`]{8,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,                                // long hex
  /\b[A-Za-z0-9+_-]{48,}={0,2}(?![\w/])/g,                // long base64 (no "/" so paths and URLs survive)
];

export const redact = s => SECRET_PATTERNS.reduce((t, re) => t.replace(re, (m, p1) =>
  (typeof p1 === 'string' && /[:=]/.test(p1) ? p1 : '') + '[REDACTED]'), String(s));

export const looksLikeSecret = s => SECRET_PATTERNS.some(re => { re.lastIndex = 0; const hit = re.test(s); re.lastIndex = 0; return hit; });
