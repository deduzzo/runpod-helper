import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { makePlan, syncDerivedFields } from '../../src/core/planner/plan.js';
import { loadFlags, detectParsers, applyOverrides } from '../../src/core/planner/vllm-args.js';
import { kvBytesPerToken, kvShardsFor, estimate, weightsBytes, GiB, hasMtp } from '../../src/core/planner/vram.js';
import { summarizeModel } from '../../src/core/hf.js';
import { searchRows } from '../../src/core/search.js';
import { reviewAdvice, ADVISOR_ALLOWED } from '../../src/core/advisor/advice.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const SHA = 'aedc6ce29b7b0c84c7fadfb59fb8524357f8014c';
const gpu = (id, memory, price, dc) => ({
  id, name: id, memory, price: { secure: price, community: 0 }, maxCount: { secure: 8, community: 0 },
  dataCenters: [{ id: dc, name: dc, availability: 'HIGH' }],
});
const base = { dataCenterId: 'EU-A', minCudaVersion: '12.9', vllmImage: 'vllm/vllm-openai:v0.30.0-cu129', flags: loadFlags() };
const SPEC = '{"method":"mtp","num_speculative_tokens":1}';

function fakesMtp({ index = fx('index-qwen38-27b-gptq-mtp.json').weight_map } = {}) {
  const hf = {
    getModel: vi.fn().mockResolvedValue(fx('model-qwen38-27b-gptq-mtp.json')),
    resolveSha: vi.fn().mockResolvedValue(SHA),
    listFiles: vi.fn().mockResolvedValue(fx('tree-qwen38-27b-gptq-mtp.json')),
    getConfig: vi.fn().mockResolvedValue(fx('config-qwen38-27b-gptq-mtp.json')),
    getWeightIndex: vi.fn().mockResolvedValue(index),
  };
  const runpod = { listGpus: vi.fn(async ({ count }) => (count === 1 ? [gpu('GPU80', 80, 1.5, 'EU-A')] : [])) };
  return { hf, runpod };
}
const ref = 'llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved-GPTQ-Int4';

describe('1. repository GGUF', () => {
  const ggufId = '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF';
  const fakes = () => {
    const hf = {
      getModel: vi.fn().mockResolvedValue(fx('model-gguf-qwen38-heretic.json')),
      resolveSha: vi.fn().mockResolvedValue('ab8d7bd81d03117501e4da60cccdff4c80f0eea0'),
      listFiles: vi.fn().mockResolvedValue(fx('tree-gguf-qwen38-heretic.json')),
      getConfig: vi.fn().mockRejectedValue(new Error('non deve essere chiamato')),
      getWeightIndex: vi.fn(),
    };
    return { hf, runpod: { listGpus: vi.fn() } };
  };

  it('il piano fallisce subito con INVALID_INPUT, hint con il modello base, senza config.json né Runpod', async () => {
    const { hf, runpod } = fakes();
    const err = await makePlan({ hf, runpod, ...base, modelRef: `https://huggingface.co/${ggufId}` }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT', message: `${ggufId} è un repository GGUF (formato di llama.cpp): vLLM in llmpod richiede pesi safetensors` });
    expect(err.hint).toContain('Usa la versione safetensors del modello');
    expect(err.hint).toContain('Qwen/Qwen3.8-27B');
    expect(err.hint).toContain('AWQ/GPTQ/FP8');
    expect(hf.getConfig).not.toHaveBeenCalled();
    expect(runpod.listGpus).not.toHaveBeenCalled();
  });

  it('senza base_model l\'hint resta generico', async () => {
    const { hf, runpod } = fakes();
    hf.getModel.mockResolvedValue({ ...fx('model-gguf-qwen38-heretic.json'), cardData: {}, tags: ['gguf'] });
    const err = await makePlan({ hf, runpod, ...base, modelRef: ggufId }).catch((e) => e);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.hint).toContain('AWQ/GPTQ/FP8');
    expect(err.hint).not.toContain('Qwen/Qwen3.8-27B');
  });

  it('un repository con .gguf e anche safetensors di primo livello non è bloccato', async () => {
    const { hf, runpod } = fakes();
    hf.listFiles.mockResolvedValue([{ type: 'file', path: 'a.gguf', size: 5 }, { type: 'file', path: 'model.safetensors', size: 100 }, { type: 'file', path: 'config.json', size: 5 }]);
    hf.getConfig.mockResolvedValue(fx('config-qwen35-27b.json'));
    runpod.listGpus.mockResolvedValue([gpu('GPU80', 80, 1.5, 'EU-A')]);
    await expect(makePlan({ hf, runpod, ...base, modelRef: ggufId })).resolves.toBeTruthy();
  });

  it('summarizeModel: ggufOnly e baseModel', () => {
    const s = summarizeModel(fx('model-gguf-qwen38-heretic.json'));
    expect(s).toMatchObject({ isGguf: true, ggufOnly: true, baseModel: 'Qwen/Qwen3.8-27B' });
    expect(summarizeModel(fx('model-qwen3-coder-30b.json'))).toMatchObject({ isGguf: false, ggufOnly: false });
    // GGUF con metadati safetensors: non è solo-GGUF
    expect(summarizeModel({ id: 'a/b', tags: ['gguf'], safetensors: { total: 1, parameters: { BF16: 1 } } }).ggufOnly).toBe(false);
    expect(summarizeModel({ id: 'a/b', library_name: 'gguf' }).ggufOnly).toBe(true);
  });

  it('searchRows esclude i repository solo-GGUF salvo all', async () => {
    const gguf = summarizeModel(fx('model-gguf-qwen38-heretic.json'));
    const ok = summarizeModel(fx('model-qwen3-coder-30b.json'));
    const hf = { searchModels: vi.fn(async () => [{ ...gguf, hasChatTemplate: true }, ok]) };
    expect((await searchRows(hf, 'q')).map((r) => r.id)).toEqual([ok.id]);
    expect((await searchRows(hf, 'q', { all: true })).map((r) => r.id)).toContain(gguf.id);
  });
});

describe('2. parser Qwen3.5', () => {
  it('model_type qwen3_5: qwen3_coder + qwen3', () => {
    const p = detectParsers({ modelId: 'Qwen/Qwen3.8-27B', config: fx('config-qwen35-27b.json') });
    expect(p).toMatchObject({ tool: 'qwen3_coder', reasoning: 'qwen3', extraArgs: [] });
    expect(p.warnings).toEqual([]);
  });
  it('model_type qwen3_5_text e qwen3_5_moe, anche con "coder" nell\'id', () => {
    for (const mt of ['qwen3_5_text', 'qwen3_5_moe', 'qwen3_5_moe_text']) {
      expect(detectParsers({ modelId: 'x/Qwen3.5-Coder-35B', config: { model_type: mt, architectures: ['Qwen3_5ForConditionalGeneration'] } }))
        .toMatchObject({ tool: 'qwen3_coder', reasoning: 'qwen3' });
    }
  });
  it('la regola sul model_type precede quelle sulle architetture', () => {
    const p = detectParsers({ modelId: 'x/Strano', config: { model_type: 'qwen3_5', architectures: ['Qwen3ForCausalLM'] } });
    expect(p).toMatchObject({ tool: 'qwen3_coder', reasoning: 'qwen3' });
  });
  it('l\'architettura Qwen3_5ForConditionalGeneration da sola (senza model_type) è riconosciuta', () => {
    expect(detectParsers({ modelId: 'x/Y', config: { architectures: ['Qwen3_5ForConditionalGeneration'] } })).toMatchObject({ tool: 'qwen3_coder', reasoning: 'qwen3' });
  });
  it('i Qwen3 esistenti restano invariati', () => {
    expect(detectParsers({ modelId: 'Qwen/Qwen3-32B', config: { architectures: ['Qwen3ForCausalLM'], model_type: 'qwen3' } })).toMatchObject({ tool: 'hermes', reasoning: 'qwen3' });
  });
});

describe('3. KV cache per architetture ibride', () => {
  const cfg = fx('config-qwen35-27b.json');
  it('Qwen3.8-27B: 16 strati full su 64, 4 teste KV, head_dim 256 → 64 KiB per token in BF16', () => {
    const kv = kvBytesPerToken(cfg);
    expect(kv.bytes).toBe(64 * 1024);
    expect(kv.kind).toBe('hybrid');
    // stato lineare: 48 strati × 48 teste value × 128 × 128 × 4 byte = 144 MiB per sequenza
    expect(kv.stateBytes).toBe(48 * 48 * 128 * 128 * 4);
    expect(kv.stateBytes / GiB).toBeCloseTo(0.1406, 3);
  });
  it('senza layer_types ma con full_attention_interval: n_full = floor(layers / interval)', () => {
    const noTypes = structuredClone(cfg);
    delete noTypes.text_config.layer_types;
    expect(kvBytesPerToken(noTypes)).toMatchObject({ bytes: 64 * 1024, kind: 'hybrid', stateBytes: 48 * 48 * 128 * 128 * 4 });
  });
  it('kvDtypeBytes scala la KV (FP8: metà) ma non lo stato lineare', () => {
    const kv = kvBytesPerToken(cfg, 1);
    expect(kv.bytes).toBe(32 * 1024);
    expect(kv.stateBytes).toBe(48 * 48 * 128 * 128 * 4);
  });
  it('legge i campi anche quando la config del testo non è annidata', () => {
    const flat = { ...cfg.text_config, architectures: cfg.architectures };
    expect(kvBytesPerToken(flat).bytes).toBe(64 * 1024);
  });
  it('layer_types senza strati lineari (es. sliding): invariato, tutti con KV, kind full', () => {
    const c = { num_hidden_layers: 4, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 64, layer_types: ['sliding_attention', 'full_attention', 'sliding_attention', 'full_attention'] };
    expect(kvBytesPerToken(c)).toEqual({ bytes: 2 * 4 * 2 * 64 * 2, kind: 'full' });
  });
  it('i modelli non ibridi restano invariati', () => {
    expect(kvBytesPerToken(fx('config-qwen3-coder-30b.json'))).toEqual({ bytes: 98304, kind: 'full' });
    expect(kvBytesPerToken(fx('config-deepseek-v3.json'))).toEqual({ bytes: 70272, kind: 'mla' });
  });
  it('kvShardsFor usa le teste KV del testo (4)', () => {
    expect(kvShardsFor(cfg, 8)).toBe(4);
    expect(kvShardsFor(cfg, 2)).toBe(2);
  });
  it('estimate somma extraGiB (stato lineare, riserva MTP) alla memoria per GPU', () => {
    const e0 = estimate({ weightsBytes: 20 * GiB, kvPerToken: 65536, context: 65536, concurrency: 2, tp: 1, kvShards: 1 });
    const e1 = estimate({ weightsBytes: 20 * GiB, kvPerToken: 65536, context: 65536, concurrency: 2, tp: 1, kvShards: 1, extraGiB: 1.5 });
    expect(e0.kvGiB).toBeCloseTo(8, 6);
    expect(e1.perGpuGiB - e0.perGpuGiB).toBeCloseTo(1.5, 6);
    expect(e1.kvGiB).toBeCloseTo(8, 6);
  });
  it('i pesi del modello multimodale (vision tower inclusa) sono contati per intero', () => {
    const tree = fx('tree-qwen38-27b-gptq-mtp.json');
    expect(weightsBytes(tree, { weightMap: fx('index-qwen38-27b-gptq-mtp.json').weight_map })).toBe(19559451000);
    expect(weightsBytes(tree)).toBe(19559451000);
  });
});

describe('4-7. piano con GPTQ + MTP (Qwen3.8-27B)', () => {
  it('7. pesi dalle dimensioni reali dei file (~18,2 GiB) e GPTQ letto dalla config: nessun --quantization', async () => {
    const { hf, runpod } = fakesMtp();
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(plan.model.weightsBytes).toBe(19559451000);
    expect(plan.estimate.weightsGiB).toBeCloseTo(18.22, 2);
    expect(plan.vllm.args).not.toContain('--quantization');
    expect(plan.vllm.args).not.toContain('--trust-remote-code');
    expect(plan.parsers).toEqual({ tool: 'qwen3_coder', reasoning: 'qwen3' });
    expect(plan.gpu).toEqual({ id: 'GPU80', count: 1 });
  });

  it('4. MTP: --speculative-config come singolo argomento JSON, riga di stato e riserva VRAM', async () => {
    const { hf, runpod } = fakesMtp();
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    const i = plan.vllm.args.indexOf('--speculative-config');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(plan.vllm.args[i + 1]).toBe(SPEC);
    expect(plan.mtp).toEqual({ present: true, enabled: true });
    // 18,22 pesi + 8 KV (64 KiB × 65536 × 2) + 0,28 stato lineare (2 seq) + 2 overhead + 1 riserva MTP
    expect(plan.estimate.perGpuGiB).toBeCloseTo(18.22 + 8 + 0.28125 + 2 + 1, 1);
    expect(plan.estimate.kvGiB).toBeCloseTo(8, 3);
    expect(plan.warnings.join(' ')).not.toMatch(/Flag non riconosciuti/);
  });

  it('senza tensori mtp.* nei pesi: MTP assente e nessun flag (anche se la config dichiara mtp_num_hidden_layers)', async () => {
    const wm = Object.fromEntries(Object.entries(fx('index-qwen38-27b-gptq-mtp.json').weight_map).filter(([k]) => !k.startsWith('mtp.')));
    const { hf, runpod } = fakesMtp({ index: wm });
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(plan.mtp).toEqual({ present: false, enabled: false });
    expect(plan.vllm.args).not.toContain('--speculative-config');
    expect(plan.estimate.perGpuGiB).toBeCloseTo(18.22 + 8 + 0.28125 + 2, 1);
  });

  it('senza indice dei pesi si ricorre alla config (mtp_num_hidden_layers > 0)', async () => {
    const { hf, runpod } = fakesMtp({ index: null });
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(plan.mtp).toEqual({ present: true, enabled: true });
    expect(plan.vllm.args).toContain('--speculative-config');
    const { hf: hf2, runpod: runpod2 } = fakesMtp({ index: null });
    const cfg = fx('config-qwen38-27b-gptq-mtp.json');
    delete cfg.text_config.mtp_num_hidden_layers;
    hf2.getConfig.mockResolvedValue(cfg);
    const p2 = await makePlan({ hf: hf2, runpod: runpod2, ...base, modelRef: ref });
    expect(p2.mtp).toEqual({ present: false, enabled: false });
  });

  it('--set speculative-config=false lo rimuove e aggiorna lo stato; --set con altro valore lo sostituisce', async () => {
    const { hf, runpod } = fakesMtp();
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref, set: ['speculative-config=false'] });
    expect(plan.vllm.args).not.toContain('--speculative-config');
    expect(plan.vllm.args).not.toContain(SPEC);
    expect(plan.mtp).toEqual({ present: true, enabled: false });
    expect(plan.estimate.perGpuGiB).toBeCloseTo(18.22 + 8 + 0.28125 + 2, 1);
    const { hf: h2, runpod: r2 } = fakesMtp();
    const p2 = await makePlan({ hf: h2, runpod: r2, ...base, modelRef: ref, set: ['speculative-config={"method":"mtp","num_speculative_tokens":3}'] });
    expect(p2.vllm.args.filter((a) => a === '--speculative-config')).toHaveLength(1);
    expect(p2.vllm.args).toContain('{"method":"mtp","num_speculative_tokens":3}');
  });

  it('applyOverrides: speculative-config=false toglie flag e valore', () => {
    expect(applyOverrides(['--a', '1', '--speculative-config', SPEC, '--b'], { set: ['speculative-config=false'] })).toEqual(['--a', '1', '--b']);
  });

  it('syncDerivedFields aggiorna mtp.enabled dagli argomenti (profili modificati a mano)', () => {
    const on = syncDerivedFields({ vllm: { args: ['--speculative-config', SPEC] }, mtp: { present: true, enabled: false } });
    expect(on.mtp).toEqual({ present: true, enabled: true });
    const off = syncDerivedFields({ vllm: { args: [] }, mtp: { present: true, enabled: true } });
    expect(off.mtp).toEqual({ present: true, enabled: false });
    expect(syncDerivedFields({ vllm: { args: [] } }).mtp).toBeUndefined();
  });

  it('hasMtp: tensori mtp.*, nextn nella config, niente', () => {
    expect(hasMtp({}, { 'mtp.fc.weight': 'a' })).toBe(true);
    expect(hasMtp({}, { 'model.layers.0.x': 'a' })).toBe(false);
    expect(hasMtp({ text_config: { mtp_num_hidden_layers: 1 } }, null)).toBe(true);
    expect(hasMtp({ num_nextn_predict_layers: 1 }, undefined)).toBe(true);
    expect(hasMtp({ num_nextn_predict_layers: 0 }, null)).toBe(false);
    // nextn in stile DeepSeek: strato extra oltre num_hidden_layers nell'indice
    expect(hasMtp({ num_hidden_layers: 61, num_nextn_predict_layers: 1 }, { 'model.layers.61.eh_proj.weight': 'a' })).toBe(true);
    expect(hasMtp({ num_hidden_layers: 61, num_nextn_predict_layers: 1 }, { 'model.layers.60.mlp.weight': 'a' })).toBe(false);
  });

  it('6. Qwen3.5 senza auto_map: --trust-remote-code non è aggiunto; con --allow-trust-remote-code resta una scelta esplicita', async () => {
    const { hf, runpod } = fakesMtp();
    expect(fx('config-qwen38-27b-gptq-mtp.json').auto_map).toBeUndefined();
    const plan = await makePlan({ hf, runpod, ...base, modelRef: ref });
    expect(plan.vllm.args.join(' ')).not.toMatch(/trust-remote-code/);
    await expect(makePlan({ hf, runpod, ...base, modelRef: ref, extra: ['--trust-remote-code'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const ok = await makePlan({ hf, runpod, ...base, modelRef: ref, extra: ['--trust-remote-code'], allowTrustRemoteCode: true });
    expect(ok.vllm.args).toContain('--trust-remote-code');
  });

  it('il flag non è nell\'allowlist del consulente e il backstop non lo tocca', () => {
    expect(ADVISOR_ALLOWED).not.toContain('speculative-config');
    const baseArgs = ['--max-model-len', '65536', '--tensor-parallel-size', '1', '--revision', SHA, '--speculative-config', SPEC];
    const r = reviewAdvice({ advice: { set: { 'speculative-config': 'false', speculative_config: '{"method":"ngram"}' }, warnings: [] }, baseArgs, flags: loadFlags() });
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['non consentito al consulente', 'non consentito al consulente']);
    expect(r.args).toEqual(baseArgs);
  });
});

describe('5. ricerca: MTP', () => {
  const mk = (id, extra = {}) => ({ id, params: 27e9, paramsByDtype: null, dtypes: [], license: null, gated: false, downloads: 1, lastModified: null, architectures: ['Qwen3_5ForConditionalGeneration'], modelType: 'qwen3_5', hasChatTemplate: true, ...extra });

  it('summarizeModel: mtp true da tag o nome, altrimenti null', () => {
    expect(summarizeModel(fx('model-qwen38-27b-gptq-mtp.json'))).toMatchObject({ mtp: true, baseModel: 'llmfan46/Qwen3.8-27B-Ultra-Uncensored-Heretic-Native-MTP-Preserved', quantBits: 4 });
    expect(summarizeModel({ id: 'a/Model-MTP-GPTQ' }).mtp).toBe(true);
    expect(summarizeModel({ id: 'a/Model', tags: ['mtp'] }).mtp).toBe(true);
    expect(summarizeModel({ id: 'a/Amtpx' }).mtp).toBeNull();
    expect(summarizeModel(fx('model-qwen3-coder-30b.json')).mtp).toBeNull();
  });

  it('searchRows espone mtp e, a parità di modello base, mette prima le varianti con MTP', async () => {
    const rows = [
      mk('a/Qwen-27B-GPTQ', { baseModel: 'Qwen/Qwen3.8-27B', mtp: null }),
      mk('z/Altro', { baseModel: 'Altro/Base', mtp: null }),
      mk('b/Qwen-27B-MTP-GPTQ', { baseModel: 'Qwen/Qwen3.8-27B', mtp: true }),
      mk('c/Senza-base', { mtp: true }),
    ];
    const hf = { searchModels: vi.fn(async () => rows) };
    const out = await searchRows(hf, 'qwen');
    expect(out.map((r) => r.id)).toEqual(['b/Qwen-27B-MTP-GPTQ', 'a/Qwen-27B-GPTQ', 'z/Altro', 'c/Senza-base']);
    expect(out.map((r) => r.mtp)).toEqual([true, null, null, true]);
  });
});
