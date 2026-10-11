import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server/app.js';
import { createRoutes } from '../../src/server/routes.js';
import { createSse } from '../../src/server/sse.js';
import { createJobs } from '../../src/server/jobs.js';
import { createOps } from '../../src/core/ops.js';
import { createStore } from '../../src/core/config.js';
import { clearSecrets } from '../../src/core/secrets.js';
import { apiClient } from './helpers.js';

// Job "up" con l'ops reale (runpod/http finti): senza risposta alle domande non si deve continuare a spendere.
const TOKEN = 'token-api-ops-di-prova-1122334455';
const gpu = (id, memory, price, dcs) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: dcs.map(([d, a]) => ({ id: d, availability: a })) });
const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  context: 65536, concurrency: 2, vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 },
  gpu: { id: 'GPU80', count: 1 }, hourlyUSD: 1.5, alternatives: [], elsewhere: [], candidates: [],
  dataCenterId: 'EU-A', cloud: 'SECURE', kvCacheDtype: null, warnings: [],
};

let server; let port; let sse; let jobs; let runpod; let call; let phase;
const waitFor = async (fn, tries = 300) => {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  return undefined;
};

beforeEach(async () => {
  clearSecrets();
  phase = 'loading';
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-apiops-')), 'cfg');
  const store = createStore({ dir, platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-A' } });
  store.writeJson('last-plan.json', plan);
  let deleted = false;
  runpod = {
    listPods: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 50, spendPerHour: 0 })),
    listGpus: vi.fn(async () => [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']])]),
    createPod: vi.fn(async () => ({ status: 201, data: { id: 'pod1' } })),
    getPod: vi.fn(async () => (deleted ? null : { id: 'pod1', status: 'RUNNING', cost: 1.49 })),
    deletePod: vi.fn(async () => { deleted = true; }),
  };
  const http_ = { request: vi.fn(async (m, url) => {
    if (url.endsWith('/status')) return { ok: true, status: 200, data: { phase } };
    if (url.includes('/logs')) return { ok: true, status: 200, data: { lines: [] } };
    return { ok: false, status: 404, data: null };
  }) };
  const hf = { checkAccess: vi.fn(async () => ({ ok: true, status: 200 })) };
  let t = 0;
  const ctx = {
    env: {}, store, hf, http: http_, ops: null,
    makeOps: ({ ask, events }) => createOps({ store, runpod, hf, http: http_, events, ask, now: () => (t += 1000), sleep: async () => {}, zcode: { dir: path.join(dir, 'zcode'), isRunning: async () => false } }),
    advisor: { config: () => null, provider: () => null, active: () => false },
  };
  ctx.ops = ctx.makeOps({ ask: async () => false, events: { emit() {}, on() {} } });
  ctx.ops.saveProfile('qwen3-coder');
  sse = createSse();
  jobs = createJobs({ questionTimeoutMs: 250, onEvent: (e) => sse.broadcast('job', e) });
  server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  call = apiClient({ port, token: TOKEN });
  server.on('request', createApp({ ctx, token: TOKEN, port, staticDir: null, jobs, version: '0.1.0', routes: createRoutes({ ctx, jobs, sse, state: {} }) }));
});
afterEach(() => { sse.close(); server.close(); });

const start = async () => (await call('/api/jobs', { method: 'POST', body: { action: 'up', profile: 'qwen3-coder' } })).json.job;
const finished = (id) => waitFor(async () => { const j = (await call(`/api/jobs/${id}`)).json; return j.job.status !== 'running' ? j : null; });

describe('job up con ops reale e domande senza risposta', () => {
  it('conferma del costo senza risposta → CANCELLED e nessun Pod creato', async () => {
    const { id } = await start();
    const { job, events } = await finished(id);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'CANCELLED' } });
    expect(runpod.createPod).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'question').text).toMatch(/Confermi\?/);
    expect(events.find((e) => e.type === 'answer')).toMatchObject({ answer: false });
  });

  it('vLLM non pronto: "Aspettare altri 15 minuti?" scade → no; la terminazione scade → sì e il Pod viene eliminato', async () => {
    const { id } = await start();
    const q = await waitFor(async () => (await call(`/api/jobs/${id}`)).json.job.question);
    expect(q.text).toMatch(/Confermi\?/);
    expect((await call(`/api/jobs/${id}/answer`, { method: 'POST', body: { questionId: q.id, answer: true } })).status).toBe(200);
    const { job, events } = await finished(id);
    expect(runpod.createPod).toHaveBeenCalledTimes(1);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'POD_START_TIMEOUT' } });
    const questions = events.filter((e) => e.type === 'question');
    expect(questions.map((e) => e.text)).toEqual([expect.stringMatching(/Confermi\?/), expect.stringMatching(/Aspettare altri 15 minuti\?/), expect.stringMatching(/Terminare il Pod pod1/)]);
    expect(questions.map((e) => e.defYes)).toEqual([false, true, true]);
    expect(events.filter((e) => e.type === 'answer').map((e) => e.answer)).toEqual([true, false, true]);
    expect(runpod.deletePod).toHaveBeenCalledWith('pod1');
  });
});
