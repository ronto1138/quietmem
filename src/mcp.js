// MCP server over stdio: makes quietmem usable from any MCP client (Cursor, Codex CLI, Windsurf, Zed,
// Claude Desktop, ...). Clients without prompt hooks cannot inject memory automatically, so the model
// asks for it through these tools.
//
//   search_memory   plain semantic + lexical search, no precision gates (the model asked explicitly)
//   recall_memory   the same gated recall the hooks use: returns nothing unless it is confident

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { connect } from './db.js';
import { makeEmbedder } from './embedder.js';
import { redact } from './redact.js';
import * as R from './recall.js';

export async function serve(cfg) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const server = new McpServer({ name: 'quietmem', version });
  const emb = makeEmbedder(cfg);
  const entities = R.loadEntities(cfg);
  const tf = R.loadTermFrequencies(cfg);
  const text = t => ({ content: [{ type: 'text', text: t }] });

  async function rowsFor(query, opts) {
    const vec = await emb.query(query.slice(0, 2000));
    const db = await connect(cfg);
    try { await db.query(R.searchSettings(cfg)); return await R.candidates(db, cfg, vec, opts); }
    finally { await db.end().catch(() => {}); }
  }

  server.tool('search_memory',
    'Search past conversations with the user (all projects unless one is given). Use it when the user refers to earlier work, decisions or context you do not have.',
    { query: z.string().min(3), limit: z.number().int().min(1).max(20).optional(), project: z.string().optional() },
    async ({ query, limit = 8, project }) => {
      const rows = (await rowsFor(query, { lexTerms: [], project })).slice(0, limit);
      if (!rows.length) return text('No matching fragments.');
      return text(rows.map(r => `— ${r.d} · ${r.project} · similarity ${r.s.toFixed(2)}\n${redact(r.content).slice(0, 900)}`).join('\n\n'));
    });

  server.tool('recall_memory',
    'High-precision recall for the current user message: returns past fragments only when they clearly match, otherwise nothing.',
    { message: z.string().min(1) },
    async ({ message }) => {
      const q = R.prepare(message, cfg, { entities, tf });
      if (q.stop) return text(`No recall (${q.stop}).`);
      const picked = R.pick(await rowsFor(message, { lexTerms: q.lexTerms }), cfg, q);
      return text(picked.length ? R.render(picked, cfg).text : 'No recall (no_match).');
    });

  await server.connect(new StdioServerTransport());
}
