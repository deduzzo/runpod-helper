import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, READ_ONLY_TOOLS } from '../../src/mcp/server.js';
import { validateInput } from '../../src/mcp/schema.js';
import { createWorld, KEY, RUNPOD_KEY, HF_TOKEN, ACTIVE_ARGS } from '../fixtures/fake-world.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const hfFake = () => ({
  getModel: vi.fn(async () => fx('model-qwen3-coder-30b.json')),
  resolveSha: vi.fn(async () => 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120'),
  listFiles: vi.fn(async () => fx('tree-qwen3-coder-30b.json')),
  getConfig: vi.fn(async () => fx('config-qwen3-coder-30b.json')),
  searchModels: vi.fn(async () => [
    { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', params: 30.5e9, paramsByDtype: { BF16: 30.5e9 }, dtypes: ['BF16'], license: 'apache-2.0', gated: false, downloads: 1000, lastModified: '2025-07-31T00:00:00.000Z', architectures: ['Qwen3MoeForCausalLM'], modelType: 'qwen3_moe', hasChatTemplate: true },
  ]),
});

const SECRETS = [KEY, RUNPOD_KEY, HF_TOKEN];
const noSecrets = (value) => {
  const text = JSON.stringify(value);
  for (const s of SECRETS) expect(text).not.toContain(s);
};

function setup(worldOpts = {}, { questionTimeoutMs } = {}) {
  const w = createWorld(worldOpts);
  const hf = hfFake();
  const sleep = vi.fn(async () => {});
  const mcp = createMcpServer({ env: w.env, overrides: { runpod: w.runpod, http: w.http, hf, sleep }, questionTimeoutMs });
  const call = async (name, args = {}) => {
    const r = await mcp.callTool(name, args);
    noSecrets(r);
    return { isError: Boolean(r.isError), data: JSON.parse(r.content[0].text) };
  };
  // Attende che il job esca da "running" (o abbia una domanda pendente).
  const settle = async (jobId) => {
    for (let i = 0; i < 200; i++) {
      const { data } = await call('job_status', { jobId });
      if (data.job.status !== 'running' || data.job.question) return data.job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('job non concluso');
  };
  return { ...w, hf, mcp, call, settle };
}

describe('validateInput (JSON Schema essenziale)', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', minLength: 1 }, n: { type: 'integer', minimum: 1, maximum: 5 }, ok: { const: true }, x: { type: ['boolean', 'string', 'null'] }, l: { type: 'array', items: { type: 'string' } } } };
  it('accetta input validi e rifiuta tipi, limiti, campi mancanti o in più', () => {
    expect(() => validateInput(schema, { a: 'x', n: 3, ok: true, x: null, l: ['a'] })).not.toThrow();
    for (const bad of [{}, { a: '' }, { a: 'x', n: 0 }, { a: 'x', n: 2.5 }, { a: 'x', ok: false }, { a: 'x', x: 3 }, { a: 'x', l: [1] }, { a: 'x', z: 1 }, null]) {
      expect(() => validateInput(schema, bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });
});

describe('server MCP: elenco strumenti', () => {
  it('tutti gli strumenti richiesti, con JSON Schema e annotazioni di sola lettura coerenti con i permessi', () => {
    const t = setup();
    const names = t.mcp.tools.map((x) => x.name).sort();
    expect(names).toEqual(['client_commands', 'down', 'job_answer', 'job_events', 'job_status', 'keep', 'keep_preview', 'logs', 'metrics', 'model_sets', 'plan', 'profiles', 'save_profile', 'search', 'status', 'tune', 'tune_preview', 'up', 'up_preview'].sort());
    for (const tool of t.mcp.tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.annotations.readOnlyHint, tool.name).toBe(READ_ONLY_TOOLS.includes(tool.name));
    }
    for (const name of ['up', 'tune', 'keep', 'down']) {
      expect(t.mcp.tools.find((x) => x.name === name).inputSchema.required).toContain('confirm');
    }
  });

  it('funziona tramite il protocollo MCP (client in memoria): tools/list e tools/call', async () => {
    const t = setup();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await t.mcp.server.connect(a);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.find((x) => x.name === 'status').annotations.readOnlyHint).toBe(true);
    const r = await client.callTool({ name: 'status', arguments: {} });
    expect(JSON.parse(r.content[0].text).running[0].podId).toBe('pod1');
    const bad = await client.callTool({ name: 'down', arguments: { profile: 'p' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

describe('strumenti di sola lettura', () => {
  it('model_sets: elenco dei set e modelli di un set con il riferimento per plan', async () => {
    const t = setup();
    const all = await t.call('model_sets');
    expect(all.data.sets.length).toBeGreaterThan(0);
    const id = all.data.sets[0].id;
    const one = await t.call('model_sets', { set: id });
    expect(one.data.set).toBe(id);
    expect(one.data.warning).toBeTruthy();
    expect(one.data.models[0]).toMatchObject({ n: 1, planRef: `${id}/${one.data.models[0].key}` });
    expect((await t.call('model_sets', { set: 'inesistente' })).isError).toBe(true);
  });

  it('search: righe di Hugging Face', async () => {
    const t = setup();
    const r = await t.call('search', { query: 'qwen coder', limit: 5 });
    expect(r.data.rows[0].id).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');
  });

  it('plan: stima, opzioni GPU con prezzo e disponibilità, argomenti; salva last-plan.json', async () => {
    const t = setup();
    const r = await t.call('plan', { model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', context: 32768 });
    expect(r.isError).toBe(false);
    expect(r.data.estimate.perGpuGiB).toBeGreaterThan(0);
    expect(r.data.options[0]).toMatchObject({ id: 'GPU80', hourlyUSD: 1.5, availabilityHere: 'HIGH' });
    expect(r.data.vllmArgs).toEqual(expect.arrayContaining(['--max-model-len', '32768']));
    expect(r.data.mtp).toBeDefined();
    expect(t.store.readJson('last-plan.json', null)).toBeTruthy();
  });

  it('profiles: profili salvati, senza chiavi', async () => {
    const t = setup();
    const r = await t.call('profiles');
    expect(r.data.profiles[0]).toMatchObject({ name: 'p', model: 'org/modello-mtp', context: 65536, gpu: { id: 'GPU80', count: 1 } });
  });

  it('status: Pod raggruppati in avviati/in avvio/spenti/in eliminazione', async () => {
    const t = setup({ pods: [
      { id: 'pod1', name: 'llmpod-p', status: 'RUNNING', cost: 1.5, gpu: { id: 'GPU80', count: 1 } },
      { id: 'pod2', name: 'llmpod-q', status: 'EXITED', cost: 0, gpu: { id: 'GPU80', count: 1 } },
      { id: 'pod3', name: 'llmpod-r', status: 'CREATED', cost: 1.5, gpu: { id: 'GPU80', count: 1 } },
    ] });
    const r = await t.call('status');
    expect(r.data.running.map((p) => p.podId)).toEqual(['pod1']);
    expect(r.data.stopped.map((p) => p.podId)).toEqual(['pod2']);
    expect(r.data.starting.map((p) => p.podId)).toEqual(['pod3']);
    expect(r.data.terminating).toEqual([]);
    expect(r.data.balanceUSD).toBe(50);
  });

  it('metrics e logs: dati del Pod, log mascherati', async () => {
    const t = setup();
    const m = await t.call('metrics', { profile: 'p', window: 2 });
    expect(m.data.metrics.throughput.generationTokensPerSec).toBe(500);
    const l = await t.call('logs', { profile: 'p' });
    expect(l.data.lines.map((x) => x.n)).toEqual([1, 2, 3]);
  });

  it('client_commands: comandi llmpod run, mai la chiave', async () => {
    const t = setup();
    const r = await t.call('client_commands', { profile: 'p' });
    expect(r.data.commands.claude).toMatch(/llmpod run claude --profile p/);
    expect(r.data.commands.zcode).toMatch(/llmpod run zcode --profile p/);
    expect(JSON.stringify(r.data)).not.toMatch(/LLMPOD_API_KEY=|ANTHROPIC_AUTH_TOKEN=/);
  });
});

describe('up: nessuna spesa senza conferma esplicita e al prezzo mostrato', () => {
  const noPods = { pods: [] };

  it('up_preview: opzioni con costo orario e massimo; nessun Pod creato', async () => {
    const t = setup(noPods);
    const r = await t.call('up_preview', { profile: 'p' });
    expect(r.data.options[0]).toMatchObject({ gpu: { id: 'GPU80', count: 1, dataCenterId: 'EU-A' }, hourlyUSD: 1.5, maxCostUSD: 12 });
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('senza confirm: true → errore, nessun job e nessun Pod', async () => {
    const t = setup(noPods);
    for (const args of [{ profile: 'p', gpu: { id: 'GPU80', count: 1 }, expectedHourlyUSD: 1.5 }, { profile: 'p', gpu: { id: 'GPU80', count: 1 }, expectedHourlyUSD: 1.5, confirm: false }]) {
      const r = await t.call('up', args);
      expect(r.isError).toBe(true);
    }
    expect(t.mcp.jobs.list()).toEqual([]);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('prezzo diverso da up_preview → errore "il prezzo è cambiato", nessun Pod', async () => {
    const t = setup(noPods);
    const r = await t.call('up', { profile: 'p', gpu: { id: 'GPU80', count: 1 }, confirm: true, expectedHourlyUSD: 1.2 });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('PRICE_CHANGED');
    expect(r.data.error.message).toMatch(/prezzo è cambiato/);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('con conferma e prezzo giusto parte in background: jobId, eventi con seq, esito', async () => {
    const t = setup(noPods);
    const r = await t.call('up', { profile: 'p', gpu: { id: 'GPU80', count: 1 }, confirm: true, expectedHourlyUSD: 1.5 });
    expect(r.isError).toBe(false);
    expect(r.data.jobId).toBeTruthy();
    const job = await t.settle(r.data.jobId);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ podId: 'pod1', candidate: { id: 'GPU80' } });
    const ev = await t.call('job_events', { jobId: r.data.jobId });
    expect(ev.data.events.length).toBeGreaterThan(2);
    const seqs = ev.data.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(ev.data.events.some((e) => e.type === 'phase')).toBe(true);
    expect(ev.data.events.some((e) => e.type === 'log')).toBe(false);
    const withLogs = await t.call('job_events', { jobId: r.data.jobId, includeLogs: true });
    expect(withLogs.data.events.map((e) => e.seq)).toEqual([...withLogs.data.events.keys()]);
    expect(withLogs.data.events.some((e) => e.type === 'log')).toBe(true);
    expect(ev.data.nextSince).toBe(withLogs.data.events.length);
    const later = await t.call('job_events', { jobId: r.data.jobId, since: 2 });
    expect(later.data.events[0].seq).toBe(2);
    expect(t.runpod.createPod).toHaveBeenCalledTimes(1);
  });

  it('domanda del core (Pod spento da eliminare) → pendente; job_answer la risolve', async () => {
    const t = setup({ pods: [{ id: 'old', name: 'llmpod-p', status: 'EXITED', cost: 0 }] });
    const r = await t.call('up', { profile: 'p', gpu: { id: 'GPU80', count: 1 }, confirm: true, expectedHourlyUSD: 1.5 });
    const job = await t.settle(r.data.jobId);
    expect(job.question).toMatchObject({ kind: 'confirm', text: expect.stringMatching(/Pod spento/) });
    const bad = await t.call('job_answer', { jobId: r.data.jobId, questionId: job.question.id, answer: 'forse' });
    expect(bad.isError).toBe(true);
    const ok = await t.call('job_answer', { jobId: r.data.jobId, questionId: job.question.id, answer: false });
    expect(ok.data.ok).toBe(true);
    const end = await t.settle(r.data.jobId);
    expect(end.status).toBe('failed');
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('un secondo up sullo stesso profilo mentre il primo è in corso → errore', async () => {
    const t = setup({ pods: [{ id: 'old', name: 'llmpod-p', status: 'EXITED', cost: 0 }] });
    const args = { profile: 'p', gpu: { id: 'GPU80', count: 1 }, confirm: true, expectedHourlyUSD: 1.5 };
    const first = await t.call('up', args);
    await t.settle(first.data.jobId);
    expect((await t.call('up', args)).isError).toBe(true);
    expect((await t.call('tune', { profile: 'p', set: ['max-num-seqs=4'], confirm: true })).isError).toBe(true);
  });
});

describe('tune, keep, down', () => {
  it('tune_preview non ricarica; tune senza confirm → errore', async () => {
    const t = setup();
    const p = await t.call('tune_preview', { profile: 'p', set: ['max-num-seqs=4'] });
    expect(p.data.changes.added).toEqual(['--max-num-seqs 4']);
    expect((await t.call('tune', { profile: 'p', set: ['max-num-seqs=4'] })).isError).toBe(true);
    expect(t.calls('/reload')).toHaveLength(0);
  });

  it('tune con confirm: job in background che ricarica e salva', async () => {
    const t = setup();
    const r = await t.call('tune', { profile: 'p', set: ['max-model-len=32768'], confirm: true, save: true });
    const job = await t.settle(r.data.jobId);
    expect(job.status).toBe('done');
    expect(t.calls('/reload', 'POST')[0][2].json.args).toEqual(expect.arrayContaining(['--max-model-len', '32768']));
    expect(t.store.readProfile('p').context).toBe(32768);
  });

  it('tune fallito: il ritorno agli argomenti precedenti è una domanda pendente', async () => {
    const t = setup({ onReload: (_a, n) => (n === 1 ? 'error' : 'ready') });
    const r = await t.call('tune', { profile: 'p', set: ['max-num-seqs=4'], confirm: true });
    const job = await t.settle(r.data.jobId);
    expect(job.question.text).toMatch(/Tornare agli argomenti precedenti/);
    await t.call('job_answer', { jobId: r.data.jobId, questionId: job.question.id, answer: true });
    const end = await t.settle(r.data.jobId);
    expect(end.status).toBe('failed');
    expect(t.calls('/reload', 'POST').at(-1)[2].json.args).toEqual(ACTIVE_ARGS);
  });

  it('keep_preview mostra il costo massimo; keep senza confirm → errore; con confirm applica', async () => {
    const t = setup();
    const p = await t.call('keep_preview', { profile: 'p', maxHours: 12 });
    expect(p.data.maxCostUSD).toBeCloseTo(16.5);
    expect(t.calls('/watchdog')).toHaveLength(0);
    expect((await t.call('keep', { profile: 'p', maxHours: 12 })).isError).toBe(true);
    const k = await t.call('keep', { profile: 'p', maxHours: 12, confirm: true });
    expect(k.data.maxSeconds).toBe(43200);
    expect(t.calls('/watchdog', 'POST')).toHaveLength(1);
  });

  it('down: senza confirm errore; con confirm ELIMINA il Pod e restituisce l\'elenco completo dei Pod', async () => {
    const t = setup();
    expect((await t.call('down', { profile: 'p' })).isError).toBe(true);
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
    const r = await t.call('down', { profile: 'p', confirm: true });
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(r.data.podIds).toEqual(['pod1']);
    expect(Array.isArray(r.data.allPods)).toBe(true);
  });

  it('save_profile salva l\'ultimo piano con la GPU scelta', async () => {
    const t = setup();
    await t.call('plan', { model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', context: 32768 });
    const r = await t.call('save_profile', { name: 'coder', gpu: { id: 'GPU80', count: 1 } });
    expect(r.data.profile).toMatchObject({ name: 'coder', gpu: { id: 'GPU80', count: 1 } });
    expect(t.store.readEnv().LLMPOD_KEY_CODER).toBeTruthy();
  });
});

describe('errori', () => {
  it('input non valido o strumento sconosciuto → errore strutturato', async () => {
    const t = setup();
    const r = await t.call('metrics', { profile: 'p', window: 999 });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('INVALID_INPUT');
    expect((await t.call('boh')).isError).toBe(true);
  });
});
