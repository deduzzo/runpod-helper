import { describe, it, expect, vi } from 'vitest';
import { smokeTest } from '../../src/core/pod/smoke.js';

const okModels = { ok: true, status: 200, data: { data: [{ id: 'm' }] } };
const okMessages = { ok: true, status: 200, data: { content: [{ type: 'tool_use', name: 'get_weather', input: { city: 'Messina' } }] } };
const okChat = { ok: true, status: 200, data: { choices: [{ message: { tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Messina"}' } }] } }] } };

describe('smokeTest', () => {
  it('tutto ok', async () => {
    const http = { request: vi.fn().mockResolvedValueOnce(okModels).mockResolvedValueOnce(okMessages).mockResolvedValueOnce(okChat) };
    const r = await smokeTest({ http, baseUrl: 'https://p-8000.proxy.runpod.net', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(true);
    const [, url, opts] = http.request.mock.calls[1];
    expect(url).toBe('https://p-8000.proxy.runpod.net/v1/messages');
    expect(opts.json.tools[0].name).toBe('get_weather');
    expect(opts.timeoutMs).toBeLessThan(95_000);
  });

  it('nessuna chiamata a strumento → fallisce con dettaglio', async () => {
    const http = { request: vi.fn().mockResolvedValueOnce(okModels)
      .mockResolvedValueOnce({ ok: true, status: 200, data: { content: [{ type: 'text', text: 'Fa bel tempo' }] } })
      .mockResolvedValueOnce({ ok: false, status: 400, data: { message: '"auto" tool choice requires --enable-auto-tool-choice' } }) };
    const r = await smokeTest({ http, baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.messages).toMatchObject({ ok: false, detail: expect.stringContaining('Fa bel tempo') });
    expect(r.chat.detail).toContain('enable-auto-tool-choice');
  });

  it('un errore di rete diventa un dettaglio, non un\'eccezione', async () => {
    const http = { request: vi.fn().mockRejectedValue(Object.assign(new Error('Errore di rete'), { code: 'NETWORK' })) };
    const r = await smokeTest({ http, baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.models.detail).toContain('Errore di rete');
  });
});
