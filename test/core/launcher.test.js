import { describe, it, expect, vi } from 'vitest';
import { rankCandidates, createWithFallback, waitForRunning, waitForReady, readyTimeoutMs, createSupervisorClient } from '../../src/core/pod/launcher.js';

const sleep = vi.fn().mockResolvedValue();
const clock = () => { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; };

describe('rankCandidates', () => {
  it('prima il datacenter del volume (scelta + alternative), poi gli altri datacenter', () => {
    const profile = { dataCenterId: 'EU-A', gpu: { id: 'G1', count: 1 }, alternatives: [{ id: 'G2', count: 2 }], volume: { id: 'v' } };
    const g = (id, price, dcs) => ({ id, price: { secure: price }, dataCenters: dcs.map(([d, a]) => ({ id: d, availability: a })) });
    const catalogs = { 1: [g('G1', 1, [['EU-A', 'NONE'], ['US-B', 'HIGH'], ['EU-C', 'LOW']])], 2: [g('G2', 0.5, [['EU-A', 'LOW']])] };
    const r = rankCandidates({ profile, catalogs, cloud: 'SECURE' });
    expect(r.inVolumeDc).toEqual([
      { id: 'G1', count: 1, dataCenterId: 'EU-A', withVolume: true, hourly: 1, availability: 'NONE' },
      { id: 'G2', count: 2, dataCenterId: 'EU-A', withVolume: true, hourly: 1, availability: 'LOW' },
    ]);
    expect(r.otherDcs.map((c) => `${c.id}@${c.dataCenterId}`)).toEqual(['G1@US-B', 'G1@EU-C']);
    expect(r.otherDcs.every((c) => c.withVolume === false)).toBe(true);
  });
});

describe('createWithFallback', () => {
  const cands = [{ id: 'A', count: 1 }, { id: 'B', count: 1 }, { id: 'C', count: 1 }];
  const body = (c) => ({ gpu: c.id });

  it('400 e 403 passano al candidato successivo', async () => {
    const runpod = { createPod: vi.fn()
      .mockResolvedValueOnce({ status: 400, data: { detail: 'no capacity' } })
      .mockResolvedValueOnce({ status: 403, data: {} })
      .mockResolvedValueOnce({ status: 201, data: { id: 'pod1' } }) };
    const r = await createWithFallback({ runpod, candidates: cands, buildBody: body, sleep });
    expect(r).toEqual({ pod: { id: 'pod1' }, candidate: cands[2] });
  });

  it('5xx ritenta lo stesso candidato', async () => {
    const runpod = { createPod: vi.fn().mockResolvedValueOnce({ status: 503, data: {} }).mockResolvedValueOnce({ status: 201, data: { id: 'p' } }) };
    const r = await createWithFallback({ runpod, candidates: cands, buildBody: body, sleep });
    expect(r.candidate.id).toBe('A');
    expect(runpod.createPod).toHaveBeenCalledTimes(2);
  });

  it('5xx con findExisting che trova un Pod: nessun secondo createPod', async () => {
    const runpod = { createPod: vi.fn().mockResolvedValue({ status: 503, data: {} }) };
    const findExisting = vi.fn().mockResolvedValue({ id: 'pod9' });
    const r = await createWithFallback({ runpod, candidates: cands, buildBody: body, sleep, findExisting });
    expect(r).toEqual({ pod: { id: 'pod9' }, candidate: cands[0] });
    expect(runpod.createPod).toHaveBeenCalledTimes(1);
  });

  it('402 si ferma subito, 422 è un errore della richiesta', async () => {
    const r402 = { createPod: vi.fn().mockResolvedValue({ status: 402, data: { detail: 'balance' } }) };
    await expect(createWithFallback({ runpod: r402, candidates: cands, buildBody: body, sleep })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(r402.createPod).toHaveBeenCalledTimes(1);
    const r422 = { createPod: vi.fn().mockResolvedValue({ status: 422, data: { detail: 'Request validation failed.', errors: ['$.gpu: x'] } }) };
    await expect(createWithFallback({ runpod: r422, candidates: cands, buildBody: body, sleep })).rejects.toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringContaining('$.gpu: x') });
  });

  it('tutti esauriti → NO_GPU_AVAILABLE con l\'ultimo dettaglio', async () => {
    const runpod = { createPod: vi.fn().mockResolvedValue({ status: 400, data: { detail: 'no instances available' } }) };
    await expect(createWithFallback({ runpod, candidates: cands, buildBody: body, sleep }))
      .rejects.toMatchObject({ code: 'NO_GPU_AVAILABLE', message: expect.stringContaining('no instances available') });
  });

  it('beforeAttempt può fermare il tentativo (es. conferma per un candidato più caro)', async () => {
    const runpod = { createPod: vi.fn().mockResolvedValueOnce({ status: 400, data: {} }) };
    const beforeAttempt = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'CANCELLED' }));
    await expect(createWithFallback({ runpod, candidates: cands, buildBody: body, sleep, beforeAttempt })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('attese', () => {
  it('waitForRunning restituisce il Pod RUNNING', async () => {
    const runpod = { getPod: vi.fn().mockResolvedValueOnce({ status: 'PROVISIONING' }).mockResolvedValueOnce({ id: 'p', status: 'RUNNING' }) };
    expect(await waitForRunning({ runpod, podId: 'p', sleep })).toMatchObject({ status: 'RUNNING' });
  });

  it('waitForRunning: stato ERROR o Pod sparito → errore; timeout → POD_START_TIMEOUT', async () => {
    await expect(waitForRunning({ runpod: { getPod: async () => ({ status: 'ERROR' }) }, podId: 'p', sleep })).rejects.toMatchObject({ code: 'VLLM_ERROR' });
    await expect(waitForRunning({ runpod: { getPod: async () => null }, podId: 'p', sleep })).rejects.toMatchObject({ code: 'VLLM_ERROR' });
    const c = clock();
    const s = async (ms) => c.tick(ms);
    await expect(waitForRunning({ runpod: { getPod: async () => ({ status: 'STARTING' }) }, podId: 'p', sleep: s, now: c.now, timeoutMs: 30000 }))
      .rejects.toMatchObject({ code: 'POD_START_TIMEOUT' });
  });

  it('waitForReady segue le fasi, inoltra i log e riconosce l\'OOM', async () => {
    const statuses = [null, { phase: 'downloading', downloadedBytes: 5, totalBytes: 10 }, { phase: 'ready', kvCacheTokens: 1000 }];
    const sup = { status: vi.fn(async () => statuses.shift()), logs: vi.fn(async () => ({ lines: [{ n: 1, line: 'ciao' }] })) };
    const onLog = vi.fn();
    const st = await waitForReady({ sup, timeoutMs: 60000, sleep, onLog });
    expect(st.phase).toBe('ready');
    expect(onLog).toHaveBeenCalledWith('ciao');
    const supErr = { status: async () => ({ phase: 'error', lastError: 'vLLM terminato con codice 1' }), logs: async () => ({ lines: [{ n: 1, line: 'torch.OutOfMemoryError: CUDA out of memory' }] }) };
    await expect(waitForReady({ sup: supErr, timeoutMs: 60000, sleep })).rejects.toMatchObject({ code: 'OOM' });
  });

  it('readyTimeoutMs: pesi a 50 MB/s + 10 minuti', () => {
    expect(readyTimeoutMs(50e6 * 600)).toBe(600_000 + 600_000);
  });

  it('createSupervisorClient usa la porta 8001 con Bearer e restituisce null se il proxy non è pronto', async () => {
    const http = { request: vi.fn().mockResolvedValueOnce({ ok: false, status: 502, data: '' }).mockResolvedValueOnce({ ok: true, status: 200, data: { phase: 'loading' } }) };
    const sup = createSupervisorClient({ http, podId: 'p1', apiKey: 'k' });
    expect(await sup.status()).toBeNull();
    expect(await sup.status()).toEqual({ phase: 'loading' });
    expect(http.request.mock.calls[0][1]).toBe('https://p1-8001.proxy.runpod.net/status');
    expect(http.request.mock.calls[0][2].headers.authorization).toBe('Bearer k');
  });
});
