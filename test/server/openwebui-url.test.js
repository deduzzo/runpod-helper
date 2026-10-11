import { describe, it, expect, afterEach } from 'vitest';
import { resolveOpenwebuiUrl, frameSources, DEFAULT_OPENWEBUI_URL } from '../../src/server/openwebui-url.js';
import { SECURITY_HEADERS, setFrameSources } from '../../src/server/http-utils.js';
import { LlmpodError } from '../../src/core/errors.js';

afterEach(() => setFrameSources());

describe('indirizzo di Open WebUI (R27)', () => {
  it('predefinito, da LLMPOD_OPENWEBUI_URL, senza credenziali', () => {
    expect(resolveOpenwebuiUrl({})).toBe(DEFAULT_OPENWEBUI_URL);
    expect(resolveOpenwebuiUrl({ LLMPOD_OPENWEBUI_URL: 'http://localhost:3100/' })).toBe('http://localhost:3100');
    expect(resolveOpenwebuiUrl({ LLMPOD_OPENWEBUI_URL: 'http://u:segreto@10.0.0.5:8080/chat' })).toBe('http://10.0.0.5:8080/chat');
  });

  it('valore non valido → errore senza riportare il valore', () => {
    for (const bad of ['non-un-url', 'ftp://x:segreto@host/']) {
      try {
        resolveOpenwebuiUrl({ LLMPOD_OPENWEBUI_URL: bad });
        throw new Error('doveva fallire');
      } catch (e) {
        expect(e).toBeInstanceOf(LlmpodError);
        expect(e.message).not.toContain('segreto');
        expect(e.message).not.toContain(bad);
      }
    }
  });

  it('frame-src: entrambi i nomi loopback con la stessa porta, altrimenti solo l\'origine', () => {
    expect(frameSources('http://127.0.0.1:3000')).toEqual(['http://127.0.0.1:3000', 'http://localhost:3000']);
    expect(frameSources('http://localhost:3100')).toEqual(['http://127.0.0.1:3100', 'http://localhost:3100']);
    expect(frameSources('https://owui.example.org/chat')).toEqual(['https://owui.example.org']);
  });

  it('la CSP segue le origini impostate e si ripristina', () => {
    const base = SECURITY_HEADERS['content-security-policy'];
    expect(base).toContain('frame-src http://127.0.0.1:3000 http://localhost:3000;');
    setFrameSources(frameSources('http://localhost:3100'));
    expect(SECURITY_HEADERS['content-security-policy']).toContain('frame-src http://127.0.0.1:3100 http://localhost:3100;');
    expect(SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'");
    setFrameSources();
    expect(SECURITY_HEADERS['content-security-policy']).toBe(base);
  });
});
