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
      seen.push({ url: req.url, cookie: req.headers.cookie, xApiKey: req.headers['x-api-key'], auth: req.headers.authorization, ua: req.headers['user-agent'], body });
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
    registerSecret(INTERNAL);
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

  it('createOpenwebuiProxy rifiuta una chiave interna assente o corta (niente fail-open)', () => {
    for (const bad of [undefined, '', 'corta', 12345678901234567, null]) {
      expect(() => createOpenwebuiProxy({ resolveTarget: async () => null, internalKey: bad, userAgent: 'x' })).toThrow(/internalKey/);
    }
  });

  it('risposta 3xx dell\'upstream → 502 mascherato, nessun redirect seguito', async () => {
    let followed = false;
    const other = http.createServer((req, res) => { followed = true; res.end('segreto'); });
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    const redirecting = http.createServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${other.address().port}/x` });
      res.end();
    });
    await new Promise((r) => redirecting.listen(0, '127.0.0.1', r));
    try {
      await withProxy({ resolveTarget: async () => ({ baseUrl: `http://127.0.0.1:${redirecting.address().port}`, apiKey: POD_KEY }) }, async (base) => {
        const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
        expect(r.status).toBe(502);
        expect((await r.json()).error.message).toMatch(/reindirizzamento/);
        expect(followed).toBe(false);
      });
    } finally { redirecting.close(); other.close(); }
  });

  it('errore di resolveTarget → 502 "Impossibile determinare il Pod", distinto dagli errori di rete', async () => {
    await withProxy({ resolveTarget: async () => { throw new Error('config illeggibile'); } }, async (base) => {
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect(r.status).toBe(502);
      expect((await r.json()).error.message).toMatch(/^Impossibile determinare il Pod: config illeggibile/);
    });
  });

  it('errore di rete → 502 con il codice della causa e invalida la cache del resolver', async () => {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));
    const resolveTarget = Object.assign(async () => ({ baseUrl: `http://127.0.0.1:${deadPort}`, apiKey: POD_KEY }), { invalidate: vi.fn() });
    await withProxy({ resolveTarget }, async (base) => {
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect(r.status).toBe(502);
      const msg = (await r.json()).error.message;
      expect(msg).toMatch(/^Pod non raggiungibile: /);
      expect(msg).toMatch(/ECONNREFUSED/);
      expect(resolveTarget.invalidate).toHaveBeenCalledTimes(1);
    });
  });

  it('più Pod attivi senza profilo scelto → 503 con messaggio dedicato', async () => {
    const store = { readConfig: () => ({}), readState: () => ({ pods: { a: {}, b: {} } }) };
    const resolve = createTargetResolver({ store, getOps: () => ({ endpoint: vi.fn() }) });
    await withProxy({ resolveTarget: resolve }, async (base) => {
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect(r.status).toBe(503);
      expect((await r.json()).error.message).toBe('Più Pod attivi: scegli il profilo per Open WebUI nella pagina Prova veloce');
    });
  });

  it('createTargetResolver.invalidate() svuota la cache positiva', async () => {
    const endpoint = vi.fn(async () => ({ baseUrl: 'https://x-8000.proxy.runpod.net', apiKey: POD_KEY }));
    const resolve = createTargetResolver({ store: { readConfig: () => ({ openwebuiProfile: 'x' }), readState: () => ({ pods: {} }) }, getOps: () => ({ endpoint }) });
    await resolve(); await resolve();
    expect(endpoint).toHaveBeenCalledTimes(1);
    resolve.invalidate();
    await resolve();
    expect(endpoint).toHaveBeenCalledTimes(2);
  });

  it('percorsi insidiosi non escono da baseUrl; Authorization e cookie del client non arrivano al Pod; la chiave interna non compare nel 502', async () => {
    seen = [];
    const raw = (base, path, headers) => new Promise((resolve, reject) => {
      const u = new URL(base);
      http.get({ host: u.hostname, port: u.port, path, headers }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }).on('error', reject);
    });
    await withProxy({ resolveTarget: async () => target() }, async (base) => {
      const auth = { authorization: `Bearer ${INTERNAL}`, cookie: 'llmpod_session=sessione-segreta-123', 'x-api-key': 'altra-chiave' };
      const a = await raw(base, '//evil.example/v1/models', auth);
      expect([200, 404]).toContain(a.status);
      expect((await raw(base, '/v1/../x', auth)).status).toBe(404);
      expect((await raw(base, '/v1/%2e%2e/x', auth)).status).toBe(404);
      expect((await raw(base, '/v1/%2e%2e%2fx', auth)).status).not.toBe(500);
      for (const s of seen) {
        expect(s.url.startsWith('/v1/')).toBe(true);
        expect(s.auth).toBe(`Bearer ${POD_KEY}`);
        expect(s.cookie).toBeUndefined();
        expect(s.xApiKey).toBeUndefined();
      }
    });
    await withProxy({ resolveTarget: async () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: POD_KEY }) }, async (base) => {
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect(r.status).toBe(502);
      expect(await r.text()).not.toContain(INTERNAL);
    });
  });
});
