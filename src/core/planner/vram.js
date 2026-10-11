export const GiB = 1024 ** 3;

const textConfig = (config) => config.text_config ?? config;

export function weightsBytes(tree) {
  return tree
    .filter((f) => f.type === 'file' && f.path.endsWith('.safetensors'))
    .reduce((sum, f) => sum + (f.lfs?.size ?? f.size ?? 0), 0);
}

export function kvBytesPerToken(config, kvDtypeBytes = 2) {
  const c = textConfig(config);
  const layers = c.num_hidden_layers;
  if (c.kv_lora_rank && c.qk_rope_head_dim) {
    return { bytes: (c.kv_lora_rank + c.qk_rope_head_dim) * layers * kvDtypeBytes, kind: 'mla' };
  }
  const heads = c.num_attention_heads;
  const kvHeads = c.num_key_value_heads ?? heads;
  const headDim = c.head_dim ?? c.hidden_size / heads;
  // Stima prudente: anche le architetture a finestra scorrevole/ibride sono trattate ad attenzione completa.
  return { bytes: 2 * layers * kvHeads * headDim * kvDtypeBytes, kind: 'full' };
}

export function estimate({ weightsBytes: w, kvPerToken, context, concurrency, tp, overheadGiB = 2 }) {
  const kvBytes = kvPerToken * context * concurrency;
  return {
    weightsGiB: w / GiB,
    kvGiB: kvBytes / GiB,
    perGpuGiB: (w / tp + kvBytes / tp) / GiB + overheadGiB,
  };
}

export const fits = (perGpuGiB, gpuMemGiB, util = 0.9) => perGpuGiB <= gpuMemGiB * util;

export function tpSizes(config) {
  const heads = textConfig(config).num_attention_heads;
  return [1, 2, 4, 8].filter((n) => heads % n === 0);
}

const DTYPE_BYTES = { F64: 8, I64: 8, F32: 4, I32: 4, U32: 4, BF16: 2, F16: 2, I16: 2, U16: 2, F8_E4M3: 1, F8_E5M2: 1, I8: 1, U8: 1, BOOL: 1 };

export function bytesFromSafetensorsParams(parameters) {
  if (!parameters) return null;
  return Object.entries(parameters).reduce((sum, [dtype, count]) => sum + count * (DTYPE_BYTES[dtype] ?? 2), 0);
}
