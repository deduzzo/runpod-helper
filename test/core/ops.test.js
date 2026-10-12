import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOps, profileFromPlan, generateKey } from '../../src/core/ops.js';
import { createStore } from '../../src/core/config.js';
import { createEvents } from '../../src/core/events.js';
import { clearSecrets } from '../../src/core/secrets.js';
import { LlmpodError, Codes } from '../../src/core/errors.js';
import { waitForReady, readyTimeoutMs, startupTimeoutMs } from '../../src/core/pod/launcher.js';
import { estimateStartup } from '../../src/core/planner/startup.js';

vi.mock('../../src/core/pod/launcher.js', async (orig) => {
  const m = await orig();
  return { ...m, waitForReady: vi.fn(m.waitForReady) };
});

const KEY = 'CHIAVE-PROFILO-FINTA-123456';
const gpu = (id, memory, price, dcs) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: dcs.map(([d, a]) => ({ id: d, availability: a })) });
const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  context: 65536, concurrency: 2, vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 },
  gpu: { id: 'GPU80', count: 1 }, hourlyUSD: 1.5, alternatives: [{ id: 'GPU96', count: 1, hourly: 2.5 }], elsewhere: [], candidates: [],
  dataCenterId: 'EU-A', cloud: 'SECURE', kvCacheDtype: null, warnings: [],
};

function setup({ catalog = { 1: [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU96', 96, 2.5, [['EU-A', 'LOW']])] }, createResponses, smokeOk = true, askAnswers = [] } = {}) {
  clearSecrets();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-ops-')), 'cfg');
  const store = createStore({ dir, platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-A' } });
  store.writeJson('last-plan.json', plan);
  let deleted = false;
  const runpod = {
    listPods: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 50, spendPerHour: 0 })),
    listGpus: vi.fn(async ({ count }) => catalog[count] ?? []),
    createPod: vi.fn(async () => (createResponses?.shift() ?? { status: 201, data: { id: 'pod1' } })),
    getPod: vi.fn(async () => (deleted ? null : { id: 'pod1', status: 'RUNNING', cost: 1.49 })),
    deletePod: vi.fn(async () => { deleted = true; }),
  };
  const routes = {
    'GET https://pod1-8001.proxy.runpod.net/logs?since=0': { ok: true, status: 200, data: { lines: [] } },
    'GET https://pod1-8001.proxy.runpod.net/status': { ok: true, status: 200, data: { phase: 'ready', kvCacheTokens: 400000 } },
    'GET https://pod1-8000.proxy.runpod.net/v1/models': { ok: true, status: 200, data: { data: [{ id: 'qwen3-coder' }] } },
    'POST https://pod1-8000.proxy.runpod.net/v1/messages': { ok: true, status: 200, data: { content: smokeOk ? [{ type: 'tool_use', name: 'get_weather' }] : [{ type: 'text', text: 'no' }] } },
    'POST https://pod1-8000.proxy.runpod.net/v1/chat/completions': { ok: true, status: 200, data: { choices: [{ message: { tool_calls: [{ function: { name: 'get_weather' } }] } }] } },
  };
  const http = { request: vi.fn(async (m, url) => routes[`${m} ${url}`] ?? { ok: false, status: 404, data: null }) };
  const hf = { checkAccess: vi.fn(async () => ({ ok: true, status: 200 })) };
  const ask = vi.fn(async () => (askAnswers.length ? askAnswers.shift() : true));
  const events = createEvents();
  const seen = [];
  events.on((e) => seen.push(e));
  let t = 0;
  const ops = createOps({ store, runpod, hf, http, events, ask, now: () => (t += 1000), sleep: async () => {}, zcode: { dir: path.join(dir, 'zcode'), isRunning: async () => false } });
  return { ops, store, runpod, http, ask, seen };
}

describe('ops', () => {
  beforeEach(() => clearSecrets());

  it('generateKey produce chiavi lunghe e diverse', () => {
    expect(generateKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateKey()).not.toBe(generateKey());
  });

  it('profileFromPlan', () => {
    const p = profileFromPlan(plan, { name: 'qwen3-coder', volume: { id: 'vol1' }, watchdog: { idleMinutes: 30, maxHours: 8 } });
    expect(p).toMatchObject({ name: 'qwen3-coder', servedName: 'qwen3-coder', gpu: { id: 'GPU80', count: 1 }, alternatives: [{ id: 'GPU96', count: 1 }], volume: { id: 'vol1', mountPath: '/workspace' }, allowFallbackWithoutVolume: 'ask' });
  });

  it('saveProfile salva il profilo e genera la chiave una sola volta', () => {
    const { ops, store } = setup();
    ops.saveProfile('qwen3-coder');
    const k1 = store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    ops.saveProfile('qwen3-coder');
    expect(store.readEnv().LLMPOD_KEY_QWEN3_CODER).toBe(k1);
    expect(store.readProfile('qwen3-coder').volume.id).toBe('vol1');
  });

  it('up completo: crea il Pod, attende, smoke test, suggerisce il contesto', async () => {
    const { ops, store, runpod, seen } = setup();
    ops.saveProfile('qwen3-coder');
    const r = await ops.up('qwen3-coder', { yes: true });
    expect(r).toMatchObject({ podId: 'pod1', baseUrl: 'https://pod1-8000.proxy.runpod.net', hourlyUSD: 1.49, kvCacheTokens: 400000, contextSuggestion: 199680 });
    const body = runpod.createPod.mock.calls[0][0];
    expect(body.dataCenterIds).toEqual(['EU-A']);
    expect(body.mounts.network[0].volumeId).toBe('vol1');
    expect(store.readState().pods['qwen3-coder'].podId).toBe('pod1');
    expect(seen.some((e) => e.type === 'pod' && e.podId === 'pod1')).toBe(true);
  });

  it('up: il timeout di avvio usa downloadBytes (tutti i safetensors da scaricare); profili vecchi → weightsBytes', async () => {
    const DL = 47144848872 * 2;
    const run = async (estimate) => {
      const { ops, store } = setup();
      ops.saveProfile('qwen3-coder');
      const prof = store.readProfile('qwen3-coder');
      store.writeProfile({ ...prof, estimate });
      waitForReady.mockClear();
      await ops.up('qwen3-coder', { yes: true });
      return waitForReady.mock.calls[0][0].timeoutMs;
    };
    // il massimo tra il limite sui byte e 1,5 × la stima dell'avvio (qui: volume di rete, una GPU)
    const est = (dl) => estimateStartup({ downloadBytes: dl, weightsBytes: 61066575656, count: 1, withVolume: true });
    expect(await run({ weightsGiB: 43.9, downloadBytes: DL })).toBe(startupTimeoutMs(DL, est(DL)));
    expect(await run({ weightsGiB: 56.9 })).toBe(startupTimeoutMs(61066575656, est(61066575656)));
    expect(startupTimeoutMs(DL, est(DL))).toBeGreaterThan(readyTimeoutMs(DL));
  });

  it('up: smoke test fallito → propone di terminare e termina', async () => {
    const { ops, store, runpod, ask } = setup({ smokeOk: false });
    ops.saveProfile('qwen3-coder');
    await expect(ops.up('qwen3-coder', { yes: false })).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(ask.mock.calls.at(-1)[0]).toMatch(/Terminare il Pod pod1/);
    expect(runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(store.readState().pods['qwen3-coder']).toBeUndefined();
  });

  it('up --dry-run non crea nulla e maschera i segreti', async () => {
    const { ops, runpod, store } = setup();
    ops.saveProfile('qwen3-coder');
    const r = await ops.up('qwen3-coder', { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(runpod.createPod).not.toHaveBeenCalled();
    const key = store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.body.env.VLLM_API_KEY).toBe('<REDATTO>');
  });

  it('up rifiuta se il profilo ha già un Pod attivo', async () => {
    const { ops, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    runpod.listPods.mockResolvedValue([{ id: 'old', name: 'llmpod-qwen3-coder', status: 'RUNNING' }]);
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('old') });
  });

  it('up: nessuna disponibilità nel DC del volume → con consenso prova altri DC senza volume', async () => {
    const catalog = { 1: [gpu('GPU80', 80, 1.5, [['EU-A', 'NONE'], ['US-B', 'HIGH']]), gpu('GPU96', 96, 2.5, [['EU-A', 'NONE']])] };
    const { ops, runpod } = setup({ catalog, createResponses: [{ status: 400, data: {} }, { status: 400, data: {} }, { status: 201, data: { id: 'pod1' } }], askAnswers: [true, true] });
    ops.saveProfile('qwen3-coder');
    await ops.up('qwen3-coder', {});
    const bodies = runpod.createPod.mock.calls.map((c) => c[0]);
    expect(bodies.map((b) => b.dataCenterIds[0])).toEqual(['EU-A', 'EU-A', 'US-B']);
    expect(bodies[2].mounts).toBeUndefined();
  });

  it('up: credito insufficiente', async () => {
    const { ops, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    runpod.getBalance.mockResolvedValue({ balance: 0.5, spendPerHour: 0 });
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('down termina, verifica e pulisce lo stato; --dry-run non termina', async () => {
    const { ops, store, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    await ops.up('qwen3-coder', { yes: true });
    const dry = await ops.down('qwen3-coder', { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, podId: 'pod1' });
    expect(runpod.deletePod).not.toHaveBeenCalled();
    const r = await ops.down('qwen3-coder', { yes: true });
    expect(r.podId).toBe('pod1');
    expect(runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(store.readState().pods).toEqual({});
  });

  it('status: Pod llmpod, orfani, volume', async () => {
    const { ops, runpod } = setup();
    runpod.listPods.mockResolvedValue([
      { id: 'x1', name: 'llmpod-orfano', status: 'RUNNING', cost: 2, runtime: { uptime: 3600 } },
      { id: 'y', name: 'altro-pod', status: 'RUNNING', cost: 1 },
    ]);
    const s = await ops.status();
    expect(s.pods).toEqual([expect.objectContaining({ profile: 'orfano', podId: 'x1', orphan: true, sessionUSD: 2, uptimeSeconds: 3600 })]);
    expect(s.volume).toMatchObject({ id: 'vol1', monthlyUSD: 10.5 });
    expect(s.balance.balance).toBe(50);
  });

  it('endpoint e rotateKey', async () => {
    const { ops, store } = setup();
    ops.saveProfile('qwen3-coder');
    await expect(ops.endpoint('qwen3-coder')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await ops.up('qwen3-coder', { yes: true });
    const ep = await ops.endpoint('qwen3-coder');
    expect(ep).toMatchObject({ baseUrl: 'https://pod1-8000.proxy.runpod.net', servedName: 'qwen3-coder', context: 65536, reasoning: false, podId: 'pod1' });
    const before = store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    const r = await ops.rotateKey('qwen3-coder');
    expect(r.activePodId).toBe('pod1');
    expect(store.readEnv().LLMPOD_KEY_QWEN3_CODER).not.toBe(before);
  });

  it('resolveProfile', async () => {
    const { ops } = setup();
    await expect(ops.resolveProfile()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    ops.saveProfile('qwen3-coder');
    expect(await ops.resolveProfile()).toBe('qwen3-coder');
    expect(await ops.resolveProfile('qwen3-coder')).toBe('qwen3-coder');
  });

  it('nessun segreto negli eventi emessi durante up', async () => {
    const { ops, store, seen } = setup();
    ops.saveProfile('qwen3-coder');
    await ops.up('qwen3-coder', { yes: true });
    expect(JSON.stringify(seen)).not.toContain(store.readEnv().LLMPOD_KEY_QWEN3_CODER);
  });
});

describe('ops: nessun Pod orfano', () => {
  beforeEach(() => clearSecrets());

  it('down: Pod ancora attivo dopo la terminazione → RUNPOD_API e stato conservato', async () => {
    const { ops, store, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    await ops.up('qwen3-coder', { yes: true });
    runpod.deletePod.mockResolvedValue();
    runpod.getPod.mockResolvedValue({ id: 'pod1', status: 'RUNNING', cost: 1.49 });
    await expect(ops.down('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'RUNPOD_API' });
    expect(store.readState().pods['qwen3-coder'].podId).toBe('pod1');
  });

  it('up: creazione ambigua (NETWORK) con Pod comparso → terminato e errore originale rilanciato', async () => {
    const { ops, store, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    runpod.createPod.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'NETWORK' }));
    runpod.listPods.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'pod1', name: 'llmpod-qwen3-coder', status: 'RUNNING' }]);
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(store.readState().pods['qwen3-coder']).toBeUndefined();
  });

  it('up: timeout di avvio → "aspettare ancora" (sì) e poi pronto', async () => {
    const { ops, http, ask } = setup();
    ops.saveProfile('qwen3-coder');
    const orig = http.request.getMockImplementation();
    let extended = false;
    http.request.mockImplementation(async (m, url, o) => {
      if (url.endsWith('/status') && !extended) return { ok: false, status: 502, data: null };
      return orig(m, url, o);
    });
    ask.mockImplementation(async (msg) => { if (/Aspettare altri 15 minuti/.test(msg)) extended = true; return true; });
    const r = await ops.up('qwen3-coder', {});
    expect(r.podId).toBe('pod1');
    expect(ask.mock.calls.some((c) => /Aspettare altri 15 minuti/.test(c[0]))).toBe(true);
  });

  it('up: errore di avvio + terminazione fallita → warning e errore ORIGINALE', async () => {
    const { ops, runpod, seen } = setup({ smokeOk: false });
    ops.saveProfile('qwen3-coder');
    runpod.deletePod.mockRejectedValue(new Error('boom'));
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(seen.some((e) => e.type === 'warning' && /Terminazione del Pod pod1 non riuscita: boom/.test(e.message))).toBe(true);
  });
});

describe('ops: correzioni della revisione finale', () => {
  beforeEach(() => clearSecrets());

  it('offerTerminate: ask che rifiuta con CANCELLED (Ctrl+C al prompt) → il Pod viene terminato comunque', async () => {
    const { ops, runpod, ask } = setup({ smokeOk: false });
    ops.saveProfile('qwen3-coder');
    ask.mockImplementation(async (msg) => {
      if (/Terminare il Pod/.test(msg)) throw new LlmpodError(Codes.CANCELLED, 'annullato');
      return true;
    });
    await expect(ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(runpod.deletePod).toHaveBeenCalledWith('pod1');
  });

  it('profileFromPlan: senza GPU nel DC del volume usa le alternative "altrove" (dedupe per id+count)', () => {
    const noHere = { ...plan, gpu: null, alternatives: [], elsewhere: [
      { gpuId: 'GPU80', count: 1, hourly: 1.5 }, { gpuId: 'GPU96', count: 1, hourly: 2.5 },
      { gpuId: 'GPU80', count: 1, hourly: 1.5 }, { gpuId: 'GPU80', count: 2, hourly: 3 },
    ] };
    const p = profileFromPlan(noHere, { name: 'x', volume: null, watchdog: {} });
    expect(p.gpu).toEqual({ id: 'GPU80', count: 1 });
    expect(p.alternatives).toEqual([{ id: 'GPU96', count: 1 }, { id: 'GPU80', count: 2 }]);
  });

  it('saveProfile: né GPU né alternative altrove → NO_GPU_AVAILABLE con suggerimento', () => {
    const { ops, store } = setup();
    store.writeJson('last-plan.json', { ...plan, gpu: null, alternatives: [], elsewhere: [] });
    let err;
    try { ops.saveProfile('x'); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'NO_GPU_AVAILABLE' });
    expect(err.hint).toMatch(/llmpod plan/);
    expect(store.listProfiles()).toEqual([]);
  });

  it('saveProfile: profilo con GPU solo altrove viene avviabile da up (consenso senza volume)', async () => {
    const catalog = { 1: [gpu('GPU80', 80, 1.5, [['EU-A', 'NONE'], ['US-B', 'HIGH']])] };
    const { ops, store, runpod } = setup({ catalog, createResponses: [{ status: 400, data: {} }, { status: 201, data: { id: 'pod1' } }] });
    store.writeJson('last-plan.json', { ...plan, gpu: null, alternatives: [], elsewhere: [{ gpuId: 'GPU80', count: 1, hourly: 1.5 }] });
    ops.saveProfile('qwen3-coder');
    await ops.up('qwen3-coder', { yes: true });
    expect(runpod.createPod.mock.calls.map((c) => c[0].dataCenterIds[0])).toEqual(['EU-A', 'US-B']);
  });

  it('up: creazione ambigua senza Pod visibile → warning con istruzioni per controllare', async () => {
    const { ops, runpod, seen } = setup();
    ops.saveProfile('qwen3-coder');
    runpod.createPod.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'NETWORK' }));
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'NETWORK' });
    const w = seen.filter((e) => e.type === 'warning').map((e) => e.message).join('\n');
    expect(w).toContain('Potrebbe essere stato creato un Pod non ancora visibile');
    expect(w).toContain('llmpod status');
    expect(w).toContain('https://www.runpod.io/console/pods');
  });

  it('up: errore non ambiguo (credito) non emette il warning del Pod non visibile', async () => {
    const { ops, runpod, seen } = setup();
    ops.saveProfile('qwen3-coder');
    runpod.createPod.mockResolvedValue({ status: 402, data: { detail: 'no' } });
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(seen.some((e) => e.type === 'warning' && /non ancora visibile/.test(e.message))).toBe(false);
  });

  it('up: scrittura dello stato fallita dopo la creazione → viene offerta (e fatta) la terminazione', async () => {
    const { ops, store, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    const orig = store.writeState.bind(store);
    store.writeState = vi.fn().mockImplementationOnce(() => { throw new Error('disco pieno'); }).mockImplementation(orig);
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toThrow('disco pieno');
    expect(runpod.deletePod).toHaveBeenCalledWith('pod1');
  });
});
