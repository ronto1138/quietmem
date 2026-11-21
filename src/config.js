// Configuration: defaults <- config file <- environment variables.
//
// Config file lookup (first one found wins):
//   1. $QUIETMEM_CONFIG
//   2. ./quietmem.config.json
//   3. ~/.quietmem/config.json
//
// Secrets never need to live in the config file: QUIETMEM_DATABASE_URL overrides database.url, and
// embedder.apiKeyEnv names the variable that holds an embedding API key (the key itself is never stored).

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULTS = {
  dataDir: '~/.quietmem',
  database: {
    url: 'postgresql://quietmem:quietmem@localhost:5433/quietmem',
    index: 'hnsw',          // 'hnsw' (default) or 'ivfflat'
    efSearch: 40,           // hnsw.ef_search
    probes: 10,             // ivfflat.probes
  },
  embedder: {
    provider: 'ollama',     // 'ollama' | 'openai' (any OpenAI-compatible /v1/embeddings endpoint)
    url: 'http://localhost:11434',
    model: 'nomic-embed-text:v1.5',
    dimensions: 768,
    queryPrefix: 'search_query: ',       // nomic-embed-text expects task prefixes; set '' for other models
    documentPrefix: 'search_document: ',
    apiKeyEnv: null,        // e.g. 'OPENAI_API_KEY' for provider 'openai'
    keepAlive: '4h',        // ollama only: keep the model loaded between prompts
  },
  recall: {
    budgetMs: 500,          // hard wall-clock limit for the hook; past it, inject nothing
    minChars: 25,
    minWords: 4,
    candidates: 30,
    maxFragments: 4,
    fragmentChars: 700,
    maxChars: 4800,
    minSimilarity: 0.72,
    lowSimilarity: 0.5,
    minSharedTerms: 2,
    rarePct: 0.03,          // a term is "rare" if it appears in < 3% of chunks
    veryRarePct: 0.003,     // "very rare": < 0.3% of chunks
    minDf: 30,              // below this many chunks a term always counts as rare (small corpora)
    entities: [],           // names that open the gate: projects, clients, tools, people
    entitiesFile: null,     // optional file, one entity per line, '#' comments
    intentPatterns: null,   // null = built-in English + Spanish "do you remember / what did we decide"
  },
  index: {
    chunkChars: 1200,
    hardMax: 1600,
    overlap: 150,
    minChars: 80,
    batch: 16,
    skipSubagents: true,    // Claude Code: ignore agent-*.jsonl transcripts
    sources: [],            // [{ adapter: 'claude-code', dir: '~/.claude/projects' }, { adapter: 'jsonl', dir: '...' }]
  },
  // Project label for a transcript: first matching rule on the session's working directory,
  // else the last segment of that directory.
  projects: {
    rules: [],              // [{ match: '^/home/me/work/acme', label: 'acme' }]
  },
  distill: {
    command: ['claude', '-p', '--output-format', 'text'],   // any command that reads a prompt on stdin
    shell: false,           // true runs the command through a shell (Windows: needed for .cmd shims like claude.cmd)
    scrubEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
    timeoutMs: 600000,
    timezone: 'UTC',
    language: 'English',
    minChars: 3000,
    maxChars: 400000,
    maxProjects: 10,
    maxPending: 15,
    expireDays: 14,
    outDir: '~/.quietmem/proposals',
    promptFile: null,       // null = prompts/distill.md from this package
    contextFiles: [],       // extra files the distiller should know (e.g. a global memory file)
    memoryIndex: null,      // path template of each project's existing memory index, '{project}' is replaced
  },
};

export const expandHome = p => (typeof p === 'string' && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
export function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export function configPath(cwd = process.cwd()) {
  for (const p of [process.env.QUIETMEM_CONFIG, join(cwd, 'quietmem.config.json'), join(homedir(), '.quietmem', 'config.json')]) {
    if (p && existsSync(p)) return resolve(p);
  }
  return null;
}

export function loadConfig({ cwd, file } = {}) {
  const path = file || configPath(cwd);
  let cfg = DEFAULTS;
  if (path) cfg = merge(DEFAULTS, JSON.parse(readFileSync(path, 'utf8')));
  if (process.env.QUIETMEM_DATABASE_URL) cfg = merge(cfg, { database: { url: process.env.QUIETMEM_DATABASE_URL } });
  if (process.env.QUIETMEM_EMBEDDER_URL) cfg = merge(cfg, { embedder: { url: process.env.QUIETMEM_EMBEDDER_URL } });
  if (process.env.QUIETMEM_BUDGET_MS) cfg = merge(cfg, { recall: { budgetMs: Number(process.env.QUIETMEM_BUDGET_MS) } });
  cfg = merge(cfg, { dataDir: expandHome(cfg.dataDir), distill: { outDir: expandHome(cfg.distill.outDir) } });
  return Object.defineProperty(cfg, 'path', { value: path, enumerable: false });
}

// Never print a password: for diagnostics, show the URL with the password masked.
export const maskUrl = u => String(u).replace(/(\/\/[^:/@]+:)[^@]*@/, '$1***@');
