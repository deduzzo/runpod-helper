import { spawn as nodeSpawn } from 'node:child_process';
import { LlmpodError, Codes } from '../errors.js';
import { httpError } from '../http.js';
import { redact } from '../secrets.js';
import { CLAUDE_CLI_IN_DOCKER } from './presets.js';

const authHeaders = (cfg) => (cfg.auth === 'x-api-key' ? { 'x-api-key': cfg.apiKey } : { authorization: `Bearer ${cfg.apiKey}` });

async function post(http, url, headers, json, timeoutMs) {
  let r;
  try {
    r = await http.request('POST', url, { headers, json, timeoutMs });
  } catch (err) {
    throw new LlmpodError(Codes.ADVISOR_FAILED, `Consulente non raggiungibile: ${redact(err.message)}`);
  }
  if (!r.ok) {
    throw new LlmpodError(Codes.ADVISOR_FAILED, httpError(r, 'Consulente').message, {
      hint: r.status === 401 || r.status === 403 ? 'Verifica la chiave e il modello del consulente con: llmpod advisor' : undefined,
    });
  }
  return r.data;
}

const truncated = () => new LlmpodError(Codes.ADVISOR_FAILED, 'La risposta del consulente è stata troncata per il limite di token', { hint: 'Riprova; se si ripete, scegli un modello più conciso con: llmpod advisor' });
const refused = () => new LlmpodError(Codes.ADVISOR_FAILED, 'Il consulente ha rifiutato la richiesta', { hint: 'Riprova o scegli un altro modello/preset con: llmpod advisor' });

function requireText(text) {
  if (!text || !String(text).trim()) throw new LlmpodError(Codes.ADVISOR_FAILED, 'Il consulente ha restituito una risposta vuota');
  return { text: String(text) };
}

function anthropicProvider(cfg, http) {
  return {
    label: `${cfg.preset} (${cfg.model})`,
    async complete({ system, user, maxTokens = 2000 }) {
      const d = await post(http, `${cfg.baseUrl}/v1/messages`, { ...authHeaders(cfg), 'anthropic-version': '2023-06-01' },
        { model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }, cfg.timeoutMs);
      if (d?.stop_reason === 'max_tokens') throw truncated();
      if (d?.stop_reason === 'refusal') throw refused();
      return requireText((d?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    },
  };
}

function openaiProvider(cfg, http) {
  return {
    label: `${cfg.preset} (${cfg.model})`,
    async complete({ system, user, maxTokens = 2000 }) {
      const d = await post(http, `${cfg.baseUrl}/chat/completions`, authHeaders(cfg),
        { model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, cfg.timeoutMs);
      const choice = d?.choices?.[0];
      if (choice?.finish_reason === 'length') throw truncated();
      if (choice?.message?.refusal) throw refused();
      return requireText(choice?.message?.content);
    },
  };
}

function claudeCliProvider(cfg, spawn) {
  return {
    label: 'claude -p',
    complete: ({ system, user }) => new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--system-prompt', system], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill?.('SIGKILL'), cfg.timeoutMs ?? 180000);
      timer.unref?.();
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e.code === 'ENOENT'
          ? new LlmpodError(Codes.ADVISOR_NOT_CONFIGURED, 'Comando "claude" non trovato', { hint: 'Installa Claude Code o scegli un altro preset con: llmpod advisor' })
          : new LlmpodError(Codes.ADVISOR_FAILED, redact(e.message)));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new LlmpodError(Codes.ADVISOR_FAILED, redact(`claude -p è uscito con codice ${code}: ${err.slice(0, 300)}`)));
        let j;
        try { j = JSON.parse(out); } catch { return reject(new LlmpodError(Codes.ADVISOR_FAILED, 'claude -p non ha restituito JSON')); }
        if (j.is_error) return reject(new LlmpodError(Codes.ADVISOR_FAILED, redact(`claude -p ha segnalato un errore: ${String(j.result ?? '').slice(0, 300)}`)));
        try { resolve(requireText(j.result)); } catch (e) { reject(e); }
      });
      child.stdin.end(user);
    }),
  };
}

export function createProvider(cfg, { http, spawn = nodeSpawn, env = process.env } = {}) {
  if (cfg.protocol === 'claude-cli') {
    if (env.LLMPOD_IN_DOCKER === '1') throw new LlmpodError(Codes.INVALID_INPUT, CLAUDE_CLI_IN_DOCKER);
    return claudeCliProvider(cfg, spawn);
  }
  if (cfg.protocol === 'anthropic') return anthropicProvider(cfg, http);
  if (cfg.protocol === 'openai') return openaiProvider(cfg, http);
  throw new LlmpodError(Codes.ADVISOR_NOT_CONFIGURED, `Protocollo del consulente non supportato: ${cfg.protocol}`);
}
