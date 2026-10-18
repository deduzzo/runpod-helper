import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { makePlan } from '../../src/core/planner/plan.js';
import { loadFlags } from '../../src/core/planner/vllm-args.js';
import { kvBytesPerToken, kvShardsFor, mtpHeadLoadable, linearHeads } from '../../src/core/planner/vram.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const flash = fx('config-glm53-flash-nvfp4.json');
const full = fx('config-glm53-nvfp4.json');
const flashIndex = fx('index-glm53-flash-nvfp4.json').weight_map;
const fullIndex = fx('index-glm53-nvfp4.json').weight_map;
const SHA = '745aac2ff0f10acf961f396df3f9418598aa7327';
const gpu = (id, memory, price, dc) => ({
  id, name: id, memory, price: { secure: price, community: 0 }, maxCount: { secure: 8, community: 0 },
  dataCenters: [{ id: dc, name: dc, availability: 'HIGH' }],
});
const base = { dataCenterId: 'EU-A', minCudaVersion: '12.9', vllmImage: 'vllm/vllm-openai:v0.30.0', flags: loadFlags() };

function fakes(config, index, sizeGiB) {
  const shards = [...new Set(Object.values(index))];
  const hf = {
    getModel: vi.fn().mockResolvedValue({ id: 'x', sha: SHA, cardData: {}, tags: [], config: { tokenizer_config: { chat_template: 'x' } } }),
    resolveSha: vi.fn().mockResolvedValue(SHA),
    listFiles: vi.fn().mockResolvedValue(shards.map((path) => ({ type: 'file', path, size: Math.round(sizeGiB * 1024 ** 3 / shards.length) }))),
    getConfig: vi.fn().mockResolvedValue(config),
    getWeightIndex: vi.fn().mockResolvedValue(index),
  };
  const runpod = { listGpus: vi.fn(async ({ count }) => (count === 1 ? [gpu('B300', 288, 8.99, 'EU-A')] : [gpu('B300', 288, 8.99 * count, 'EU-A')])) };
  return { hf, runpod };
}

describe('GLM-5.3-Flash (glm5_next: MLA senza RoPE + attenzione lineare KDA)', () => {
  it('KV cache MLA anche con qk_rope_head_dim 0: solo gli 11 strati DSA su 45, non zero', () => {
    const kv = kvBytesPerToken(flash);
    expect(kv.kind).toBe('mla');
    expect(kv.bytes).toBe(512 * 11 * 2);
    // stato KDA per sequenza: 34 strati × 64 teste × 128 × 128 × 4 byte
    expect(kv.stateBytes).toBe(34 * 64 * 128 * 128 * 4);
    expect(kvShardsFor(flash, 4)).toBe(1);
  });

  it('teste dell\'attenzione lineare lette da linear_attn_config', () => {
    expect(linearHeads(flash)).toBe(64);
    expect(linearHeads(full)).toBeNull();
  });

  it('la testa MTP del checkpoint NVFP4 non è esclusa dalla quantizzazione: MTP disattivato con avviso', async () => {
    expect(mtpHeadLoadable(flash, flashIndex)).toBe(false);
    const { hf, runpod } = fakes(flash, flashIndex, 181.3);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: `dealignai/GLM-5.3-Flash-UNCENSORED-NVFP4@${SHA}`, context: 131072 });
    expect(plan.mtp).toMatchObject({ present: true, enabled: false });
    expect(plan.vllm.args).not.toContain('--speculative-config');
    expect(plan.warnings.join(' ')).toMatch(/MTP_DISABLED/);
  });

  it('64 teste KDA: --max-num-seqs e --max-cudagraph-capture-size a 512 (griglia CUDA ≤ 65535)', async () => {
    const { hf, runpod } = fakes(flash, flashIndex, 181.3);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: `dealignai/GLM-5.3-Flash-UNCENSORED-NVFP4@${SHA}`, context: 131072 });
    const at = (f) => plan.vllm.args[plan.vllm.args.indexOf(f) + 1];
    expect(at('--max-num-seqs')).toBe('512');
    expect(at('--max-cudagraph-capture-size')).toBe('512');
    expect(plan.estimate.kvGiB).toBeGreaterThan(0);
  });

  it('un --max-num-seqs scelto dall\'utente non viene sovrascritto', async () => {
    const { hf, runpod } = fakes(flash, flashIndex, 181.3);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: `dealignai/GLM-5.3-Flash-UNCENSORED-NVFP4@${SHA}`, set: ['max-num-seqs=64'] });
    expect(plan.vllm.args.filter((a) => a === '--max-num-seqs')).toHaveLength(1);
    expect(plan.vllm.args[plan.vllm.args.indexOf('--max-num-seqs') + 1]).toBe('64');
  });
});

describe('GLM-5.3 (glm_moe_dsa NVFP4)', () => {
  it('lo strato MTP 78 è escluso dalla quantizzazione (model.layers.78*): MTP resta attivo', async () => {
    expect(mtpHeadLoadable(full, fullIndex)).toBe(true);
    const { hf, runpod } = fakes(full, fullIndex, 432.9);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: `dealignai/GLM-5.3-UNCENSORED-NVFP4@${SHA}` });
    expect(plan.mtp).toMatchObject({ present: true, enabled: true });
    expect(plan.vllm.args).toContain('--speculative-config');
    expect(plan.vllm.args).not.toContain('--max-num-seqs');
  });

  it('KV MLA invariata: (512 + 64) × 78 strati × 2 byte', () => {
    expect(kvBytesPerToken(full)).toEqual({ bytes: 576 * 78 * 2, kind: 'mla' });
  });
});
