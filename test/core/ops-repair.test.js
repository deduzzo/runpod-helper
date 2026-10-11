import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOps } from '../../src/core/ops.js';
import { createStore } from '../../src/core/config.js';
import { createEvents } from '../../src/core/events.js';
import { clearSecrets } from '../../src/core/secrets.js';

const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  context: 65536, concurrency: 2, vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1', '--enable-auto-tool-choice', '--tool-call-parser', 'hermes'] },
  parsers: { tool: 'hermes', reasoning: null }, estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 },
  gpu: { id: 'GPU80', count: 1 }, hourlyUSD: 1.5, alternatives: [], elsewhere: [], candidates: [],
  dataCenterId: 'EU-A', cloud: 'SECURE', kvCacheDtype: null, warnings: [], advisor: null,
};

function setup({ smokeResults, advisorText, answers = [] }) {
  clearSecrets();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-rep-')), 'cfg');
  const store = createStore({ dir, platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'v', size: 150, dataCenterId: 'EU-A' } });
  store.writeJson('last-plan.json', plan);
  let deleted = false;
  const runpod = {
    listPods: vi.fn(async () => []), getBalance: vi.fn(async () => ({ balance: 50 })),
    listGpus: vi.fn(async () => [{ id: 'GPU80', price: { secure: 1.5 }, maxCount: { secure: 8 }, memory: 80, dataCenters: [{ id: 'EU-A', availability: 'HIGH' }] }]),
    createPod: vi.fn(async () => ({ status: 201, data: { id: 'pod1' } })),
    getPod: vi.fn(async () => (deleted ? null : { id: 'pod1', status: 'RUNNING', cost: 1.5 })),
    deletePod: vi.fn(async () => { deleted = true; }),
  };
  const smoke = [...smokeResults];
  const http = { request: vi.fn(async (m, url, opts) => {
    if (url.endsWith('/status')) return { ok: true, status: 200, data: { phase: 'ready', kvCacheTokens: 1000 } };
    if (url.includes('/logs')) return { ok: true, status: 200, data: { lines: [] } };
    if (url.endsWith('/reload')) return { ok: true, status: 202, data: { ok: true } };
    if (url.endsWith('/v1/models')) return { ok: true, status: 200, data: { data: [{ id: 'qwen3-coder' }] } };
    const good = smoke[0];
    if (url.endsWith('/v1/chat/completions')) smoke.shift();
    if (url.endsWith('/v1/messages')) return { ok: true, status: 200, data: { content: good ? [{ type: 'tool_use', name: 'get_weather' }] : [{ type: 'text', text: 'no' }] } };
    return { ok: true, status: 200, data: { choices: [{ message: { tool_calls: good ? [{ function: { name: 'get_weather' } }] : [] } }] } };
  }) };
  const provider = { label: 'finto', complete: vi.fn(async () => ({ text: advisorText })) };
  const advisor = { provider: vi.fn(() => provider) };
  const ask = vi.fn(async () => (answers.length ? answers.shift() : true));
  const events = createEvents();
  const seen = [];
  events.on((e) => seen.push(e));
  const ops = createOps({ store, runpod, hf: {}, http, events, ask, now: (() => { let t = 0; return () => (t += 1000); })(), sleep: async () => {}, zcode: { dir: path.join(dir, 'z'), isRunning: async () => false }, advisor });
  ops.saveProfile('qwen3-coder');
  return { ops, http, provider, advisor, runpod, ask, seen, store };
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
    const t2 = setup({ smokeResults: [false], advisorText: FIX, answers: [true, true, false] });
    await expect(t2.ops.up('qwen3-coder', {})).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(t2.http.request.mock.calls.some(([, url]) => url.endsWith('/reload'))).toBe(false);
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
