import { LlmpodError, Codes } from '../errors.js';
import { applyOverrides, validateArgs } from '../planner/vllm-args.js';

export const LOCKED = ['revision', 'tensor-parallel-size', 'max-model-len'];
// Allowlist: il consulente può proporre solo questi flag (nomi senza `--`).
export const ADVISOR_ALLOWED = [
  'tool-call-parser', 'reasoning-parser', 'enable-auto-tool-choice', 'tokenizer-mode',
  'chat-template-content-format', 'enable-prefix-caching', 'no-enable-prefix-caching',
  'enable-chunked-prefill', 'no-enable-chunked-prefill', 'max-num-seqs', 'max-num-batched-tokens',
  'kv-cache-dtype', 'gpu-memory-utilization', 'enforce-eager', 'enable-expert-parallel',
  'async-scheduling', 'default-chat-template-kwargs',
];
// Tipo del valore per ciascun flag dell'allowlist: bool (true/false), posint (intero > 0), util (0 < x <= 0.98),
// json (oggetto JSON in una stringa), str (testo semplice). `false` vale per tutti: rimuove il flag.
export const FLAG_TYPES = Object.freeze({
  'tool-call-parser': 'str', 'reasoning-parser': 'str', 'enable-auto-tool-choice': 'bool', 'tokenizer-mode': 'str',
  'chat-template-content-format': 'str', 'enable-prefix-caching': 'bool', 'no-enable-prefix-caching': 'bool',
  'enable-chunked-prefill': 'bool', 'no-enable-chunked-prefill': 'bool', 'max-num-seqs': 'posint', 'max-num-batched-tokens': 'posint',
  'kv-cache-dtype': 'str', 'gpu-memory-utilization': 'util', 'enforce-eager': 'bool', 'enable-expert-parallel': 'bool',
  'async-scheduling': 'bool', 'default-chat-template-kwargs': 'json',
});
const MEMORY_KEYS = ['kv-cache-dtype', 'gpu-memory-utilization'];

const CONTROL_RE = /[\x00-\x1f\x7f]/;
// Toglie i caratteri di controllo (ANSI, NUL, ...) da un testo di terzi; a capo e tabulazioni diventano spazi.
export const stripControl = (text) => String(text ?? '').replace(/[\t\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');

function tryObject(candidate) {
  try {
    const v = JSON.parse(candidate);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

export function parseAdvice(text) {
  const s = String(text ?? '');
  // Prima i blocchi recintati (```json, ```bash, ...): vince il primo che è un oggetto JSON valido.
  let obj = null;
  for (const m of s.matchAll(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g)) {
    obj = tryObject(m[1]);
    if (obj) break;
  }
  // Fallback: tra la prima '{' e l'ultima '}'.
  if (!obj) obj = tryObject(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  if (!obj) {
    throw new LlmpodError(Codes.ADVISOR_INVALID, 'La risposta del consulente non contiene un oggetto JSON valido');
  }
  const set = obj.set ?? {};
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new LlmpodError(Codes.ADVISOR_INVALID, 'Il campo "set" della proposta non è un oggetto');
  return {
    set,
    rationale: typeof obj.rationale === 'string' ? stripControl(obj.rationale.slice(0, 4000)) : '',
    warnings: Array.isArray(obj.warnings) ? obj.warnings.filter((w) => typeof w === 'string').slice(0, 20).map((w) => stripControl(w.slice(0, 500))) : [],
  };
}

export function argMap(args) {
  const m = new Map();
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (inline !== undefined) m.set(flag, inline);
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) m.set(flag, args[++i]);
    else m.set(flag, null);
  }
  return m;
}

export function diffArgs(before, after) {
  const a = argMap(before);
  const b = argMap(after);
  const show = (f, v) => (v === null ? f : `${f} ${v}`);
  return {
    added: [...b].filter(([f]) => !a.has(f)).map(([f, v]) => show(f, v)),
    removed: [...a].filter(([f]) => !b.has(f)).map(([f]) => f),
    changed: [...b].filter(([f, v]) => a.has(f) && a.get(f) !== v).map(([f, v]) => ({ flag: f, from: a.get(f), to: v })),
  };
}

const STR_RE = /^[A-Za-z0-9_.:/][A-Za-z0-9_.:/-]*$/; // niente '-' iniziale: verrebbe letto come flag
const bad = (why) => ({ error: `valore non valido: ${why}` });

// Controlla il valore proposto in base al tipo del flag. Restituisce { value } (stringa per applyOverrides) oppure { error }.
function checkValue(key, value) {
  if (typeof value === 'string' && CONTROL_RE.test(value)) return bad('contiene caratteri di controllo');
  if (value === false) return { value: 'false' }; // rimozione del flag
  const type = FLAG_TYPES[key];
  if (type === 'bool') {
    if (value === true || value === 'true') return { value: 'true' };
    return value === 'false' ? { value: 'false' } : bad('atteso true o false');
  }
  if (type === 'posint') {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : NaN);
    return Number.isSafeInteger(n) && n > 0 ? { value: String(n) } : bad('atteso un intero positivo');
  }
  if (type === 'util') {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^(\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : NaN);
    return Number.isFinite(n) && n > 0 && n <= 0.98 ? { value: String(n) } : bad('atteso un numero maggiore di 0 e al massimo 0,98');
  }
  if (type === 'json') {
    if (value && typeof value === 'object' && !Array.isArray(value)) value = JSON.stringify(value);
    if (typeof value !== 'string' || value.length > 300) return bad('atteso un oggetto JSON (testo di al massimo 300 caratteri)');
    try {
      const o = JSON.parse(value);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('non oggetto');
    } catch { return bad('atteso un oggetto JSON'); }
    return { value };
  }
  if (type === 'str') {
    // "true"/"false" come testo verrebbero letti da applyOverrides come flag senza valore o rimozione.
    if (value === 'true' || value === 'false') return bad('atteso un testo, non un booleano');
    return typeof value === 'string' && value.length <= 300 && STR_RE.test(value) ? { value } : bad('atteso un testo semplice (lettere, cifre, _ . : / -, al massimo 300 caratteri)');
  }
  return bad('tipo del flag sconosciuto');
}

// Controllo finale di integrità: nessun flag vietato/sconosciuto nuovo e i flag protetti invariati.
function protectedFlagsIntact(baseArgs, args, flags, allowTrustRemoteCode) {
  const before = validateArgs(baseArgs, flags, { allowTrustRemoteCode });
  const after = validateArgs(args, flags, { allowTrustRemoteCode });
  const known = new Set([...before.unknown, ...before.forbidden]);
  if ([...after.unknown, ...after.forbidden].some((f) => !known.has(f))) return false;
  const a = argMap(baseArgs);
  const b = argMap(args);
  return LOCKED.every((k) => {
    const f = `--${k}`;
    return a.has(f) === b.has(f) && a.get(f) === b.get(f);
  });
}

export function reviewAdvice({ advice, baseArgs, flags, allowTrustRemoteCode = false, fitsWith = () => true }) {
  let accepted = [];
  const rejected = [];
  const baseMap = argMap(baseArgs);
  for (const [rawKey, rawValue] of Object.entries(advice.set)) {
    const shownKey = stripControl(rawKey).slice(0, 100);
    const key = rawKey.replace(/^-+/, '').trim().toLowerCase().replace(/_/g, '-');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) { rejected.push({ key: shownKey, reason: 'nome di flag non valido' }); continue; }
    if (LOCKED.includes(key)) { rejected.push({ key: shownKey, reason: 'deciso da llmpod (bloccato)' }); continue; }
    const { unknown, forbidden } = validateArgs([`--${key}`], flags, { allowTrustRemoteCode });
    if (forbidden.length) { rejected.push({ key: shownKey, reason: 'flag vietato' }); continue; }
    if (unknown.length) { rejected.push({ key: shownKey, reason: 'flag sconosciuto a questa versione di vLLM' }); continue; }
    if (!ADVISOR_ALLOWED.includes(key)) { rejected.push({ key: shownKey, reason: 'non consentito al consulente' }); continue; }
    const checked = checkValue(key, rawValue);
    if (checked.error) { rejected.push({ key: shownKey, reason: checked.error }); continue; }
    const { value } = checked;
    // "true" su un flag che nella base ha già un valore lo cancellerebbe: rifiutato.
    if (value === 'true' && typeof baseMap.get(`--${key}`) === 'string') { rejected.push({ key: shownKey, reason: 'valore non valido: cancellerebbe il valore già impostato' }); continue; }
    accepted.push(`${key}=${value}`);
  }
  let args = applyOverrides(baseArgs, { set: accepted });
  if (!protectedFlagsIntact(baseArgs, args, flags, allowTrustRemoteCode)) {
    accepted = [];
    args = [...baseArgs];
    rejected.push({ key: '*', reason: 'la proposta altererebbe flag protetti: scartata' });
  }
  if (!fitsWith(args)) {
    const memory = accepted.filter((s) => MEMORY_KEYS.includes(s.split('=')[0]));
    for (const s of memory) rejected.push({ key: s.split('=')[0], reason: 'la memoria non basterebbe sulla GPU scelta' });
    accepted = accepted.filter((s) => !memory.includes(s));
    args = applyOverrides(baseArgs, { set: accepted });
  }
  return { args, accepted, rejected, changes: diffArgs(baseArgs, args) };
}

// Entra la configurazione `option` ({ count, memoryGiB, perGpuGiB }) con questi argomenti? La stima parte da quella del piano
// (o del profilo): pesi, stato costante, dtype di base della KV; il resto (KV, utilizzo della memoria) dipende dagli argomenti.
export function fitsForOption(plan, option) {
  const check = memoryCheck({ ...plan, context: undefined }, option);
  return (args) => check(args).fits;
}

// Memoria per GPU stimata con questi argomenti ({ neededGiB, availableGiB, fits }). Se `plan.context` è noto (contesto su cui è
// calcolata la stima), la KV si scala anche con --max-model-len (llmpod tune può cambiarlo); altrimenti solo con il dtype della KV.
export function memoryCheck(plan, option) {
  const tp = option.count;
  const perGpu = option.perGpuGiB ?? plan.estimate.perGpuGiB;
  const fixed = plan.estimate.weightsGiB / tp + 2 + (plan.estimate.extraGiB ?? 0);
  const kvPerGpu = perGpu - fixed;
  const memoryGiB = option.memoryGiB;
  return (args) => {
    const m = argMap(args);
    const isFp8 = /fp8/i.test(m.get('--kv-cache-dtype') ?? 'auto');
    const planFp8 = plan.estimate.kvDtype ? plan.estimate.kvDtype === 'fp8' : plan.kvCacheDtype === 'fp8';
    const factor = isFp8 === planFp8 ? 1 : (isFp8 ? 0.5 : 2);
    const len = Number(m.get('--max-model-len'));
    const ctxFactor = plan.context > 0 && Number.isFinite(len) && len > 0 ? len / plan.context : 1;
    const util = Number(m.get('--gpu-memory-utilization') ?? 0.9);
    const neededGiB = Math.round((fixed + kvPerGpu * factor * ctxFactor) * 10) / 10;
    const validUtil = Number.isFinite(util) && util > 0 && util <= 0.98;
    const availableGiB = validUtil ? Math.round(memoryGiB * util * 10) / 10 : 0;
    return { neededGiB, availableGiB, fits: validUtil && fixed + kvPerGpu * factor * ctxFactor <= memoryGiB * util };
  };
}

// La GPU scelta del piano si cerca tra TUTTE le opzioni (non solo nei primi `candidates`).
export function makeFitsWith(plan) {
  const same = (x) => (x.id ?? x.gpuId) === plan.gpu?.id && x.count === plan.gpu?.count;
  const c = plan.options?.find(same) ?? plan.candidates?.find(same);
  if (!c) return () => true;
  return fitsForOption(plan, { count: c.count, memoryGiB: c.memoryGiB, perGpuGiB: plan.estimate.perGpuGiB });
}

// Dopo un consiglio (o qualunque cambio degli argomenti): ricalcola per ogni opzione se entra e marca `fits:false` le altre.
export function markFits(plan) {
  for (const o of plan.options ?? []) {
    if (!o.memoryGiB || !Number.isFinite(o.perGpuGiB)) { o.fits = true; continue; }
    o.fits = fitsForOption(plan, o)(plan.vllm.args);
  }
  // Anche le alternative salvate nel profilo: senza questo `up --yes` ripiegherebbe su GPU dove il modello non entra più.
  if (Array.isArray(plan.alternatives)) {
    plan.alternatives = plan.alternatives.filter((a) => !(plan.options ?? []).some((o) => o.id === a.id && o.count === a.count && o.fits === false));
  }
  return plan;
}
