import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server/app.js';
import { createRoutes } from '../../src/server/routes.js';
import { createSse } from '../../src/server/sse.js';
import { createJobs } from '../../src/server/jobs.js';
import { createStore } from '../../src/core/config.js';
import { clearSecrets } from '../../src/core/secrets.js';
import { apiClient } from './helpers.js';

const TOKEN = 'token-api-scelta-di-prova-0987';
const OPTIONS = [{ id: 'A|1', label: 'GPU-A ×1' }, { id: 'B|1', label: 'GPU-B ×1' }];
let server; let sse; let jobs; let call; let ops; let picked;

const waitFor = async (fn, tries = 100) => {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  return undefined;
};

beforeEach(async () => {
  clearSecrets();
  picked = undefined;
  const store = createStore({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-choice-')), 'cfg'), platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-RO-1' });
  store.writeJson('last-plan.json', { dataCenterId: 'EU-RO-1' });
  ops = { saveProfile: vi.fn((name, opts) => ({ name, opts })) };
  const ctx = {
    env: {}, store, ops,
    makeOps: ({ askChoice }) => ({ up: async () => { picked = await askChoice('Quale GPU?', OPTIONS, 'A|1'); return { picked }; }, down: async () => ({}) }),
    advisor: { config: () => null, provider: () => null }, http: {},
  };
  sse = createSse();
  jobs = createJobs({ questionTimeoutMs: 150, onEvent: (e) => sse.broadcast('job', e) });
  server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  call = apiClient({ port, token: TOKEN });
  server.on('request', createApp({ ctx, token: TOKEN, port, staticDir: null, jobs, version: '0.1.0', routes: createRoutes({ ctx, jobs, sse, state: {} }) }));
});
afterEach(() => { sse.close(); server.close(); });

const startUp = async () => (await call('/api/jobs', { method: 'POST', body: { action: 'up', profile: 'qwen' } })).json.job;
const pending = (id) => waitFor(async () => (await call(`/api/jobs/${id}`)).json.job.question);
const answer = (id, q, a) => call(`/api/jobs/${id}/answer`, { method: 'POST', body: { questionId: q.id, answer: a } });

describe('API: domande a scelta dei job', () => {
  it('il job up propone una scelta (kind choice, opzioni, predefinita) e usa l\'id risposto', async () => {
    const { id } = await startUp();
    const q = await pending(id);
    expect(q).toMatchObject({ kind: 'choice', text: 'Quale GPU?', options: OPTIONS, defaultId: 'A|1' });
    expect((await answer(id, q, 'B|1')).status).toBe(200);
    const done = await waitFor(async () => { const j = (await call(`/api/jobs/${id}`)).json; return j.job.status === 'done' ? j : null; });
    expect(done.job.result).toEqual({ picked: 'B|1' });
    expect(done.events.find((e) => e.type === 'answer')).toMatchObject({ answer: 'B|1' });
  });

  it('validazione lato server: un id sconosciuto, un booleano o un numero → 400 e la domanda resta aperta', async () => {
    const { id } = await startUp();
    const q = await pending(id);
    for (const a of ['zzz', true, false, 7, undefined]) expect((await answer(id, q, a)).status).toBe(400);
    expect((await call(`/api/jobs/${id}`)).json.job.question).not.toBeNull();
    expect((await answer(id, q, 'A|1')).status).toBe(200);
  });

  it('answer null = annulla la scelta', async () => {
    const { id } = await startUp();
    const q = await pending(id);
    expect((await answer(id, q, null)).status).toBe(200);
    await waitFor(() => picked !== undefined);
    expect(picked).toBeNull();
  });

  it('senza risposta alla scadenza la scelta vale null', async () => {
    const { id } = await startUp();
    await pending(id);
    await waitFor(() => picked !== undefined);
    expect(picked).toBeNull();
  });
});

describe('API: salvataggio del profilo con la GPU scelta', () => {
  it('POST /api/profiles passa la scelta a saveProfile', async () => {
    const r = await call('/api/profiles', { method: 'POST', body: { name: 'qwen', gpu: { id: 'GPU-B', count: 2 } } });
    expect(r.status).toBe(200);
    expect(ops.saveProfile).toHaveBeenCalledWith('qwen', { gpu: { id: 'GPU-B', count: 2 } });
  });

  it('senza gpu: nessuna scelta (comportamento di prima)', async () => {
    await call('/api/profiles', { method: 'POST', body: { name: 'qwen' } });
    expect(ops.saveProfile).toHaveBeenCalledWith('qwen', { gpu: undefined });
  });

  it('gpu malformata → 400 e nulla viene salvato', async () => {
    for (const gpu of ['GPU-B', 5, { id: 5 }, { id: 'X', count: 'due' }, { id: 'X', count: 0 }, { id: '' }]) {
      expect((await call('/api/profiles', { method: 'POST', body: { name: 'qwen', gpu } })).status).toBe(400);
    }
    expect(ops.saveProfile).not.toHaveBeenCalled();
  });
});
