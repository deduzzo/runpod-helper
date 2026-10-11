import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';
import { createOpenwebuiProxy, createTargetResolver } from '../../src/server/openwebui-proxy.js';

const INTERNAL = 'chiave-interna-openwebui-123456';
const POD_KEY = 'chiave-del-pod-abcdef-123456';
let upstream; let upstreamPort; let seen = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, ua: req.headers['user-agent'], body });
      if (req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const t = setInterval(() => {
          res.write(`data: {"n":${i}}\n\n`);
          if (++i === 3) { clearInterval(t); res.end('data: [DONE]\n\n'); }
        }, 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3-coder' }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
});
afterAll(() => { upstream.close(); clearSecrets(); });

async function withProxy(opts, fn) {
  const server = http.createServer(createOpenwebuiProxy({ internalKey: INTERNAL, userAgent: 'llmpod/0.1.0', ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const target = () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: POD_KEY });

describe('proxy Open WebUI', () => {
  it('sostituisce la chiave e inoltra lo streaming', async () => {
    seen = [];
    await withProxy({ resolveTarget: async () => target() }, async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' }, body: '{"model":"qwen3-coder","stream":true}' });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/event-stream/);
      const text = await r.text();
      expect(text).toContain('data: {"n":2}');
      expect(text).toContain('[DONE]');
      expect(seen[0]).toMatchObject({ url: '/v1/chat/completions', auth: `Bearer ${POD_KEY}`, ua: 'llmpod/0.1.0', body: '{"model":"qwen3-coder","stream":true}' });
      const models = await fetch(`${base}/v1/models?x=1`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect((await models.json()).data[0].id).toBe('qwen3-coder');
      expect(seen[1].url).toBe('/v1/models?x=1');
    });
  });

  it('chiave interna sbagliata → 401, percorso fuori da /v1 → 404, nessun Pod → 503', async () => {
    await withProxy({ resolveTarget: async () => null }, async (base) => {
      expect((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sbagliata' } })).status).toBe(401);
      expect((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${INTERNAL}` } })).status).toBe(404);
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect(r.status).toBe(503);
      expect((await r.json()).error.message).toMatch(/Nessun Pod attivo/);
    });
  });

  it('Pod irraggiungibile → 502 e il proxy resta in piedi', async () => {
    registerSecret(POD_KEY);
    await withProxy({ resolveTarget: async () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: POD_KEY }) }, async (base) => {
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect(r.status).toBe(502);
      expect(JSON.stringify(await r.json())).not.toContain(POD_KEY);
      expect((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } })).status).toBe(502);
    });
  });

  it('createTargetResolver: profilo configurato o unico attivo, cache', async () => {
    const endpoint = vi.fn(async (name) => ({ baseUrl: `https://${name}-8000.proxy.runpod.net`, apiKey: POD_KEY }));
    const store = { readConfig: () => ({}), readState: () => ({ pods: { solo: { podId: 'x' } } }) };
    const resolve = createTargetResolver({ store, getOps: () => ({ endpoint }) });
    expect(await resolve()).toEqual({ baseUrl: 'https://solo-8000.proxy.runpod.net', apiKey: POD_KEY });
    await resolve();
    expect(endpoint).toHaveBeenCalledTimes(1);
    const none = createTargetResolver({ store: { readConfig: () => ({}), readState: () => ({ pods: {} }) }, getOps: () => ({ endpoint }) });
    expect(await none()).toBeNull();
    const gone = createTargetResolver({ store: { readConfig: () => ({ openwebuiProfile: 'p' }), readState: () => ({ pods: {} }) }, getOps: () => ({ endpoint: async () => { throw Object.assign(new Error('x'), { code: 'NOT_FOUND' }); } }) });
    expect(await gone()).toBeNull();
  });

  it('corpo oltre 10 MB → 413 e nessuna richiesta al Pod', async () => {
    seen = [];
    await withProxy({ resolveTarget: async () => target() }, async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' }, body: Buffer.alloc(10 * 1024 * 1024 + 1024, 97) });
      expect(r.status).toBe(413);
      expect((await r.json()).error.type).toBe('llmpod_proxy');
      expect(seen).toHaveLength(0);
    });
  });

  it('Pod che cade a metà streaming: nessun crash, il proxy continua a rispondere', async () => {
    const flaky = http.createServer((req, res) => {
      if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":0}\n\n');
      setTimeout(() => req.socket.destroy(), 30);
    });
    await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
    const flakyTarget = { baseUrl: `http://127.0.0.1:${flaky.address().port}`, apiKey: POD_KEY };
    const errors = [];
    const onUncaught = (e) => errors.push(e);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    try {
      await withProxy({ resolveTarget: async () => flakyTarget }, async (base) => {
        const headers = { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' };
        let outcome = 'ok';
        try { const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: '{}' }); await r.text(); } catch { outcome = 'errore'; }
        expect(['ok', 'errore']).toContain(outcome);
        expect((await fetch(`${base}/v1/models`, { headers })).status).toBe(200);
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
      flaky.closeAllConnections();
      flaky.close();
    }
  });

  it('il client che chiude a metà streaming annulla la richiesta upstream', async () => {
    let upstreamClosed;
    const closed = new Promise((r) => { upstreamClosed = r; });
    const slow = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":0}\n\n');
      const t = setInterval(() => res.write(': ping\n\n'), 20);
      res.on('close', () => { clearInterval(t); upstreamClosed(true); });
    });
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    try {
      await withProxy({ resolveTarget: async () => ({ baseUrl: `http://127.0.0.1:${slow.address().port}`, apiKey: POD_KEY }) }, async (base) => {
        const ac = new AbortController();
        const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' }, body: '{}', signal: ac.signal });
        const reader = r.body.getReader();
        await reader.read();
        ac.abort();
        expect(await Promise.race([closed, new Promise((res) => setTimeout(() => res('timeout'), 2000))])).toBe(true);
        expect((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer x' } })).status).toBe(401);
      });
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });

  it('createTargetResolver: mette in cache anche l\'esito "nessun Pod" per 10 s', async () => {
    vi.useFakeTimers();
    try {
      const endpoint = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'NOT_FOUND' }); });
      const resolve = createTargetResolver({ store: { readConfig: () => ({ openwebuiProfile: 'p' }), readState: () => ({ pods: {} }) }, getOps: () => ({ endpoint }) });
      expect(await resolve()).toBeNull();
      expect(await resolve()).toBeNull();
      expect(endpoint).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10_001);
      expect(await resolve()).toBeNull();
      expect(endpoint).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('createTargetResolver: errori diversi da NOT_FOUND si propagano e non vengono messi in cache', async () => {
    const endpoint = vi.fn(async () => { throw new Error('rete'); });
    const resolve = createTargetResolver({ store: { readConfig: () => ({ openwebuiProfile: 'p' }), readState: () => ({ pods: {} }) }, getOps: () => ({ endpoint }) });
    await expect(resolve()).rejects.toThrow('rete');
    await expect(resolve()).rejects.toThrow('rete');
    expect(endpoint).toHaveBeenCalledTimes(2);
  });
});
