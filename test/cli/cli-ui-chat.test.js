import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sandbox } from './helpers.js';
import { redact, clearSecrets } from '../../src/core/secrets.js';
import { openBrowser } from '../../src/cli/open-browser.js';

const TOKEN = 'abcdef0123456789abcdef0123456789';
const child = () => ({ on: vi.fn(), unref: vi.fn() });

beforeEach(() => clearSecrets());

describe('llmpod ui', () => {
  it('avvia il server, stampa l\'URL con il token, registra il token e si chiude con SIGINT', async () => {
    const s = sandbox();
    const spawn = vi.fn(child);
    s.env.LLMPOD_UI_TOKEN = TOKEN;
    const done = s.run(['ui', '--port', '0', '--proxy-port', '0', '--no-open'], { spawn, exit: vi.fn() });
    for (let i = 0; i < 100 && !/Interfaccia llmpod: http/.test(s.out()); i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.out()).toMatch(new RegExp(`Interfaccia llmpod: http://127\\.0\\.0\\.1:\\d+/\\?t=${TOKEN}`));
    expect(s.out()).toContain('Proxy per Open WebUI su 127.0.0.1:');
    // L'avviso dipende dalla presenza della build (dist/web, creata da `npm run build:web`).
    const built = fs.existsSync(fileURLToPath(new URL('../../dist/web/index.html', import.meta.url)));
    if (built) expect(s.err()).not.toContain('Interfaccia non compilata');
    else expect(s.err()).toContain('Interfaccia non compilata');
    expect(redact(`x ${TOKEN}`)).not.toContain(TOKEN);
    expect(spawn).not.toHaveBeenCalled();
    process.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('senza LLMPOD_UI_TOKEN genera un token esadecimale e apre il browser', async () => {
    const s = sandbox();
    const spawn = vi.fn(child);
    const done = s.run(['ui', '--port', '0', '--no-proxy'], { spawn, exit: vi.fn() });
    for (let i = 0; i < 100 && !spawn.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.out()).toMatch(/\/\?t=[0-9a-f]{48}\n/);
    expect(s.out()).not.toContain('Proxy per Open WebUI');
    expect(spawn).toHaveBeenCalledTimes(1);
    process.emit('SIGTERM');
    expect(await done).toBe(0);
  });

  it.each([['corto', 'abc'], ['caratteri non validi', 'token con spazi e simboli!!!']])('LLMPOD_UI_TOKEN %s: INVALID_INPUT', async (_n, bad) => {
    const s = sandbox();
    s.env.LLMPOD_UI_TOKEN = bad;
    expect(await s.run(['ui', '--port', '0', '--no-open'])).toBe(1);
    expect(s.err()).toContain('INVALID_INPUT');
    expect(s.err()).toContain('LLMPOD_UI_TOKEN');
    expect(s.err()).not.toContain(bad);
  });

  it('porta non valida: errore chiaro', async () => {
    const s = sandbox();
    expect(await s.run(['ui', '--port', 'abc', '--no-open'])).toBe(1);
    expect(s.err()).toContain('Porta non valida');
  });
});

describe('llmpod chat', () => {
  it('Open WebUI risponde: stampa l\'URL e apre il browser', async () => {
    const s = sandbox();
    const spawn = vi.fn(child);
    const http = { request: vi.fn(async () => ({ ok: true, status: 200, data: '' })) };
    expect(await s.run(['chat'], { http, spawn })).toBe(0);
    expect(http.request).toHaveBeenCalledWith('GET', 'http://127.0.0.1:3000/', expect.objectContaining({ retry: false }));
    // R27: la verifica usa l'indirizzo configurato, il browser riceve l'altro nome loopback (niente cookie llmpod_session a Open WebUI)
    expect(s.out()).toContain('Open WebUI: http://localhost:3000/');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spawn.mock.calls[0])).toContain('http://localhost:3000/');
    expect(JSON.stringify(spawn.mock.calls[0])).not.toContain('127.0.0.1');
  });

  it('R27: indirizzi già diversi da 127.0.0.1 restano invariati (localhost, host remoto)', async () => {
    for (const [configured, shown] of [['http://localhost:4000', 'http://localhost:4000/'], ['https://owui.example.org/chat', 'https://owui.example.org/chat']]) {
      const s = sandbox();
      s.env.LLMPOD_OPENWEBUI_URL = configured;
      const http = { request: vi.fn(async () => ({ ok: true, status: 200, data: '' })) };
      expect(await s.run(['chat', '--no-open'], { http, spawn: vi.fn(child) })).toBe(0);
      expect(s.out()).toContain(`Open WebUI: ${shown}`);
    }
  });

  it('--no-open stampa solo l\'URL; usa LLMPOD_OPENWEBUI_URL', async () => {
    const s = sandbox();
    s.env.LLMPOD_OPENWEBUI_URL = 'http://localhost:4000';
    const spawn = vi.fn(child);
    const http = { request: vi.fn(async () => ({ ok: true, status: 200, data: '' })) };
    expect(await s.run(['chat', '--no-open'], { http, spawn })).toBe(0);
    expect(http.request.mock.calls[0][1]).toBe('http://localhost:4000/');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['rete', async () => { throw new Error('ECONNREFUSED'); }],
    ['5xx', async () => ({ ok: false, status: 502, data: null })],
  ])('Open WebUI non risponde (%s): errore con suggerimento', async (_n, request) => {
    const s = sandbox();
    const spawn = vi.fn(child);
    expect(await s.run(['chat'], { http: { request }, spawn })).toBe(1);
    expect(s.err()).toContain('Open WebUI non risponde su http://127.0.0.1:3000');
    expect(s.err()).toContain('Avvia Open WebUI con scripts/start.sh (Docker) oppure usa la pagina Prova veloce di llmpod ui');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('LLMPOD_OPENWEBUI_URL non http(s): INVALID_INPUT senza chiamate', async () => {
    const s = sandbox();
    s.env.LLMPOD_OPENWEBUI_URL = 'file:///etc/passwd';
    const http = { request: vi.fn() };
    expect(await s.run(['chat'], { http })).toBe(1);
    expect(s.err()).toContain('INVALID_INPUT');
    expect(http.request).not.toHaveBeenCalled();
  });
});

describe('openBrowser', () => {
  it('comando per piattaforma; rifiuta URL non http(s) o pericolosi su Windows', () => {
    const spawn = vi.fn(child);
    expect(openBrowser('http://127.0.0.1:1/', { platform: 'darwin', spawn })).toBe(true);
    expect(spawn.mock.calls[0][0]).toBe('open');
    openBrowser('http://127.0.0.1:1/', { platform: 'linux', spawn });
    expect(spawn.mock.calls[1][0]).toBe('xdg-open');
    openBrowser('http://127.0.0.1:1/', { platform: 'win32', spawn });
    expect(spawn.mock.calls[2]).toEqual(['cmd', ['/c', 'start', '', 'http://127.0.0.1:1/'], expect.anything()]);
    expect(openBrowser('javascript:alert(1)', { platform: 'linux', spawn })).toBe(false);
    expect(openBrowser('http://x/?a=1&b=2', { platform: 'win32', spawn })).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(3);
  });
  it('spawn che lancia: false, nessuna eccezione', () => {
    expect(openBrowser('http://x/', { platform: 'linux', spawn: () => { throw new Error('ENOENT'); } })).toBe(false);
  });
});

describe('llmpod chat: credenziali nell\'URL', () => {
  it('user:password@ rimossi da richiesta, output e browser', async () => {
    const s = sandbox();
    s.env.LLMPOD_OPENWEBUI_URL = 'http://utente:segretissima@127.0.0.1:3000/';
    const spawn = vi.fn(child);
    const http = { request: vi.fn(async () => ({ ok: true, status: 200, data: '' })) };
    expect(await s.run(['chat'], { http, spawn })).toBe(0);
    expect(http.request.mock.calls[0][1]).toBe('http://127.0.0.1:3000/');
    expect(s.all()).not.toContain('segretissima');
    expect(JSON.stringify(spawn.mock.calls)).not.toContain('segretissima');
  });
  it('host con caratteri da CSP (";"): rifiutato come INVALID_INPUT, nessuna chiamata (stessa validazione della UI)', async () => {
    const s = sandbox();
    s.env.LLMPOD_OPENWEBUI_URL = 'http://a.com;script-src';
    const http = { request: vi.fn() };
    expect(await s.run(['chat'], { http })).toBe(1);
    expect(s.err()).toContain('INVALID_INPUT');
    expect(http.request).not.toHaveBeenCalled();
  });
  it('URL non valido: il valore non è riportato nell\'errore', async () => {
    const s = sandbox();
    s.env.LLMPOD_OPENWEBUI_URL = 'ftp://utente:segretissima@host';
    expect(await s.run(['chat'], { http: { request: vi.fn() } })).toBe(1);
    expect(s.all()).not.toContain('segretissima');
  });
});
