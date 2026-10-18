import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, READ_ONLY_TOOLS } from '../../src/mcp/server.js';
import { COSTLY_QUESTION_TIMEOUT_MS } from '../../src/mcp/tools.js';
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

// sleep "lento" (cede il ciclo degli eventi): per i job che restano in attesa (vLLM mai pronto).
const yieldSleep = () => new Promise((r) => setTimeout(r, 1));

function setup(worldOpts = {}, { questionTimeoutMs, sleep = vi.fn(async () => {}) } = {}) {
  const w = createWorld(worldOpts);
  const hf = hfFake();
  const logs = [];
  const mcp = createMcpServer({ env: w.env, overrides: { runpod: w.runpod, http: w.http, hf, sleep }, questionTimeoutMs, log: (m) => logs.push(m) });
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
  // Attende un evento del job (es. 'pod').
  const until = async (jobId, type) => {
    for (let i = 0; i < 500; i++) {
      const { data } = await call('job_events', { jobId });
      if (data.events.some((e) => e.type === type)) return;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`evento ${type} non arrivato`);
  };
  return { ...w, hf, mcp, call, settle, until, logs };
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
    expect(names).toEqual(['client_commands', 'down', 'job_answer', 'job_cancel', 'job_events', 'job_status', 'keep', 'keep_preview', 'logs', 'metrics', 'model_sets', 'plan', 'profiles', 'save_profile', 'search', 'status', 'tune', 'tune_preview', 'up', 'up_preview'].sort());
    for (const tool of t.mcp.tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.annotations.readOnlyHint, tool.name).toBe(READ_ONLY_TOOLS.includes(tool.name));
    }
    expect(t.mcp.tools.find((x) => x.name === 'plan').inputSchema.properties.advisor).toBeUndefined();
    for (const name of ['up', 'tune', 'keep', 'down', 'job_cancel']) {
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
    expect(r.data.note).toMatch(/--cwd <cartella>/);
    expect(r.data.withoutGlobalCommand).toMatch(/run <client> --profile p/);
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

  it('wait: GPU non disponibile ora (waitable) → il job attende la disponibilità e poi crea il Pod', async () => {
    const t = setup(noPods);
    const preview = await t.call('up_preview', { profile: 'p' });
    expect(preview.data.waitable[0]).toMatchObject({ gpu: { id: 'GPU141', count: 1 }, hourlyUSD: 3.9 });
    // senza wait resta l'errore di oggi
    expect((await t.call('up', { profile: 'p', gpu: { id: 'GPU141', count: 1 }, confirm: true, expectedHourlyUSD: 3.9 })).data.error.code).toBe('NO_GPU_AVAILABLE');
    let checks = 0;
    const base = t.runpod.listGpus.getMockImplementation();
    t.runpod.listGpus.mockImplementation(async (q) => {
      const list = await base(q);
      if (q.count !== 1) return list;
      checks++;
      return checks > 3 ? list.map((g) => (g.id === 'GPU141' ? { ...g, dataCenters: [{ id: 'EU-A', availability: 'HIGH' }] } : g)) : list;
    });
    const r = await t.call('up', { profile: 'p', gpu: { id: 'GPU141', count: 1 }, confirm: true, expectedHourlyUSD: 3.9, wait: true });
    expect(r.isError).toBe(false);
    const job = await t.settle(r.data.jobId);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ candidate: { id: 'GPU141' } });
    const ev = await t.call('job_events', { jobId: r.data.jobId });
    expect(ev.data.events.some((e) => e.type === 'phase' && /In attesa di GPU141/.test(e.message))).toBe(true);
  });

  it('wait: job_cancel durante l\'attesa ferma il job, nessun Pod creato', async () => {
    const t = setup(noPods, { sleep: yieldSleep });
    const r = await t.call('up', { profile: 'p', gpu: { id: 'GPU141', count: 1 }, confirm: true, expectedHourlyUSD: 3.9, wait: true });
    await t.until(r.data.jobId, 'progress');
    const c = await t.call('job_cancel', { jobId: r.data.jobId, confirm: true });
    expect(c.isError).toBe(false);
    const job = await t.settle(r.data.jobId);
    expect(job.status).toBe('cancelled');
    expect(t.runpod.createPod).not.toHaveBeenCalled();
  });

  it('wait con prezzo diverso da quello di waitable → PRICE_CHANGED subito, nessun job', async () => {
    const t = setup(noPods);
    const r = await t.call('up', { profile: 'p', gpu: { id: 'GPU141', count: 1 }, confirm: true, expectedHourlyUSD: 3.5, wait: true });
    expect(r.data.error.code).toBe('PRICE_CHANGED');
    expect(t.mcp.jobs.list()).toEqual([]);
  });

  it('un secondo up sullo stesso profilo mentre il primo è in corso → errore', async () => {
    const t = setup({ pods: [{ id: 'old', name: 'llmpod-p', status: 'EXITED', cost: 0 }] });
    const args = { profile: 'p', gpu: { id: 'GPU80', count: 1 }, confirm: true, expectedHourlyUSD: 1.5 };
    const first = await t.call('up', args);
    await t.settle(first.data.jobId);
    expect((await t.call('up', args)).isError).toBe(true);
    expect((await t.call('tune', { profile: 'p', set: ['max-num-seqs=4'], expectedArgs: ACTIVE_ARGS, confirm: true })).isError).toBe(true);
  });
});

describe('tune, keep, down', () => {
  it('tune_preview non ricarica; tune senza confirm → errore', async () => {
    const t = setup();
    const p = await t.call('tune_preview', { profile: 'p', set: ['max-num-seqs=4'] });
    expect(p.data.changes.added).toEqual(['--max-num-seqs 4']);
    expect((await t.call('tune', { profile: 'p', set: ['max-num-seqs=4'], expectedArgs: p.data.before })).isError).toBe(true);
    // argomenti attivi diversi da quelli dell'anteprima → rifiuto prima del job
    const changed = await t.call('tune', { profile: 'p', set: ['max-num-seqs=4'], expectedArgs: ['--max-model-len', '1024'], confirm: true });
    expect(changed.isError).toBe(true);
    expect(changed.data.error.message).toMatch(/cambiati dall'anteprima/);
    expect(t.calls('/reload')).toHaveLength(0);
  });

  it('tune con confirm: job in background che ricarica e salva', async () => {
    const t = setup();
    const r = await t.call('tune', { profile: 'p', set: ['max-model-len=32768'], expectedArgs: ACTIVE_ARGS, confirm: true, save: true });
    const job = await t.settle(r.data.jobId);
    expect(job.status).toBe('done');
    expect(t.calls('/reload', 'POST')[0][2].json.args).toEqual(expect.arrayContaining(['--max-model-len', '32768']));
    expect(t.store.readProfile('p').context).toBe(32768);
  });

  it('tune fallito: il ritorno agli argomenti precedenti è una domanda pendente', async () => {
    const t = setup({ onReload: (_a, n) => (n === 1 ? 'error' : 'ready') });
    const r = await t.call('tune', { profile: 'p', set: ['max-num-seqs=4'], expectedArgs: ACTIVE_ARGS, confirm: true });
    const job = await t.settle(r.data.jobId);
    expect(job.question.text).toMatch(/Tornare agli argomenti precedenti/);
    // il Pod costa: la domanda scade in 3 minuti (poi vale il valore sicuro: tornare indietro)
    const left = Date.parse(job.question.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(COSTLY_QUESTION_TIMEOUT_MS - 10_000);
    expect(left).toBeLessThanOrEqual(COSTLY_QUESTION_TIMEOUT_MS);
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
    const wrong = await t.call('save_profile', { name: 'coder', model: 'org/altro-modello', gpu: { id: 'GPU80', count: 1 } });
    expect(wrong.isError).toBe(true);
    expect(wrong.data.error.message).toMatch(/ultimo piano è di Qwen\/Qwen3-Coder-30B-A3B-Instruct/);
    const r = await t.call('save_profile', { name: 'coder', model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', gpu: { id: 'GPU80', count: 1 } });
    expect(r.data.profile).toMatchObject({ name: 'coder', gpu: { id: 'GPU80', count: 1 } });
    expect(t.store.readEnv().LLMPOD_KEY_CODER).toBeTruthy();
  });
});

describe('nessun Pod lasciato acceso da un job', () => {
  const UP = { profile: 'p', gpu: { id: 'GPU80', count: 1 }, confirm: true, expectedHourlyUSD: 1.5 };

  it('up fallito (smoke test): il Pod si elimina subito, senza domanda pendente', async () => {
    const t = setup({ pods: [], smoke: [false] });
    const r = await t.call('up', UP);
    const job = await t.settle(r.data.jobId);
    expect(job.status).toBe('failed');
    expect(job.question).toBeNull();
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
  });

  it('domanda durante un up con il Pod già creato: scade in 3 minuti', async () => {
    // vLLM mai pronto entro il limite → "Aspettare altri 15 minuti?"
    let clock = 0;
    const t = setup({ pods: [], phase: 'loading' }, { sleep: async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); } });
    const realNow = Date.now;
    const start = realNow();
    Date.now = () => start + clock;
    try {
      const r = await t.call('up', UP);
      const job = await t.settle(r.data.jobId);
      expect(job.question.text).toMatch(/Aspettare altri 15 minuti/);
      const left = Date.parse(job.question.expiresAt) - Date.now();
      expect(left).toBeLessThanOrEqual(COSTLY_QUESTION_TIMEOUT_MS);
      await t.call('job_answer', { jobId: r.data.jobId, questionId: job.question.id, answer: false });
      const end = await t.settle(r.data.jobId);
      expect(end.status).toBe('failed');
      expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
    } finally {
      Date.now = realNow;
    }
  });

  it('down durante un up in corso: annulla il job ed elimina il Pod', async () => {
    const t = setup({ pods: [], phase: 'loading' }, { sleep: yieldSleep });
    const r = await t.call('up', UP);
    await t.until(r.data.jobId, 'pod');
    const d = await t.call('down', { profile: 'p', confirm: true });
    expect(d.isError).toBe(false);
    expect(d.data.cancelledJobs).toEqual([r.data.jobId]);
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(d.data.allPods).toEqual([]);
    const job = (await t.call('job_status', { jobId: r.data.jobId })).data.job;
    expect(job.status).toBe('cancelled');
  });

  it('down durante un up con domanda pendente: la domanda si chiude col valore sicuro', async () => {
    const t = setup({ pods: [{ id: 'old', name: 'llmpod-p', status: 'EXITED', cost: 0 }] });
    const r = await t.call('up', UP);
    const job = await t.settle(r.data.jobId);
    expect(job.question).toBeTruthy();
    await t.call('down', { profile: 'p', confirm: true });
    const after = (await t.call('job_status', { jobId: r.data.jobId })).data.job;
    expect(after).toMatchObject({ status: 'cancelled', question: null });
    expect(t.runpod.createPod).not.toHaveBeenCalled();
    expect(t.runpod.deletePod).toHaveBeenCalledWith('old');
  });

  it('job_cancel: senza confirm errore; con confirm annulla ed elimina il Pod', async () => {
    const t = setup({ pods: [], phase: 'loading' }, { sleep: yieldSleep });
    const r = await t.call('up', UP);
    await t.until(r.data.jobId, 'pod');
    expect((await t.call('job_cancel', { jobId: r.data.jobId })).isError).toBe(true);
    const c = await t.call('job_cancel', { jobId: r.data.jobId, confirm: true });
    expect(c.isError).toBe(false);
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect((await t.call('job_cancel', { jobId: r.data.jobId, confirm: true })).isError).toBe(true);
  });

  const TUNE = { profile: 'p', set: ['max-num-seqs=4'], expectedArgs: ACTIVE_ARGS, confirm: true };
  const untilReloads = async (t, n) => {
    for (let i = 0; i < 500 && t.sv.reloads < n; i++) await new Promise((r) => setTimeout(r, 2));
    expect(t.sv.reloads).toBe(n);
  };

  it('job_cancel su un tune in attesa: NON elimina il Pod, riporta vLLM agli argomenti precedenti; esito nell\'evento finale', async () => {
    const t = setup({ onReload: (_a, n) => (n === 1 ? 'loading' : 'ready') }, { sleep: yieldSleep });
    const r = await t.call('tune', TUNE);
    await untilReloads(t, 1);
    const c = await t.call('job_cancel', { jobId: r.data.jobId, confirm: true });
    expect(c.data).toMatchObject({ interrupted: true, podKept: true });
    const job = await t.settle(r.data.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'CANCELLED', message: expect.stringMatching(/di nuovo attivo con gli argomenti precedenti; il Pod resta acceso/) });
    const reloads = t.calls('/reload', 'POST');
    expect(reloads).toHaveLength(2);
    expect(reloads[1][2].json.args).toEqual(ACTIVE_ARGS);
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
    const ev = await t.call('job_events', { jobId: r.data.jobId });
    expect(ev.data.events.at(-1)).toMatchObject({ type: 'failed', error: { code: 'CANCELLED' } });
  });

  it('job_cancel su un tune con la domanda di ritorno pendente: la chiude (sì), torna indietro, Pod acceso', async () => {
    const t = setup({ onReload: (_a, n) => (n === 1 ? 'error' : 'ready') });
    const r = await t.call('tune', TUNE);
    const job = await t.settle(r.data.jobId);
    expect(job.question.text).toMatch(/Tornare agli argomenti precedenti/);
    await t.call('job_cancel', { jobId: r.data.jobId, confirm: true });
    const end = await t.settle(r.data.jobId);
    expect(end.error.code).toBe('CANCELLED');
    expect(t.calls('/reload', 'POST').at(-1)[2].json.args).toEqual(ACTIVE_ARGS);
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
  });

  it('secondo job_cancel sullo stesso tune: ignorato ("annullamento già in corso"), il ritorno indietro prosegue', async () => {
    const t = setup({ onReload: (_a, n) => (n === 1 ? 'loading' : 'ready') }, { sleep: yieldSleep });
    const r = await t.call('tune', TUNE);
    await untilReloads(t, 1);
    expect((await t.call('job_cancel', { jobId: r.data.jobId, confirm: true })).data.interrupted).toBe(true);
    const again = await t.call('job_cancel', { jobId: r.data.jobId, confirm: true });
    expect(again.data).toMatchObject({ ignored: true, message: 'Annullamento già in corso' });
    const job = await t.settle(r.data.jobId);
    expect(job.error.message).toMatch(/di nuovo attivo con gli argomenti precedenti/);
    expect(t.calls('/reload', 'POST')).toHaveLength(2);
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
  });

  it('job_cancel arrivato durante una chiamata HTTP (nessuna attesa in corso) non va perso', async () => {
    let gate = null;
    let blocked = false;
    const beforeStatus = async () => { if (gate) { blocked = true; await gate; } };
    const t = setup({ onReload: (_a, n) => (n === 1 ? 'loading' : 'ready'), beforeStatus }, { sleep: yieldSleep });
    const r = await t.call('tune', TUNE);
    await untilReloads(t, 1);
    let release;
    gate = new Promise((res) => { release = res; });
    for (let i = 0; i < 500 && !blocked; i++) await new Promise((res) => setTimeout(res, 2));
    expect(blocked).toBe(true); // il job è dentro GET /status
    expect((await t.call('job_cancel', { jobId: r.data.jobId, confirm: true })).data.interrupted).toBe(true);
    gate = null;
    release();
    const job = await t.settle(r.data.jobId);
    expect(job.error).toMatchObject({ code: 'CANCELLED', message: expect.stringMatching(/argomenti precedenti/) });
    expect(t.calls('/reload', 'POST').at(-1)[2].json.args).toEqual(ACTIVE_ARGS);
  });

  it('job_cancel su un up prima della creazione del Pod: annulla e basta, nessun altro Pod del profilo toccato', async () => {
    const t = setup({ pods: [{ id: 'old', name: 'llmpod-p', status: 'EXITED', cost: 0 }] });
    const r = await t.call('up', UP);
    const job = await t.settle(r.data.jobId);
    expect(job.question.text).toMatch(/Pod spento/);
    const c = await t.call('job_cancel', { jobId: r.data.jobId, confirm: true });
    expect(c.data).toMatchObject({ cancelled: true, terminatedPodId: null });
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
    expect(t.runpod.createPod).not.toHaveBeenCalled();
    expect(c.data.allPods.map((p) => p.podId)).toEqual(['old']);
  });

  it('down durante un tune (richiesta esplicita): annulla il job ed elimina il Pod', async () => {
    const t = setup({ onReload: () => 'loading' }, { sleep: yieldSleep });
    const r = await t.call('tune', TUNE);
    await untilReloads(t, 1);
    const d = await t.call('down', { profile: 'p', confirm: true });
    expect(d.data.cancelledJobs).toEqual([r.data.jobId]);
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
  });

  it('chiusura del server con un up in corso e Pod creato: elimina il Pod e lo scrive nel log', async () => {
    const t = setup({ pods: [], phase: 'loading' }, { sleep: yieldSleep });
    const r = await t.call('up', UP);
    await t.until(r.data.jobId, 'pod');
    const res = await t.mcp.shutdown({ timeoutMs: 5000 });
    expect(res.terminated).toEqual(['pod1']);
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(t.logs.join('\n')).toMatch(/elimino il Pod pod1/);
  });

  it('chiusura senza job in corso: nessuna azione', async () => {
    const t = setup();
    expect(await t.mcp.shutdown({ timeoutMs: 100 })).toEqual({ terminated: [] });
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
  });
});

describe('status con all', () => {
  it('elenca anche gli altri Pod dell\'account, in sola lettura', async () => {
    const t = setup({ pods: [
      { id: 'pod1', name: 'llmpod-p', status: 'RUNNING', cost: 1.5, gpu: { id: 'GPU80', count: 1 } },
      { id: 'x1', name: 'mio-notebook', status: 'RUNNING', cost: 0.4, gpu: { id: 'GPU24', count: 1 } },
    ] });
    const base = await t.call('status');
    expect(base.data.otherAccountPods).toBeUndefined();
    expect(base.data.note).toMatch(/all: true/);
    const all = await t.call('status', { all: true });
    expect(all.data.otherAccountPods).toEqual([expect.objectContaining({ podId: 'x1', name: 'mio-notebook', hourlyUSD: 0.4 })]);
    expect(t.runpod.deletePod).not.toHaveBeenCalled();
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
