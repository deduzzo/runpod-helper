import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { makePlan, syncDerivedFields } from '../../src/core/planner/plan.js';
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

  it('options: tutte le configurazioni che entrano, per costo, con disponibilità qui e altrove; gpu predefinita = la più economica disponibile', async () => {
    const withDcs = (id, memory, price, dcs) => ({ ...gpu(id, memory, price, 'EU-A'), dataCenters: dcs.map(([d, availability]) => ({ id: d, name: d, availability })) });
    const { hf, runpod } = fakes({
      1: [withDcs('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), withDcs('GPU96', 96, 1.2, [['EU-A', 'NONE'], ['US-B', 'LOW']]), withDcs('GPUNO', 80, 1.1, [['EU-A', 'NONE']])],
    });
    const plan = await makePlan({ hf, runpod, ...base });
    expect(plan.options.map((o) => `${o.id}x${o.count}`)).toEqual(['GPUNOx1', 'GPU96x1', 'GPU80x1']);
    expect(plan.options[0]).toMatchObject({ id: 'GPUNO', name: 'GPUNO', count: 1, memoryGiB: 80, hourly: 1.1, availabilityHere: 'NONE', availableHere: false, available: false, elsewhere: [] });
    expect(plan.options[1]).toMatchObject({ availableHere: false, available: true, elsewhere: [{ id: 'US-B', availability: 'LOW' }] });
    expect(plan.options[2]).toMatchObject({ availableHere: true, available: true, headroomGiB: expect.any(Number), perGpuGiB: expect.any(Number) });
    expect(plan.gpu).toEqual({ id: 'GPU80', count: 1 });
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
    expect(plan.parsers.tool).toBe('hermes');
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

describe('makePlan: MLX e pesi (R3, R4b)', () => {
  it('R3: un modello MLX è rifiutato con INVALID_INPUT prima di qualunque chiamata a Runpod', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
    hf.getModel.mockResolvedValue(fx('model-mlx-qwen3-coder-30b-4bit.json'));
    const err = await makePlan({ hf, runpod, ...base, modelRef: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Formato MLX non supportato da vLLM') });
    expect(err.hint).toMatch(/safetensors|AWQ/);
    expect(runpod.listGpus).not.toHaveBeenCalled();
  });

  it('pesi solo in sottocartelle: errore esplicito, non "nessun .safetensors"', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
    hf.listFiles.mockResolvedValue([{ type: 'file', path: 'original/model-00001.safetensors', size: 1000 }, { type: 'file', path: 'config.json', size: 5 }]);
    const err = await makePlan({ hf, runpod, ...base }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('i pesi sono solo in sottocartelle: non supportato') });
    hf.listFiles.mockResolvedValue([{ type: 'file', path: 'pytorch_model.bin', size: 1000 }]);
    await expect(makePlan({ hf, runpod, ...base })).rejects.toMatchObject({ message: expect.stringContaining('non contiene file .safetensors') });
    hf.listFiles.mockResolvedValue([{ type: 'file', path: 'model.gguf', size: 1000 }]);
    await expect(makePlan({ hf, runpod, ...base })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('repository GGUF') });
  });

  it('R4b: Devstral-Small-2507 pesa 43,9 GiB (non il doppio) con e senza indice dei pesi', async () => {
    const devstral = { ...fx('model-qwen3-coder-30b.json'), id: 'mistralai/Devstral-Small-2507' };
    const run = async (index) => {
      const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
      hf.getModel.mockResolvedValue(devstral);
      hf.listFiles.mockResolvedValue(fx('tree-devstral-small-2507.json'));
      if (index !== undefined) hf.getWeightIndex = vi.fn().mockResolvedValue(index);
      return makePlan({ hf, runpod, ...base, modelRef: 'mistralai/Devstral-Small-2507' });
    };
    for (const index of [undefined, null, fx('index-devstral-small-2507.json').weight_map]) {
      const plan = await run(index);
      expect(plan.model.weightsBytes / 1024 ** 3).toBeCloseTo(43.9, 1);
      expect(plan.estimate.weightsGiB).toBeCloseTo(43.9, 1);
      // disco e timeout si calcolano sul totale da scaricare (shard + consolidated)
      expect(plan.estimate.downloadBytes / 1024 ** 3).toBeCloseTo(87.8, 1);
    }
  });
});

describe('syncDerivedFields', () => {
  it('aggiorna parsers dal --reasoning-parser aggiunto', () => {
    const t = syncDerivedFields({ vllm: { args: ['--reasoning-parser', 'qwen3'] }, parsers: { tool: null, reasoning: null }, warnings: [] });
    expect(t.parsers).toEqual({ tool: null, reasoning: 'qwen3' });
  });
  it('--tool-call-parser senza auto-tool-choice: aggiunge il flag', () => {
    const t = syncDerivedFields({ vllm: { args: ['--tool-call-parser=hermes'] } });
    expect(t.vllm.args).toContain('--enable-auto-tool-choice');
    expect(t.parsers.tool).toBe('hermes');
  });
  it('--kv-cache-dtype auto su un target fp8: kvCacheDtype null e avviso rimosso', () => {
    const t = syncDerivedFields({ vllm: { args: ['--kv-cache-dtype', 'auto'] }, kvCacheDtype: 'fp8', warnings: ['KV cache in FP8 (--kv-cache-dtype fp8): in BF16 non entra', 'altro'] });
    expect(t.kvCacheDtype).toBeNull();
    expect(t.warnings).toEqual(['altro']);
  });

  it("l'ultima occorrenza di un flag vince", () => {
    const t = syncDerivedFields({ vllm: { args: ['--reasoning-parser', 'a', '--reasoning-parser=b', '--kv-cache-dtype', 'fp8', '--kv-cache-dtype', 'auto'] } });
    expect(t.parsers.reasoning).toBe('b');
    expect(t.kvCacheDtype).toBeNull();
  });
  it('senza --tool-call-parser toglie --enable-auto-tool-choice', () => {
    const t = syncDerivedFields({ vllm: { args: ['--enable-auto-tool-choice', '--reasoning-parser', 'qwen3'] } });
    expect(t.vllm.args).toEqual(['--reasoning-parser', 'qwen3']);
    expect(t.parsers.tool).toBeNull();
  });
});

describe('makePlan estimate.kvDtype', () => {
  it('BF16 → auto; resta invariato con --set kv-cache-dtype=fp8', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
    expect((await makePlan({ hf, runpod, ...base })).estimate.kvDtype).toBe('auto');
    const p = await makePlan({ hf, runpod, ...base, set: ['kv-cache-dtype=fp8'] });
    expect(p.estimate.kvDtype).toBe('auto');
    expect(p.kvCacheDtype).toBe('fp8');
  });
});
