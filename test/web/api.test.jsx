// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, fmtUSD, fmtGiB, fmtDuration } from '../../web/src/lib/api.js';
import { mockApi } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('api', () => {
  it('JSON, stessa origine e corpo', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await api('/api/plan', { method: 'POST', body: { model: 'x' } })).toEqual({ ok: 1 });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/plan');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{"model":"x"}' });
  });

  it('R26: ogni richiesta non GET invia content-type JSON, anche senza corpo ({})', async () => {
    const fetchMock = mockApi({ 'POST /api/jobs/j1/answer': { ok: true }, 'DELETE /api/x': { ok: true } });
    await api('/api/jobs/j1/answer', { method: 'POST' });
    await api('/api/x', { method: 'DELETE' });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toEqual({ 'content-type': 'application/json' });
      expect(init.body).toBe('{}');
    }
  });

  it('GET senza corpo né content-type', async () => {
    const fetchMock = mockApi({ 'GET /api/status': { ok: true } });
    await api('/api/status');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['content-type']).toBeUndefined();
  });

  it('errori → ApiError con codice e suggerimento', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'GATED_MODEL', message: 'Accesso negato', hint: 'Richiedi l\'accesso' } }), { status: 400 }));
    const err = await api('/api/plan').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'GATED_MODEL', message: 'Accesso negato', hint: 'Richiedi l\'accesso' });
  });

  it('formattazione', () => {
    expect(fmtUSD(1.789)).toBe('1,79 $');
    expect(fmtUSD(null)).toBe('—');
    expect(fmtGiB(56.87)).toBe('56,9 GiB');
    expect(fmtDuration(3900)).toBe('1 h 5 min');
    expect(fmtDuration(200)).toBe('3 min 20 s');
  });
});
