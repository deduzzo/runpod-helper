// Mondo finto per i test di metrics/logs/tune/up_preview e del server MCP: store su disco temporaneo, Runpod finto,
// supervisore e vLLM finti (stessa forma delle risposte reali). Nessuna rete.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createStore } from '../../src/core/config.js';
import { clearSecrets } from '../../src/core/secrets.js';
import { metricsText } from './vllm-metrics.js';

export const KEY = 'CHIAVE-PROFILO-FINTA-ABCDEFG-123';
export const RUNPOD_KEY = 'rpa_SEGRETO_RUNPOD_FINTO_123456';
export const HF_TOKEN = 'hf_SEGRETO_HF_FINTO_1234567';
export const ACTIVE_ARGS = ['--max-model-len', '65536', '--tensor-parallel-size', '1', '--gpu-memory-utilization', '0.9', '--revision', 'a'.repeat(40), '--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_coder', '--speculative-config', '{"method":"mtp","num_speculative_tokens":2}'];

const option = (id, memoryGiB, hourly, availabilityHere = 'HIGH') => ({
  id, name: id, count: 1, memoryGiB, perGpuGiB: 62, headroomGiB: memoryGiB * 0.9 - 62, hourly,
  availabilityHere, elsewhere: [], availableHere: availabilityHere !== 'NONE', available: availabilityHere !== 'NONE',
});

export const PROFILE = {
  name: 'p', servedName: 'p', cloud: 'SECURE', dataCenterId: 'EU-A', context: 65536, concurrency: 2,
  model: { id: 'org/modello-mtp', revision: 'a'.repeat(40), gated: false, weightsBytes: 40 * 1024 ** 3, maxContext: 262144 },
  vllm: { image: 'vllm/vllm-openai:v0.30.0', args: [...ACTIVE_ARGS] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, mtp: { present: true, enabled: true, tokens: 2 },
  gpu: { id: 'GPU80', count: 1 }, alternatives: [],
  options: [option('GPU80', 80, 1.5), option('GPU96', 96, 2.5, 'LOW'), option('GPU141', 141, 3.9, 'NONE')],
  volume: null, allowFallbackWithoutVolume: 'never', watchdog: { idleMinutes: 30, maxHours: 8 },
  estimate: { weightsGiB: 40, kvGiB: 20, perGpuGiB: 62, extraGiB: 0, kvDtype: 'auto', hourlyUSD: 1.5 },
};

const gpu = (id, memory, price, dcs) => ({ id, displayName: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: dcs.map(([d, a]) => ({ id: d, availability: a })) });
export const CATALOG = [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU96', 96, 2.5, [['EU-A', 'LOW']]), gpu('GPU141', 141, 3.9, [['EU-A', 'NONE']])];

// pods: Pod di Runpod; onReload(args, n) → 'ready' | 'error' (esito dell'n-esimo reload); smoke: esiti degli smoke test in ordine.
export function createWorld({
  pods = [{ id: 'pod1', name: 'llmpod-p', status: 'RUNNING', cost: 1.5, gpu: { id: 'GPU80', count: 1 } }],
  profile = PROFILE, catalog = CATALOG, balance = 50, metrics = [metricsText(), metricsText({ gen: 1500, prompt: 3000, drafts: 200, draftTokens: 400, accepted: 250, pos: [170, 80] })],
  phase = 'ready', onReload = () => 'ready', reloadStatus = 202, smoke = [], logLines = null, config = {},
  beforeStatus = null, // async () => {}: per simulare una chiamata HTTP lenta a /status
} = {}) {
  clearSecrets();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-world-'));
  const dir = path.join(root, 'cfg');
  const store = createStore({ dir, platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-A', ...config });
  store.writeEnv({ RUNPOD_API_KEY: RUNPOD_KEY, HF_TOKEN, LLMPOD_KEY_P: KEY });
  if (profile) store.writeProfile(structuredClone(profile));
  const list = pods.map((p) => ({ ...p }));
  const runpod = {
    listPods: vi.fn(async () => list.filter((p) => p.status !== 'TERMINATED')),
    getPod: vi.fn(async (id) => list.find((p) => p.id === id) ?? null),
    getBalance: vi.fn(async () => ({ balance, spendPerHour: 0 })),
    listGpus: vi.fn(async ({ count }) => (count === 1 ? catalog : [])),
    createPod: vi.fn(async (body) => {
      const pod = { id: `pod${list.length + 1}`, name: body.name, status: 'RUNNING', cost: 1.5, gpu: { id: body.gpu.id, count: body.gpu.count } };
      list.push(pod);
      return { status: 201, data: pod };
    }),
    deletePod: vi.fn(async (id) => { const p = list.find((x) => x.id === id); if (p) p.status = 'TERMINATED'; }),
  };
  const sv = { phase, args: [...ACTIVE_ARGS], reloads: 0, pending: null };
  const lines = logLines ?? [{ n: 1, line: 'INFO avvio' }, { n: 2, line: `chiave ${KEY} nei log` }, { n: 3, line: 'INFO pronto' }];
  const smokeQueue = [...smoke];
  const metricQueue = [...metrics];
  const http = {
    request: vi.fn(async (method, url, opts = {}) => {
      const u = new URL(url);
      const sup = u.host.endsWith('-8001.proxy.runpod.net');
      if (sup && opts.headers?.authorization !== `Bearer ${KEY}`) return { ok: false, status: 401, data: { error: 'unauthorized' } };
      if (sup && u.pathname === '/status') {
        if (beforeStatus) await beforeStatus();
        const data = { phase: sv.phase, args: [...sv.args], features: ['watchdog'], idleSeconds: 60, idleLimitSeconds: 1800, uptimeSeconds: 3600, maxSeconds: 28800, restarts: 0, lastError: sv.phase === 'error' ? 'vLLM terminato con codice 1' : null, kvCacheTokens: 500000 };
        if (sv.pending) { sv.phase = sv.pending; sv.pending = null; }
        return { ok: true, status: 200, data };
      }
      if (sup && u.pathname === '/logs') {
        const since = Number(u.searchParams.get('since') ?? 0);
        return { ok: true, status: 200, data: { lines: lines.filter((l) => l.n > since) } };
      }
      if (sup && u.pathname === '/reload') {
        if (reloadStatus !== 202) return { ok: false, status: reloadStatus, data: { error: 'ricarica già in corso' } };
        sv.reloads += 1;
        sv.args = [...opts.json.args];
        sv.phase = 'loading';
        sv.pending = onReload(opts.json.args, sv.reloads);
        return { ok: true, status: 202, data: { ok: true } };
      }
      if (sup && u.pathname === '/watchdog') return { ok: true, status: 200, data: { ok: true, idleLimitSeconds: (opts.json.idleMinutes ?? 30) * 60, maxSeconds: (opts.json.maxHours ?? 8) * 3600, uptimeSeconds: 3600 } };
      if (u.pathname === '/metrics') {
        if (sv.phase !== 'ready') return { ok: false, status: 502, data: 'Bad Gateway' };
        const text = metricQueue.length > 1 ? metricQueue.shift() : metricQueue[0];
        return { ok: true, status: 200, data: text };
      }
      if (u.pathname === '/v1/models') return { ok: true, status: 200, data: { data: [{ id: profile?.servedName ?? 'p' }] } };
      const good = smokeQueue.length ? smokeQueue[0] : true;
      if (u.pathname === '/v1/chat/completions') {
        smokeQueue.shift();
        return { ok: true, status: 200, data: { choices: [{ message: { tool_calls: good ? [{ function: { name: 'get_weather' } }] : [] } }] } };
      }
      if (u.pathname === '/v1/messages') return { ok: true, status: 200, data: { content: good ? [{ type: 'tool_use', name: 'get_weather' }] : [{ type: 'text', text: 'no' }] } };
      return { ok: false, status: 404, data: null };
    }),
  };
  const calls = (pathname, method) => http.request.mock.calls.filter(([m, url]) => new URL(url).pathname === pathname && (!method || m === method));
  return { root, dir, store, runpod, http, sv, calls, env: { LLMPOD_CONFIG_DIR: dir, ZCODE_DIR: path.join(root, 'zcode'), PI_CODING_AGENT_DIR: path.join(root, 'pi') } };
}
