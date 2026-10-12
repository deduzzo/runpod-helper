import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { createApp } from '../../src/server/app.js';
import { createRoutes } from '../../src/server/routes.js';
import { createSse } from '../../src/server/sse.js';
import { createJobs } from '../../src/server/jobs.js';
import { LlmpodError, Codes } from '../../src/core/errors.js';
import { clearSecrets } from '../../src/core/secrets.js';
import { apiClient, request } from './helpers.js';

const TOKEN = 'token-api-keep-di-prova-5566778899';
let server; let port; let sse; let jobs; let ctx; let call;

beforeEach(async () => {
  clearSecrets();
  ctx = {
    env: {},
    store: { readConfig: () => ({}), listProfiles: () => ['qwen3-coder'], readProfile: () => ({}) },
    ops: { keep: vi.fn(async () => ({ podId: 'pod1', idleLimitSeconds: 1800, maxSeconds: 43200, uptimeSeconds: 7200, remainingSeconds: 36000, expiresAt: '2026-01-01T20:00:00.000Z', hourlyUSD: 1.5, maxCostUSD: 15, saved: false })) },
    makeOps: () => ctx.ops,
    advisor: { config: () => null, provider: () => null },
    hf: {}, http: {},
  };
  sse = createSse();
  jobs = createJobs({ questionTimeoutMs: 1000, onEvent: (e) => sse.broadcast('job', e) });
  server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  call = apiClient({ port, token: TOKEN });
  server.on('request', createApp({ ctx, token: TOKEN, port, staticDir: null, jobs, version: '0.1.0', routes: createRoutes({ ctx, jobs, sse, state: {} }) }));
});
afterEach(() => { sse.close(); server.close(); });

describe('POST /api/pods/:profile/watchdog', () => {
  it('prolunga il Pod del profilo (la conferma del costo è già stata data nell\'interfaccia) e restituisce i nuovi limiti', async () => {
    const r = await call('/api/pods/qwen3-coder/watchdog', { method: 'POST', body: { idleMinutes: 0, maxHours: 12 } });
    expect(r.status).toBe(200);
    expect(ctx.ops.keep).toHaveBeenCalledWith('qwen3-coder', { idleMinutes: 0, maxHours: 12, yes: true });
    expect(r.json).toMatchObject({ podId: 'pod1', maxSeconds: 43200, remainingSeconds: 36000, maxCostUSD: 15 });
  });

  it('limiti non validi → 400 (la validazione è di ops.keep) e gli errori dei Pod diventano 400 con il messaggio', async () => {
    ctx.ops.keep.mockRejectedValueOnce(new LlmpodError(Codes.INVALID_INPUT, 'Ore massime deve essere tra 0.25 e 168'));
    const bad = await call('/api/pods/qwen3-coder/watchdog', { method: 'POST', body: { maxHours: 500 } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/Ore massime/) });
    ctx.ops.keep.mockRejectedValueOnce(new LlmpodError(Codes.INVALID_INPUT, 'supervisore di una versione precedente', { hint: 'llmpod down x e llmpod up x' }));
    const old = await call('/api/pods/qwen3-coder/watchdog', { method: 'POST', body: { maxHours: 12 } });
    expect(old.status).toBe(400);
    expect(old.json.error.hint).toMatch(/llmpod down/);
  });

  it('nome del profilo non valido → errore, nessuna chiamata a ops', async () => {
    const r = await call('/api/pods/..%2Fetc/watchdog', { method: 'POST', body: { maxHours: 12 } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(ctx.ops.keep).not.toHaveBeenCalled();
  });

  it('non accetta i valori di save o yes dal corpo (la conferma è nell\'interfaccia, il profilo non si tocca)', async () => {
    await call('/api/pods/qwen3-coder/watchdog', { method: 'POST', body: { maxHours: 12, save: true, yes: false } });
    expect(ctx.ops.keep).toHaveBeenCalledWith('qwen3-coder', { idleMinutes: undefined, maxHours: 12, yes: true });
  });

  it('stesse protezioni delle altre rotte: serve la sessione, Origin e Content-Type JSON', async () => {
    const url = '/api/pods/qwen3-coder/watchdog';
    const body = JSON.stringify({ maxHours: 12 });
    expect((await request(port, url, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body })).status).toBe(401);
    const auth = { cookie: `llmpod_session=${TOKEN}` };
    expect((await request(port, url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body })).status).toBeGreaterThanOrEqual(400); // senza Origin
    expect((await request(port, url, { method: 'POST', headers: { ...auth, origin: 'https://evil.example.com', 'content-type': 'application/json' }, body })).status).toBeGreaterThanOrEqual(400);
    expect((await request(port, url, { method: 'POST', headers: { ...auth, origin: `http://127.0.0.1:${port}`, 'content-type': 'text/plain' }, body })).status).toBe(415);
    expect(ctx.ops.keep).not.toHaveBeenCalled();
  });

  it('con un\'operazione up/down in corso sul profilo → 409', async () => {
    ctx.ops.down = vi.fn(() => new Promise(() => {}));
    expect((await call('/api/jobs', { method: 'POST', body: { action: 'down', profile: 'qwen3-coder' } })).status).toBe(200);
    const r = await call('/api/pods/qwen3-coder/watchdog', { method: 'POST', body: { maxHours: 12 } });
    expect(r.status).toBe(409);
    expect(ctx.ops.keep).not.toHaveBeenCalled();
  });
});
