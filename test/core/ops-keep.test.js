import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOps } from '../../src/core/ops.js';
import { createStore } from '../../src/core/config.js';
import { createEvents } from '../../src/core/events.js';
import { clearSecrets } from '../../src/core/secrets.js';
import { validateWatchdog, maxCostUSD } from '../../src/core/watchdog.js';

const KEY = 'CHIAVE-PROFILO-FINTA-ABCDEFG';
const profile = {
  name: 'p', servedName: 'p', cloud: 'SECURE', dataCenterId: 'EU-A', context: 65536, concurrency: 2,
  model: { id: 'org/m', revision: 'a'.repeat(40), gated: false, weightsBytes: 1e9, maxContext: 262144 },
  vllm: { image: 'x', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, gpu: { id: 'GPU80', count: 1 }, alternatives: [],
  volume: null, allowFallbackWithoutVolume: 'ask', watchdog: { idleMinutes: 30, maxHours: 8 },
};
const STATUS = { phase: 'ready', features: ['watchdog'], idleSeconds: 100, idleLimitSeconds: 1800, uptimeSeconds: 7200, maxSeconds: 28800 };

function setup({ pods = [{ id: 'pod1', name: 'llmpod-p', status: 'RUNNING', cost: 1.5 }], status = STATUS, post = null, askAnswers = [], profileOver = {} } = {}) {
  clearSecrets();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-keep-')), 'cfg');
  const store = createStore({ dir, platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-A' });
  store.writeEnv({ LLMPOD_KEY_P: KEY });
  store.writeProfile({ ...profile, ...profileOver });
  const runpod = { listPods: vi.fn(async () => pods), getPod: vi.fn(async (id) => pods.find((p) => p.id === id) ?? null) };
  const http = {
    request: vi.fn(async (m, url, opts) => {
      if (m === 'GET' && url === 'https://pod1-8001.proxy.runpod.net/status') return status ? { ok: true, status: 200, data: status } : { ok: false, status: 502, data: null };
      if (m === 'POST' && url === 'https://pod1-8001.proxy.runpod.net/watchdog') {
        if (post) return post(opts);
        const b = opts.json;
        return { ok: true, status: 200, data: { ok: true, idleLimitSeconds: b.idleMinutes == null ? status.idleLimitSeconds : b.idleMinutes * 60, maxSeconds: b.maxHours == null ? status.maxSeconds : b.maxHours * 3600, uptimeSeconds: status.uptimeSeconds, persisted: true } };
      }
      return { ok: false, status: 404, data: null };
    }),
  };
  const ask = vi.fn(async () => (askAnswers.length ? askAnswers.shift() : true));
  const ops = createOps({ store, runpod, hf: {}, http, events: createEvents(), ask, now: () => Date.parse('2026-01-01T10:00:00Z'), sleep: async () => {} });
  const posts = () => http.request.mock.calls.filter(([m]) => m === 'POST');
  return { ops, store, http, ask, posts };
}

describe('validateWatchdog', () => {
  it('accetta valori nei limiti; null/assente = invariato', () => {
    expect(validateWatchdog({ idleMinutes: 90, maxHours: 12 })).toEqual({ idleMinutes: 90, maxHours: 12 });
    expect(validateWatchdog({ maxHours: 12 })).toEqual({ idleMinutes: null, maxHours: 12 });
    expect(validateWatchdog({ idleMinutes: 0 })).toEqual({ idleMinutes: 0, maxHours: null });
    expect(validateWatchdog({ idleMinutes: 5 })).toEqual({ idleMinutes: 5, maxHours: null });
    expect(validateWatchdog({ idleMinutes: 1440, maxHours: 0.25 })).toEqual({ idleMinutes: 1440, maxHours: 0.25 });
  });
  it('rifiuta fuori intervallo, tipi sbagliati e richieste vuote', () => {
    for (const bad of [{ idleMinutes: -1 }, { idleMinutes: 1441 }, { idleMinutes: 1 }, { idleMinutes: 4 }, { idleMinutes: 5.5 }, { idleMinutes: 1e400 }, { idleMinutes: '30' }, { idleMinutes: true }, { idleMinutes: NaN }, { maxHours: 0.1 }, { maxHours: 169 }, { maxHours: '8' }, { maxHours: Infinity }, {}, { idleMinutes: null, maxHours: null }, null, []]) {
      expect(() => validateWatchdog(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });
  it('maxCostUSD: ore rimanenti per costo orario, mai negativo', () => {
    expect(maxCostUSD({ hourlyUSD: 1.5, maxSeconds: 12 * 3600, uptimeSeconds: 2 * 3600 })).toBeCloseTo(15);
    expect(maxCostUSD({ hourlyUSD: 1.5, maxSeconds: 3600, uptimeSeconds: 7200 })).toBe(0);
  });
});

describe('ops.keep', () => {
  beforeEach(() => clearSecrets());

  it('aumenta le ore massime: chiede conferma con il costo massimo fino alla nuova scadenza e chiama /watchdog', async () => {
    const t = setup();
    const r = await t.ops.keep('p', { maxHours: 12 });
    // restano 12 h - 2 h = 10 h × 1,50 $/h = 15,00 $
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(t.ask.mock.calls[0][0]).toMatch(/15,00 \$/);
    expect(t.ask.mock.calls[0][0]).toMatch(/10 h/);
    expect(t.ask.mock.calls[0][0]).toMatch(/Confermi\?/);
    expect(t.posts()).toHaveLength(1);
    expect(t.posts()[0][1]).toBe('https://pod1-8001.proxy.runpod.net/watchdog');
    expect(t.posts()[0][2].json).toEqual({ idleMinutes: null, maxHours: 12 });
    expect(t.posts()[0][2].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r).toMatchObject({ podId: 'pod1', idleLimitSeconds: 1800, maxSeconds: 43200, uptimeSeconds: 7200, remainingSeconds: 36000, hourlyUSD: 1.5, saved: false });
    expect(r.maxCostUSD).toBeCloseTo(15);
    expect(r.expiresAt).toBe('2026-01-01T20:00:00.000Z');
  });

  it('--yes salta la conferma; se non aumenta le ore massime non la chiede', async () => {
    const a = setup();
    await a.ops.keep('p', { maxHours: 12, yes: true });
    expect(a.ask).not.toHaveBeenCalled();
    expect(a.posts()).toHaveLength(1);
    const c = setup();
    await c.ops.keep('p', { idleMinutes: 0, yes: true });
    expect(c.ask).not.toHaveBeenCalled();
    const b = setup();
    await b.ops.keep('p', { maxHours: 4 });
    await b.ops.keep('p', { idleMinutes: 10 });
    expect(b.ask).not.toHaveBeenCalled();
    expect(b.posts().map((c) => c[2].json)).toEqual([{ idleMinutes: null, maxHours: 4 }, { idleMinutes: 10, maxHours: null }]);
  });

  it('conferma rifiutata: CANCELLED e nessuna chiamata al Pod', async () => {
    const t = setup({ askAnswers: [false] });
    await expect(t.ops.keep('p', { maxHours: 12 })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(t.posts()).toHaveLength(0);
  });

  it('input non valido: INVALID_INPUT prima di qualunque chiamata di rete', async () => {
    const t = setup();
    await expect(t.ops.keep('p', { maxHours: 500 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(t.ops.keep('p', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(t.http.request).not.toHaveBeenCalled();
  });

  it('senza Pod attivo: NOT_FOUND; Pod non ancora avviato o supervisore irraggiungibile: errore chiaro', async () => {
    await expect(setup({ pods: [] }).ops.keep('p', { maxHours: 12 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setup({ pods: [{ id: 'pod1', name: 'llmpod-p', status: 'CREATED', cost: 1 }] }).ops.keep('p', { maxHours: 12 })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/non è ancora avviato/) });
    const t = setup({ status: null });
    await expect(t.ops.keep('p', { maxHours: 12 })).rejects.toMatchObject({ code: 'HTTP', message: expect.stringMatching(/supervisore/) });
    expect(t.posts()).toHaveLength(0);
  });

  it('supervisore vecchio (404 su /watchdog): spiega che serve un Pod avviato con la nuova versione', async () => {
    const t = setup({ post: async () => ({ ok: false, status: 404, data: { error: 'not found' } }) });
    const err = await t.ops.keep('p', { maxHours: 12, yes: true }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(err.message).toMatch(/versione precedente/);
    expect(err.hint).toMatch(/llmpod down p.*llmpod up p/);
  });

  it('rifiuto 400 del supervisore: errore con il suo messaggio', async () => {
    const t = setup({ post: async () => ({ ok: false, status: 400, data: { error: 'maxHours deve essere tra 0.25 e 168' } }) });
    await expect(t.ops.keep('p', { maxHours: 12, yes: true })).rejects.toMatchObject({ code: 'HTTP', message: expect.stringMatching(/maxHours deve essere/) });
  });

  it('il profilo si aggiorna solo con save, e solo i campi indicati', async () => {
    const t = setup();
    await t.ops.keep('p', { maxHours: 12, yes: true });
    expect(t.store.readProfile('p').watchdog).toEqual({ idleMinutes: 30, maxHours: 8 });
    const r = await t.ops.keep('p', { idleMinutes: 0, yes: true, save: true });
    expect(r.saved).toBe(true);
    expect(t.store.readProfile('p').watchdog).toEqual({ idleMinutes: 0, maxHours: 8 });
    await t.ops.keep('p', { maxHours: 12, idleMinutes: 45, yes: true, save: true });
    expect(t.store.readProfile('p').watchdog).toEqual({ idleMinutes: 45, maxHours: 12 });
  });

  it('con save e supervisore che rifiuta il profilo non cambia', async () => {
    const t = setup({ post: async () => ({ ok: false, status: 404, data: null }) });
    await t.ops.keep('p', { maxHours: 12, yes: true, save: true }).catch(() => {});
    expect(t.store.readProfile('p').watchdog).toEqual({ idleMinutes: 30, maxHours: 8 });
  });

  it('disattivare o aumentare l\'inattività chiede conferma con il costo massimo fino alla scadenza (restano 6 h x 1,50 $)', async () => {
    const off = setup();
    await off.ops.keep('p', { idleMinutes: 0 });
    expect(off.ask).toHaveBeenCalledTimes(1);
    expect(off.ask.mock.calls[0][0]).toMatch(/inattività: mai/);
    expect(off.ask.mock.calls[0][0]).toMatch(/9,00 \$/);
    expect(off.ask.mock.calls[0][0]).toMatch(/6 h/);
    const more = setup();
    await more.ops.keep('p', { idleMinutes: 60 });
    expect(more.ask).toHaveBeenCalledTimes(1);
    expect(more.ask.mock.calls[0][0]).toMatch(/inattività: 60 min/);
    expect(more.ask.mock.calls[0][0]).toMatch(/9,00 \$/);
    const less = setup();
    await less.ops.keep('p', { idleMinutes: 10 });
    expect(less.ask).not.toHaveBeenCalled();
    // già disattivata: qualunque valore la riattiva, quindi non aumenta la spesa
    const was = setup({ status: { ...STATUS, idleLimitSeconds: 0 } });
    await was.ops.keep('p', { idleMinutes: 120 });
    expect(was.ask).not.toHaveBeenCalled();
    const declined = setup({ askAnswers: [false] });
    await expect(declined.ops.keep('p', { idleMinutes: 0 })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(declined.posts()).toHaveLength(0);
  });

  it('ore massime sotto l\'uptime (+5 min) non eliminano il Pod in silenzio: INVALID_INPUT, nessuna chiamata né conferma', async () => {
    const t = setup(); // acceso da 2 h
    const err = await t.ops.keep('p', { maxHours: 2 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(err.message).toMatch(/Il Pod è acceso da 2 h: con un massimo di 2 h verrebbe eliminato subito/);
    expect(err.message).toMatch(/llmpod down p/);
    await expect(t.ops.keep('p', { maxHours: 0.25 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(t.posts()).toHaveLength(0);
    expect(t.ask).not.toHaveBeenCalled();
    await t.ops.keep('p', { maxHours: 2.1 }); // 7560 s > 7200 + 300
    expect(t.posts()).toHaveLength(1);
  });

  it('supervisore vecchio (senza "watchdog" tra le funzioni dello stato) rilevato PRIMA della conferma del costo', async () => {
    const { features, ...old } = STATUS;
    const t = setup({ status: old });
    const err = await t.ops.keep('p', { maxHours: 48 }).catch((e) => e);
    expect(err.message).toMatch(/versione precedente/);
    expect(err.hint).toMatch(/llmpod down p.*llmpod up p/);
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.posts()).toHaveLength(0);
  });

  it('con save: se il profilo salvato avrà inattività mai o più di 8 ore chiede una conferma esplicita (yes la salta)', async () => {
    const a = setup({ askAnswers: [true, true] });
    await a.ops.keep('p', { idleMinutes: 0, save: true });
    expect(a.ask).toHaveBeenCalledTimes(2);
    expect(a.ask.mock.calls[1][0]).toMatch(/profilo p.*inattività: mai.*massimo 8 h/s);
    expect(a.ask.mock.calls[1][0]).toMatch(/Confermi\?/);
    const b = setup({ askAnswers: [true] });
    await b.ops.keep('p', { maxHours: 4, idleMinutes: 20, save: true }); // nessuna conferma per il Pod (non aumenta) né per il profilo (20 min, 4 h)
    expect(b.ask).not.toHaveBeenCalled();
    const c = setup({ askAnswers: [false] });
    await expect(c.ops.keep('p', { maxHours: 12, save: true, yes: false })).rejects.toMatchObject({ code: 'CANCELLED' });
    const d = setup({ askAnswers: [true, false] });
    await expect(d.ops.keep('p', { maxHours: 12, save: true })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(d.posts()).toHaveLength(0);
    expect(d.store.readProfile('p').watchdog).toEqual({ idleMinutes: 30, maxHours: 8 });
    const e = setup();
    await e.ops.keep('p', { maxHours: 12, save: true, yes: true });
    expect(e.ask).not.toHaveBeenCalled();
    expect(e.store.readProfile('p').watchdog.maxHours).toBe(12);
  });

  it('costo orario: se Runpod non lo dà si usa la stima del profilo, e se manca del tutto non si mostra 0,00', async () => {
    const est = setup({ pods: [{ id: 'pod1', name: 'llmpod-p', status: 'RUNNING' }], profileOver: { estimate: { hourlyUSD: 1.4 } } });
    const r = await est.ops.keep('p', { maxHours: 12 });
    expect(r.hourlyUSD).toBe(1.4);
    expect(r.maxCostUSD).toBeCloseTo(14);
    expect(est.ask.mock.calls[0][0]).toMatch(/14,00 \$/);
    const none = setup({ pods: [{ id: 'pod1', name: 'llmpod-p', status: 'RUNNING' }] });
    const n = await none.ops.keep('p', { maxHours: 12 });
    expect(n).toMatchObject({ hourlyUSD: null, maxCostUSD: null });
    expect(none.ask.mock.calls[0][0]).toMatch(/costo orario non noto/);
    expect(none.ask.mock.calls[0][0]).not.toContain('0,00');
  });
});
