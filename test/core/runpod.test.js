import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { createRunpod, proxyUrl } from '../../src/core/runpod.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/runpod/${p}`, import.meta.url), 'utf8'));
const ok = (data, status = 200) => ({ ok: status < 300, status, data, headers: new Headers() });

function setup(handler) {
  const http = { request: vi.fn(handler) };
  return { http, rp: createRunpod({ http, apiKey: 'rpa_SEGRETOFINTO1234' }) };
}

describe('runpod', () => {
  it('proxyUrl', () => {
    expect(proxyUrl('abc123', 8000)).toBe('https://abc123-8000.proxy.runpod.net');
  });

  it('listGpus passa i filtri di disponibilità e l\'autorizzazione', async () => {
    const { http, rp } = setup(async () => ok(fx('catalog-gpus-count1.json')));
    const gpus = await rp.listGpus({ count: 2, minCudaVersion: '12.9' });
    const [method, url, opts] = http.request.mock.calls[0];
    expect(method).toBe('GET');
    expect(url).toBe('https://api.runpod.io/v2/catalog/gpus');
    expect(opts.query).toEqual({ include: 'AVAILABILITY', product: 'POD', count: 2, cloud: 'SECURE', minCudaVersion: '12.9' });
    expect(opts.headers.authorization).toBe('Bearer rpa_SEGRETOFINTO1234');
    expect(gpus.some((g) => g.id === 'NVIDIA H100 80GB HBM3')).toBe(true);
  });

  it('listPods segue la paginazione', async () => {
    const { rp } = setup(async (m, url, opts) => (opts.query?.cursor
      ? ok({ pagination: { hasNextPage: false, nextCursor: null }, pods: [{ id: 'b' }] })
      : ok({ pagination: { hasNextPage: true, nextCursor: 'C1' }, pods: [{ id: 'a' }] })));
    expect((await rp.listPods()).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('getPod restituisce null su 404', async () => {
    const { rp } = setup(async () => ok(fx('error-404.json'), 404));
    expect(await rp.getPod('xyz')).toBeNull();
  });

  it('deletePod accetta 204 e 404', async () => {
    const { rp } = setup(async () => ok(null, 204));
    await expect(rp.deletePod('a')).resolves.toBeUndefined();
    const { rp: rp2 } = setup(async () => ok(fx('error-404.json'), 404));
    await expect(rp2.deletePod('a')).resolves.toBeUndefined();
  });

  it('volumi su /v2/network-volumes', async () => {
    const { http, rp } = setup(async (m) => (m === 'GET' ? ok(fx('networkvolumes-list.json')) : ok({ id: 'v1', name: 'llmpod-pesi', size: 150, dataCenter: 'EU-RO-1' }, 201)));
    expect(await rp.listVolumes()).toEqual([]);
    const v = await rp.createVolume({ name: 'llmpod-pesi', size: 150, dataCenter: 'EU-RO-1' });
    expect(v.id).toBe('v1');
    const [, url, opts] = http.request.mock.calls[1];
    expect(url).toBe('https://api.runpod.io/v2/network-volumes');
    expect(opts.json).toEqual({ name: 'llmpod-pesi', size: 150, dataCenter: 'EU-RO-1' });
  });

  it('getBalance usa GraphQL', async () => {
    const { http, rp } = setup(async () => ok({ data: { myself: { clientBalance: 49.5, currentSpendPerHr: 0 } } }));
    expect(await rp.getBalance()).toEqual({ balance: 49.5, spendPerHour: 0 });
    expect(http.request.mock.calls[0][1]).toBe('https://api.runpod.io/graphql');
  });

  it('mappa 401/402 su codici specifici', async () => {
    const { rp } = setup(async () => ok({ title: 'Unauthorized', status: 401 }, 401));
    await expect(rp.listPods()).rejects.toMatchObject({ code: 'RUNPOD_AUTH' });
    const { rp: rp2 } = setup(async () => ok({ detail: 'insufficient balance', status: 402 }, 402));
    await expect(rp2.createVolume({ name: 'x', size: 10, dataCenter: 'EU-RO-1' })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });
});
