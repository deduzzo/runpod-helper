import { detectParsers } from './planner/vllm-args.js';
import { bytesFromSafetensorsParams, GiB } from './planner/vram.js';

// A parità di modello base (model card) le varianti con MTP vengono prima; i gruppi restano nella posizione del primo membro.
function mtpFirst(rows) {
  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const key = row.baseModel ?? `\0${row.id}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(row);
  }
  return order.flatMap((key) => {
    const g = groups.get(key);
    return [...g.filter((r) => r.mtp === true), ...g.filter((r) => r.mtp !== true)];
  });
}

export async function searchRows(hf, query, { limit = 20, all = false } = {}) {
  // I modelli MLX e i repository solo-GGUF non girano su vLLM: esclusi salvo --all.
  const models = (await hf.searchModels(query, { limit })).filter((m) => all || (m.hasChatTemplate && !m.isMlx && !m.ggufOnly));
  const rows = models.map((m) => {
    const known = m.architectures.length || m.modelType;
    const p = known ? detectParsers({ modelId: m.id, config: { architectures: m.architectures, model_type: m.modelType } }) : { tool: null };
    const bytes = bytesFromSafetensorsParams(m.paramsByDtype, { bits: m.quantBits });
    // Mantiene tutti i campi del modello (compatibilità con "search --json") e aggiunge parser, pesi e MTP (true/null: dai soli metadati).
    return { ...m, weightsGiB: bytes ? bytes / GiB : null, parser: p.tool ?? null, mtp: m.mtp ?? null };
  });
  return mtpFirst(rows);
}
