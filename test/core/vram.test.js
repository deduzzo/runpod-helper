import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { GiB, weightsBytes, kvBytesPerToken, kvShardsFor, estimate, fits, tpSizes, bytesFromSafetensorsParams } from '../../src/core/planner/vram.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));

describe('vram', () => {
  it('somma i pesi safetensors reali di Qwen3-Coder-30B', () => {
    expect(weightsBytes(fx('tree-qwen3-coder-30b.json'))).toBe(61066575656);
  });

  it('KV per token con GQA (Qwen3-Coder: 2×48×4×128×2)', () => {
    expect(kvBytesPerToken(fx('config-qwen3-coder-30b.json'))).toEqual({ bytes: 98304, kind: 'full' });
  });

  it('KV per token con MLA (DeepSeek-V3: (512+64)×61×2)', () => {
    expect(kvBytesPerToken(fx('config-deepseek-v3.json'))).toEqual({ bytes: 70272, kind: 'mla' });
  });

  it('KV per token GLM-4.6 e Llama-3.3-70B', () => {
    expect(kvBytesPerToken(fx('config-glm.json')).bytes).toBe(376832);
    expect(kvBytesPerToken(fx('config-llama.json')).bytes).toBe(327680);
  });

  it('head_dim mancante e text_config annidato', () => {
    const cfg = { text_config: { num_hidden_layers: 2, num_attention_heads: 8, num_key_value_heads: 2, hidden_size: 1024 } };
    expect(kvBytesPerToken(cfg).bytes).toBe(2 * 2 * 2 * 128 * 2);
  });

  it('stima per GPU: Qwen3-Coder 64K×2 su 1 GPU ≈ 70,9 GiB, entra in 80 GB', () => {
    const e = estimate({ weightsBytes: 61066575656, kvPerToken: 98304, context: 65536, concurrency: 2, tp: 1, kvShards: 1 });
    expect(e.kvGiB).toBeCloseTo(12, 5);
    expect(e.weightsGiB).toBeCloseTo(56.87, 2);
    expect(e.perGpuGiB).toBeCloseTo(70.87, 2);
    expect(fits(e.perGpuGiB, 80)).toBe(true);
    expect(fits(e.perGpuGiB, 48)).toBe(false);
    const e2 = estimate({ weightsBytes: 61066575656, kvPerToken: 98304, context: 65536, concurrency: 2, tp: 2, kvShards: 2 });
    expect(e2.perGpuGiB).toBeCloseTo(36.44, 2);
    expect(fits(e2.perGpuGiB, 48)).toBe(true);
  });

  it('kvShardsFor: GQA = min(tp, kvHeads), MLA = 1, fallback su num_attention_heads, text_config', () => {
    const qwen = fx('config-qwen3-coder-30b.json');
    expect([1, 2, 4, 8].map((tp) => kvShardsFor(qwen, tp))).toEqual([1, 2, 4, 4]);
    const mla = fx('config-deepseek-v3.json');
    expect([1, 2, 4, 8].map((tp) => kvShardsFor(mla, tp))).toEqual([1, 1, 1, 1]);
    expect(kvShardsFor({ num_attention_heads: 8 }, 8)).toBe(8);
    expect(kvShardsFor({ text_config: { num_attention_heads: 8, num_key_value_heads: 2 } }, 8)).toBe(2);
  });

  it('estimate: con tp > kvHeads la KV per GPU non scende oltre kvHeads (Qwen3-Coder, kvHeads 4)', () => {
    const qwen = fx('config-qwen3-coder-30b.json');
    const kv = kvBytesPerToken(qwen).bytes;
    const at = (tp) => estimate({ weightsBytes: 61066575656, kvPerToken: kv, context: 65536, concurrency: 2, tp, kvShards: kvShardsFor(qwen, tp), overheadGiB: 0 });
    const kvPart = (e, tp) => e.perGpuGiB - e.weightsGiB / tp;
    expect(kvPart(at(8), 8)).toBeCloseTo(kvPart(at(4), 4), 6);
    expect(kvPart(at(8), 8)).toBeCloseTo(12 / 4, 6);
  });

  it('estimate: con MLA la KV non viene divisa per tp', () => {
    const mla = fx('config-deepseek-v3.json');
    const kv = kvBytesPerToken(mla).bytes;
    const e = estimate({ weightsBytes: 0, kvPerToken: kv, context: 65536, concurrency: 2, tp: 8, kvShards: kvShardsFor(mla, 8), overheadGiB: 0 });
    expect(e.perGpuGiB).toBeCloseTo(e.kvGiB, 6);
  });

  it('estimate richiede kvShards esplicito', () => {
    expect(() => estimate({ weightsBytes: 1, kvPerToken: 1, context: 1, concurrency: 1, tp: 2 })).toThrow(/kvShards/);
  });

  it('bytesFromSafetensorsParams moltiplica per la dimensione del dtype', () => {
    expect(bytesFromSafetensorsParams({ BF16: 10, F8_E4M3: 4, F32: 1 })).toBe(10 * 2 + 4 + 4);
    expect(bytesFromSafetensorsParams({ BF16: 30532122624 })).toBe(61064245248);
    expect(bytesFromSafetensorsParams(undefined)).toBeNull();
  });

  it('tpSizes rispetta il numero di attention heads', () => {
    expect(tpSizes({ num_attention_heads: 32 })).toEqual([1, 2, 4, 8]);
    expect(tpSizes({ num_attention_heads: 12 })).toEqual([1, 2, 4]);
    expect(tpSizes({ num_attention_heads: 40, text_config: undefined })).toEqual([1, 2, 4, 8]);
    expect(tpSizes({ num_attention_heads: 6 })).toEqual([1, 2]);
  });
});
