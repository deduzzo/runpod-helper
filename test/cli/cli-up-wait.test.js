import { describe, it, expect, vi } from 'vitest';
import { sandbox, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-PROFILO-FINTA-ABCDEFG';
const profile = {
  name: 'qwen3-coder', servedName: 'qwen3-coder', cloud: 'SECURE', dataCenterId: 'EU-A', context: 65536, concurrency: 2,
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, gpu: { id: 'GPU80', count: 1 }, alternatives: [{ id: 'GPU96', count: 1, hourly: 2.5 }],
  volume: null, allowFallbackWithoutVolume: 'ask', watchdog: { idleMinutes: 30, maxHours: 8 },
};
const gpu = (id, memory, price, availability) => ({ id, price: { secure: price }, maxCount: { secure: 8 }, memory, dataCenters: [{ id: 'EU-A', availability }] });

// GPU96 diventa disponibile dopo `after` letture del catalogo.
function setup({ after = 2, answers = {} } = {}) {
  const s = sandbox({ answers });
  s.store.writeEnv({ ...SECRETS, LLMPOD_KEY_QWEN3_CODER: KEY });
  s.store.writeConfig({ dataCenterId: 'EU-A' });
  s.store.writeProfile(profile);
  let reads = 0;
  const runpod = {
    listPods: vi.fn(async () => []),
    getPod: vi.fn(async () => null),
    getBalance: vi.fn(async () => ({ balance: 42.5, spendPerHour: 0 })),
    listGpus: vi.fn(async () => { reads++; return [gpu('GPU80', 80, 1.5, 'HIGH'), gpu('GPU96', 96, 2.5, reads > after ? 'LOW' : 'NONE')]; }),
    createPod: vi.fn(async () => ({ status: 402, data: { detail: 'finto' } })),
    deletePod: vi.fn(async () => {}),
  };
  const http = { request: vi.fn(async () => ({ ok: false, status: 404, data: null })) };
  const sleep = vi.fn(async () => {});
  return { ...s, runpod, sleep, go: (argv) => s.run(argv, { runpod, http, sleep, isZcodeRunning: async () => false }) };
}

describe('CLI up --gpu --wait', () => {
  it('conferma il costo PRIMA dell\'attesa, poi verifica ogni 10 s e crea il Pod sulla GPU scelta appena è disponibile', async () => {
    const t = setup({ after: 3 });
    await t.go(['up', 'qwen3-coder', '--gpu', 'GPU96', '--wait']);
    expect(t.prompt.ask).toHaveBeenCalledTimes(1);
    expect(t.prompt.ask.mock.calls[0][0]).toMatch(/GPU96 ×1.*2,50 \$\/h.*massimo 20,00 \$.*appena disponibile/s);
    expect(t.sleep.mock.calls.filter(([ms]) => ms === 10000).length).toBeGreaterThanOrEqual(2);
    expect(t.err()).toContain('In attesa di GPU96 ×1');
    expect(t.runpod.createPod).toHaveBeenCalledTimes(1);
    expect(t.runpod.createPod.mock.calls[0][0].gpu).toMatchObject({ id: 'GPU96', count: 1 });
  });

  it('costo non confermato: nessuna attesa e nessun Pod', async () => {
    const t = setup({ answers: { ask: [false] } });
    expect(await t.go(['up', 'qwen3-coder', '--gpu', 'GPU96', '--wait'])).toBe(130);
    expect(t.sleep).not.toHaveBeenCalledWith(10000);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('--wait senza --gpu → errore, nessuna attesa', async () => {
    const t = setup();
    expect(await t.go(['up', 'qwen3-coder', '--wait'])).not.toBe(0);
    expect(t.err()).toMatch(/--gpu/);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });
});
