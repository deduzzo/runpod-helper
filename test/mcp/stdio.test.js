import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../src/mcp/server.js', import.meta.url));
const INIT = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`;

// Server MCP reale su stdio con una configurazione vuota (nessuna chiave, nessuna rete).
function startServer() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-mcp-')), 'cfg');
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, LLMPOD_CONFIG_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const initialized = new Promise((resolve) => {
    const check = () => (out.includes('"id":1') ? resolve() : setTimeout(check, 10));
    check();
  });
  child.stdin.write(INIT);
  return { child, exited, initialized, out: () => out, err: () => err };
}

describe('server MCP su stdio: chiusura', () => {
  it('SIGTERM: chiusura ordinata, messaggio su stderr, uscita 0', async () => {
    const s = startServer();
    await s.initialized;
    s.child.kill('SIGTERM');
    expect(await s.exited).toEqual({ code: 0, signal: null });
    expect(s.err()).toMatch(/chiusura \(SIGTERM\)/);
  }, 15000);

  it('chiusura di stdin (client uscito): uscita 0', async () => {
    const s = startServer();
    await s.initialized;
    s.child.stdin.end();
    expect((await s.exited).code).toBe(0);
    expect(s.err()).toMatch(/chiusura/);
  }, 15000);
});
