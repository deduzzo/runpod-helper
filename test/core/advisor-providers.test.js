import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createProvider } from '../../src/core/advisor/providers.js';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';

const KEY = 'CHIAVE-CONSULENTE-FINTA-123';
const ok = (data) => ({ ok: true, status: 200, data });

describe('provider HTTP', () => {
  beforeEach(() => { clearSecrets(); registerSecret(KEY); });

  it('anthropic: /v1/messages, anthropic-version, bearer o x-api-key', async () => {
    const http = { request: vi.fn(async () => ok({ content: [{ type: 'text', text: '{"set":{}}' }] })) };
    const p = createProvider({ preset: 'zai-coding-plan', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3', apiKey: KEY, auth: 'bearer', timeoutMs: 120000 }, { http });
    expect(await p.complete({ system: 'S', user: 'U' })).toEqual({ text: '{"set":{}}' });
    const [method, url, opts] = http.request.mock.calls[0];
    expect(method).toBe('POST');
    expect(url).toBe('https://api.z.ai/api/anthropic/v1/messages');
    expect(opts.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'anthropic-version': '2023-06-01' });
    expect(opts.headers['user-agent']).toBeUndefined();
    expect(opts.json).toEqual({ model: 'glm-5.3', max_tokens: 2000, system: 'S', messages: [{ role: 'user', content: 'U' }] });
    expect(opts.timeoutMs).toBe(120000);

    const http2 = { request: vi.fn(async () => ok({ content: [{ type: 'text', text: 'x' }] })) };
    await createProvider({ preset: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: KEY, auth: 'x-api-key', timeoutMs: 1 }, { http: http2 }).complete({ system: 's', user: 'u' });
    expect(http2.request.mock.calls[0][2].headers).toMatchObject({ 'x-api-key': KEY });
    expect(http2.request.mock.calls[0][2].headers.authorization).toBeUndefined();
  });

  it('openai: /chat/completions con messaggio di sistema', async () => {
    const http = { request: vi.fn(async () => ok({ choices: [{ message: { content: 'risposta' } }] })) };
    const p = createProvider({ preset: 'zai', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', apiKey: KEY, auth: 'bearer', timeoutMs: 120000 }, { http });
    expect((await p.complete({ system: 'S', user: 'U', maxTokens: 500 })).text).toBe('risposta');
    const [, url, opts] = http.request.mock.calls[0];
    expect(url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(opts.json).toEqual({ model: 'glm-5.3', max_tokens: 500, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
  });

  it('401 → ADVISOR_FAILED con suggerimento e senza la chiave nel messaggio', async () => {
    const http = { request: vi.fn(async () => ({ ok: false, status: 401, data: { error: { message: `invalid key ${KEY}` } } })) };
    const p = createProvider({ preset: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: KEY, auth: 'x-api-key', timeoutMs: 1 }, { http });
    const err = await p.complete({ system: 's', user: 'u' }).catch((e) => e);
    expect(err.code).toBe('ADVISOR_FAILED');
    expect(err.hint).toMatch(/llmpod advisor/);
    expect(JSON.stringify({ m: err.message, h: err.hint })).not.toContain(KEY);
  });

  it('errore di rete e risposta vuota → ADVISOR_FAILED', async () => {
    const httpNet = { request: vi.fn(async () => { throw Object.assign(new Error('Errore di rete verso x'), { code: 'NETWORK' }); }) };
    const cfg = { preset: 'zai', protocol: 'openai', baseUrl: 'https://x', model: 'm', apiKey: KEY, auth: 'bearer', timeoutMs: 1 };
    await expect(createProvider(cfg, { http: httpNet }).complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'ADVISOR_FAILED' });
    const httpEmpty = { request: vi.fn(async () => ok({ choices: [{ message: { content: '' } }] })) };
    await expect(createProvider(cfg, { http: httpEmpty }).complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'ADVISOR_FAILED' });
  });
});

describe('provider claude -p', () => {
  function fakeSpawn({ stdout = '', stderr = '', code = 0, error } = {}) {
    return vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn() };
      child.kill = vi.fn();
      setTimeout(() => {
        if (error) return child.emit('error', error);
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
      }, 0);
      return child;
    });
  }

  it('invoca claude senza strumenti e legge "result"', async () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ result: '{"set":{}}', is_error: false }) });
    const p = createProvider({ preset: 'claude-cli', protocol: 'claude-cli', timeoutMs: 180000 }, { spawn });
    expect(await p.complete({ system: 'SISTEMA', user: 'DOMANDA' })).toEqual({ text: '{"set":{}}' });
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--system-prompt', 'SISTEMA']);
    expect(spawn.mock.results[0].value.stdin.end).toHaveBeenCalledWith('DOMANDA');
  });

  it('uscita non zero, is_error e comando assente', async () => {
    const cfg = { preset: 'claude-cli', protocol: 'claude-cli', timeoutMs: 180000 };
    await expect(createProvider(cfg, { spawn: fakeSpawn({ code: 1, stderr: 'boom' }) }).complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'ADVISOR_FAILED' });
    await expect(createProvider(cfg, { spawn: fakeSpawn({ stdout: JSON.stringify({ result: 'x', is_error: true }) }) }).complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'ADVISOR_FAILED' });
    await expect(createProvider(cfg, { spawn: fakeSpawn({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }) }).complete({ system: 's', user: 'u' }))
      .rejects.toMatchObject({ code: 'ADVISOR_NOT_CONFIGURED' });
  });
});
