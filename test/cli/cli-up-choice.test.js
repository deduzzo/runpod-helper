import { describe, it, expect, vi } from 'vitest';
import { sandbox, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-PROFILO-FINTA-ABCDEFG';
const profile = {
  name: 'qwen3-coder', servedName: 'qwen3-coder', cloud: 'SECURE', dataCenterId: 'EU-A', context: 65536, concurrency: 2,
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, gpu: { id: 'GPU80', count: 1 }, alternatives: [{ id: 'GPU96', count: 1, hourly: 2.5 }],
  volume: { id: 'vol1', mountPath: '/workspace' }, allowFallbackWithoutVolume: 'ask', watchdog: { idleMinutes: 30, maxHours: 8 },
};
const gpu = (id, memory, price, availability) => ({ id, price: { secure: price }, maxCount: { secure: 8 }, memory, dataCenters: [{ id: 'EU-A', availability }] });

function setup(opts = {}) {
  const s = sandbox(opts);
  s.store.writeEnv({ ...SECRETS, LLMPOD_KEY_QWEN3_CODER: KEY });
  s.store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-A' } });
  s.store.writeProfile(profile);
  const runpod = {
    listPods: vi.fn(async () => []),
    getPod: vi.fn(async () => null),
    getBalance: vi.fn(async () => ({ balance: 42.5, spendPerHour: 0 })),
    listGpus: vi.fn(async () => [gpu('GPU80', 80, 1.5, 'HIGH'), gpu('GPU96', 96, 2.5, 'LOW')]),
    createPod: vi.fn(async () => ({ status: 402, data: { detail: 'finto' } })),
    deletePod: vi.fn(async () => {}),
  };
  const http = { request: vi.fn(async () => ({ ok: false, status: 404, data: null })) };
  // Rifiutando la conferma del costo, up si ferma prima di creare il Pod: qui conta cosa viene proposto e scelto.
  return { ...s, runpod, go: (argv) => s.run(argv, { runpod, http, isZcodeRunning: async () => false }) };
}

describe('CLI up: scelta della GPU', () => {
  it('interattivo: propone le GPU disponibili ora numerate e la conferma di costo riguarda la scelta', async () => {
    const t = setup({ answers: { interactive: true, text: ['2'], ask: [false] } });
    expect(await t.go(['up', 'qwen3-coder'])).toBe(130); // costo non confermato → annullato
    const err = t.err();
    expect(err).toContain('Quale GPU usare per l\'avvio?');
    expect(err).toContain('1) GPU80 ×1 · 80 GB · 1,50 $/h · EU-A · HIGH  (predefinita)');
    expect(err).toContain('2) GPU96 ×1 · 96 GB · 2,50 $/h · EU-A · LOW');
    expect(t.prompt.ask.mock.calls[0][0]).toMatch(/GPU96 ×1.*2,50 \$\/h/);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('interattivo con invio: vale la GPU del profilo', async () => {
    const t = setup({ answers: { interactive: true, ask: [false] } });
    await t.go(['up', 'qwen3-coder']);
    expect(t.prompt.ask.mock.calls[0][0]).toMatch(/GPU80 ×1.*1,50 \$\/h/);
  });

  it('--yes: nessuna domanda di scelta, si usa la GPU del profilo', async () => {
    const t = setup({ answers: { interactive: true } });
    await t.go(['up', 'qwen3-coder', '--yes']);
    expect(t.prompt.askText).not.toHaveBeenCalled();
    expect(t.err()).not.toContain('Quale GPU');
    expect(t.runpod.createPod.mock.calls[0][0].gpu.id).toBe('GPU80');
  });

  it('non interattivo: nessuna domanda di scelta', async () => {
    const t = setup({ answers: { ask: [false] } });
    await t.go(['up', 'qwen3-coder']);
    expect(t.prompt.askText).not.toHaveBeenCalled();
    expect(t.prompt.ask.mock.calls[0][0]).toMatch(/GPU80 ×1/);
  });
});
