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

  it('le altre variabili del .env sopravvivono alla generazione della chiave interna', async () => {
    const c = ctx();
    c.store.writeEnv({ ALTRA_VARIABILE: 'valore-qualsiasi', LLMPOD_KEY_QWEN: 'CHIAVE-PROFILO-FINTA-ABCDEFG' });
    const ui = await startUi(c, { port: 0, proxy: false, token: 't'.repeat(20), staticDir: null });
    try {
      const env = c.store.readEnv();
      expect(env.ALTRA_VARIABILE).toBe('valore-qualsiasi');
      expect(env.LLMPOD_KEY_QWEN).toBe('CHIAVE-PROFILO-FINTA-ABCDEFG');
      expect(env.LLMPOD_OPENWEBUI_KEY).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await ui.close();
    }
  });

  it.each([['corto', 'abc'], ['caratteri non validi', 'token con spazi!!!!!!!!!']])('token %s: INVALID_INPUT senza stampare il valore', async (_n, bad) => {
    const err = await startUi(ctx(), { port: 0, proxy: false, token: bad, staticDir: null }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(err.message).not.toContain(bad);
    expect(String(err.hint ?? '')).not.toContain(bad);
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const startJob = async (ui, profile = 'qwen') => {
    const r = await apiClient({ port: ui.port, token: TOKEN })('/api/jobs', { method: 'POST', body: { action: 'up', profile } });
    expect(r.status).toBe(200);
  };

  it('termina il Pod in creazione e stampa cosa ha fatto', async () => {
    const t = withJob();
    const ui = await startUi(t.c, { port: 0, proxy: false, token: TOKEN, staticDir: null });
    await startJob(ui);
    await waitFor(() => ui.trackedUps().some((u) => u.podId === 'pod9'));
    await ui.shutdown({ io: t.io });
    expect(t.down).toHaveBeenCalledWith('qwen', { yes: true });
    expect(t.lines()).toContain('pod9');
  });

  it('senza Pod noto ma in creazione: avvisa che potrebbe esistere un Pod non visibile', async () => {
    const t = withJob({ emitPod: false });
    const ui = await startUi(t.c, { port: 0, proxy: false, token: TOKEN, staticDir: null });
    await startJob(ui);
    await waitFor(() => ui.trackedUps().some((u) => u.creating));
    await ui.shutdown({ io: t.io });
    expect(t.down).not.toHaveBeenCalled();
    expect(t.lines()).toContain('Potrebbe essere stato creato un Pod');
  });

  it('job concluso: chiude e basta; il Pod pronto resta con un messaggio', async () => {
    const down = vi.fn();
    const c = ctx({ ops: { down }, makeOps: ({ events: ev }) => ({ up: async () => { ev.emit('pod', { podId: 'podOK' }); return { baseUrl: 'x' }; } }) });
    const lines = [];
    const ui = await startUi(c, { port: 0, proxy: false, token: TOKEN, staticDir: null });
    await startJob(ui);
    await waitFor(() => ui.trackedUps().some((u) => u.returned));
    await ui.shutdown({ io: { err: (t) => lines.push(t), out: (t) => lines.push(t) } });
    expect(down).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/podOK.*(watchdog|llmpod down qwen)/s);
  });

  it('job in attesa della domanda "Salvare gli argomenti corretti?": il Pod è pronto e resta', async () => {
    const down = vi.fn();
    const c = ctx({ ops: { down }, makeOps: ({ events: ev }) => ({ up: async () => { ev.emit('pod', { podId: 'podPronto' }); return { baseUrl: 'x', repairedArgs: ['--x'] }; }, saveProfileArgs: vi.fn() }) });
    const lines = [];
    const ui = await startUi(c, { port: 0, proxy: false, token: TOKEN, staticDir: null });
    await startJob(ui);
    await waitFor(() => ui.trackedUps().some((u) => u.returned));
    await sleep(30);
    const jobsNow = (await apiClient({ port: ui.port, token: TOKEN })('/api/jobs')).json.jobs;
    expect(jobsNow.some((j) => j.status === 'running' && j.question)).toBe(true);
    await ui.shutdown({ io: { err: (t) => lines.push(t), out: (t) => lines.push(t) } });
    expect(down).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('podPronto');
  });

  it('lo stato del job è letto dal vivo: un Pod comparso durante lo spegnimento dei precedenti viene terminato', async () => {
    const calls = [];
    const down = vi.fn(async (name) => { calls.push(name); await sleep(60); });
    const c = ctx({
      ops: { down },
      runpod: { listPods: async () => [] },
      makeOps: ({ events: ev }) => ({
        up: (name) => new Promise(() => {
          ev.emit('phase', { message: 'Creazione del Pod' });
          if (name === 'alpha') ev.emit('pod', { podId: 'podA' });
          else setTimeout(() => ev.emit('pod', { podId: 'podB' }), 20);
        }),
      }),
    });
    const ui = await startUi(c, { port: 0, proxy: false, token: TOKEN, staticDir: null });
    await startJob(ui, 'alpha');
    await startJob(ui, 'beta');
    await waitFor(() => ui.trackedUps().some((u) => u.profile === 'beta' && u.creating));
    await ui.shutdown({ io: { err: () => {}, out: () => {} } });
    expect(calls).toEqual(['alpha', 'beta']);
  });
});
