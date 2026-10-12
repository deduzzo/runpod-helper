#!/usr/bin/env node
// Server MCP di llmpod (stdio): strumenti per far gestire a Claude Code (o a un altro client MCP) ricerca, piano, avvio,
// monitoraggio, tuning e spegnimento dei Pod. Registrato nel progetto con .mcp.json; avviabile anche con "llmpod mcp".
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createContext, VERSION } from '../cli/context.js';
import { createJobs } from '../server/jobs.js';
import { redact } from '../core/secrets.js';
import { createTools, READ_ONLY_TOOLS } from './tools.js';
import { validateInput } from './schema.js';

export { READ_ONLY_TOOLS };

const INSTRUCTIONS = [
  'llmpod: LLM self-hosted su Runpod con vLLM. Rispondi in italiano.',
  'Prima di ogni operazione che costa mostra le opzioni (GPU, varianti) con prezzo e disponibilità e fai scegliere l\'utente; preferisci varianti con MTP/decodifica speculativa.',
  'Spesa: up richiede up_preview, la scelta dell\'utente, confirm: true ed expectedHourlyUSD; tune/keep/down richiedono confirm: true dopo l\'anteprima.',
  'I Pod si ELIMINANO sempre (down), mai fermati; a fine lavoro verifica con status l\'elenco completo dei Pod.',
  'Le domande pendenti dei job (job_status) vanno mostrate all\'utente prima di rispondere con job_answer.',
  'Non leggere né stampare mai chiavi o token; per i client usa client_commands (llmpod run …). Non toccare Pod che l\'utente sta usando senza permesso.',
].join('\n');

// Output dell'interfaccia (prompt, avvisi) su stderr: stdout è riservato al protocollo MCP.
function silentIo() {
  const err = (t) => process.stderr.write(`${redact(t)}\n`);
  return { interactive: false, askChoice: null, out: err, raw: err, err, ask: async () => false, askText: async (_q, def) => def, askSecret: async () => '' };
}

const textResult = (value, isError = false) => ({ content: [{ type: 'text', text: redact(JSON.stringify(value, null, 2)) }], ...(isError ? { isError: true } : {}) });

export function createMcpServer({ env = process.env, overrides = {}, questionTimeoutMs = 30 * 60_000 } = {}) {
  const ctx = createContext({ env, io: silentIo(), overrides });
  const jobs = createJobs({ questionTimeoutMs });
  const tools = createTools({ ctx, jobs });
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function callTool(name, args = {}) {
    try {
      ctx.store.readEnv(); // registra chiavi e token come segreti da mascherare in ogni risposta
      const tool = byName.get(name);
      if (!tool) throw Object.assign(new Error(`Strumento sconosciuto: ${name}`), { code: 'NOT_FOUND' });
      const input = validateInput(tool.inputSchema, args ?? {});
      return textResult(await tool.run(input));
    } catch (err) {
      return textResult({ error: { code: err.code ?? 'INTERNAL', message: String(err.message ?? err), ...(err.hint ? { hint: String(err.hint) } : {}) } }, true);
    }
  }

  const server = new Server({ name: 'llmpod', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments ?? {}));
  return { server, tools, jobs, callTool, ctx };
}

export async function startStdioServer({ env = process.env } = {}) {
  const { server, jobs } = createMcpServer({ env });
  const transport = new StdioServerTransport();
  // Fine sessione: chiusura del trasporto o dello stdin (il client MCP è uscito).
  const closed = new Promise((resolve) => {
    transport.onclose = resolve;
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  await server.connect(transport);
  await closed;
  jobs.close();
}

// Avvio diretto: node src/mcp/server.js
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  startStdioServer().catch((err) => {
    process.stderr.write(`llmpod-mcp: ${redact(err.message)}\n`);
    process.exit(1);
  });
}
