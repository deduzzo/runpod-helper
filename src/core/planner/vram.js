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

// Strati senza KV cache per token: attenzione lineare (Gated DeltaNet) o ricorrenti; hanno uno stato di dimensione costante per sequenza.
const CONSTANT_STATE_LAYERS = ['linear_attention', 'mamba'];

// Numero di strati con KV cache per token e di strati a stato costante. layer_types (se presente) è la fonte più precisa; altrimenti
// full_attention_interval (un strato ogni `interval` è ad attenzione completa); altrimenti tutti gli strati hanno KV cache.
function layerSplit(c) {
  const layers = c.num_hidden_layers;
  if (Array.isArray(c.layer_types) && c.layer_types.length > 0) {
    const constant = c.layer_types.filter((t) => CONSTANT_STATE_LAYERS.includes(t)).length;
    return { kv: c.layer_types.length - constant, constant };
  }
  if (c.full_attention_interval > 1 && layers > 0) {
    const kv = Math.floor(layers / c.full_attention_interval);
    return { kv, constant: layers - kv };
  }
  return { kv: layers, constant: 0 };
}

// Stato lineare per sequenza (Gated DeltaNet): per strato lineare linear_num_value_heads × linear_key_head_dim × linear_value_head_dim
// × 4 byte (FP32). Le convoluzioni (linear_conv_kernel_dim) sono trascurate: vale come stima, in eccesso rispetto alla KV quantizzata.
// 0 se la config non dichiara le dimensioni.
function linearStateBytes(c, nLinear) {
  const { linear_num_value_heads: vh, linear_key_head_dim: kd, linear_value_head_dim: vd } = c;
  return vh > 0 && kd > 0 && vd > 0 ? nLinear * vh * kd * vd * 4 : 0;
}

// KV cache per token (kvDtypeBytes per elemento). Per le architetture ibride (layer_types con strati lineari, o
// full_attention_interval) contano solo gli strati ad attenzione completa; `stateBytes` è lo stato costante per sequenza degli
// strati lineari. Gli strati a finestra scorrevole sono trattati prudentemente come attenzione completa.
export function kvBytesPerToken(config, kvDtypeBytes = 2) {
  const c = textConfig(config);
  const layers = c.num_hidden_layers;
  if (c.kv_lora_rank && c.qk_rope_head_dim) {
    return { bytes: (c.kv_lora_rank + c.qk_rope_head_dim) * layers * kvDtypeBytes, kind: 'mla' };
  }
  const heads = c.num_attention_heads;
  const kvHeads = c.num_key_value_heads ?? heads;
  const headDim = c.head_dim ?? c.hidden_size / heads;
  const { kv, constant } = layerSplit(c);
  const bytes = 2 * kv * kvHeads * headDim * kvDtypeBytes;
  if (constant > 0) return { bytes, kind: 'hybrid', stateBytes: linearStateBytes(c, constant) };
  return { bytes, kind: 'full' };
}

// Il modello ha un draft head MTP (decodifica speculativa)? Con l'indice dei pesi decide la presenza di tensori mtp.* (o, in stile
// DeepSeek/GLM, di uno strato oltre num_hidden_layers quando la config dichiara strati nextn): se l'indice dice che mancano, mancano
// anche se la config li dichiara (checkpoint ripuliti). Senza indice (null/undefined) decide la config.
export function hasMtp(config, weightMap) {
  const c = { ...(config.text_config ?? {}), ...config };
  const declared = (c.mtp_num_hidden_layers ?? 0) > 0 || (c.num_nextn_predict_layers ?? 0) > 0;
  if (weightMap && typeof weightMap === 'object') {
    const keys = Object.keys(weightMap);
    if (keys.some((k) => /(^|\.)mtp\./.test(k))) return true;
    if ((c.num_nextn_predict_layers ?? 0) > 0 && c.num_hidden_layers > 0) {
      // Strato nextn oltre l'ultimo: model.layers.<n>. (GLM-5.3, DeepSeek-V3) o model.language_model.layers.<n>. (GLM-5.3-Flash, multimodale).
      return keys.some((k) => k.startsWith(`model.layers.${c.num_hidden_layers}.`) || k.startsWith(`model.language_model.layers.${c.num_hidden_layers}.`));
    }
    return false;
  }
  return declared;
}

// Tipo di draft head nei pesi: 'dspark' se la config (o text_config) ha chiavi dspark_* (DeepSeek-V4-Flash-0731 e V4.1: i tensori
// mtp.* sono stadi DSpark, non un modulo MTP), 'mtp' per un draft MTP/nextn, null se assente.
export function draftKind(config, weightMap) {
  if (!hasMtp(config, weightMap)) return null;
  const keys = [...Object.keys(config ?? {}), ...Object.keys(config?.text_config ?? {})];
  return keys.some((k) => k.startsWith('dspark_')) ? 'dspark' : 'mtp';
}

// In quante GPU si ripartisce davvero la KV cache: con MLA la cache latente non è sharded;
// con GQA vLLM replica le teste KV quando tp > num_key_value_heads.
export function kvShardsFor(config, tp) {
  const c = textConfig(config);
  if (c.kv_lora_rank && c.qk_rope_head_dim) return 1;
  const kvHeads = c.num_key_value_heads ?? c.num_attention_heads;
  return Math.max(1, Math.min(tp, kvHeads));
}

// extraGiB: memoria costante per GPU oltre pesi e KV (stato lineare × concorrenza, riserva del draft MTP): non divisa per tp (stima per eccesso).
export function estimate({ weightsBytes: w, kvPerToken, context, concurrency, tp, kvShards, overheadGiB = 2, extraGiB = 0 }) {
  if (!(kvShards >= 1)) throw new Error('estimate: kvShards è obbligatorio (usa kvShardsFor(config, tp))');
  const kvBytes = kvPerToken * context * concurrency;
  return {
    weightsGiB: w / GiB,
    kvGiB: kvBytes / GiB,
    perGpuGiB: (w / tp + kvBytes / kvShards) / GiB + overheadGiB + extraGiB,
    extraGiB,
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
