import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server/app.js';
import { HttpError, readJson, sendJson, parseCookies, safeEqual } from '../../src/server/http-utils.js';
import { LlmpodError, Codes } from '../../src/core/errors.js';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';
import { request } from './helpers.js';

const TOKEN = 'token-di-prova-1234567890';
let server;
let port;
let baseDir;
let staticDir;
let effects = 0;

const req = (pathname, opts) => request(port, pathname, opts);

const AUTH = { cookie: `llmpod_session=${TOKEN}` };
const POST_HEADERS = () => ({ ...AUTH, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' });

function routes(method, pathname) {
  if (method === 'POST' && pathname === '/api/echo') {
    return async ({ req: rq, res }) => { effects += 1; sendJson(res, 200, await readJson(rq)); };
  }
  if (pathname === '/api/circular') return async () => { const e = {}; e.self = e; throw e; };
  if (pathname === '/api/secret-boom') return async () => { throw new Error('esplosione con chiave-segreta-0123456789'); };
  if (pathname === '/api/boom') return async () => { throw new Error('esplosione interna con dettagli'); };
  if (pathname === '/api/llmpod-error') return async () => { throw new LlmpodError(Codes.INVALID_INPUT, 'errore con chiave-segreta-0123456789', { hint: 'hint chiave-segreta-0123456789' }); };
  return null;
}

beforeAll(async () => {
  // Cartella dedicata: il file "segreto" sta accanto alla radice dei statici e viene rimosso a fine test.
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-web-'));
  staticDir = path.join(baseDir, 'static');
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>llmpod</title>');
  fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(baseDir, 'segreto.txt'), 'NON DEVE USCIRE');
  server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  server.on('request', createApp({ ctx: {}, token: TOKEN, port, staticDir, jobs: null, version: '0.1.0', routes }));
});
afterAll(() => {
  server.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
  clearSecrets();
});

async function withServer(opts, fn) {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  srv.on('request', createApp({ ctx: {}, port: p, staticDir, jobs: null, version: '0.1.0', ...opts }));
  try { return await fn(p); } finally { srv.close(); }
}

function rawReq(p, pathname, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p, path: pathname, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('sicurezza del server', () => {
  it('Host non ammesso → 403 (DNS rebinding)', async () => {
    expect((await req('/api/health', { host: 'evil.example.com' })).status).toBe(403);
    expect((await req('/api/health', { host: `localhost:${port}` })).status).toBe(200);
  });

  it('Host assente o con porta sbagliata → 403', async () => {
    const noHost = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET /api/health HTTP/1.0\r\n\r\n'));
      let data = '';
      sock.on('data', (c) => { data += c; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    expect(noHost).toMatch(/^HTTP\/1\.\d 403/);
    expect((await req('/api/health', { host: `127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await req('/api/health', { host: '127.0.0.1' })).status).toBe(403);
  });

  it('Origin: null → 403', async () => {
    expect((await req('/api/session', { headers: { origin: 'null', ...AUTH } })).status).toBe(403);
  });

  it('Origin estranea → 403', async () => {
    const r = await req('/api/session', { headers: { origin: 'https://evil.example.com', ...AUTH } });
    expect(r.status).toBe(403);
  });

  it('POST da origine estranea (anche con cookie valido) → 403 e nessun effetto', async () => {
    const before = effects;
    const r = await req('/api/echo', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json', ...AUTH },
      body: '{"a":1}',
    });
    expect(r.status).toBe(403);
    expect(effects).toBe(before);
    const ok = await req('/api/echo', { method: 'POST', headers: POST_HEADERS(), body: '{"a":1}' });
    expect(ok.status).toBe(200);
    expect(effects).toBe(before + 1);
  });

  it('token: link corretto imposta il cookie, sbagliato → 401', async () => {
    const ok = await req(`/?t=${TOKEN}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/');
    expect(ok.headers['set-cookie'][0]).toMatch(/^llmpod_session=token-di-prova-1234567890; HttpOnly; SameSite=Strict; Path=\//);
    const bad = await req('/?t=sbagliato');
    expect(bad.status).toBe(401);
    expect(bad.body).toContain('Link non valido');
  });

  it('token con + % ; : cookie codificato e autenticante', async () => {
    const weird = 'a+b%c;d=e f';
    await withServer({ token: weird }, async (p) => {
      const base = { host: `127.0.0.1:${p}` };
      const ok = await rawReq(p, `/?t=${encodeURIComponent(weird)}`, base);
      expect(ok.status).toBe(302);
      const setCookie = ok.headers['set-cookie'][0];
      expect(setCookie).toMatch(/^llmpod_session=[^;\s]+; HttpOnly; SameSite=Strict; Path=\//);
      const cookie = setCookie.split(';')[0];
      expect((await rawReq(p, '/api/session', { ...base, cookie })).status).toBe(200);
    });
  });

  it('POST /api: Sec-Fetch-Site cross-site, header mancanti, content-type', async () => {
    const base = POST_HEADERS();
    const before = effects;
    const cross = await req('/api/echo', { method: 'POST', headers: { ...base, 'sec-fetch-site': 'cross-site' }, body: '{}' });
    expect(cross.status).toBe(403);
    const same = await req('/api/echo', { method: 'POST', headers: { ...base, 'sec-fetch-site': 'same-origin' }, body: '{}' });
    expect(same.status).toBe(200);
    const none = await req('/api/echo', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json', 'sec-fetch-site': 'none' }, body: '{}' });
    expect(none.status).toBe(200);
    const noOrigin = await req('/api/echo', { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: '{}' });
    expect(noOrigin.status).toBe(403);
    expect(effects).toBe(before + 2);
    // POST senza corpo e senza content-type → 415; con charset → ok
    const noCt = await req('/api/echo', { method: 'POST', headers: { ...AUTH, origin: base.origin } });
    expect(noCt.status).toBe(415);
    const textCt = await req('/api/echo', { method: 'POST', headers: { ...base, 'content-type': 'application/jsonx' }, body: '{}' });
    expect(textCt.status).toBe(415);
    const charset = await req('/api/echo', { method: 'POST', headers: { ...base, 'content-type': 'application/json; charset=utf-8' }, body: '{}' });
    expect(charset.status).toBe(200);
  });

  it('API senza cookie → 401; con cookie → 200', async () => {
    expect((await req('/api/session')).status).toBe(401);
    const r = await req('/api/session', { headers: AUTH });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, version: '0.1.0' });
  });

  it('cookie malformato = assente (401, nessun crash)', async () => {
    const r = await req('/api/session', { headers: { cookie: 'llmpod_session=%E0%A4%A' } });
    expect(r.status).toBe(401);
    expect((await req('/api/health')).status).toBe(200);
  });

  it('percorso API sconosciuto → 404', async () => {
    expect((await req('/api/nulla', { headers: AUTH })).status).toBe(404);
  });

  it('statici con header di sicurezza, fallback SPA e niente path traversal', async () => {
    const page = await req('/profili');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>llmpod</title>');
    expect(page.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(page.headers['content-security-policy']).toContain('frame-src http://127.0.0.1:3000 http://localhost:3000;');
    expect(page.headers['content-security-policy']).toContain("base-uri 'none'");
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect((await req('/assets/app.js')).headers['content-type']).toMatch(/javascript/);
    for (const p of ['/../segreto.txt', '/assets/../../segreto.txt', '/%2e%2e/segreto.txt', '/..%2fsegreto.txt', '/%2e%2e%2fsegreto.txt', '/assets/..%2f..%2fsegreto.txt', '/..%5csegreto.txt', '/%5c..%5csegreto.txt']) {
      const r = await req(p);
      expect(r.status, p).toBe(404);
      expect(r.body, p).not.toContain('NON DEVE USCIRE');
    }
    expect((await req('/assets/mancante.js')).status).toBe(404);
  });

  it('HEAD sui statici: niente corpo', async () => {
    const r = await req('/assets/app.js', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.body).toBe('');
  });
});

describe('readJson via router', () => {
  const post = (body, headers = {}) => req('/api/echo', { method: 'POST', headers: { ...POST_HEADERS(), ...headers }, body });

  it('content-type non JSON → 415', async () => {
    const r = await post('a=1', { 'content-type': 'text/plain' });
    expect(r.status).toBe(415);
    expect(JSON.parse(r.body).error.code).toBe('HTTP');
  });

  it('JSON non valido → 400', async () => {
    expect((await post('{non json')).status).toBe(400);
  });

  it('JSON non oggetto (null, numero, stringa, array) → 400', async () => {
    for (const b of ['null', '42', '"testo"', '[1,2]']) expect((await post(b)).status, b).toBe(400);
    expect((await post('{}')).status).toBe(200);
  });

  it('corpo oltre 1 MB → 413 con risposta consegnata', async () => {
    const r = await post(JSON.stringify({ x: 'a'.repeat(1_100_000) }));
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).error.message).toMatch(/troppo grande/);
  });

  it('il server resta vivo dopo il 413', async () => {
    expect((await req('/api/health')).status).toBe(200);
  });
});

describe('gestione errori', () => {
  it('errore interno → 500 generico; log su stderr senza segreti e senza testo nella risposta', async () => {
    registerSecret('chiave-segreta-0123456789');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await req('/api/secret-boom', { headers: AUTH });
      expect(r.status).toBe(500);
      expect(JSON.parse(r.body)).toEqual({ error: { code: 'INTERNAL', message: 'Errore interno' } });
      expect(r.body).not.toContain('esplosione');
      expect(spy).toHaveBeenCalled();
      const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('esplosione');
      expect(logged).not.toContain('chiave-segreta-0123456789');
    } finally {
      spy.mockRestore();
    }
  });

  it('errore circolare: 500 e nessuna unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await req('/api/circular', { headers: AUTH });
      expect(r.status).toBe(500);
      await new Promise((r2) => setTimeout(r2, 20));
      expect(unhandled).toEqual([]);
      expect((await req('/api/health')).status).toBe(200);
    } finally {
      spy.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('LlmpodError → 400 con messaggio e hint mascherati', async () => {
    registerSecret('chiave-segreta-0123456789');
    const r = await req('/api/llmpod-error', { headers: AUTH });
    expect(r.status).toBe(400);
    const { error } = JSON.parse(r.body);
    expect(error.code).toBe('INVALID_INPUT');
    expect(r.body).not.toContain('chiave-segreta-0123456789');
  });
});

describe('http-utils', () => {
  it('parseCookies tollera valori malformati', () => {
    expect(parseCookies('a=1; b=%E0%A4%A; c=x%20y')).toEqual({ a: '1', c: 'x y' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('safeEqual: false con lunghezze diverse o vuoti', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual(undefined, 'x')).toBe(false);
  });

  it('HttpError porta lo status', () => {
    expect(new HttpError(418, 'x').status).toBe(418);
  });
});

describe('serveStatic: errore di lettura', () => {
  it.skipIf(process.getuid?.() === 0)('un file illeggibile → 500 e il server resta vivo', async () => {
    const f = path.join(staticDir, 'assets', 'noperm.js');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o000);
    try {
      const r = await req('/assets/noperm.js');
      expect(r.status).toBe(500);
      expect((await req('/api/health')).status).toBe(200);
    } finally {
      fs.chmodSync(f, 0o644);
    }
  });
});

describe('controllo Host in base all\'indirizzo di ascolto (R2)', () => {
  async function withHost(host, fn) {
    const srv = http.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;
    srv.on('request', createApp({ ctx: {}, token: TOKEN, port: p, staticDir: null, jobs: null, version: '0.1.0', host }));
    try { await fn(p); } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
  }

  it.each(['::1', 'localhost'])('host di ascolto %s: ammette anche [::1]:porta', async (host) => {
    await withHost(host, async (p) => {
      expect((await request(p, '/api/health', { host: `[::1]:${p}` })).status).toBe(200);
      expect((await request(p, '/api/health', { host: `localhost:${p}` })).status).toBe(200);
      expect((await request(p, '/api/health', { host: `127.0.0.1:${p}` })).status).toBe(200);
      expect((await request(p, '/api/health', { host: `[::2]:${p}` })).status).toBe(403);
    });
  });

  it('host di ascolto 127.0.0.1: [::1] non è ammesso', async () => {
    await withHost('127.0.0.1', async (p) => {
      expect((await request(p, '/api/health', { host: `[::1]:${p}` })).status).toBe(403);
      expect((await request(p, '/api/health', { host: `127.0.0.1:${p}` })).status).toBe(200);
    });
  });
});
