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

const SHORT_FLAG = /^-[^-\d.]/; // "-tp": forma breve, non controllabile con i nomi lunghi
const shortError = (t) => invalid(`Argomento con un solo trattino non ammesso: ${t}`, 'Usa la forma lunga, es. --tensor-parallel-size (ma il numero di GPU non si cambia con tune)');
const normalName = (name) => name.toLowerCase().replace(/_/g, '-');

// Porta ogni flag nella forma canonica di vLLM: --nome-con-trattini (minuscole, "_" → "-") e "--k=v" in due token, così
// i controlli (bloccati, valori, duplicati) vedono gli stessi nomi che vedrà argparse.
export function normalizeArgTokens(tokens) {
  const out = [];
  for (const raw of tokens) {
    const t = String(raw);
    if (SHORT_FLAG.test(t)) throw shortError(t);
    if (!t.startsWith('--')) { out.push(t); continue; }
    const i = t.indexOf('=');
    out.push(normalName(i < 0 ? t : t.slice(0, i)));
    if (i >= 0) out.push(t.slice(i + 1));
  }
  return out;
}

function normalizeSet(item) {
  const s = String(item).trim();
  if (SHORT_FLAG.test(s)) throw shortError(s);
  const i = s.indexOf('=');
  const key = normalName((i < 0 ? s : s.slice(0, i)).replace(/^-+/, '').trim());
  return i < 0 ? key : `${key}=${s.slice(i + 1)}`;
}

// Nuovi argomenti di vLLM a partire da quelli ATTIVI sul Pod. Lancia INVALID_INPUT per flag vietati, bloccati, sconosciuti
// (anche le abbreviazioni che argparse accetterebbe), duplicati, valori non validi o nessuna modifica.
export function computeTune({ currentArgs, set = [], extra = [], flags, maxContext = null }) {
  const current = normalizeArgTokens(currentArgs);
  const sets = set.map(normalizeSet);
  for (const item of sets) {
    const key = item.split('=')[0];
    if (TUNE_LOCKED.includes(key)) throw invalid(`--${key} non si può cambiare con tune`, '“llmpod tune” non cambia modello, revisione, numero di GPU né chiave, host, porta e nome servito');
  }
  const args = syncDerivedFields({ vllm: { args: applyOverrides(current, { set: sets, extra: normalizeArgTokens(extra) }) } }).vllm.args;
  const seen = new Set();
  for (const f of args.filter((a) => a.startsWith('--'))) {
    if (seen.has(f)) throw invalid(`Flag duplicato: ${f}`, `Per cambiare un argomento già presente usa --set ${f.slice(2)}=<valore>`);
    seen.add(f);
  }
  const { unknown, forbidden } = validateArgs(args, flags);
  const before = validateArgs(current, flags);
  const newForbidden = forbidden.filter((f) => !before.forbidden.includes(f));
  if (newForbidden.length) throw invalid(`Argomenti vLLM non consentiti: ${newForbidden.join(', ')}`, 'llmpod gestisce da solo chiave, host, porta e nome servito');
  const newUnknown = unknown.filter((f) => !before.unknown.includes(f));
  if (newUnknown.length) throw invalid(`Flag non riconosciuti da vLLM ${'v0.30.0'}: ${newUnknown.join(', ')}`, 'Usa il nome completo del flag (le abbreviazioni non sono ammesse); elenco in data/vllm-flags-v0.30.0.json');
  const a = argMap(current);
  const b = argMap(args);
  for (const k of TUNE_LOCKED) {
    const f = `--${k}`;
    if (a.has(f) !== b.has(f) || a.get(f) !== b.get(f)) throw invalid(`${f} non si può cambiare con tune`);
  }
  checkValues(b, maxContext);
  const changes = diffArgs(current, args);
  if (!changes.added.length && !changes.removed.length && !changes.changed.length) {
    throw invalid('Nessuna modifica rispetto agli argomenti attivi sul Pod', 'Esempio: llmpod tune <profilo> --set max-num-seqs=4');
  }
  const from = Number(a.get('--max-model-len'));
  const to = Number(b.get('--max-model-len'));
  return {
    args, changes,
    unknown: [],
    contextChange: from !== to && Number.isFinite(to) ? { from, to } : null,
  };
}
