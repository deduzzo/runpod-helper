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
const MEMORY_KEYS = ['kv-cache-dtype', 'gpu-memory-utilization'];

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
    rationale: typeof obj.rationale === 'string' ? obj.rationale.slice(0, 4000) : '',
    warnings: Array.isArray(obj.warnings) ? obj.warnings.filter((w) => typeof w === 'string').slice(0, 20).map((w) => w.slice(0, 500)) : [],
  };
}

function argMap(args) {
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

function checkValue(value) {
  if (value === true || value === false) return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  // Una stringa che inizia con '-' verrebbe letta come flag (contrabbando): ammessi solo i numeri negativi.
  if (typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\r\n]/.test(value)
    && (!value.startsWith('-') || /^-\d+(\.\d+)?$/.test(value))) return value;
  return null;
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
    const key = rawKey.replace(/^-+/, '').trim().toLowerCase().replace(/_/g, '-');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) { rejected.push({ key: rawKey, reason: 'nome di flag non valido' }); continue; }
    if (LOCKED.includes(key)) { rejected.push({ key: rawKey, reason: 'deciso da llmpod (bloccato)' }); continue; }
    const { unknown, forbidden } = validateArgs([`--${key}`], flags, { allowTrustRemoteCode });
    if (forbidden.length) { rejected.push({ key: rawKey, reason: 'flag vietato' }); continue; }
    if (unknown.length) { rejected.push({ key: rawKey, reason: 'flag sconosciuto a questa versione di vLLM' }); continue; }
    if (!ADVISOR_ALLOWED.includes(key)) { rejected.push({ key: rawKey, reason: 'non consentito al consulente' }); continue; }
    const value = checkValue(rawValue);
    if (value === null) { rejected.push({ key: rawKey, reason: 'valore non valido' }); continue; }
    // "true" su un flag che nella base ha già un valore lo cancellerebbe: rifiutato.
    if (value === 'true' && typeof baseMap.get(`--${key}`) === 'string') { rejected.push({ key: rawKey, reason: 'valore non valido' }); continue; }
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

export function makeFitsWith(plan) {
  const c = plan.candidates?.find((x) => x.gpuId === plan.gpu?.id && x.count === plan.gpu?.count);
  if (!c) return () => true;
  const tp = plan.gpu.count;
  const fixed = plan.estimate.weightsGiB / tp + 2;
  const kvPerGpu = plan.estimate.perGpuGiB - fixed;
  return (args) => {
    const m = argMap(args);
    const isFp8 = /fp8/i.test(m.get('--kv-cache-dtype') ?? 'auto');
    const planFp8 = plan.estimate.kvDtype ? plan.estimate.kvDtype === 'fp8' : plan.kvCacheDtype === 'fp8';
    const factor = isFp8 === planFp8 ? 1 : (isFp8 ? 0.5 : 2);
    const util = Number(m.get('--gpu-memory-utilization') ?? 0.9);
    return Number.isFinite(util) && util > 0 && util <= 0.98 && fixed + kvPerGpu * factor <= c.memoryGiB * util;
  };
}
