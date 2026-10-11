import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startUi } from '../../src/server/start.js';
import { createStore } from '../../src/core/config.js';
import { clearSecrets, redact } from '../../src/core/secrets.js';
import { apiClient } from './helpers.js';

function ctx(extra = {}) {
  const store = createStore({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-ui-')), 'cfg'), platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-RO-1' });
  return { store, env: {}, platform: 'linux', ops: { endpoint: async () => { throw Object.assign(new Error('x'), { code: 'NOT_FOUND' }); } }, makeOps: () => ({}), advisor: { config: () => null, provider: () => null }, ...extra };
}

beforeEach(() => clearSecrets());

describe('startUi', () => {
  it('avvia interfaccia e proxy, genera la chiave interna, autentica con il token', async () => {
    const c = ctx();
    const ui = await startUi(c, { port: 0, proxyPort: 0, token: 'token-avvio-1234567890', staticDir: null, version: '0.1.0' });
    try {
      expect(ui.url).toBe(`http://127.0.0.1:${ui.port}/?t=token-avvio-1234567890`);
      const key = c.store.readEnv().LLMPOD_OPENWEBUI_KEY;
      // R-A5: chiave esadecimale casuale di 32 byte, salvata con permessi 600.
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.statSync(path.join(c.store.dir, '.env')).mode & 0o777).toBe(0o600);
      expect((await fetch(`http://127.0.0.1:${ui.port}/api/health`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${ui.port}/api/session`)).status).toBe(401);
      const r = await fetch(`http://127.0.0.1:${ui.proxyPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
      expect(r.status).toBe(503);
    } finally {
      await ui.close();
    }
  });

  it('riusa la chiave interna esistente e può fare a meno del proxy', async () => {
    const c = ctx();
    c.store.writeEnv({ LLMPOD_OPENWEBUI_KEY: 'chiave-esistente-1234567890' });
    const ui = await startUi(c, { port: 0, proxy: false, token: 't'.repeat(20), staticDir: null });
    try {
      expect(c.store.readEnv().LLMPOD_OPENWEBUI_KEY).toBe('chiave-esistente-1234567890');
      expect(ui.proxyPort).toBeNull();
    } finally {
      await ui.close();
    }
  });

  it('chiave interna troppo corta: errore chiaro, nessun server lasciato aperto', async () => {
    const c = ctx();
    c.store.writeEnv({ LLMPOD_OPENWEBUI_KEY: 'corta' });
    await expect(startUi(c, { port: 0, proxyPort: 0, token: 't'.repeat(20), staticDir: null })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('registra tutti i segreti (token, chiavi, profili, consulente) prima di rispondere', async () => {
    const c = ctx();
    const secrets = {
      RUNPOD_API_KEY: 'rpa_SEGRETO_RUNPOD_FINTO_123', HF_TOKEN: 'hf_SEGRETO_HF_FINTO_1234567',
      LLMPOD_ADVISOR_API_KEY: 'CHIAVE-CONSULENTE-FINTA-1234', LLMPOD_KEY_QWEN: 'CHIAVE-PROFILO-FINTA-ABCDEFG',
    };
    c.store.writeEnv(secrets);
    clearSecrets(); // simula un processo che non ha ancora letto il .env
    const token = 'abcdef0123456789abcdef0123456789';
    const ui = await startUi(c, { port: 0, proxyPort: 0, token, staticDir: null });
    try {
      const key = c.store.readEnv().LLMPOD_OPENWEBUI_KEY;
      for (const v of [...Object.values(secrets), token, key]) expect(redact(`x ${v} y`), v).not.toContain(v);
    } finally {
      await ui.close();
    }
  });

  it('state.proxy espone solo porta e stato, mai la chiave', async () => {
    const c = ctx();
    const token = 'tok-0123456789abcdef';
    const ui = await startUi(c, { port: 0, proxyPort: 0, token, staticDir: null });
    try {
      const key = c.store.readEnv().LLMPOD_OPENWEBUI_KEY;
      const r = await apiClient({ port: ui.port, token })('/api/openwebui');
      expect(r.status).toBe(200);
      expect(r.json.proxy).toEqual({ port: ui.proxyPort, listening: true });
      expect(r.text).not.toContain(key);
    } finally {
      await ui.close();
    }
    const c2 = ctx();
    const ui2 = await startUi(c2, { port: 0, proxy: false, token, staticDir: null });
    try {
      expect((await apiClient({ port: ui2.port, token })('/api/openwebui')).json.proxy).toBeNull();
    } finally {
      await ui2.close();
    }
  });

  it('il ctx del server espone isZcodeRunning (come quello della CLI)', async () => {
    const c = ctx();
    const ui = await startUi(c, { port: 0, proxy: false, token: 't'.repeat(20), staticDir: null });
    try {
      expect(typeof c.isZcodeRunning).toBe('function');
    } finally {
      await ui.close();
    }
    const own = vi.fn(async () => false);
    const c2 = ctx({ isZcodeRunning: own });
    const ui2 = await startUi(c2, { port: 0, proxy: false, token: 't'.repeat(20), staticDir: null });
    try {
      expect(c2.isZcodeRunning).toBe(own);
    } finally {
      await ui2.close();
    }
  });

  it('porta occupata: errore chiaro in italiano', async () => {
    const c = ctx();
    const first = await startUi(c, { port: 0, proxy: false, token: 't'.repeat(20), staticDir: null });
    try {
      await expect(startUi(ctx(), { port: first.port, proxy: false, token: 't'.repeat(20), staticDir: null })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining(String(first.port)) });
    } finally {
      await first.close();
    }
  });
});

describe('startUi: chiusura con job up in corso (R5)', () => {
  const TOKEN = 'abcdef0123456789abcdef0123456789';
  const waitFor = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

  function withJob({ emitPod = true } = {}) {
    const down = vi.fn(async () => ({}));
    const listPods = vi.fn(async () => []);
    const events = [];
    const c = ctx({
      ops: { down },
      runpod: { listPods },
      makeOps: ({ events: ev }) => ({
        up: () => new Promise(() => {
          ev.emit('phase', { message: 'Creazione del Pod' });
          if (emitPod) ev.emit('pod', { podId: 'pod9' });
        }),
        down: async () => ({}),
      }),
    });
    const io = { err: (t) => events.push(t), out: (t) => events.push(t) };
    return { c, io, down, listPods, lines: () => events.join('\n') };
  }

  async function startJob(c, ui, profile = 'qwen') {
    const api = apiClient({ port: ui.port, token: TOKEN });
    const r = await api('/api/jobs', { method: 'POST', body: { action: 'up', profile } });
    expect(r.status).toBe(200);
    return api;
  }

  it('termina il Pod in creazione e stampa cosa ha fatto', async () => {
    const t = withJob();
    const ui = await startUi(t.c, { port: 0, proxy: false, token: TOKEN, staticDir: null });
    await startJob(t.c, ui);
    await waitFor(() => /pod9/.test(JSON.stringify(ui.trackedJobs())));
    await ui.shutdown({ io: t.io });
    expect(t.down).toHaveBeenCalledWith('qwen', { yes: true });
    expect(t.lines()).toContain('pod9');
  });

  it('senza Pod noto ma in creazione: avvisa che potrebbe esistere un Pod non visibile', async () => {
    const t = withJob({ emitPod: false });
    const ui = await startUi(t.c, { port: 0, proxy: false, token: TOKEN, staticDir: null });
    await startJob(t.c, ui);
    await waitFor(() => ui.trackedJobs().some((j) => j.creating));
    await ui.shutdown({ io: t.io });
    expect(t.down).not.toHaveBeenCalled();
    expect(t.lines()).toContain('Potrebbe essere stato creato un Pod');
  });

  it('senza job in corso chiude e basta; i Pod già pronti restano con un messaggio', async () => {
    const down = vi.fn();
    const c = ctx({ ops: { down }, makeOps: ({ events: ev }) => ({ up: async () => { ev.emit('pod', { podId: 'podOK' }); return { baseUrl: 'x' }; } }) });
    const lines = [];
    const ui = await startUi(c, { port: 0, proxy: false, token: TOKEN, staticDir: null });
    const api = apiClient({ port: ui.port, token: TOKEN });
    await api('/api/jobs', { method: 'POST', body: { action: 'up', profile: 'qwen' } });
    await waitFor(() => ui.trackedJobs().some((j) => j.status === 'done'));
    await ui.shutdown({ io: { err: (t) => lines.push(t), out: (t) => lines.push(t) } });
    expect(down).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/podOK.*(watchdog|llmpod down qwen)/s);
  });
});
