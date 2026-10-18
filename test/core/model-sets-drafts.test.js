import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { makePlan } from '../../src/core/planner/plan.js';
import { loadFlags } from '../../src/core/planner/vllm-args.js';
import { hasMtp, draftKind } from '../../src/core/planner/vram.js';
import { applyGpuChoice } from '../../src/core/planner/gpu-choice.js';
import { mtpLabel } from '../../src/core/planner/mtp-label.js';
import { getSet } from '../../src/core/model-sets.js';

// Fixture reali dall'API pubblica di Hugging Face (config.json completo, estratto del weight_map) per ogni modello del set.
const fixture = (id) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/model-sets/${id.replace('/', '__')}.json`, import.meta.url), 'utf8'));
const V4_0731 = 'apetersson/DeepSeek-V4-Flash-0731-Abliterated-FP8';
const V41 = 'dealignai/DeepSeek-V4.1-Flash-UNCENSORED-FP8';
const GLM_FLASH = 'dealignai/GLM-5.3-Flash-UNCENSORED-FP8';
const GLM_FLASH_NVFP4 = 'dealignai/GLM-5.3-Flash-UNCENSORED-NVFP4';

const gpu = (id, memory, price) => ({ id, name: id, memory, price: { secure: price, community: 0 }, maxCount: { secure: 8, community: 0 }, dataCenters: [{ id: 'EU-A', name: 'EU-A', availability: 'HIGH' }] });
const GiB = 1024 ** 3;
function fakes(id, catalog = [gpu('NVIDIA H100 80GB HBM3', 80, 2.5)]) {
  const fx = fixture(id);
  const shards = [...new Set(Object.values(fx.weightMap))];
  const hf = {
    getModel: vi.fn().mockResolvedValue({ id, sha: fx.revision, config: { architectures: fx.config.architectures, model_type: fx.config.model_type, tokenizer_config: { chat_template: '{{ x }}' } }, cardData: { license: 'mit' }, tags: [] }),
    resolveSha: vi.fn(),
    listFiles: vi.fn().mockResolvedValue(shards.map((p) => ({ type: 'file', path: p, size: GiB, lfs: { size: GiB } }))),
    getConfig: vi.fn().mockResolvedValue(fx.config),
    getWeightIndex: vi.fn().mockResolvedValue(fx.weightMap),
  };
  const runpod = { listGpus: vi.fn(async ({ count }) => catalog.map((g) => ({ ...g })).filter(() => count >= 1)) };
  return { hf, runpod, ref: `${id}@${fx.revision}` };
}
const base = { dataCenterId: 'EU-A', minCudaVersion: '12.9', vllmImage: 'vllm/vllm-openai:v0.30.0', flags: loadFlags(), context: 65536 };
const specOf = (plan) => JSON.parse(plan.vllm.args[plan.vllm.args.indexOf('--speculative-config') + 1]);

describe('draft head: MTP o DSpark (fixture reali)', () => {
  it('coerenza: per ogni modello del set, mtp e draft del set == rilevamento del planner sulle fixture', () => {
    for (const m of getSet('abliterated').models) {
      const fx = fixture(m.id);
      expect(fx.revision, m.id).toBe(m.revision);
      expect(hasMtp(fx.config, fx.weightMap), m.id).toBe(m.mtp);
      expect(draftKind(fx.config, fx.weightMap), m.id).toBe(m.draft);
    }
  });

  it('DeepSeek-V4-Flash-0731: i tensori mtp.* sono stadi DSpark (config dspark_*) → draft dspark', () => {
    const fx = fixture(V4_0731);
    expect(Object.keys(fx.config).some((k) => k.startsWith('dspark_'))).toBe(true);
    expect(draftKind(fx.config, fx.weightMap)).toBe('dspark');
  });

  it('GLM-5.3-Flash: lo strato MTP è model.language_model.layers.<num_hidden_layers>.* → MTP presente', () => {
    const fx = fixture(GLM_FLASH);
    expect(Object.keys(fx.weightMap).some((k) => k.startsWith('model.language_model.layers.45.'))).toBe(true);
    expect(hasMtp(fx.config, fx.weightMap)).toBe(true);
    expect(draftKind(fx.config, fx.weightMap)).toBe('mtp');
  });

  it('senza draft head → null', () => {
    const fx = fixture('kldzj/gpt-oss-120b-heretic-v2');
    expect(draftKind(fx.config, fx.weightMap)).toBeNull();
  });
});

describe('piano con draft DSpark/MTP (recipe vLLM ufficiali)', () => {
  it('DeepSeek-V4-Flash-0731: --speculative-config DSpark della recipe V4-Flash (0731), mtp.draft dspark e avvisi della recipe', async () => {
    const { hf, runpod, ref } = fakes(V4_0731);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(specOf(plan)).toEqual({ method: 'dspark', num_speculative_tokens: 7, draft_sample_method: 'probabilistic' });
    expect(plan.mtp).toMatchObject({ present: true, enabled: true, tokens: 7, draft: 'dspark' });
    expect(mtpLabel(plan.mtp)).toBe('DSpark attivo (decodifica speculativa, 7 token per passo)');
    const w = plan.warnings.join('\n');
    expect(w).toMatch(/--kv-cache-dtype fp8/);
    expect(w).toMatch(/--block-size 256/);
    expect(plan.vllm.args).not.toContain('--block-size');
  });

  it('DeepSeek-V4.1-Flash: --speculative-config DSpark della recipe V4.1 e avviso su engram-config e max-num-batched-tokens', async () => {
    const { hf, runpod, ref } = fakes(V41);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(specOf(plan)).toEqual({ method: 'dspark', num_speculative_tokens: 5, draft_sample_method: 'probabilistic', rejection_sample_method: 'block', enable_adaptive_verification: true });
    expect(plan.mtp.draft).toBe('dspark');
    const w = plan.warnings.join('\n');
    expect(w).toMatch(/--engram-config '\{"cpu_offload":true\}'/);
    expect(w).toMatch(/--max-num-batched-tokens 4096/);
    expect(plan.vllm.args).not.toContain('--engram-config');
  });

  it('DeepSeek-V4.1-Flash-1017: stessa config della V4.1 di lancio → stessa speculative-config DSpark della recipe', async () => {
    const a = fakes(V41);
    const b = fakes('dealignai/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8');
    const [pa, pb] = await Promise.all([makePlan({ ...a, ...base, modelRef: a.ref }), makePlan({ ...b, ...base, modelRef: b.ref })]);
    expect(specOf(pb)).toEqual(specOf(pa));
    expect(pb.mtp).toMatchObject({ present: true, enabled: true, draft: 'dspark' });
  });

  it('Qwen3.8-27B NVFP4 (ModelOpt W4A16, mtp* escluso dalla quantizzazione): MTP attivo', async () => {
    const { hf, runpod, ref } = fakes('llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved-NVFP4', [gpu('NVIDIA RTX A6000', 48, 0.6)]);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(specOf(plan)).toEqual({ method: 'mtp', num_speculative_tokens: 1 });
    expect(plan.mtp).toMatchObject({ present: true, enabled: true, draft: 'mtp' });
  });

  it('GLM-5.3-Flash: MTP rilevato dal prefisso language_model e --speculative-config mtp', async () => {
    const { hf, runpod, ref } = fakes(GLM_FLASH);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(specOf(plan).method).toBe('mtp');
    expect(plan.mtp).toMatchObject({ present: true, enabled: true, draft: 'mtp' });
    expect(mtpLabel(plan.mtp)).toBe('attivo (decodifica speculativa, 1 token)');
  });

  it('DSpark disattivato con --set speculative-config=false: etichetta dedicata', async () => {
    const { hf, runpod, ref } = fakes(V4_0731);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref, set: ['speculative-config=false'] });
    expect(mtpLabel(plan.mtp)).toBe('draft DSpark presente nei pesi ma disattivato');
  });
});

describe('NVFP4 su GPU non Blackwell', () => {
  const H100 = 'NVIDIA H100 80GB HBM3';
  const B200 = 'NVIDIA B200';

  it('avviso se la GPU scelta non è Blackwell; nessun avviso su B200; aggiornato quando si cambia GPU', async () => {
    const { hf, runpod, ref } = fakes(GLM_FLASH_NVFP4, [gpu(H100, 80, 2.5), gpu(B200, 180, 6)]);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(plan.gpu.id).toBe(H100);
    expect(plan.warnings.join('\n')).toMatch(/NVFP4/);
    applyGpuChoice(plan, { id: B200, count: plan.options.find((o) => o.id === B200).count });
    expect(plan.warnings.join('\n')).not.toMatch(/NVFP4/);
    applyGpuChoice(plan, { id: H100, count: plan.options.find((o) => o.id === H100).count });
    expect(plan.warnings.filter((x) => /NVFP4/.test(x))).toHaveLength(1);
  });

  it('nessun avviso NVFP4 per un modello FP8', async () => {
    const { hf, runpod, ref } = fakes(GLM_FLASH);
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(plan.warnings.join('\n')).not.toMatch(/NVFP4/);
  });
});
