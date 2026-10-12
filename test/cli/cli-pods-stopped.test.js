import { describe, it, expect, vi } from 'vitest';
import { sandbox, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-PROFILO-FINTA-ABCDEFG';
const profile = {
  name: 'qwen3-coder', servedName: 'qwen3-coder', cloud: 'SECURE', dataCenterId: 'EU-A', context: 65536, concurrency: 2,
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, gpu: { id: 'GPU80', count: 1 }, alternatives: [],
  volume: { id: 'vol1', mountPath: '/workspace' }, allowFallbackWithoutVolume: 'ask', watchdog: { idleMinutes: 30, maxHours: 8 },
};

function setup(pods, opts = {}) {
  const s = sandbox(opts);
  s.store.writeEnv({ ...SECRETS, LLMPOD_KEY_QWEN3_CODER: KEY });
  s.store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-A' } });
  s.store.writeProfile(profile);
  const list = [...pods];
  const runpod = {
    listPods: vi.fn(async () => list.filter((p) => p.status !== 'GONE')),
    getPod: vi.fn(async (id) => list.find((p) => p.id === id && p.status !== 'GONE') ?? null),
    getBalance: vi.fn(async () => ({ balance: 42.5, spendPerHour: 0 })),
    listGpus: vi.fn(async () => [{ id: 'GPU80', price: { secure: 1.5 }, maxCount: { secure: 8 }, memory: 80, dataCenters: [{ id: 'EU-A', availability: 'HIGH' }] }]),
    createPod: vi.fn(async () => ({ status: 201, data: { id: 'pod9' } })),
    deletePod: vi.fn(async (id) => { const p = list.find((x) => x.id === id); if (p) p.status = 'GONE'; }),
    deleteVolume: vi.fn(async () => {}),
  };
  const http = { request: vi.fn(async () => ({ ok: false, status: 404, data: null })) };
  return { ...s, runpod, go: (argv) => s.run(argv, { runpod, http, isZcodeRunning: async () => false }) };
}

const RUNNING = { id: 'pod1', name: 'llmpod-qwen3-coder', status: 'RUNNING', cost: 1.49, runtime: { uptime: 7200 } };
const EXITED = { id: 'pod2', name: 'llmpod-altro', status: 'EXITED', cost: 1.5, storageCostPerHr: 0.0123 };

describe('CLI status: Pod avviati e spenti', () => {
  it('mostra "avviato" e "spento" e avvisa che il Pod spento costa ancora e va eliminato', async () => {
    const t = setup([RUNNING, EXITED]);
    expect(await t.go(['status'])).toBe(0);
    const out = t.out();
    expect(out).toMatch(/qwen3-coder \(orfano\)\s+pod1\s+avviato/);
    expect(out).toMatch(/altro \(orfano\)\s+pod2\s+spento/);
    expect(out).toContain('⚠ altro (pod2): Spento ma costa ancora lo spazio su disco: eliminalo con llmpod down altro');
    expect(out).toContain('0,01 $/h di spazio su disco');
    expect(out).not.toContain('RUNNING');
  });

  it('senza costo di storage noto l\'avviso resta, senza cifra', async () => {
    const t = setup([{ ...EXITED, storageCostPerHr: undefined }]);
    await t.go(['status']);
    expect(t.out()).toContain('eliminalo con llmpod down altro');
    expect(t.out()).not.toContain('di spazio su disco');
  });

  it('--json espone state, stateLabel e storageUSD', async () => {
    const t = setup([RUNNING, EXITED]);
    await t.go(['status', '--json']);
    const s = JSON.parse(t.out());
    expect(s.pods.map((p) => [p.podId, p.state, p.stateLabel])).toEqual([['pod1', 'running', 'avviato'], ['pod2', 'stopped', 'spento']]);
    expect(s.pods[1].storageUSD).toBe(0.0123);
    // l'ordine delle chiavi serve agli script Docker (stop.sh): profile, podId, status, state
    expect(Object.keys(s.pods[1]).slice(0, 4)).toEqual(['profile', 'podId', 'status', 'state']);
  });

  it('un Pod in avvio è "in avvio"', async () => {
    const t = setup([{ id: 'pod3', name: 'llmpod-x', status: 'CREATED', cost: 1 }]);
    await t.go(['status']);
    expect(t.out()).toMatch(/x \(orfano\)\s+pod3\s+in avvio/);
  });
});

describe('CLI down e up con Pod spenti', () => {
  it('down elimina un Pod spento e lo dice', async () => {
    const t = setup([{ id: 'pod2', name: 'llmpod-qwen3-coder', status: 'EXITED' }]);
    expect(await t.go(['down', 'qwen3-coder', '--yes'])).toBe(0);
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod2');
    expect(t.out()).toContain('✓ Pod pod2 eliminato (era spento: ora non costa più nulla)');
  });

  it('down --dry-run su un Pod spento non elimina', async () => {
    const t = setup([{ id: 'pod2', name: 'llmpod-qwen3-coder', status: 'EXITED' }]);
    expect(await t.go(['down', 'qwen3-coder', '--dry-run'])).toBe(0);
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
    expect(t.out()).toContain('[dry-run] verrebbe eliminato il Pod pod2');
  });

  it('down senza Pod dice che non ce ne sono', async () => {
    const t = setup([]);
    await t.go(['down', 'qwen3-coder']);
    expect(t.out()).toContain('Nessun Pod per qwen3-coder');
  });

  it('up --yes elimina prima un Pod spento dello stesso profilo', async () => {
    const t = setup([{ id: 'pod2', name: 'llmpod-qwen3-coder', status: 'EXITED' }]);
    await t.go(['up', 'qwen3-coder', '--yes']); // fallisce più avanti (nessun supervisore finto): conta l'ordine delle chiamate
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod2');
    expect(t.runpod.deletePod.mock.invocationCallOrder[0]).toBeLessThan(t.runpod.createPod.mock.invocationCallOrder[0]);
  });

  it('destroy-volume non procede se ci sono Pod llmpod, anche spenti', async () => {
    const t = setup([{ id: 'pod2', name: 'llmpod-qwen3-coder', status: 'EXITED' }]);
    expect(await t.go(['destroy-volume', '--yes'])).toBe(1);
    expect(t.runpod.deleteVolume).not.toHaveBeenCalled();
    expect(t.err()).toContain('pod2');
  });
});
