import { LlmpodError, Codes } from '../errors.js';
import { parseModelRef, summarizeModel } from '../hf.js';
import { weightsBytes, kvBytesPerToken, kvShardsFor, estimate, tpSizes } from './vram.js';
import { detectParsers, buildArgs, applyOverrides, validateArgs } from './vllm-args.js';
import { selectGpus } from './gpu-select.js';

const SHA_RE = /^[0-9a-f]{40}$/;

// Valore di un flag negli argomenti di vllm serve (forma `--flag valore` o `--flag=valore`); vale l'ultima occorrenza (come argparse).
// null se assente o senza valore.
function argValue(args, flag) {
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === flag) return args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : null;
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return null;
}
const hasFlag = (args, flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`));

// Riallinea i campi derivati dagli argomenti (piano o profilo) dopo che gli args sono cambiati. Modifica in posto.
export function syncDerivedFields(target) {
  const args = target.vllm.args;
  // vLLM accetta --tool-call-parser solo insieme a --enable-auto-tool-choice (e viceversa): parser presente <=> flag presente
  if (hasFlag(args, '--tool-call-parser')) {
    if (!args.includes('--enable-auto-tool-choice')) args.push('--enable-auto-tool-choice');
  } else {
    for (let i = args.length - 1; i >= 0; i--) if (args[i] === '--enable-auto-tool-choice') args.splice(i, 1);
  }
  target.parsers = { tool: argValue(args, '--tool-call-parser'), reasoning: argValue(args, '--reasoning-parser') };
  target.kvCacheDtype = /fp8/i.test(argValue(args, '--kv-cache-dtype') ?? '') ? 'fp8' : null;
  if (Array.isArray(target.warnings) && !target.kvCacheDtype) {
    target.warnings = target.warnings.filter((w) => !w.startsWith('KV cache in FP8'));
  }
  return target;
}

export async function makePlan({
  hf, runpod, modelRef, context = 65536, concurrency = 2, cloud = 'SECURE', dataCenterId,
  minCudaVersion, vllmImage, set = [], extra = [], flags, allowTrustRemoteCode = false, onProgress = () => {},
}) {
  const { id, revision } = parseModelRef(modelRef);
  const warnings = [];

  onProgress(`Lettura di ${id} da Hugging Face`);
  const info = await hf.getModel(id);
  // R3: prima di qualunque chiamata a pagamento (e prima di leggere l'albero dei file).
  if (summarizeModel(info).isMlx) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Formato MLX non supportato da vLLM: ${id}`, { hint: 'Cerca la versione safetensors/AWQ dello stesso modello (ad esempio quella dell\'organizzazione originale, non mlx-community)' });
  }
  const sha = SHA_RE.test(revision) ? revision : await hf.resolveSha(id, revision);
  const [tree, config] = await Promise.all([hf.listFiles(id, sha), hf.getConfig(id, sha)]);
  const summary = summarizeModel(info);

  // Con l'indice dei pesi (file piccolo) contano solo gli shard elencati; se non è leggibile vale la regola sull'albero.
  const weightMap = await hf.getWeightIndex?.(id, sha);
  const wBytes = weightsBytes(tree, { weightMap });
  if (!wBytes) {
    throw new LlmpodError(Codes.INVALID_INPUT, `${id} non contiene file .safetensors`, { hint: 'vLLM su llmpod supporta modelli safetensors (i repository solo GGUF non sono supportati)' });
  }
  const maxCtx = (config.text_config ?? config).max_position_embeddings;
  let ctx = context;
  if (maxCtx && ctx > maxCtx) {
    warnings.push(`Contesto ridotto da ${context} a ${maxCtx}, il massimo dichiarato dal modello`);
    ctx = maxCtx;
  }
  if (!summary.hasChatTemplate) warnings.push('Il modello non dichiara un chat template: le chiamate a strumento potrebbero non funzionare');
  if (summary.gated) warnings.push(`Modello gated (${summary.gated}): serve HF_TOKEN con accesso approvato`);

  const parsers = detectParsers({ modelId: id, config });
  warnings.push(...parsers.warnings);

  const sizes = tpSizes(config);
  onProgress('Lettura del catalogo GPU Runpod');
  const catalogs = {};
  for (const count of sizes) catalogs[count] = await runpod.listGpus({ count, cloud, minCudaVersion });

  const kv = kvBytesPerToken(config);
  const pick = (kvPerToken) => {
    const needs = (tp) => estimate({ weightsBytes: wBytes, kvPerToken, context: ctx, concurrency, tp, kvShards: kvShardsFor(config, tp) }).perGpuGiB;
    return { needs, sel: selectGpus({ catalogs, dataCenterId, needs, tpSizes: sizes, cloud }) };
  };
  let kvCacheDtype = null;
  let kvPerToken = kv.bytes;
  let { sel } = pick(kvPerToken);
  if (!sel.choice && !sel.elsewhere.length) {
    const fp8 = pick(kv.bytes / 2);
    if (fp8.sel.all.length) {
      ({ sel } = fp8);
      kvPerToken = kv.bytes / 2;
      kvCacheDtype = 'fp8';
      warnings.push('KV cache in FP8 (--kv-cache-dtype fp8): in BF16 non entra in nessuna GPU disponibile');
    }
  }
  if (!sel.choice) {
    warnings.push(`NO_GPU_AVAILABLE: nessuna GPU adatta disponibile nel datacenter ${dataCenterId}`
      + (sel.elsewhere.length ? ` (disponibile altrove: ${sel.elsewhere.map((c) => `${c.name}×${c.count}`).join(', ')})` : ''));
  }

  const tp = sel.choice?.count ?? 1;
  const args = applyOverrides(buildArgs({ context: ctx, tp, revision: sha, parsers, kvCacheDtype }), { set, extra });
  const { unknown, forbidden } = validateArgs(args, flags, { allowTrustRemoteCode });
  if (forbidden.length) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Argomenti vLLM non consentiti: ${forbidden.join(', ')}`, { hint: 'llmpod gestisce da solo chiave, host, porta e nome servito' });
  }
  if (unknown.length) warnings.push(`Flag non riconosciuti da vLLM ${'v0.30.0'}: ${unknown.join(', ')}`);

  const est = estimate({ weightsBytes: wBytes, kvPerToken, context: ctx, concurrency, tp, kvShards: kvShardsFor(config, tp) });
  return syncDerivedFields({
    model: { id, revision: sha, requestedRevision: revision, gated: summary.gated, license: summary.license, params: summary.params, weightsBytes: wBytes, maxContext: maxCtx ?? null },
    context: ctx,
    concurrency,
    vllm: { image: vllmImage, args },
    parsers: { tool: parsers.tool, reasoning: parsers.reasoning },
    // kvDtype: base della stima (fp8 solo se il ripiego ha dimezzato la KV), indipendente dagli override successivi
    estimate: { weightsGiB: est.weightsGiB, kvGiB: est.kvGiB, perGpuGiB: est.perGpuGiB, kvDtype: kvCacheDtype === 'fp8' ? 'fp8' : 'auto' },
    gpu: sel.choice ? { id: sel.choice.gpuId, count: sel.choice.count } : null,
    hourlyUSD: sel.choice?.hourly ?? null,
    alternatives: sel.alternatives.map((c) => ({ id: c.gpuId, count: c.count, hourly: c.hourly })),
    elsewhere: sel.elsewhere,
    candidates: sel.all.slice(0, 10),
    dataCenterId,
    cloud,
    kvCacheDtype,
    warnings,
  });
}
