// Embedding providers. node:http(s) instead of fetch: fetch loads undici on first use (~100 ms),
// which matters inside a 500 ms hook.
//
//   ollama  POST {url}/api/embed          { model, input, keep_alive }
//   openai  POST {url}/v1/embeddings      { model, input }   (OpenAI, LM Studio, vLLM, llama.cpp server, ...)

import http from 'node:http';
import https from 'node:https';

function postJson(url, body, { headers = {}, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', d => s += d);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`embedder HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('embedder timeout')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

export function makeEmbedder(cfg) {
  const e = cfg.embedder;
  const base = e.url.replace(/\/+$/, '');
  const auth = () => {
    if (!e.apiKeyEnv) return {};
    const key = process.env[e.apiKeyEnv];
    if (!key) throw new Error(`embedder: environment variable ${e.apiKeyEnv} is not set`);
    return { Authorization: `Bearer ${key}` };
  };
  async function raw(texts, timeoutMs) {
    if (e.provider === 'ollama') {
      const r = await postJson(`${base}/api/embed`, { model: e.model, input: texts, keep_alive: e.keepAlive }, { timeoutMs, headers: auth() });
      return r.embeddings;
    }
    if (e.provider === 'openai') {
      const r = await postJson(`${base}/v1/embeddings`, { model: e.model, input: texts }, { timeoutMs, headers: auth() });
      return r.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    }
    throw new Error(`embedder: unknown provider "${e.provider}"`);
  }
  // Adaptive batch: if a batch fails (context too long), split it in half.
  async function many(texts, timeoutMs) {
    try { return await raw(texts, timeoutMs); }
    catch (err) {
      if (texts.length === 1) throw err;
      const m = texts.length >> 1;
      return [...await many(texts.slice(0, m), timeoutMs), ...await many(texts.slice(m), timeoutMs)];
    }
  }
  return {
    query: (text, timeoutMs) => raw([e.queryPrefix + text], timeoutMs).then(v => v[0]),
    documents: (texts, timeoutMs) => many(texts.map(t => e.documentPrefix + t), timeoutMs),
    // Ollama unloads idle models; loading takes seconds. Warming keeps the next prompt fast.
    warm: () => raw(['warm'], 60000).then(() => true),
  };
}
