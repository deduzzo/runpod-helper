import { detectParsers } from './planner/vllm-args.js';
import { bytesFromSafetensorsParams, GiB } from './planner/vram.js';

export async function searchRows(hf, query, { limit = 20, all = false } = {}) {
  // I modelli MLX non girano su vLLM: esclusi salvo --all.
  const models = (await hf.searchModels(query, { limit })).filter((m) => all || (m.hasChatTemplate && !m.isMlx));
  return models.map((m) => {
    const known = m.architectures.length || m.modelType;
    const p = known ? detectParsers({ modelId: m.id, config: { architectures: m.architectures, model_type: m.modelType } }) : { tool: null };
    const bytes = bytesFromSafetensorsParams(m.paramsByDtype, { bits: m.quantBits });
    // Mantiene tutti i campi del modello (compatibilità con "search --json") e aggiunge parser e pesi.
    return { ...m, weightsGiB: bytes ? bytes / GiB : null, parser: p.tool ?? null };
  });
}
