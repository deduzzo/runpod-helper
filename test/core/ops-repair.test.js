import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOps } from '../../src/core/ops.js';
import { createStore } from '../../src/core/config.js';
import { createEvents } from '../../src/core/events.js';
import { clearSecrets } from '../../src/core/secrets.js';
import * as zcodeModule from '../../src/core/clients/zcode.js';

vi.mock('../../src/core/clients/zcode.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, updateZcode: vi.fn((...a) => actual.updateZcode(...a)) };
});

const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  context: 65536, concurrency: 2, vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1', '--enable-auto-tool-choice', '--tool-call-parser', 'hermes'] },
  parsers: { tool: 'hermes', reasoning: null }, estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 },
  gpu: { id: 'GPU80', count: 1 }, hourlyUSD: 1.5, alternatives: [], elsewhere: [], candidates: [],
  dataCenterId: 'EU-A', cloud: 'SECURE', kvCacheDtype: null, warnings: [], advisor: null,
};

// statusFn({ reloaded, sinceReload, args }) → risposta di /status; logLines: righe del supervisore (con numero progressivo)
function setup({ smokeResults, advisorText, answers = [], statusFn, logLines = [], podOnly = false, advisorFails = false, reloadOk = true, planArgs, planParsers }) {
  clearSecrets();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-rep-')), 'cfg');
  const store = createStore({ dir, platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'v', size: 150, dataCenterId: 'EU-A' } });
  store.writeJson('last-plan.json', { ...plan, vllm: { ...plan.vllm, args: planArgs ?? plan.vllm.args }, parsers: planParsers ?? plan.parsers });
  let deleted = false;
  const runpod = {
    listPods: vi.fn(async () => []), getBalance: vi.fn(async () => ({ balance: 50 })),
    listGpus: vi.fn(async () => [{ id: 'GPU80', price: { secure: 1.5 }, maxCount: { secure: 8 }, memory: 80, dataCenters: [{ id: 'EU-A', availability: 'HIGH' }] }]),
    createPod: vi.fn(async () => ({ status: 201, data: { id: 'pod1' } })),
    getPod: vi.fn(async () => (deleted ? null : { id: 'pod1', status: 'RUNNING', cost: 1.5 })),
    deletePod: vi.fn(async () => { deleted = true; }),
  };
  const smoke = [...smokeResults];
  const sv = { reloaded: false, sinceReload: 0, args: null };
  const defaultStatus = ({ reloaded, sinceReload, args }) => (reloaded && sinceReload === 1 ? { phase: 'loading', args } : { phase: 'ready', kvCacheTokens: 1000, args });
  const http = { request: vi.fn(async (m, url, opts) => {
    if (url.endsWith('/status')) {
      if (sv.reloaded) sv.sinceReload += 1;
      return { ok: true, status: 200, data: (statusFn ?? defaultStatus)({ ...sv }) };
    }
    if (url.includes('/logs')) {
      const since = Number(new URL(url).searchParams.get('since'));
      return { ok: true, status: 200, data: { lines: logLines.filter((l) => l.n > since) } };
    }
    if (url.endsWith('/reload')) {
      if (!reloadOk) return { ok: false, status: 409, data: { error: 'ricarica già in corso' } };
      sv.reloaded = true;
      sv.sinceReload = 0;
      sv.args = opts.json.args;
      return { ok: true, status: 202, data: { ok: true } };
    }
    if (url.endsWith('/v1/models')) return { ok: true, status: 200, data: { data: [{ id: 'qwen3-coder' }] } };
    const good = smoke[0];
    if (url.endsWith('/v1/chat/completions')) smoke.shift();
    if (url.endsWith('/v1/messages')) return { ok: true, status: 200, data: { content: good ? [{ type: 'tool_use', name: 'get_weather' }] : [{ type: 'text', text: 'no' }] } };
    return { ok: true, status: 200, data: { choices: [{ message: { tool_calls: good ? [{ function: { name: 'get_weather' } }] : [] } }] } };
  }) };
  const provider = { label: 'finto', podOnly, complete: vi.fn(async () => { if (advisorFails) throw new Error('rete assente'); return { text: advisorText }; }) };
  const advisor = { provider: vi.fn(() => provider) };
  const ask = vi.fn(async () => (answers.length ? answers.shift() : true));
  const events = createEvents();
  const seen = [];
  events.on((e) => seen.push(e));
  const sleep = vi.fn(async () => {});
  const ops = createOps({ store, runpod, hf: {}, http, events, ask, now: (() => { let t = 0; return () => (t += 1000); })(), sleep, zcode: { dir: path.join(dir, 'z'), isRunning: async () => false }, advisor });
  ops.saveProfile('qwen3-coder');
  return { ops, http, provider, advisor, runpod, ask, seen, store, sleep, dir };
}

const FIX = '{"set":{"tool-call-parser":"qwen3_coder"},"rationale":"parser corretto per Qwen3-Coder","warnings":[]}';

describe('up: correzione con il consulente (livello 3)', () => {
  it('smoke test fallito → proposta → reload → nuovo smoke ok', async () => {
    const t = setup({ smokeResults: [false, true], advisorText: FIX });
    const r = await t.ops.up('qwen3-coder', {});
    const reload = t.http.request.mock.calls.find(([, url]) => url.endsWith('/reload'));
    expect(reload[2].json.args).toEqual(expect.arrayContaining(['--tool-call-parser', 'qwen3_coder']));
    expect(r.repairedArgs).toEqual(expect.arrayContaining(['--tool-call-parser', 'qwen3_coder']));
    expect(t.seen.some((e) => e.type === 'advice' && /parser corretto/.test(e.rationale))).toBe(true);
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
    expect(t.ask.mock.calls.map((c) => c[0]).join('\n')).toMatch(/1,50 \$\/h/);
  });

  it('con --yes nessuna correzione automatica: si propone la terminazione', async () => {
    const t = setup({ smokeResults: [false], advisorText: FIX });
    await expect(t.ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t.provider.complete).not.toHaveBeenCalled();
    expect(t.runpod.deletePod).toHaveBeenCalled();
  });

  it('al massimo 3 tentativi', async () => {
    const t = setup({ smokeResults: [false, false, false, false, false], advisorText: FIX });
    await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t.provider.complete).toHaveBeenCalledTimes(3);
    expect(t.runpod.deletePod).toHaveBeenCalled();
  });

  it('consulente senza modifiche applicabili o rifiuto dell\'utente → terminazione proposta', async () => {
    const t = setup({ smokeResults: [false], advisorText: '{"set":{"api-key":"x"}}' });
    await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t.http.request.mock.calls.some(([, url]) => url.endsWith('/reload'))).toBe(false);
    expect(t.runpod.deletePod).toHaveBeenCalled();
    const t2 = setup({ smokeResults: [false], advisorText: FIX, answers: [true, true, false] });
    await expect(t2.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t2.http.request.mock.calls.some(([, url]) => url.endsWith('/reload'))).toBe(false);
    expect(t2.runpod.deletePod).toHaveBeenCalled();
  });

  const OOM_LINES = [{ n: 1, line: 'torch.OutOfMemoryError: CUDA out of memory' }];
  const erroring = ({ reloaded, sinceReload, args }) => (!reloaded ? { phase: 'error', lastError: 'vLLM terminato con codice 1' } : sinceReload === 1 ? { phase: 'loading', args } : { phase: 'ready', kvCacheTokens: 1000, args });

  it('consulente solo-pod: con OOM o VLLM_ERROR nessuna consultazione, si propone la terminazione', async () => {
    for (const logLines of [OOM_LINES, []]) {
      const t = setup({ smokeResults: [true], advisorText: FIX, podOnly: true, statusFn: () => ({ phase: 'error', lastError: 'vLLM terminato con codice 1' }), logLines });
      await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: logLines.length ? 'OOM' : 'VLLM_ERROR' });
      expect(t.provider.complete).not.toHaveBeenCalled();
      expect(t.ask.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/correzione al consulente/);
      expect(t.runpod.deletePod).toHaveBeenCalled();
    }
  });

  it('consulente che lancia → avviso e terminazione proposta', async () => {
    const t = setup({ smokeResults: [false], advisorText: FIX, advisorFails: true });
    await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t.seen.some((e) => e.type === 'warning' && /Consulente non disponibile: rete assente/.test(e.message))).toBe(true);
    expect(t.http.request.mock.calls.some(([, url]) => url.endsWith('/reload'))).toBe(false);
    expect(t.runpod.deletePod).toHaveBeenCalled();
  });

  it('reload non ok → avviso e terminazione proposta', async () => {
    const t = setup({ smokeResults: [false], advisorText: FIX, reloadOk: false });
    await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t.seen.some((e) => e.type === 'warning' && /Riavvio di vLLM non riuscito \(HTTP 409\)/.test(e.message))).toBe(true);
    expect(t.runpod.deletePod).toHaveBeenCalled();
  });

  it('riparazione partita da un errore di waitForReady (OOM), non dallo smoke', async () => {
    const t = setup({ smokeResults: [true], advisorText: FIX, statusFn: erroring, logLines: OOM_LINES });
    const r = await t.ops.up('qwen3-coder', {});
    expect(t.ask.mock.calls.map((c) => c[0]).join('\n')).toMatch(/Avvio non riuscito \(OOM\)/);
    expect(t.provider.complete).toHaveBeenCalledTimes(1);
    expect(t.provider.complete.mock.calls[0][0].user).toMatch(/OOM/);
    expect(r.repairedArgs).toEqual(expect.arrayContaining(['--tool-call-parser', 'qwen3_coder']));
    expect(t.http.request.mock.calls.filter(([, url]) => url.endsWith('/v1/chat/completions'))).toHaveLength(1); // un solo smoke, dopo il riavvio
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
  });

  it('dopo il reload attende args nuovi e fase non ready (60 s, ogni 2 s), poi waitForReady', async () => {
    const seq = [{ phase: 'ready', args: ['vecchi'] }];
    const statusFn = ({ reloaded, args }) => {
      if (!reloaded) return { phase: 'ready', kvCacheTokens: 1000, args: ['vecchi'] };
      seq.push(seq.length === 1 ? { phase: 'ready', args: ['vecchi'] } : seq.length === 2 ? { phase: 'loading', args } : { phase: 'ready', kvCacheTokens: 1000, args });
      return seq[seq.length - 1];
    };
    const t = setup({ smokeResults: [false, true], advisorText: FIX, statusFn });
    const r = await t.ops.up('qwen3-coder', {});
    // dopo il reload: 1) ready con args vecchi (scartata), 2) loading con args nuovi (attesa finita), 3) ready letta da waitForReady
    expect(seq.map((x) => x.phase)).toEqual(['ready', 'ready', 'loading', 'ready']);
    expect(t.sleep.mock.calls.map((c) => c[0])).toContain(2000);
    expect(t.sleep.mock.calls.map((c) => c[0])).not.toContain(10_000);
    expect(r.repairedArgs).toBeTruthy();
  });

  it('se il supervisore non conferma il riavvio entro 60 s → avviso, nessun nuovo tentativo, terminazione proposta', async () => {
    const statusFn = () => ({ phase: 'ready', kvCacheTokens: 1000, args: ['vecchi'] });
    const t = setup({ smokeResults: [false, true], advisorText: FIX, statusFn });
    await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t.seen.some((e) => e.type === 'warning' && /60 secondi/.test(e.message))).toBe(true);
    expect(t.sleep.mock.calls.filter((c) => c[0] === 2000).length).toBeGreaterThan(20);
    expect(t.http.request.mock.calls.filter(([, url]) => url.endsWith('/v1/chat/completions'))).toHaveLength(1);
    expect(t.runpod.deletePod).toHaveBeenCalled();
  });

  it('se dopo il reload la fase è error l\'attesa finisce e waitForReady riporta l\'errore', async () => {
    const statusFn = ({ reloaded }) => (reloaded ? { phase: 'error', lastError: 'boom' } : { phase: 'ready', kvCacheTokens: 1000 });
    const t = setup({ smokeResults: [false], advisorText: FIX, statusFn, answers: [true, true, true, false] });
    await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'VLLM_ERROR' });
    expect(t.provider.complete).toHaveBeenCalledTimes(1);
  });

  it('dopo il riavvio i log ripartono dal cursore: un vecchio OOM non classifica il nuovo errore', async () => {
    const statusFn = ({ reloaded, sinceReload, args }) => {
      if (!reloaded) return { phase: 'error', lastError: 'vLLM terminato con codice 1' };
      return sinceReload === 1 ? { phase: 'loading', args } : { phase: 'error', lastError: 'altro errore' };
    };
    const t = setup({ smokeResults: [true], advisorText: FIX, statusFn, logLines: OOM_LINES, answers: [true, true, true, false] });
    await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'VLLM_ERROR' });
    const asks = t.ask.mock.calls.map((c) => c[0]).join('\n');
    expect(asks).toMatch(/Avvio non riuscito \(OOM\)/);
    expect(asks).toMatch(/Avvio non riuscito \(VLLM_ERROR\)/);
    const since = t.http.request.mock.calls.filter(([, url]) => url.includes('/logs')).map(([, url]) => new URL(url).searchParams.get('since'));
    expect(since[0]).toBe('0');
    expect(since.slice(1).every((x) => x === '1')).toBe(true);
  });

  it('smoke fallito: dopo il reload i log ripartono dal cursore della waitForReady riuscita', async () => {
    const t = setup({ smokeResults: [false, true], advisorText: FIX, logLines: [{ n: 1, line: 'a' }, { n: 2, line: 'b' }, { n: 3, line: 'c' }] });
    await t.ops.up('qwen3-coder', {});
    const since = t.http.request.mock.calls.filter(([, url]) => url.includes('/logs')).map(([, url]) => new URL(url).searchParams.get('since'));
    expect(since).toEqual(['0', '3']);
  });

  it('Pod in terminazione (watchdog): nessuna riparazione, si propone la terminazione', async () => {
    const t = setup({ smokeResults: [true], advisorText: FIX, statusFn: () => ({ phase: 'terminating', terminateReason: 'idle' }), logLines: OOM_LINES });
    await expect(t.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'OOM', details: { terminating: true } });
    expect(t.provider.complete).not.toHaveBeenCalled();
    expect(t.ask.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/correzione al consulente/);
    expect(t.runpod.deletePod).toHaveBeenCalled();
  });

  it('saveProfileArgs riporta il tensor parallel del profilo', () => {
    const t = setup({ smokeResults: [true], advisorText: FIX });
    t.ops.saveProfileArgs('qwen3-coder', ['--max-model-len', '65536', '--tensor-parallel-size', '2', '--tool-call-parser', 'qwen3_coder']);
    // syncDerivedFields aggiunge --enable-auto-tool-choice insieme a --tool-call-parser
    expect(t.store.readProfile('qwen3-coder').vllm.args).toEqual(['--max-model-len', '65536', '--tensor-parallel-size', '1', '--tool-call-parser', 'qwen3_coder', '--enable-auto-tool-choice']);
  });

  it('saveProfileArgs riallinea parsers e kvCacheDtype del profilo', () => {
    const t = setup({ smokeResults: [true], advisorText: FIX });
    const p = t.ops.saveProfileArgs('qwen3-coder', ['--max-model-len', '65536', '--tool-call-parser', 'qwen3_coder', '--reasoning-parser', 'qwen3', '--kv-cache-dtype', 'fp8']);
    expect(p.parsers).toEqual({ tool: 'qwen3_coder', reasoning: 'qwen3' });
    expect(p.kvCacheDtype).toBe('fp8');
    const saved = t.store.readProfile('qwen3-coder');
    expect(saved.parsers.reasoning).toBe('qwen3');
    expect(saved.kvCacheDtype).toBe('fp8');
  });
});

describe('up: argomenti riallineati prima del reload (livello 3)', () => {
  const reloadArgs = (t) => t.http.request.mock.calls.find(([, url]) => url.endsWith('/reload'))[2].json.args;

  it('proposta tool-call-parser: false → il reload non contiene --enable-auto-tool-choice', async () => {
    const t = setup({ smokeResults: [false, true], advisorText: '{"set":{"tool-call-parser":false},"rationale":"niente parser","warnings":[]}' });
    const r = await t.ops.up('qwen3-coder', {});
    expect(reloadArgs(t)).not.toContain('--tool-call-parser');
    expect(reloadArgs(t)).not.toContain('--enable-auto-tool-choice');
    expect(r.repairedArgs).toEqual(reloadArgs(t));
    // il diff mostrato all'utente riflette ciò che viene davvero applicato
    const advice = t.seen.find((e) => e.type === 'advice');
    expect(advice.changes.removed).toEqual(expect.arrayContaining(['--tool-call-parser', '--enable-auto-tool-choice']));
  });

  it('proposta che aggiunge tool-call-parser → il reload contiene anche --enable-auto-tool-choice', async () => {
    const t = setup({
      smokeResults: [false, true], advisorText: '{"set":{"tool-call-parser":"qwen3_coder"},"rationale":"r","warnings":[]}',
      planArgs: ['--max-model-len', '65536', '--tensor-parallel-size', '1'], planParsers: { tool: null, reasoning: null },
    });
    const r = await t.ops.up('qwen3-coder', {});
    expect(reloadArgs(t)).toEqual(expect.arrayContaining(['--tool-call-parser', 'qwen3_coder', '--enable-auto-tool-choice']));
    expect(r.repairedArgs).toEqual(reloadArgs(t));
    // l'attesa post-reload ha usato gli stessi argomenti: nessun avviso di mancata conferma
    expect(t.seen.some((e) => e.type === 'warning' && /60 secondi/.test(e.message))).toBe(false);
  });

  it('proposta che aggiunge reasoning-parser → la configurazione ZCode scritta riflette il nuovo reasoning', async () => {
    const t = setup({
      smokeResults: [false, true], advisorText: '{"set":{"reasoning-parser":"qwen3"},"rationale":"r","warnings":[]}',
      planParsers: { tool: 'hermes', reasoning: null },
    });
    fs.mkdirSync(path.join(t.dir, 'z'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'z', 'config.json'), JSON.stringify({ provider: { llmpod: {} } }));
    zcodeModule.updateZcode.mockClear();
    await t.ops.up('qwen3-coder', {});
    expect(zcodeModule.updateZcode).toHaveBeenCalledTimes(1);
    expect(zcodeModule.updateZcode.mock.calls[0][0].reasoning).toBe(true);
  });

  it('senza riparazione il reasoning resta quello del profilo', async () => {
    const t = setup({ smokeResults: [true], advisorText: FIX, planParsers: { tool: 'hermes', reasoning: null } });
    fs.mkdirSync(path.join(t.dir, 'z'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'z', 'config.json'), JSON.stringify({ provider: { llmpod: {} } }));
    zcodeModule.updateZcode.mockClear();
    await t.ops.up('qwen3-coder', {});
    expect(zcodeModule.updateZcode.mock.calls[0][0].reasoning).toBe(false);
  });
});
