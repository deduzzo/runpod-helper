import { LlmpodError, Codes } from '../errors.js';
import { parseModelRef, summarizeModel } from '../hf.js';
import { weightsBytes, kvBytesPerToken, estimate, tpSizes } from './vram.js';
import { detectParsers, buildArgs, applyOverrides, validateArgs } from './vllm-args.js';
import { selectGpus } from './gpu-select.js';

const SHA_RE = /^[0-9a-f]{40}$/;

export async function makePlan({
  hf, runpod, modelRef, context = 65536, concurrency = 2, cloud = 'SECURE', dataCenterId,
  minCudaVersion, vllmImage, set = [], extra = [], flags, allowTrustRemoteCode = false, onProgress = () => {},
}) {
  const { id, revision } = parseModelRef(modelRef);
  const warnings = [];

  onProgress(`Lettura di ${id} da Hugging Face`);
  const info = await hf.getModel(id);
  const sha = SHA_RE.test(revision) ? revision : await hf.resolveSha(id, revision);
  const [tree, config] = await Promise.all([hf.listFiles(id, sha), hf.getConfig(id, sha)]);
  const summary = summarizeModel(info);

  const wBytes = weightsBytes(tree);
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
    const needs = (tp) => estimate({ weightsBytes: wBytes, kvPerToken, context: ctx, concurrency, tp }).perGpuGiB;
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

  const est = estimate({ weightsBytes: wBytes, kvPerToken, context: ctx, concurrency, tp });
  return {
    model: { id, revision: sha, requestedRevision: revision, gated: summary.gated, license: summary.license, params: summary.params, weightsBytes: wBytes, maxContext: maxCtx ?? null },
    context: ctx,
    concurrency,
    vllm: { image: vllmImage, args },
    parsers: { tool: parsers.tool, reasoning: parsers.reasoning },
    estimate: { weightsGiB: est.weightsGiB, kvGiB: est.kvGiB, perGpuGiB: est.perGpuGiB },
    gpu: sel.choice ? { id: sel.choice.gpuId, count: sel.choice.count } : null,
    hourlyUSD: sel.choice?.hourly ?? null,
    alternatives: sel.alternatives.map((c) => ({ id: c.gpuId, count: c.count, hourly: c.hourly })),
    elsewhere: sel.elsewhere,
    candidates: sel.all.slice(0, 10),
    dataCenterId,
    cloud,
    kvCacheDtype,
    warnings,
  };
}
