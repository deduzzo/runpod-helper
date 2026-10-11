import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttp, httpError } from '../../src/core/http.js';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';

const res = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('http', () => {
  beforeEach(() => clearSecrets());

  it('invia User-Agent, JSON e query ripetute', async () => {
    const fetch = vi.fn().mockResolvedValue(res(200, { ok: 1 }));
    const http = createHttp({ fetch, userAgent: 'llmpod/0.1.0' });
    const out = await http.request('POST', 'https://x.test/a', { json: { b: 1 }, query: { 'expand[]': ['sha', 'gated'], n: 2 } });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://x.test/a?expand%5B%5D=sha&expand%5B%5D=gated&n=2');
    expect(init.headers['user-agent']).toBe('llmpod/0.1.0');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"b":1}');
    expect(out).toMatchObject({ status: 200, ok: true, data: { ok: 1 } });
  });

  it('ritenta 429 rispettando Retry-After', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(res(429, '', { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    const sleep = vi.fn().mockResolvedValue();
    const http = createHttp({ fetch, userAgent: 'u', sleep });
    const out = await http.request('POST', 'https://x.test/a', { json: {} });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(out.status).toBe(200);
  });

  it('ritenta 5xx solo per metodi idempotenti', async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fetchGet = vi.fn().mockResolvedValueOnce(res(503, '')).mockResolvedValueOnce(res(200, '{}'));
    expect((await createHttp({ fetch: fetchGet, userAgent: 'u', sleep }).request('GET', 'https://x.test')).status).toBe(200);
    const fetchPost = vi.fn().mockResolvedValue(res(503, ''));
    expect((await createHttp({ fetch: fetchPost, userAgent: 'u', sleep }).request('POST', 'https://x.test', { json: {} })).status).toBe(503);
    expect(fetchPost).toHaveBeenCalledTimes(1);
  });

  it('gli errori di rete non contengono segreti', async () => {
    registerSecret('rpa_SEGRETOFINTO1234');
    const fetch = vi.fn().mockRejectedValue(new Error('fallito con rpa_SEGRETOFINTO1234'));
    const http = createHttp({ fetch, userAgent: 'u', sleep: async () => {}, maxRetries: 0 });
    await expect(http.request('GET', 'https://x.test')).rejects.toMatchObject({
      code: 'NETWORK', message: expect.not.stringContaining('rpa_SEGRETOFINTO1234'),
    });
  });

  it('httpError usa il detail del problem+json e maschera', () => {
    registerSecret('rpa_SEGRETOFINTO1234');
    const err = httpError({ status: 400, data: { detail: 'header rpa_SEGRETOFINTO1234 errato' } }, 'Creazione Pod');
    expect(err.code).toBe('HTTP');
    expect(err.message).toBe('Creazione Pod: HTTP 400 header <REDATTO> errato');
  });
});
