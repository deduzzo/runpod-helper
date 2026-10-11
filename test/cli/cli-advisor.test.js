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
});
