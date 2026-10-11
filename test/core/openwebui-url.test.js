import { describe, it, expect, afterEach } from 'vitest';
import { resolveOpenwebuiUrl, frameSources, embedUrl, DEFAULT_OPENWEBUI_URL } from '../../src/core/openwebui-url.js';
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

  it('iniezione nella CSP: host con ";", "," o apice rifiutati; IPv6 e host normali ammessi', () => {
    for (const bad of ['http://a.com;script-src', 'http://a.com,b', "http://a'b.com", 'http://a.com;script-src-elem']) {
      expect(() => resolveOpenwebuiUrl({ LLMPOD_OPENWEBUI_URL: bad }), bad).toThrow(/LLMPOD_OPENWEBUI_URL non valido/);
    }
    expect(resolveOpenwebuiUrl({ LLMPOD_OPENWEBUI_URL: 'http://[::1]:3000' })).toBe('http://[::1]:3000');
    expect(resolveOpenwebuiUrl({ LLMPOD_OPENWEBUI_URL: 'https://owui-1.example.org:8443' })).toBe('https://owui-1.example.org:8443');
  });

  it('difesa in profondità: setFrameSources rifiuta origini non conformi', () => {
    for (const bad of ["http://a.com;script-src", "http://a.com 'unsafe-inline'", 'http://a.com,b', 'ftp://a.com', "*", "http://a.com/path"]) {
      expect(() => setFrameSources([bad]), bad).toThrow();
    }
    expect(SECURITY_HEADERS['content-security-policy']).toContain('frame-src http://127.0.0.1:3000');
    setFrameSources(['http://[::1]:3000', 'https://owui.example.org']);
    expect(SECURITY_HEADERS['content-security-policy']).toContain('frame-src http://[::1]:3000 https://owui.example.org;');
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

describe('embedUrl nel core (condiviso da web e CLI)', () => {
  it('scambia 127.0.0.1 <-> localhost solo se coincide con l\'host dell\'interfaccia', () => {
    expect(embedUrl('http://127.0.0.1:3000', '127.0.0.1')).toBe('http://localhost:3000');
    expect(embedUrl('http://localhost:3100', 'localhost')).toBe('http://127.0.0.1:3100');
    expect(embedUrl('http://localhost:3100', '127.0.0.1')).toBe('http://localhost:3100');
    expect(embedUrl('https://owui.example.org', '127.0.0.1')).toBe('https://owui.example.org');
    expect(embedUrl('non un url', '127.0.0.1')).toBe('non un url');
  });
});
