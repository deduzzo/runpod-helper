import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOps } from '../../src/core/ops.js';
import { createStore } from '../../src/core/config.js';
import { createEvents } from '../../src/core/events.js';
import { clearSecrets } from '../../src/core/secrets.js';
import { optionOf } from '../../src/core/planner/gpu-choice.js';
import { podState } from '../../src/core/pod-state.js';

const gpu = (id, memory, price, dcs) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: dcs.map(([d, a]) => ({ id: d, availability: a })) });
const opt = (id, count, hourly, availabilityHere) => optionOf({ gpuId: id, name: id, count, memoryGiB: 80, hourly, perGpuGiB: 70.9, headroomGiB: 1, availabilityHere, elsewhere: [] });
const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  context: 65536, concurrency: 2, vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 },
  gpu: { id: 'GPU80', count: 1 }, hourlyUSD: 1.5, alternatives: [{ id: 'GPU96', count: 1, hourly: 2.5 }, { id: 'GPUX', count: 1, hourly: 2 }], elsewhere: [],
  options: [opt('GPU80', 1, 1.5, 'HIGH'), opt('GPUX', 1, 2, 'LOW'), opt('GPU96', 1, 2.5, 'LOW')], candidates: [],
  dataCenterId: 'EU-A', cloud: 'SECURE', kvCacheDtype: null, warnings: [],
};
const CATALOG = { 1: [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU96', 96, 2.5, [['EU-A', 'LOW']]), gpu('GPUX', 80, 2, [['EU-A', 'MEDIUM']])] };

function setup({ catalog = CATALOG, pods = [], askAnswers = [], askChoice = null } = {}) {
  clearSecrets();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-opspods-')), 'cfg');
  const store = createStore({ dir, platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-A' } });
  store.writeJson('last-plan.json', plan);
  const list = [...pods];
  let created = false;
  const runpod = {
    listPods: vi.fn(async () => list.filter((p) => p.status !== 'GONE')),
    getBalance: vi.fn(async () => ({ balance: 50, spendPerHour: 0 })),
    listGpus: vi.fn(async ({ count }) => catalog[count] ?? []),
    createPod: vi.fn(async () => { created = true; return { status: 201, data: { id: 'pod1' } }; }),
    getPod: vi.fn(async (id) => (id === 'pod1' ? (created ? { id: 'pod1', status: 'RUNNING', cost: 1.49 } : null) : list.find((p) => p.id === id && p.status !== 'GONE') ?? null)),
    deletePod: vi.fn(async (id) => { const p = list.find((x) => x.id === id); if (p) p.status = 'GONE'; }),
  };
  const routes = {
    'GET https://pod1-8001.proxy.runpod.net/logs?since=0': { ok: true, status: 200, data: { lines: [] } },
    'GET https://pod1-8001.proxy.runpod.net/status': { ok: true, status: 200, data: { phase: 'ready', kvCacheTokens: 400000 } },
    'GET https://pod1-8000.proxy.runpod.net/v1/models': { ok: true, status: 200, data: { data: [{ id: 'p' }] } },
    'POST https://pod1-8000.proxy.runpod.net/v1/messages': { ok: true, status: 200, data: { content: [{ type: 'tool_use', name: 'get_weather' }] } },
    'POST https://pod1-8000.proxy.runpod.net/v1/chat/completions': { ok: true, status: 200, data: { choices: [{ message: { tool_calls: [{ function: { name: 'get_weather' } }] } }] } },
  };
  const http = { request: vi.fn(async (m, url) => routes[`${m} ${url}`] ?? { ok: false, status: 404, data: null }) };
  const hf = { checkAccess: vi.fn(async () => ({ ok: true, status: 200 })) };
  const ask = vi.fn(async () => (askAnswers.length ? askAnswers.shift() : true));
  const choose = askChoice ? vi.fn(askChoice) : null;
  const events = createEvents();
  const seen = [];
  events.on((e) => seen.push(e));
  let t = 0;
  const ops = createOps({ store, runpod, hf, http, events, ask, askChoice: choose, now: () => (t += 1000), sleep: async () => {}, zcode: { dir: path.join(dir, 'zcode'), isRunning: async () => false } });
  ops.saveProfile('p');
  return { ops, store, runpod, ask, choose, seen };
}

describe('podState', () => {
  it('avviato / in avvio / spento', () => {
    expect(podState('RUNNING')).toEqual({ state: 'running', label: 'avviato' });
    expect(podState('CREATED')).toMatchObject({ state: 'starting', label: 'in avvio' });
    expect(podState('EXITED')).toEqual({ state: 'stopped', label: 'spento' });
    expect(podState('STRANGE')).toMatchObject({ state: 'unknown', label: 'strange' });
  });
});

describe('up: scelta della GPU', () => {
  beforeEach(() => clearSecrets());

  it('propone le configurazioni disponibili ora (prezzo, VRAM, numero, datacenter), predefinita quella del profilo, e usa la scelta', async () => {
    const t = setup({ askChoice: async () => 'GPU96|1|EU-A' });
    await t.ops.up('p');
    expect(t.choose).toHaveBeenCalledTimes(1);
    const [text, options, def] = t.choose.mock.calls[0];
    expect(text).toMatch(/Quale GPU/);
    expect(options.map((o) => o.id)).toEqual(['GPU80|1|EU-A', 'GPUX|1|EU-A', 'GPU96|1|EU-A']);
    expect(options[0].label).toBe('GPU80 ×1 · 80 GB · 1,50 $/h · EU-A · HIGH');
    expect(options[2].label).toBe('GPU96 ×1 · 96 GB · 2,50 $/h · EU-A · LOW');
    expect(def).toBe('GPU80|1|EU-A');
    // la conferma del costo resta, e riguarda la GPU scelta; si crea il Pod solo con quella
    expect(t.ask.mock.calls[0][0]).toMatch(/GPU96 ×1.*2,50 \$\/h.*Confermi\?/);
    expect(t.runpod.createPod).toHaveBeenCalledTimes(1);
    expect(t.runpod.createPod.mock.calls[0][0].gpu).toMatchObject({ id: 'GPU96', count: 1 });
  });

  it('se la GPU del profilo non è disponibile la predefinita è la più economica disponibile (le non disponibili non sono proposte)', async () => {
    const catalog = { 1: [gpu('GPU80', 80, 1.5, [['EU-A', 'NONE']]), gpu('GPU96', 96, 2.5, [['EU-A', 'LOW']]), gpu('GPUX', 80, 2, [['EU-A', 'MEDIUM']])] };
    const t = setup({ catalog, askChoice: async (_t, _o, def) => def });
    await t.ops.up('p');
    const [, options, def] = t.choose.mock.calls[0];
    expect(options.map((o) => o.id)).toEqual(['GPUX|1|EU-A', 'GPU96|1|EU-A']);
    expect(def).toBe('GPUX|1|EU-A');
    expect(t.runpod.createPod.mock.calls[0][0].gpu.id).toBe('GPUX');
  });

  it('con una sola configurazione disponibile non chiede nulla', async () => {
    const catalog = { 1: [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU96', 96, 2.5, [['EU-A', 'NONE']]), gpu('GPUX', 80, 2, [['EU-A', 'NONE']])] };
    const t = setup({ catalog, askChoice: async () => 'x' });
    await t.ops.up('p');
    expect(t.choose).not.toHaveBeenCalled();
    expect(t.runpod.createPod.mock.calls[0][0].gpu.id).toBe('GPU80');
  });

  it('con yes o dryRun non chiede nulla (comportamento di prima)', async () => {
    const t = setup({ askChoice: async () => 'GPU96|1|EU-A' });
    await t.ops.up('p', { yes: true });
    expect(t.choose).not.toHaveBeenCalled();
    expect(t.runpod.createPod.mock.calls[0][0].gpu.id).toBe('GPU80');
    const d = setup({ askChoice: async () => 'GPU96|1|EU-A' });
    const r = await d.ops.up('p', { dryRun: true });
    expect(d.choose).not.toHaveBeenCalled();
    expect(r.dryRun).toBe(true);
  });

  it('senza askChoice (terminale non interattivo) non chiede nulla', async () => {
    const t = setup();
    await t.ops.up('p');
    expect(t.runpod.createPod.mock.calls[0][0].gpu.id).toBe('GPU80');
  });

  it('nessuna scelta (null: annullata o scaduta) → CANCELLED, nessun Pod e nessuna spesa', async () => {
    const t = setup({ askChoice: async () => null });
    await expect(t.ops.up('p')).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(t.runpod.createPod).not.toHaveBeenCalled();
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('un id che non è tra le opzioni proposte è trattato come nessuna scelta', async () => {
    const t = setup({ askChoice: async () => 'GPU-INVENTATA|1|EU-A' });
    await expect(t.ops.up('p')).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });
});

describe('saveProfile con la GPU scelta', () => {
  it('applica la scelta alla copia del piano: profilo con la GPU scelta, last-plan.json invariato', () => {
    const t = setup();
    const profile = t.ops.saveProfile('scelto', { gpu: { id: 'GPU96', count: 1 } });
    expect(profile.gpu).toEqual({ id: 'GPU96', count: 1 });
    expect(profile.alternatives.map((a) => a.id)).toEqual(['GPU80', 'GPUX']);
    expect(t.store.readJson('last-plan.json').gpu).toEqual({ id: 'GPU80', count: 1 });
  });

  it('GPU non tra le opzioni → errore e nessun profilo scritto', () => {
    const t = setup();
    expect(() => t.ops.saveProfile('x', { gpu: { id: 'NOPE', count: 1 } })).toThrow(/non è tra le opzioni/);
    expect(() => t.store.readProfile('x')).toThrow();
  });
});

describe('Pod spenti: status, down, up', () => {
  const running = { id: 'r1', name: 'llmpod-p', status: 'RUNNING', cost: 1.5, runtime: { uptime: 3600 } };
  const starting = { id: 's1', name: 'llmpod-q', status: 'CREATED', cost: 1.5 };
  const stopped = { id: 'e1', name: 'llmpod-z', status: 'EXITED', cost: 1.5, storageCostPerHr: 0.014 };
  const dead = { id: 't1', name: 'llmpod-old', status: 'TERMINATED' };

  it('status elenca avviati, in avvio e spenti con uno stato chiaro; i terminati no', async () => {
    const t = setup({ pods: [running, starting, stopped, dead, { id: 'x', name: 'altro-pod', status: 'EXITED' }] });
    const s = await t.ops.status();
    expect(s.pods.map((p) => [p.profile, p.state, p.stateLabel])).toEqual([['p', 'running', 'avviato'], ['q', 'starting', 'in avvio'], ['z', 'stopped', 'spento']]);
    expect(s.pods[2]).toMatchObject({ podId: 'e1', status: 'EXITED', hourlyUSD: 0, sessionUSD: 0, uptimeSeconds: 0, storageUSD: 0.014 });
    expect(s.pods[0]).toMatchObject({ hourlyUSD: 1.5, storageUSD: null });
  });

  it('un Pod spento senza costo di storage noto ha storageUSD null', async () => {
    const t = setup({ pods: [{ ...stopped, storageCostPerHr: undefined }] });
    expect((await t.ops.status()).pods[0]).toMatchObject({ state: 'stopped', storageUSD: null });
  });

  it('down elimina (DELETE) anche un Pod spento', async () => {
    const t = setup({ pods: [{ id: 'e1', name: 'llmpod-p', status: 'EXITED', cost: 1.5 }] });
    const r = await t.ops.down('p');
    expect(t.runpod.deletePod).toHaveBeenCalledWith('e1');
    expect(r).toMatchObject({ podId: 'e1', stopped: true });
    expect(t.ask.mock.calls[0][0]).toMatch(/Eliminare il Pod spento e1.*spazio su disco/);
  });

  it('down con un Pod acceso e uno spento elimina entrambi', async () => {
    const t = setup({ pods: [{ id: 'e1', name: 'llmpod-p', status: 'EXITED' }, { id: 'r1', name: 'llmpod-p', status: 'RUNNING', cost: 1, runtime: { uptime: 7200 } }] });
    const r = await t.ops.down('p', { yes: true });
    expect(t.runpod.deletePod.mock.calls.map((c) => c[0])).toEqual(['r1', 'e1']);
    expect(r.podIds).toEqual(['r1', 'e1']);
    expect(r.sessionUSD).toBe(2);
  });

  it('down --dry-run non elimina nulla', async () => {
    const t = setup({ pods: [{ id: 'e1', name: 'llmpod-p', status: 'EXITED' }] });
    expect(await t.ops.down('p', { dryRun: true })).toMatchObject({ dryRun: true, podId: 'e1' });
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
  });

  it('endpoint non considera attivo un Pod spento', async () => {
    const t = setup({ pods: [{ id: 'e1', name: 'llmpod-p', status: 'EXITED' }] });
    t.store.writeEnv({ LLMPOD_KEY_P: 'CHIAVE-FINTA-1234567' });
    await expect(t.ops.endpoint('p')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('up con un Pod spento del profilo: si propone di eliminarlo, e se accettato è eliminato PRIMA di creare il nuovo', async () => {
    const t = setup({ pods: [{ id: 'e1', name: 'llmpod-p', status: 'EXITED' }] });
    await t.ops.up('p');
    expect(t.ask.mock.calls[0][0]).toMatch(/Pod spento \(e1\).*Eliminarlo prima di crearne uno nuovo\?/);
    expect(t.runpod.deletePod).toHaveBeenCalledWith('e1');
    expect(t.runpod.deletePod.mock.invocationCallOrder[0]).toBeLessThan(t.runpod.createPod.mock.invocationCallOrder[0]);
  });

  it('up --yes elimina il Pod spento senza chiedere', async () => {
    const t = setup({ pods: [{ id: 'e1', name: 'llmpod-p', status: 'EXITED' }] });
    await t.ops.up('p', { yes: true });
    expect(t.runpod.deletePod).toHaveBeenCalledWith('e1');
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('up: se l\'utente rifiuta, il Pod spento resta con un avviso e il nuovo Pod viene creato', async () => {
    const t = setup({ pods: [{ id: 'e1', name: 'llmpod-p', status: 'EXITED' }], askAnswers: [false] });
    await t.ops.up('p');
    expect(t.runpod.deletePod).not.toHaveBeenCalledWith('e1');
    expect(t.runpod.createPod).toHaveBeenCalled();
    expect(t.seen.find((e) => e.type === 'warning' && /e1.*costare lo spazio su disco.*llmpod down p/.test(e.message))).toBeTruthy();
  });

  it('up --dry-run non elimina il Pod spento ma lo segnala', async () => {
    const t = setup({ pods: [{ id: 'e1', name: 'llmpod-p', status: 'EXITED' }] });
    await t.ops.up('p', { dryRun: true });
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
    expect(t.seen.find((e) => e.type === 'warning' && /e1/.test(e.message))).toBeTruthy();
  });

  it('up con un Pod acceso dello stesso profilo resta un errore', async () => {
    const t = setup({ pods: [{ id: 'r1', name: 'llmpod-p', status: 'RUNNING' }] });
    await expect(t.ops.up('p')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
