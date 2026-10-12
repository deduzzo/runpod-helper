import { LlmpodError, Codes } from '../errors.js';
import { fmtUSD } from '../confirm.js';
import { argsForCount } from '../pod/body.js';
import { refreshNcclWarning } from './nccl.js';

const ALT_LIMIT = 4;

// GPU Blackwell (kernel FP4 nativi): B200/B300, GB200/GB300, RTX PRO 6000 Blackwell, GeForce RTX 50xx.
export const isBlackwell = (gpuId) => /\bG?B[23]00\b|blackwell|rtx 50\d0|rtx pro 6000/i.test(String(gpuId ?? ''));
const NVFP4_WARNING = 'NVFP4:';
// Avviso NVFP4 sulla GPU scelta (rigenerato a ogni cambio di GPU): fuori da Blackwell vLLM usa kernel di ripiego più lenti.
export function refreshNvfp4Warning(plan) {
  if (!Array.isArray(plan.warnings)) return plan;
  plan.warnings = plan.warnings.filter((w) => !w.startsWith(NVFP4_WARNING));
  if (plan.model?.quantization === 'nvfp4' && plan.gpu && !isBlackwell(plan.gpu.id)) {
    plan.warnings.push(`${NVFP4_WARNING} ${plan.gpu.id} non è una GPU Blackwell: vLLM usa kernel FP4 di ripiego, più lenti; per le prestazioni piene scegli B200/B300 o RTX PRO 6000/RTX 5090`);
  }
  return plan;
}

// Avvisi che dipendono dalla GPU scelta: si rigenerano a ogni cambio di GPU.
export const refreshGpuWarnings = (plan) => refreshNcclWarning(refreshNvfp4Warning(plan));

// Voce dell'elenco `plan.options` a partire da un candidato di selectGpus.
export function optionOf(c) {
  const elsewhere = c.elsewhere ?? [];
  const availableHere = c.availabilityHere !== 'NONE';
  return {
    id: c.gpuId, name: c.name, count: c.count, memoryGiB: c.memoryGiB, perGpuGiB: c.perGpuGiB, headroomGiB: c.headroomGiB, hourly: c.hourly,
    availabilityHere: c.availabilityHere, elsewhere, availableHere, available: availableHere || elsewhere.length > 0,
  };
}

// "<id>" oppure "<id>x<numero>" (anche con il segno ×).
export function parseGpuSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s) throw new LlmpodError(Codes.INVALID_INPUT, 'Indica la GPU da usare: --gpu <id>[x<numero>]');
  const m = s.match(/^(.+?)\s*[x×]\s*(\d+)$/);
  return m ? { id: m[1].trim(), count: Number(m[2]) } : { id: s, count: null };
}

const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const spec = (o) => `${o.id}${o.count > 1 ? `x${o.count}` : ''}`;
// Selezionabile: disponibile ora (qui o altrove) e, dopo un consiglio, ancora in grado di contenere il modello.
export const isUsable = (o) => o.available && o.fits !== false;
export const vramLabel = (o) => `${o.count > 1 ? `${o.count}×` : ''}${o.memoryGiB} GB`;
const availableList = (options) => `Opzioni disponibili: ${options.filter(isUsable).map(spec).join(', ') || 'nessuna'}`;

export function findOption(plan, { id, count = null }) {
  const options = plan.options ?? [];
  if (!options.length) throw new LlmpodError(Codes.INVALID_INPUT, 'Il piano non contiene opzioni GPU tra cui scegliere', { hint: 'Ricalcola il piano con: llmpod plan <modello>' });
  const found = options.filter((o) => (sameId(o.id, id) || sameId(o.name, id)) && (count == null || o.count === count));
  if (!found.length) {
    throw new LlmpodError(Codes.INVALID_INPUT, `${id}${count != null ? ` ×${count}` : ''} non è tra le opzioni del piano`, { hint: availableList(options) });
  }
  const usable = found.filter(isUsable);
  if (!usable.length) {
    if (found.some((o) => o.available)) {
      throw new LlmpodError(Codes.INVALID_INPUT, `${found[0].name} ×${found[0].count} non entra in memoria con gli argomenti attuali del piano`, { hint: availableList(options) });
    }
    throw new LlmpodError(Codes.NO_GPU_AVAILABLE, `${found[0].name} ×${found[0].count} non disponibile ora in nessun datacenter`, { hint: availableList(options) });
  }
  // Le opzioni sono ordinate per costo: senza numero vale la prima disponibile, preferendo il datacenter del volume.
  return usable.find((o) => o.availableHere) ?? usable[0];
}

// Applica la scelta dell'utente al piano (in posto): GPU, costo, numero di GPU negli argomenti di vLLM e ordine delle alternative.
// Se la scelta non è valida lancia prima di toccare il piano.
export function applyGpuChoice(plan, wanted) {
  const choice = findOption(plan, wanted);
  const same = (o) => o.id === choice.id && o.count === choice.count;
  plan.gpu = { id: choice.id, count: choice.count };
  plan.hourlyUSD = choice.hourly;
  plan.alternatives = plan.options.filter((o) => o.availableHere && o.fits !== false && !same(o)).slice(0, ALT_LIMIT).map((o) => ({ id: o.id, count: o.count, hourly: o.hourly }));
  if (plan.vllm?.args) plan.vllm.args = argsForCount(plan.vllm.args, choice.count);
  if (plan.estimate) plan.estimate.perGpuGiB = choice.perGpuGiB;
  if (Array.isArray(plan.warnings)) plan.warnings = plan.warnings.filter((w) => !w.startsWith('NO_GPU_AVAILABLE'));
  return refreshGpuWarnings(plan);
}

export function optionLabel(o, dataCenterId) {
  let where;
  if (o.availableHere) where = `${o.availabilityHere} in ${dataCenterId}`;
  else if (o.elsewhere?.length) where = `solo altrove (${o.elsewhere.map((d) => d.id).join(', ')})`;
  else where = 'non disponibile ora';
  return `${o.name} ×${o.count} · ${vramLabel(o)} · ${fmtUSD(o.hourly)}/h · ${where}`;
}
