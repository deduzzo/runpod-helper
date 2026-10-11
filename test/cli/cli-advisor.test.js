import { describe, it, expect, vi } from 'vitest';
import { sandbox } from './helpers.js';

const KEY = 'CHIAVE-CONSULENTE-FINTA-XYZ';

describe('llmpod advisor', () => {
  it('configura zai-coding-plan: avviso una tantum, chiave nascosta, modello predefinito', async () => {
    const s = sandbox({ answers: { text: ['zai-coding-plan', ''], ask: [true], secret: [KEY] } });
    expect(await s.run(['advisor'])).toBe(0);
    expect(s.store.readEnv()).toMatchObject({ LLMPOD_ADVISOR_PRESET: 'zai-coding-plan', LLMPOD_ADVISOR_API_KEY: KEY });
    expect(s.store.readEnv().LLMPOD_ADVISOR_MODEL).toBeUndefined();
    expect(s.store.readConfig().advisor).toEqual({ enabled: true, zaiNoticeAcknowledged: true });
    expect(s.all()).toMatch(/strumenti supportati/);
    expect(s.all()).not.toContain(KEY);
  });

  it('rifiutare l\'avviso Z.ai annulla senza salvare', async () => {
    const s = sandbox({ answers: { text: ['zai-coding-plan'], ask: [false] } });
    expect(await s.run(['advisor'])).toBe(130);
    expect(s.store.readEnv().LLMPOD_ADVISOR_PRESET).toBeUndefined();
  });

  it('custom chiede protocollo, URL, modello e auth; claude-cli non chiede chiave', async () => {
    const s = sandbox({ answers: { text: ['custom', 'openai', 'https://llm.example.com/v1', 'mio-modello', 'bearer'], secret: [KEY] } });
    expect(await s.run(['advisor'])).toBe(0);
    expect(s.store.readEnv()).toMatchObject({ LLMPOD_ADVISOR_PRESET: 'custom', LLMPOD_ADVISOR_PROTOCOL: 'openai', LLMPOD_ADVISOR_BASE_URL: 'https://llm.example.com/v1', LLMPOD_ADVISOR_MODEL: 'mio-modello', LLMPOD_ADVISOR_AUTH: 'bearer' });
    const s2 = sandbox();
    expect(await s2.run(['advisor', '--preset', 'claude-cli'])).toBe(0);
    expect(s2.prompt.askSecret).not.toHaveBeenCalled();
    expect(s2.store.readEnv().LLMPOD_ADVISOR_PRESET).toBe('claude-cli');
  });

  it('cambiare preset rimuove i campi del preset precedente', async () => {
    const s = sandbox();
    s.store.writeEnv({ LLMPOD_ADVISOR_PRESET: 'custom', LLMPOD_ADVISOR_BASE_URL: 'https://x', LLMPOD_ADVISOR_PROTOCOL: 'openai', LLMPOD_ADVISOR_MODEL: 'm', LLMPOD_ADVISOR_API_KEY: KEY });
    expect(await s.run(['advisor', '--preset', 'claude-cli'])).toBe(0);
    const env = s.store.readEnv();
    expect(env.LLMPOD_ADVISOR_BASE_URL).toBeUndefined();
    expect(env.LLMPOD_ADVISOR_API_KEY).toBeUndefined();
  });

  describe('custom: la chiave salvata si mantiene solo verso lo stesso endpoint', () => {
    const saved = { LLMPOD_ADVISOR_PRESET: 'custom', LLMPOD_ADVISOR_PROTOCOL: 'openai', LLMPOD_ADVISOR_BASE_URL: 'https://a.example.com/v1', LLMPOD_ADVISOR_MODEL: 'm', LLMPOD_ADVISOR_AUTH: 'bearer', LLMPOD_ADVISOR_API_KEY: KEY };
    const rerun = async (texts) => {
      const s = sandbox({ answers: { text: ['custom', ...texts], secret: [''] } });
      s.store.writeEnv(saved);
      const code = await s.run(['advisor']);
      return { s, code };
    };

    it('stessi preset, URL, protocollo e auth: invio vuoto mantiene la chiave', async () => {
      const { s, code } = await rerun(['openai', 'https://a.example.com/v1', 'm', 'bearer']);
      expect(code).toBe(0);
      expect(s.store.readEnv().LLMPOD_ADVISOR_API_KEY).toBe(KEY);
      expect(s.prompt.askSecret.mock.calls[0][0]).toMatch(/invio per mantenere/);
    });

    it.each([
      ['URL', ['openai', 'https://b.example.com/v1', 'm', 'bearer']],
      ['protocollo', ['anthropic', 'https://a.example.com/v1', 'm', 'bearer']],
      ['autenticazione', ['openai', 'https://a.example.com/v1', 'm', 'x-api-key']],
    ])('%s diverso: la chiave va reinserita, invio vuoto è un errore e nulla viene salvato', async (_n, texts) => {
      const { s, code } = await rerun(texts);
      expect(s.prompt.askSecret.mock.calls[0][0]).not.toMatch(/invio per mantenere/);
      expect(code).toBe(1);
      expect(s.all()).toMatch(/chiave/i);
      expect(s.store.readEnv()).toMatchObject(saved);
    });

    it('URL diverso con una chiave nuova: viene salvata quella nuova', async () => {
      const s = sandbox({ answers: { text: ['custom', 'openai', 'https://b.example.com/v1', 'm', 'bearer'], secret: ['NUOVA-CHIAVE-FINTA-1'] } });
      s.store.writeEnv(saved);
      expect(await s.run(['advisor'])).toBe(0);
      expect(s.store.readEnv()).toMatchObject({ LLMPOD_ADVISOR_BASE_URL: 'https://b.example.com/v1', LLMPOD_ADVISOR_API_KEY: 'NUOVA-CHIAVE-FINTA-1' });
    });

    it('la domanda del Base URL suggerisce quando includere /v1', async () => {
      const { s } = await rerun(['openai', 'https://a.example.com/v1', 'm', 'bearer']);
      const q = s.prompt.askText.mock.calls.map((c) => c[0]).find((x) => /Base URL/.test(x));
      expect(q).toMatch(/openai.*\/v1.*https:\/\/host\/v1/);
      expect(q).toMatch(/anthropic.*no.*https:\/\/host\)/);
    });
  });

  it('--test: risposta valida → ok; errore del provider → codice 1 senza chiave in output', async () => {
    const s = sandbox();
    s.store.writeEnv({ LLMPOD_ADVISOR_PRESET: 'zai', LLMPOD_ADVISOR_API_KEY: KEY });
    s.store.writeConfig({ advisor: { enabled: true } });
    const http = { request: vi.fn(async () => ({ ok: true, status: 200, data: { choices: [{ message: { content: '{"set":{},"rationale":"ok","warnings":[]}' } }] } })) };
    expect(await s.run(['advisor', '--test'], { http })).toBe(0);
    expect(s.out()).toMatch(/raggiungibile/);
    const bad = { request: vi.fn(async () => ({ ok: false, status: 401, data: { message: `bad ${KEY}` } })) };
    expect(await s.run(['advisor', '--test'], { http: bad })).toBe(1);
    expect(s.all()).not.toContain(KEY);
  });

  it('--disable', async () => {
    const s = sandbox();
    s.store.writeConfig({ advisor: { enabled: true, zaiNoticeAcknowledged: true } });
    expect(await s.run(['advisor', '--disable'])).toBe(0);
    expect(s.store.readConfig().advisor).toEqual({ enabled: false, zaiNoticeAcknowledged: true });
  });

  describe('in Docker (LLMPOD_IN_DOCKER=1)', () => {
    it('il preset claude-cli non è proposto', async () => {
      const s = sandbox({ answers: { text: ['custom', 'openai', 'https://llm.example.com/v1', 'm', 'bearer'], secret: [KEY] } });
      s.env.LLMPOD_IN_DOCKER = '1';
      expect(await s.run(['advisor'])).toBe(0);
      expect(s.out()).not.toContain('claude-cli');
      expect(s.out()).toContain('zai-coding-plan');
    });

    it('--preset claude-cli è rifiutato e non viene salvato', async () => {
      const s = sandbox();
      s.env.LLMPOD_IN_DOCKER = '1';
      expect(await s.run(['advisor', '--preset', 'claude-cli'])).toBe(1);
      expect(s.err()).toMatch(/Il preset claude-cli non funziona nel container: usa un altro preset o la CLI senza Docker/);
      expect(s.store.readEnv().LLMPOD_ADVISOR_PRESET).toBeUndefined();
    });

    it('un preset claude-cli già configurato fa fallire il consulente con INVALID_INPUT', async () => {
      const s = sandbox();
      s.env.LLMPOD_IN_DOCKER = '1';
      s.store.writeEnv({ LLMPOD_ADVISOR_PRESET: 'claude-cli' });
      s.store.writeConfig({ advisor: { enabled: true } });
      expect(await s.run(['advisor', '--test'])).toBe(1);
      expect(s.err()).toMatch(/Il preset claude-cli non funziona nel container/);
    });
  });
});
