export const GiB = 1024 ** 3;

const textConfig = (config) => config.text_config ?? config;

const sizeOf = (f) => f.lfs?.size ?? f.size ?? 0;

// Peso dei file safetensors da scaricare. Con l'indice (weight_map di model.safetensors.index.json) contano solo i file
// elencati; senza indice: niente sottocartelle e, se esistono gli shard model-*.safetensors, niente consolidated*.safetensors
// (copia alternativa degli stessi pesi, in formato Mistral, che vLLM non carica insieme agli shard).
export function weightsBytes(tree, { weightMap } = {}) {
  const files = tree.filter((f) => f.type === 'file' && f.path.endsWith('.safetensors'));
  if (weightMap && typeof weightMap === 'object') {
    const listed = new Set(Object.values(weightMap));
    const matched = files.filter((f) => listed.has(f.path));
    if (matched.length) return matched.reduce((sum, f) => sum + sizeOf(f), 0);
  }
  const top = files.filter((f) => !f.path.includes('/'));
  const hasShards = top.some((f) => /^model-.*\.safetensors$/.test(f.path));
  return top
    .filter((f) => !(hasShards && /^consolidated.*\.safetensors$/.test(f.path)))
    .reduce((sum, f) => sum + sizeOf(f), 0);
}

// Totale da scaricare: TUTTI i .safetensors di primo livello (anche consolidated*: con load-format auto vLLM può scaricare
// tutto il repository). Serve a disco e timeout del Pod; weightsBytes resta per la VRAM.
export function downloadBytes(tree) {
  return tree
    .filter((f) => f.type === 'file' && f.path.endsWith('.safetensors') && !f.path.includes('/'))
    .reduce((sum, f) => sum + sizeOf(f), 0);
}

// Byte da scaricare per un profilo; i profili vecchi (senza estimate.downloadBytes) ripiegano su weightsBytes.
export const profileDownloadBytes = (profile) => profile.estimate?.downloadBytes ?? profile.model.weightsBytes;

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

// In quante GPU si ripartisce davvero la KV cache: con MLA la cache latente non è sharded;
// con GQA vLLM replica le teste KV quando tp > num_key_value_heads.
export function kvShardsFor(config, tp) {
  const c = textConfig(config);
  if (c.kv_lora_rank && c.qk_rope_head_dim) return 1;
  const kvHeads = c.num_key_value_heads ?? c.num_attention_heads;
  return Math.max(1, Math.min(tp, kvHeads));
}

export function estimate({ weightsBytes: w, kvPerToken, context, concurrency, tp, kvShards, overheadGiB = 2 }) {
  if (!(kvShards >= 1)) throw new Error('estimate: kvShards è obbligatorio (usa kvShardsFor(config, tp))');
  const kvBytes = kvPerToken * context * concurrency;
  return {
    weightsGiB: w / GiB,
    kvGiB: kvBytes / GiB,
    perGpuGiB: (w / tp + kvBytes / kvShards) / GiB + overheadGiB,
  };
}

export const fits = (perGpuGiB, gpuMemGiB, util = 0.9) => perGpuGiB <= gpuMemGiB * util;

export function tpSizes(config) {
  const heads = textConfig(config).num_attention_heads;
  return [1, 2, 4, 8].filter((n) => heads % n === 0);
}

const DTYPE_BYTES = { F64: 8, I64: 8, F32: 4, I32: 4, U32: 4, BF16: 2, F16: 2, I16: 2, U16: 2, F8_E4M3: 1, F8_E5M2: 1, I8: 1, U8: 1, BOOL: 1 };

// I32/U32 sono i contenitori dei pesi compressi (AWQ/GPTQ/MLX): il conteggio di HF è già in parametri, non in elementi
// da 4 byte. Con i bit della quantizzazione si stima parametri totali × bits/8; senza, la stima non è affidabile (null).
const PACKED = ['I32', 'U32'];

export function bytesFromSafetensorsParams(parameters, { bits } = {}) {
  if (!parameters) return null;
  if (PACKED.some((d) => d in parameters)) {
    if (!(Number.isFinite(bits) && bits > 0)) return null;
    return Object.values(parameters).reduce((sum, count) => sum + count, 0) * bits / 8;
  }
  return Object.entries(parameters).reduce((sum, [dtype, count]) => sum + count * (DTYPE_BYTES[dtype] ?? 2), 0);
}
