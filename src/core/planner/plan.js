import { LlmpodError, Codes } from '../errors.js';
import { parseModelRef, summarizeModel } from '../hf.js';
import { weightsBytes, downloadBytes, kvBytesPerToken, kvShardsFor, estimate, tpSizes, hasMtp, draftKind, GiB } from './vram.js';
import { detectParsers, buildArgs, applyOverrides, validateArgs, MTP_SPEC, DSPARK_SPEC } from './vllm-args.js';
import { selectGpus } from './gpu-select.js';
import { optionOf, refreshGpuWarnings } from './gpu-choice.js';

const SHA_RE = /^[0-9a-f]{40}$/;
// Riserva per lo stato del draft MTP (KV del suo strato e buffer): approssimazione per eccesso, i pesi MTP sono già nei file.
const MTP_RESERVE_GiB = 1;
// Quantizzazione dichiarata in config.json: 'nvfp4' (ModelOpt quant_algo NVFP4 o compressed-tensors nvfp4-*), altrimenti quant_method.
function quantizationOf(config) {
  const q = config.quantization_config ?? config.text_config?.quantization_config ?? null;
  if (!q) return null;
  if (/nvfp4/i.test(String(q.quant_algo ?? '')) || /nvfp4/i.test(String(q.format ?? ''))) return 'nvfp4';
  return q.quant_method ? String(q.quant_method).toLowerCase() : null;
}
const isTopLevel = (f, ext) => f.type === 'file' && !f.path.includes('/') && f.path.endsWith(ext);

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
  if (target.mtp) {
    let tokens = null;
    try { tokens = JSON.parse(argValue(args, '--speculative-config') ?? 'null')?.num_speculative_tokens ?? null; } catch { tokens = null; }
    let method = null;
    try { method = JSON.parse(argValue(args, '--speculative-config') ?? 'null')?.method ?? null; } catch { method = null; }
    const draft = ['mtp', 'dspark'].includes(method) ? method : (target.mtp.draft ?? null);
    target.mtp = { ...target.mtp, enabled: hasFlag(args, '--speculative-config'), tokens, draft };
  }
  target.kvCacheDtype = /fp8/i.test(argValue(args, '--kv-cache-dtype') ?? '') ? 'fp8' : null;
  if (Array.isArray(target.warnings) && !target.kvCacheDtype) {
    target.warnings = target.warnings.filter((w) => !w.startsWith('KV cache in FP8'));
  }
  return target;
}

export async function makePlan({
  hf, runpod, modelRef, context = 65536, concurrency = 2, cloud = 'SECURE', dataCenterId,
  minCudaVersion, vllmImage, set = [], extra = [], flags, allowTrustRemoteCode = false, ncclSafe = true, onProgress = () => {},
}) {
  const { id, revision } = parseModelRef(modelRef);
  const warnings = [];

  onProgress(`Lettura di ${id} da Hugging Face`);
  const info = await hf.getModel(id);
  const summary = summarizeModel(info);
  // R3: prima di qualunque chiamata a pagamento (e prima di leggere l'albero dei file).
  if (summary.isMlx) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Formato MLX non supportato da vLLM: ${id}`, { hint: 'Cerca la versione safetensors/AWQ dello stesso modello (ad esempio quella dell\'organizzazione originale, non mlx-community)' });
  }
  const sha = SHA_RE.test(revision) ? revision : await hf.resolveSha(id, revision);
  const tree = await hf.listFiles(id, sha);
  // Repository GGUF (llama.cpp): rifiutato prima di cercare config.json e prima di ogni chiamata a Runpod.
  if (tree.some((f) => isTopLevel(f, '.gguf')) && !tree.some((f) => isTopLevel(f, '.safetensors'))) {
    throw new LlmpodError(Codes.INVALID_INPUT, `${id} è un repository GGUF (formato di llama.cpp): vLLM in llmpod richiede pesi safetensors`, {
      hint: `Usa la versione safetensors del modello${summary.baseModel ? ` (il modello base indicato è ${summary.baseModel})` : ' (es. il modello base indicato nella model card)'} oppure una quantizzazione AWQ/GPTQ/FP8`,
    });
  }
  const config = await hf.getConfig(id, sha);

  // Con l'indice dei pesi (file piccolo) contano solo gli shard elencati; se non è leggibile vale la regola sull'albero.
  const weightMap = await hf.getWeightIndex?.(id, sha);
  const wBytes = weightsBytes(tree, { weightMap });
  if (!wBytes) {
    if (tree.some((f) => f.type === 'file' && f.path.endsWith('.safetensors'))) {
      throw new LlmpodError(Codes.INVALID_INPUT, `${id}: i pesi sono solo in sottocartelle: non supportato`, { hint: 'vLLM su llmpod carica i file .safetensors dalla radice del repository: scegli un altro repository del modello' });
    }
    throw new LlmpodError(Codes.INVALID_INPUT, `${id} non contiene file .safetensors`, { hint: 'vLLM su llmpod supporta modelli safetensors (i repository solo GGUF non sono supportati)' });
  }
  const maxCtx = (config.text_config ?? config).max_position_embeddings;
  let ctx = context;
  if (maxCtx && ctx > maxCtx) {
    warnings.push(`Contesto ridotto da ${context} a ${maxCtx}, il massimo dichiarato dal modello`);
    ctx = maxCtx;
  }
  if (summary.gated) warnings.push(`Modello gated (${summary.gated}): serve HF_TOKEN con accesso approvato`);

  const parsers = detectParsers({ modelId: id, config });
  // Con --tokenizer-mode della regola (DeepSeek-V4, Mistral) è il tokenizer di vLLM a costruire il prompt: il chat template non serve.
  if (!summary.hasChatTemplate && !parsers.extraArgs.includes('--tokenizer-mode')) warnings.push('Il modello non dichiara un chat template: le chiamate a strumento potrebbero non funzionare');
  warnings.push(...parsers.warnings);

  const sizes = tpSizes(config);
  onProgress('Lettura del catalogo GPU Runpod');
  const catalogs = {};
  for (const count of sizes) catalogs[count] = await runpod.listGpus({ count, cloud, minCudaVersion });

  const kv = kvBytesPerToken(config);
  // MTP: se i pesi contengono il draft head si attiva la decodifica speculativa (salvo --set speculative-config=false).
  const mtpPresent = hasMtp(config, weightMap);
  // Tipo di draft: DSpark (config con dspark_*) usa l'argomento della recipe della regola, MTP quello predefinito.
  const draft = draftKind(config, weightMap);
  const speculative = draft === 'dspark' ? (parsers.dspark ?? DSPARK_SPEC) : draft === 'mtp' ? MTP_SPEC : null;
  const specDisabled = set.some((x) => /^(--)?speculative[-_]config=false$/.test(x));
  // Memoria costante per GPU oltre pesi e KV: stato lineare degli strati ibridi × concorrenza e riserva del draft MTP (stime per eccesso).
  const extraGiB = ((kv.stateBytes ?? 0) * concurrency) / GiB + (mtpPresent && !specDisabled ? MTP_RESERVE_GiB : 0);
  const pick = (kvPerToken) => {
    const needs = (tp) => estimate({ weightsBytes: wBytes, kvPerToken, context: ctx, concurrency, tp, kvShards: kvShardsFor(config, tp), extraGiB }).perGpuGiB;
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
  const args = applyOverrides(buildArgs({ context: ctx, tp, revision: sha, parsers, kvCacheDtype, speculative }), { set, extra });
  const { unknown, forbidden } = validateArgs(args, flags, { allowTrustRemoteCode });
  if (forbidden.length) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Argomenti vLLM non consentiti: ${forbidden.join(', ')}`, { hint: 'llmpod gestisce da solo chiave, host, porta e nome servito' });
  }
  if (unknown.length) warnings.push(`Flag non riconosciuti da vLLM ${'v0.30.0'}: ${unknown.join(', ')}`);

  const est = estimate({ weightsBytes: wBytes, kvPerToken, context: ctx, concurrency, tp, kvShards: kvShardsFor(config, tp), extraGiB });
  return refreshGpuWarnings(syncDerivedFields({
    model: { id, revision: sha, requestedRevision: revision, gated: summary.gated, license: summary.license, params: summary.params, weightsBytes: wBytes, maxContext: maxCtx ?? null, quantization: quantizationOf(config) },
    context: ctx,
    concurrency,
    vllm: { image: vllmImage, args },
    parsers: { tool: parsers.tool, reasoning: parsers.reasoning },
    mtp: { present: mtpPresent, enabled: false, draft }, // enabled lo deriva syncDerivedFields dagli argomenti
    // kvDtype: base della stima (fp8 solo se il ripiego ha dimezzato la KV), indipendente dagli override successivi
    estimate: { weightsGiB: est.weightsGiB, downloadBytes: downloadBytes(tree), kvGiB: est.kvGiB, perGpuGiB: est.perGpuGiB, extraGiB: est.extraGiB, kvDtype: kvCacheDtype === 'fp8' ? 'fp8' : 'auto' },
    gpu: sel.choice ? { id: sel.choice.gpuId, count: sel.choice.count } : null,
    hourlyUSD: sel.choice?.hourly ?? null,
    alternatives: sel.alternatives.map((c) => ({ id: c.gpuId, count: c.count, hourly: c.hourly })),
    options: sel.all.map(optionOf),
    elsewhere: sel.elsewhere,
    candidates: sel.all.slice(0, 10),
    dataCenterId,
    cloud,
    kvCacheDtype,
    warnings,
    ncclSafe: ncclSafe !== false, // false (--no-nccl-safe): niente NCCL_P2P_DISABLE sui Pod multi-GPU senza NVLink
  }));
}
