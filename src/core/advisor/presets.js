import { LlmpodError, Codes } from '../errors.js';

export const ZAI_NOTICE = 'Le condizioni del GLM Coding Plan di Z.ai limitano l\'uso della quota agli strumenti supportati; la responsabilità dell\'uso da llmpod è tua.';

export const PRESETS = Object.freeze({
  'zai-coding-plan': { label: 'Z.ai GLM Coding Plan (endpoint Anthropic)', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3', auth: 'bearer' },
  zai: { label: 'Z.ai API a consumo', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', auth: 'bearer' },
  anthropic: { label: 'Anthropic API', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', auth: 'x-api-key' },
  openai: { label: 'OpenAI API', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: null, auth: 'bearer' },
  custom: { label: 'Endpoint personalizzato (compatibile Anthropic o OpenAI)', protocol: null, baseUrl: null, model: null, auth: 'bearer' },
  'claude-cli': { label: 'Claude Code locale (claude -p)', protocol: 'claude-cli' },
  pod: { label: 'Modello del Pod (solo correzioni dopo up)', protocol: 'openai' },
});

export const CLAUDE_CLI_IN_DOCKER = 'Il preset claude-cli non funziona nel container: usa un altro preset o la CLI senza Docker';

// Preset proponibili: dentro Docker "claude" non esiste nel container, quindi claude-cli non è offerto.
export function availablePresets(env = {}) {
  return Object.fromEntries(Object.entries(PRESETS).filter(([id]) => !(id === 'claude-cli' && env.LLMPOD_IN_DOCKER === '1')));
}

const SAFE_URL = /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

export function resolveAdvisorConfig(env, { endpoint } = {}) {
  const preset = env.LLMPOD_ADVISOR_PRESET;
  if (!preset) return null;
  const p = PRESETS[preset];
  if (!p) throw new LlmpodError(Codes.INVALID_INPUT, `Preset del consulente sconosciuto: "${preset}"`, { hint: `Preset: ${Object.keys(PRESETS).join(', ')}` });
  if (preset === 'claude-cli') return { preset, protocol: 'claude-cli', timeoutMs: 180000 };
  if (preset === 'pod') {
    if (!endpoint) return { preset, protocol: 'openai', podOnly: true };
    return { preset, protocol: 'openai', baseUrl: `${endpoint.baseUrl}/v1`, model: endpoint.servedName, apiKey: endpoint.apiKey, auth: 'bearer', timeoutMs: 90000, podOnly: true };
  }
  const cfg = {
    preset,
    protocol: env.LLMPOD_ADVISOR_PROTOCOL || p.protocol,
    baseUrl: (env.LLMPOD_ADVISOR_BASE_URL || p.baseUrl || '').replace(/\/+$/, ''),
    model: env.LLMPOD_ADVISOR_MODEL || p.model,
    apiKey: env.LLMPOD_ADVISOR_API_KEY,
    auth: env.LLMPOD_ADVISOR_AUTH || p.auth,
    timeoutMs: 120000,
  };
  const missing = [];
  if (!['anthropic', 'openai'].includes(cfg.protocol)) missing.push('LLMPOD_ADVISOR_PROTOCOL');
  if (!cfg.baseUrl) missing.push('LLMPOD_ADVISOR_BASE_URL');
  if (!cfg.model) missing.push('LLMPOD_ADVISOR_MODEL');
  if (!cfg.apiKey) missing.push('LLMPOD_ADVISOR_API_KEY');
  if (!['bearer', 'x-api-key'].includes(cfg.auth)) missing.push('LLMPOD_ADVISOR_AUTH');
  if (missing.length) {
    throw new LlmpodError(Codes.ADVISOR_NOT_CONFIGURED, `Consulente "${preset}" incompleto: mancano o non sono validi ${missing.join(', ')}`, { hint: 'Esegui: llmpod advisor' });
  }
  if (!SAFE_URL.test(cfg.baseUrl)) {
    throw new LlmpodError(Codes.INVALID_INPUT, `URL del consulente non consentito: ${cfg.baseUrl}`, { hint: 'Usa https:// (oppure http:// solo verso localhost)' });
  }
  return cfg;
}
