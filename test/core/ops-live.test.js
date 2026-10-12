import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { createOps } from '../../src/core/ops.js';
import { createEvents } from '../../src/core/events.js';
import { redact } from '../../src/core/secrets.js';
import { createWorld, KEY, ACTIVE_ARGS } from '../fixtures/fake-world.js';

function setup(opts = {}, { answers = [] } = {}) {
  const w = createWorld(opts);
  const ask = vi.fn(async () => (answers.length ? answers.shift() : true));
  const events = createEvents();
  const seen = [];
  events.on((e) => seen.push(e));
  const sleep = vi.fn(async () => {});
  let t = Date.parse('2026-10-01T10:00:00Z');
  const ops = createOps({ store: w.store, runpod: w.runpod, hf: {}, http: w.http, events, ask, now: () => (t += 1000), sleep, zcode: { dir: path.join(w.root, 'zcode'), isRunning: async () => false } });
  return { ...w, ops, ask, seen, sleep };
}

describe('ops.metrics', () => {
  it('legge /metrics due volte a distanza della finestra (senza chiave) e /status del supervisore', async () => {
    const t = setup();
    const r = await t.ops.metrics('p', { window: 5 });
    expect(t.sleep).toHaveBeenCalledWith(5000);
    const metricCalls = t.calls('/metrics');
    expect(metricCalls).toHaveLength(2);
    expect(metricCalls[0][1]).toBe('https://pod1-8000.proxy.runpod.net/metrics');
    expect(metricCalls[0][2]?.headers?.authorization).toBeUndefined();
    expect(r).toMatchObject({ profile: 'p', podId: 'pod1', hourlyUSD: 1.5, supervisor: { phase: 'ready', kvCacheTokens: 500000 } });
    expect(r.metrics.throughput).toEqual({ generationTokensPerSec: 200, promptTokensPerSec: 400 });
    expect(r.metrics.speculative.window).toMatchObject({ acceptanceRatePct: 50, meanAcceptedLength: 2 });
    expect(r.activeArgs).toEqual(ACTIVE_ARGS);
  });

  it('vLLM non ancora pronto: metriche null con il motivo, stato del supervisore presente', async () => {
    const t = setup({ phase: 'loading' });
    const r = await t.ops.metrics('p', { window: 1 });
    expect(r.metrics).toBeNull();
    expect(r.metricsError).toMatch(/non disponibili/);
    expect(r.supervisor.phase).toBe('loading');
  });

  it('finestra fuori intervallo o Pod assente → errore', async () => {
    await expect(setup().ops.metrics('p', { window: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(setup({ pods: [] }).ops.metrics('p')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ops.logs', () => {
  it('restituisce le righe dal cursore, mascherate, e il nuovo cursore', async () => {
    const t = setup();
    const r = await t.ops.logs('p', { since: 1 });
    expect(r.lines.map((l) => l.n)).toEqual([2, 3]);
    expect(r.cursor).toBe(3);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

describe('ops.tunePreview / ops.tune', () => {
  it('anteprima: argomenti attivi del Pod, diff e stima di memoria sulla GPU del Pod; nessun reload', async () => {
    const t = setup();
    const r = await t.ops.tunePreview('p', { set: ['max-num-seqs=4', 'kv-cache-dtype=fp8'] });
    expect(r.before).toEqual(ACTIVE_ARGS);
    expect(r.changes.added).toEqual(['--max-num-seqs 4', '--kv-cache-dtype fp8']);
    expect(r.memory).toMatchObject({ gpu: 'GPU80', count: 1, memoryGiB: 80, fits: true });
    expect(r.note).toMatch(/interruzione di alcuni minuti/);
    expect(t.calls('/reload')).toHaveLength(0);
  });

  it('rifiuta (prima di chiedere) se con il nuovo contesto il modello non entra nella GPU del Pod', async () => {
    const t = setup();
    await expect(t.ops.tune('p', { set: ['max-model-len=196608'] })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/non entra/) });
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.calls('/reload')).toHaveLength(0);
  });

  it('conferma con interruzione e costo, reload, attesa di ready con gli argomenti nuovi, smoke test', async () => {
    const t = setup();
    const r = await t.ops.tune('p', { set: ['max-num-seqs=4'] });
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(t.ask.mock.calls[0][0]).toMatch(/vLLM verrà ricaricato: interruzione di alcuni minuti; il Pod resta.*1,50 \$\/h/);
    const reload = t.calls('/reload', 'POST');
    expect(reload).toHaveLength(1);
    expect(reload[0][2].json.args).toEqual([...ACTIVE_ARGS, '--max-num-seqs', '4']);
    expect(r).toMatchObject({ podId: 'pod1', saved: false, reverted: false });
    expect(r.smoke.ok).toBe(true);
    expect(t.calls('/v1/chat/completions')).toHaveLength(1);
    // senza --save il profilo non cambia
    expect(t.store.readProfile('p').vllm.args).toEqual(ACTIVE_ARGS);
  });

  it('conferma rifiutata → annullato, nessun reload', async () => {
    const t = setup({}, { answers: [false] });
    await expect(t.ops.tune('p', { set: ['max-num-seqs=4'] })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(t.calls('/reload')).toHaveLength(0);
  });

  it('--dry-run: nessuna domanda e nessun reload', async () => {
    const t = setup();
    const r = await t.ops.tune('p', { set: ['max-num-seqs=4'], dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.calls('/reload')).toHaveLength(0);
  });

  it('--save con max-model-len: aggiorna argomenti e contesto del profilo', async () => {
    const t = setup();
    const r = await t.ops.tune('p', { set: ['max-model-len=32768'], yes: true, save: true });
    expect(t.ask).not.toHaveBeenCalled();
    expect(r.saved).toBe(true);
    const p = t.store.readProfile('p');
    expect(p.context).toBe(32768);
    expect(p.vllm.args).toEqual(expect.arrayContaining(['--max-model-len', '32768']));
  });

  it('reload fallito (vLLM in errore): propone di tornare agli argomenti precedenti e li ricarica', async () => {
    const t = setup({ onReload: (_args, n) => (n === 1 ? 'error' : 'ready') }, { answers: [true, true] });
    await expect(t.ops.tune('p', { set: ['max-num-seqs=4'] })).rejects.toMatchObject({ code: 'VLLM_ERROR', details: expect.objectContaining({ reverted: true }) });
    expect(t.ask.mock.calls[1][0]).toMatch(/Tornare agli argomenti precedenti/);
    const reloads = t.calls('/reload', 'POST');
    expect(reloads).toHaveLength(2);
    expect(reloads[1][2].json.args).toEqual(ACTIVE_ARGS);
  });

  it('reload fallito e ritorno rifiutato: nessun secondo reload', async () => {
    const t = setup({ onReload: () => 'error' }, { answers: [true, false] });
    await expect(t.ops.tune('p', { set: ['max-num-seqs=4'] })).rejects.toMatchObject({ details: expect.objectContaining({ reverted: false }) });
    expect(t.calls('/reload', 'POST')).toHaveLength(1);
  });

  it('smoke test fallito dopo il reload: stesso percorso di ritorno', async () => {
    const t = setup({ smoke: [false, true] }, { answers: [true, true] });
    await expect(t.ops.tune('p', { set: ['max-num-seqs=4'] })).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t.calls('/reload', 'POST')).toHaveLength(2);
  });

  it('confirmed: nessuna domanda per la ricarica, ma il ritorno agli argomenti precedenti resta una domanda', async () => {
    const t = setup({ onReload: (_a, n) => (n === 1 ? 'error' : 'ready') }, { answers: [false] });
    await expect(t.ops.tune('p', { set: ['max-num-seqs=4'], confirmed: true })).rejects.toMatchObject({ details: expect.objectContaining({ reverted: false }) });
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(t.ask.mock.calls[0][0]).toMatch(/Tornare agli argomenti precedenti/);
  });

  it('il supervisore rifiuta il reload (409) → errore, nessun ritorno necessario', async () => {
    const t = setup({ reloadStatus: 409 });
    await expect(t.ops.tune('p', { set: ['max-num-seqs=4'], yes: true })).rejects.toMatchObject({ code: 'HTTP' });
  });
});

describe('ops.upPreview e up con GPU scelta e prezzo atteso', () => {
  const noPods = { pods: [] };

  it('upPreview: opzioni avviabili ora con costo orario e costo massimo secondo il watchdog', async () => {
    const t = setup(noPods);
    const r = await t.ops.upPreview('p');
    expect(r.options.map((o) => o.gpu.id)).toEqual(['GPU80', 'GPU96']);
    expect(r.options[0]).toMatchObject({ gpu: { id: 'GPU80', count: 1, dataCenterId: 'EU-A' }, hourlyUSD: 1.5, maxCostUSD: 12, availability: 'HIGH', memoryGiB: 80 });
    expect(r.watchdog).toEqual({ idleMinutes: 30, maxHours: 8 });
    expect(r.balanceUSD).toBe(50);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('upPreview segnala un Pod già attivo', async () => {
    const t = setup();
    const r = await t.ops.upPreview('p');
    expect(r.activePod).toMatchObject({ podId: 'pod1' });
  });

  it('up con gpu, prezzo atteso uguale e costo già confermato: nessuna domanda di costo, crea sulla GPU scelta', async () => {
    const t = setup(noPods);
    const r = await t.ops.up('p', { gpu: { id: 'GPU96', count: 1 }, expectedHourlyUSD: 2.5, costConfirmed: true });
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.runpod.createPod).toHaveBeenCalledTimes(1);
    expect(t.runpod.createPod.mock.calls[0][0].gpu).toMatchObject({ id: 'GPU96', count: 1 });
    expect(r.candidate.id).toBe('GPU96');
  });

  it('prezzo cambiato rispetto all\'anteprima → errore PRICE_CHANGED, nessun Pod', async () => {
    const t = setup(noPods);
    await expect(t.ops.up('p', { gpu: { id: 'GPU80', count: 1 }, expectedHourlyUSD: 1.2, costConfirmed: true })).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('GPU scelta non più disponibile → NO_GPU_AVAILABLE, nessun Pod', async () => {
    const t = setup(noPods);
    await expect(t.ops.up('p', { gpu: { id: 'GPU141', count: 1 }, expectedHourlyUSD: 3.9, costConfirmed: true })).rejects.toMatchObject({ code: 'NO_GPU_AVAILABLE' });
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('senza costConfirmed la conferma del costo resta una domanda', async () => {
    const t = setup(noPods, { answers: [false] });
    await expect(t.ops.up('p', { gpu: { id: 'GPU80', count: 1 }, expectedHourlyUSD: 1.5 })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(t.ask.mock.calls[0][0]).toMatch(/1,50 \$\/h/);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });
});

describe('ops.keep con preview', () => {
  it('restituisce limiti attuali, nuovi e costo massimo senza domande né chiamate a /watchdog', async () => {
    const t = setup();
    const r = await t.ops.keep('p', { maxHours: 12, preview: true });
    expect(r).toMatchObject({ preview: true, podId: 'pod1', hourlyUSD: 1.5, spendCanIncrease: true, next: { maxSeconds: 43200, remainingSeconds: 39600 } });
    expect(r.maxCostUSD).toBeCloseTo(16.5);
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.calls('/watchdog')).toHaveLength(0);
  });
});

it('redact maschera la chiave del profilo dopo l\'uso', async () => {
  const t = setup();
  await t.ops.logs('p');
  expect(redact(`x ${KEY}`)).not.toContain(KEY);
});
