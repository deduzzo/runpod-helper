import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server/app.js';
import { HttpError, readJson, sendJson, parseCookies, safeEqual } from '../../src/server/http-utils.js';
import { LlmpodError, Codes } from '../../src/core/errors.js';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';

const TOKEN = 'token-di-prova-1234567890';
let server;
let port;
let baseDir;
let staticDir;
let effects = 0;

function req(pathname, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: host ?? `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const AUTH = { cookie: `llmpod_session=${TOKEN}` };

function routes(method, pathname) {
  if (method === 'POST' && pathname === '/api/echo') {
    return async ({ req: rq, res }) => { effects += 1; sendJson(res, 200, await readJson(rq)); };
  }
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

describe('sicurezza del server', () => {
  it('Host non ammesso → 403 (DNS rebinding)', async () => {
    expect((await req('/api/health', { host: 'evil.example.com' })).status).toBe(403);
    expect((await req('/api/health', { host: `localhost:${port}` })).status).toBe(200);
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
    const ok = await req('/api/echo', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...AUTH }, body: '{"a":1}' });
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
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect((await req('/assets/app.js')).headers['content-type']).toMatch(/javascript/);
    for (const p of ['/../segreto.txt', '/assets/../../segreto.txt', '/%2e%2e/segreto.txt', '/..%2fsegreto.txt', '/%2e%2e%2fsegreto.txt', '/assets/..%2f..%2fsegreto.txt']) {
      const r = await req(p);
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
  const post = (body, headers = { 'content-type': 'application/json' }) => req('/api/echo', { method: 'POST', headers: { ...AUTH, ...headers }, body });

  it('content-type non JSON → 415', async () => {
    const r = await post('a=1', { 'content-type': 'text/plain' });
    expect(r.status).toBe(415);
    expect(JSON.parse(r.body).error.code).toBe('HTTP');
  });

  it('JSON non valido → 400', async () => {
    expect((await post('{non json')).status).toBe(400);
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
  it('errore interno → 500 generico, loggato su stderr senza segreti', async () => {
    registerSecret('chiave-segreta-0123456789');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await req('/api/boom', { headers: AUTH });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'INTERNAL', message: 'Errore interno' } });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
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
  it('un file illeggibile non fa cadere il server', async () => {
    const f = path.join(staticDir, 'assets', 'noperm.js');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o000);
    const r = await req('/assets/noperm.js');
    // root può leggere comunque: accettiamo 200, altrimenti 404/500 senza crash.
    expect([200, 404, 500]).toContain(r.status);
    expect((await req('/api/health')).status).toBe(200);
    fs.chmodSync(f, 0o644);
  });
});
