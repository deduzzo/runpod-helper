import fs from 'node:fs';

export const VLLM_VERSION = 'v0.30.0';
// Decodifica speculativa con il draft head MTP del modello (recipe vLLM per Qwen3.5); valore JSON, un solo argomento.
export const MTP_SPEC = '{"method":"mtp","num_speculative_tokens":1}';
// Draft DSpark nei pesi (config con chiavi dspark_*) senza indicazione della regola: valore della recipe vLLM DeepSeek-V4-Flash (0731).
export const DSPARK_SPEC = '{"method":"dspark","num_speculative_tokens":7,"draft_sample_method":"probabilistic"}';
const dataFile = (name) => new URL(`../../../data/${name}`, import.meta.url);
const RULES = JSON.parse(fs.readFileSync(dataFile('parsers.json'), 'utf8')).rules;
const ALWAYS_FORBIDDEN = ['--api-key', '--host', '--port', '--allowed-local-media-path', '--served-model-name', '--config'];

function matches(rule, modelId, config) {
  if (rule.modelType && ![rule.modelType].flat().includes(config.model_type)) return false;
  if (rule.architectures && !(config.architectures ?? []).some((a) => rule.architectures.includes(a))) return false;
  if (rule.idPattern && !new RegExp(rule.idPattern, 'i').test(modelId)) return false;
  return true;
}

export function detectParsers({ modelId, config }) {
  const c = { ...(config.text_config ?? {}), ...config };
  const rule = RULES.find((r) => matches(r, modelId, c));
  if (!rule) {
    return {
      tool: null, reasoning: null, extraArgs: [], dspark: null,
      warnings: [`UNKNOWN_TOOL_PARSER: nessun tool-call parser noto per ${modelId} (${(c.architectures ?? []).join(', ') || c.model_type}); usa --set tool-call-parser=<nome>`],
    };
  }
  return {
    tool: rule.tool ?? null,
    reasoning: rule.reasoning ?? null,
    extraArgs: rule.extraArgs ?? [],
    // --speculative-config della recipe quando il draft nei pesi è DSpark (DeepSeek-V4/V4.1); null = DSPARK_SPEC.
    dspark: rule.dspark ?? null,
    warnings: rule.warning ? [rule.warning] : [],
  };
}

export function buildArgs({ context, tp, revision, parsers, gpuUtil = 0.9, kvCacheDtype, speculative = null }) {
  const args = [
    '--max-model-len', String(context),
    '--tensor-parallel-size', String(tp),
    '--gpu-memory-utilization', String(gpuUtil),
    '--revision', revision,
  ];
  if (parsers.tool) args.push('--enable-auto-tool-choice', '--tool-call-parser', parsers.tool);
  if (parsers.reasoning) args.push('--reasoning-parser', parsers.reasoning);
  if (kvCacheDtype) args.push('--kv-cache-dtype', kvCacheDtype);
  if (speculative) args.push('--speculative-config', speculative);
  args.push(...(parsers.extraArgs ?? []));
  return args;
}

function removeFlag(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    if (args[i].startsWith(`${flag}=`)) continue;
    out.push(args[i]);
  }
  return out;
}

export function applyOverrides(args, { set = [], extra = [] } = {}) {
  let out = [...args];
  for (const item of set) {
    const i = item.indexOf('=');
    const key = i < 0 ? item : item.slice(0, i);
    const value = i < 0 ? 'true' : item.slice(i + 1);
    const flag = `--${key.replace(/^--/, '')}`;
    const pos = out.indexOf(flag);
    if (value === 'false') { out = removeFlag(out, flag); continue; }
    if (pos >= 0) {
      const hasValue = out[pos + 1] !== undefined && !out[pos + 1].startsWith('--');
      if (value === 'true') { if (hasValue) out.splice(pos + 1, 1); }
      else if (hasValue) out[pos + 1] = value;
      else out.splice(pos + 1, 0, value);
    } else {
      out.push(flag);
      if (value !== 'true') out.push(value);
    }
  }
  return [...out, ...extra];
}

export function loadFlags(version = VLLM_VERSION) {
  return new Set(JSON.parse(fs.readFileSync(dataFile(`vllm-flags-${version}.json`), 'utf8')));
}

// argparse accetta '_' al posto di '-', maiuscole non normalizzate dal nostro controllo e prefissi
// univoci (--por → --port): il confronto avviene sul nome normalizzato e sui prefissi dei nomi vietati.
const normalizeFlag = (token) => token.split('=')[0].toLowerCase().replaceAll('_', '-');

function isForbidden(name, forbiddenNames) {
  return forbiddenNames.some((f) => name === f || (name.length >= 5 && f.startsWith(name)));
}

export function validateArgs(args, flags, { allowTrustRemoteCode = false } = {}) {
  const unknown = [];
  const forbidden = [];
  const forbiddenNames = allowTrustRemoteCode ? ALWAYS_FORBIDDEN : [...ALWAYS_FORBIDDEN, '--trust-remote-code'];
  for (const token of args) {
    if (!token.startsWith('--')) continue;
    const flag = token.split('=')[0];
    const name = normalizeFlag(token);
    if (isForbidden(name, forbiddenNames)) forbidden.push(flag);
    else if (!flags.has(name)) unknown.push(flag);
  }
  return { unknown, forbidden };
}
