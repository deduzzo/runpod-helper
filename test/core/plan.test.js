import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { makePlan } from '../../src/core/planner/plan.js';
import { loadFlags } from '../../src/core/planner/vllm-args.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const SHA = 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120';
const gpu = (id, memory, price, dc) => ({
  id, name: id, memory, price: { secure: price, community: 0 }, maxCount: { secure: 8, community: 0 },
  dataCenters: [{ id: dc, name: dc, availability: 'HIGH' }],
});

function fakes(catalog) {
  const hf = {
    getModel: vi.fn().mockResolvedValue(fx('model-qwen3-coder-30b.json')),
    resolveSha: vi.fn().mockResolvedValue(SHA),
    listFiles: vi.fn().mockResolvedValue(fx('tree-qwen3-coder-30b.json')),
    getConfig: vi.fn().mockResolvedValue(fx('config-qwen3-coder-30b.json')),
  };
  const runpod = { listGpus: vi.fn(async ({ count }) => catalog[count] ?? []) };
  return { hf, runpod };
}

const base = { modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', dataCenterId: 'EU-A', minCudaVersion: '12.9', vllmImage: 'vllm/vllm-openai:v0.30.0-cu129', flags: loadFlags() };

describe('makePlan', () => {
  it('produce un piano completo per Qwen3-Coder-30B su una GPU da 80 GB', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')], 2: [], 4: [], 8: [] });
    const plan = await makePlan({ hf, runpod, ...base });
    expect(plan.model).toMatchObject({ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: SHA, requestedRevision: 'main', weightsBytes: 61066575656 });
    expect(plan.gpu).toEqual({ id: 'GPU80', count: 1 });
    expect(plan.hourlyUSD).toBe(1.5);
    expect(plan.parsers).toEqual({ tool: 'qwen3_coder', reasoning: null });
    expect(plan.vllm.args).toEqual(expect.arrayContaining(['--tensor-parallel-size', '1', '--tool-call-parser', 'qwen3_coder', '--revision', SHA]));
    expect(plan.estimate.perGpuGiB).toBeCloseTo(70.87, 1);
    expect(runpod.listGpus).toHaveBeenCalledWith({ count: 2, cloud: 'SECURE', minCudaVersion: '12.9' });
  });

  it('ripiega su KV cache FP8 se in BF16 non entra', async () => {
    // 72 GB × 0,9 = 64,8 GiB: BF16 (70,9) non entra, FP8 (56,9 + 6 + 2 = 64,9)… nemmeno; con 74 GB × 0,9 = 66,6 sì.
    const { hf, runpod } = fakes({ 1: [gpu('GPU74', 74, 1, 'EU-A')] });
    const plan = await makePlan({ hf, runpod, ...base });
    expect(plan.kvCacheDtype).toBe('fp8');
    expect(plan.vllm.args).toEqual(expect.arrayContaining(['--kv-cache-dtype', 'fp8']));
    expect(plan.warnings.join(' ')).toMatch(/FP8/);
  });

  it('nessuna GPU nel datacenter → gpu null, avviso e alternative altrove', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'US-B')] });
    const plan = await makePlan({ hf, runpod, ...base });
    expect(plan.gpu).toBeNull();
    expect(plan.elsewhere[0].gpuId).toBe('GPU80');
    expect(plan.warnings.join(' ')).toMatch(/NO_GPU_AVAILABLE/);
  });

  it('gli override vietati bloccano il piano, quelli sconosciuti sono avvisi', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
    await expect(makePlan({ hf, runpod, ...base, extra: ['--api-key', 'x'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const plan = await makePlan({ hf, runpod, ...base, extra: ['--flag-inventato'] });
    expect(plan.warnings.join(' ')).toMatch(/--flag-inventato/);
  });

  it('architettura sconosciuta + --set tool-call-parser=<nome> abilita anche auto-tool-choice', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
    hf.getConfig.mockResolvedValue({ ...fx('config-qwen3-coder-30b.json'), architectures: ['FooForCausalLM'], model_type: 'foo' });
    const plan = await makePlan({ hf, runpod, ...base, set: ['tool-call-parser=hermes'] });
    expect(plan.parsers.tool).toBeNull();
    expect(plan.vllm.args).toEqual(expect.arrayContaining(['--tool-call-parser', 'hermes', '--enable-auto-tool-choice']));
    expect(plan.vllm.args.filter((a) => a === '--enable-auto-tool-choice')).toHaveLength(1);
  });

  it('contesto oltre il massimo del modello viene ridotto con avviso', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
    const plan = await makePlan({ hf, runpod, ...base, context: 10_000_000 });
    expect(plan.context).toBe(262144);
    expect(plan.warnings.join(' ')).toMatch(/262144/);
  });
});
