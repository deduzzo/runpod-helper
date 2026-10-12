import { LlmpodError, Codes } from './errors.js';
import { applyOverrides, validateArgs } from './planner/vllm-args.js';
import { syncDerivedFields } from './planner/plan.js';
import { argMap, diffArgs } from './advisor/advice.js';

// Flag che "llmpod tune" non cambia mai sul Pod avviato: identità del modello e del servizio (revisione, nome servito,
// chiave, host, porta) e il numero di GPU del Pod (tensor-parallel-size). max-model-len invece si può cambiare (è bloccato
// solo per il consulente esterno).
export const TUNE_LOCKED = ['revision', 'tensor-parallel-size', 'served-model-name', 'api-key', 'host', 'port'];

const invalid = (message, hint) => new LlmpodError(Codes.INVALID_INPUT, message, hint ? { hint } : undefined);

function checkValues(m, maxContext) {
  const len = m.get('--max-model-len');
  if (len !== undefined) {
    const n = /^\d+$/.test(len ?? '') ? Number(len) : NaN;
    if (!Number.isSafeInteger(n) || n < 1024) throw invalid(`--max-model-len deve essere un intero di almeno 1024 token (ricevuto "${len}")`);
    if (maxContext && n > maxContext) throw invalid(`--max-model-len ${n} supera il contesto massimo del modello (${maxContext})`);
  }
  const util = m.get('--gpu-memory-utilization');
  if (util !== undefined) {
    const n = /^(\d+\.?\d*|\.\d+)$/.test(util ?? '') ? Number(util) : NaN;
    if (!(n > 0 && n <= 0.98)) throw invalid(`--gpu-memory-utilization deve essere maggiore di 0 e al massimo 0,98 (ricevuto "${util}")`);
  }
  for (const flag of ['--max-num-seqs', '--max-num-batched-tokens']) {
    const v = m.get(flag);
    if (v !== undefined && !/^[1-9]\d{0,9}$/.test(v ?? '')) throw invalid(`${flag} deve essere un intero positivo (ricevuto "${v}")`);
  }
}

// Nuovi argomenti di vLLM a partire da quelli ATTIVI sul Pod. Lancia INVALID_INPUT per flag vietati o bloccati, valori non
// validi o nessuna modifica. `unknown`: flag non presenti nell'elenco di questa versione di vLLM (avviso, come in plan).
export function computeTune({ currentArgs, set = [], extra = [], flags, maxContext = null }) {
  for (const item of set) {
    const key = String(item).split('=')[0].replace(/^-+/, '').trim().toLowerCase().replace(/_/g, '-');
    if (TUNE_LOCKED.includes(key)) throw invalid(`--${key} non si può cambiare con tune`, '“llmpod tune” non cambia modello, revisione, numero di GPU né chiave, host, porta e nome servito');
  }
  const args = syncDerivedFields({ vllm: { args: applyOverrides(currentArgs, { set, extra }) } }).vllm.args;
  const { unknown, forbidden } = validateArgs(args, flags);
  const before = validateArgs(currentArgs, flags);
  const newForbidden = forbidden.filter((f) => !before.forbidden.includes(f));
  if (newForbidden.length) throw invalid(`Argomenti vLLM non consentiti: ${newForbidden.join(', ')}`, 'llmpod gestisce da solo chiave, host, porta e nome servito');
  const a = argMap(currentArgs);
  const b = argMap(args);
  for (const k of TUNE_LOCKED) {
    const f = `--${k}`;
    if (a.has(f) !== b.has(f) || a.get(f) !== b.get(f)) throw invalid(`${f} non si può cambiare con tune`);
  }
  checkValues(b, maxContext);
  const changes = diffArgs(currentArgs, args);
  if (!changes.added.length && !changes.removed.length && !changes.changed.length) {
    throw invalid('Nessuna modifica rispetto agli argomenti attivi sul Pod', 'Esempio: llmpod tune <profilo> --set max-num-seqs=4');
  }
  const from = Number(a.get('--max-model-len'));
  const to = Number(b.get('--max-model-len'));
  return {
    args, changes,
    unknown: unknown.filter((f) => !before.unknown.includes(f)),
    contextChange: from !== to && Number.isFinite(to) ? { from, to } : null,
  };
}
