import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, SECRETS } from './helpers.js';
import { VERSION } from '../../src/cli/context.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const gpu = (id, memory, price, dc) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: [{ id: dc, availability: 'HIGH' }] });
const hfFake = () => ({
  getModel: vi.fn(async () => fx('model-qwen3-coder-30b.json')),
  resolveSha: vi.fn(async () => 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120'),
  listFiles: vi.fn(async () => fx('tree-qwen3-coder-30b.json')),
  getConfig: vi.fn(async () => fx('config-qwen3-coder-30b.json')),
  searchModels: vi.fn(async () => [
    { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', params: 30.5e9, paramsByDtype: { BF16: 30.5e9 }, dtypes: ['BF16'], license: 'apache-2.0', gated: false, downloads: 1000, lastModified: '2025-07-31T00:00:00.000Z', architectures: ['Qwen3MoeForCausalLM'], modelType: 'qwen3_moe', hasChatTemplate: true },
    { id: 'strano/Modello', params: 7e9, paramsByDtype: { BF16: 7e9 }, dtypes: ['BF16'], license: null, gated: 'manual', downloads: 5, lastModified: null, architectures: ['FooForCausalLM'], modelType: 'foo', hasChatTemplate: true },
    { id: 'base/SenzaTemplate', params: 1e9, paramsByDtype: null, dtypes: [], license: null, gated: false, downloads: 1, lastModified: null, architectures: [], modelType: null, hasChatTemplate: false },
  ]),
});
const runpodFake = () => ({
  listGpus: vi.fn(async ({ count }) => (count === 1 ? [gpu('NVIDIA A100 80GB PCIe', 80, 1.79, 'EU-RO-1')] : [])),
  listPods: vi.fn(async () => []),
  listDataCenters: vi.fn(async () => [
    { id: 'EU-RO-1', region: 'EUROPE', networkVolumeTypes: ['STANDARD'], gpuAvailability: [{ id: 'A', availability: 'HIGH' }] },
    { id: 'AP-IN-1', region: 'ASIA', networkVolumeTypes: [], gpuAvailability: [] },
  ]),
  listVolumes: vi.fn(async () => []),
  createVolume: vi.fn(async ({ name, size, dataCenter }) => ({ id: 'vol1', name, size, dataCenter })),
});

describe('CLI: infrastruttura', () => {
  it('--version', async () => {
    const s = sandbox();
    expect(await s.run(['--version'])).toBe(0);
    expect(s.out()).toContain(VERSION);
  });

  it('comando sconosciuto → codice 1', async () => {
    const s = sandbox();
    expect(await s.run(['boh'])).toBe(1);
  });
});

describe('CLI: init', () => {
  it('salva credenziali (600), datacenter e crea il volume', async () => {
    const s = sandbox({ answers: { secret: [SECRETS.RUNPOD_API_KEY, SECRETS.HF_TOKEN], text: ['EU-RO-1', '150'], ask: [true, false] } });
    const runpod = runpodFake();
    const http = { request: vi.fn(async () => ({ ok: true, status: 200, data: { name: 'utente' } })) };
    expect(await s.run(['init'], { runpod, http })).toBe(0);
    expect(s.store.readEnv()).toEqual(SECRETS);
    expect(fs.statSync(path.join(s.env.LLMPOD_CONFIG_DIR, '.env')).mode & 0o777).toBe(0o600);
    expect(runpod.createVolume).toHaveBeenCalledWith({ name: 'llmpod-pesi', size: 150, dataCenter: 'EU-RO-1' });
    expect(s.store.readConfig()).toMatchObject({ dataCenterId: 'EU-RO-1', volume: { id: 'vol1', size: 150, dataCenterId: 'EU-RO-1' } });
    expect(s.all()).not.toContain(SECRETS.RUNPOD_API_KEY);
    expect(s.prompt.ask.mock.calls[0][0]).toContain('10,50 $ al mese');
  });

  it('init --dry-run non crea il volume', async () => {
    const s = sandbox({ answers: { secret: [SECRETS.RUNPOD_API_KEY, ''], text: ['EU-RO-1', '200'] } });
    const runpod = runpodFake();
    expect(await s.run(['init', '--dry-run'], { runpod })).toBe(0);
    expect(runpod.createVolume).not.toHaveBeenCalled();
  });

  it('rifiutare la creazione del volume salva la configurazione senza volume, con un avviso', async () => {
    // domande: costo del volume (no), consulente (no)
    const s = sandbox({ answers: { secret: [SECRETS.RUNPOD_API_KEY, ''], text: ['EU-RO-1', '150'], ask: [false, false] } });
    const runpod = runpodFake();
    expect(await s.run(['init'], { runpod })).toBe(0);
    expect(runpod.createVolume).not.toHaveBeenCalled();
    expect(s.prompt.ask.mock.calls[0][0]).toContain('al mese');
    const cfg = s.store.readConfig();
    expect(cfg.dataCenterId).toBe('EU-RO-1');
    expect(cfg.volume ?? null).toBeNull();
    expect(s.all()).toMatch(/i pesi saranno scaricati a ogni avvio/);
    expect(s.store.readEnv().RUNPOD_API_KEY).toBe(SECRETS.RUNPOD_API_KEY);
  });

  it('init --no-volume: nessun volume creato né riusato, nessuna domanda sul costo', async () => {
    const s = sandbox({ answers: { secret: [SECRETS.RUNPOD_API_KEY, ''], ask: [false] } });
    const runpod = runpodFake();
    runpod.listVolumes = vi.fn(async () => [{ id: 'volX', name: 'llmpod-pesi', size: 100, dataCenter: 'EU-RO-1' }]);
    expect(await s.run(['init', '--no-volume', '--datacenter', 'EU-RO-1'], { runpod })).toBe(0);
    expect(runpod.createVolume).not.toHaveBeenCalled();
    expect(s.prompt.ask.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/al mese|Riutilizzare/);
    expect(s.prompt.askText).not.toHaveBeenCalled();
    const cfg = s.store.readConfig();
    expect(cfg.dataCenterId).toBe('EU-RO-1');
    expect(cfg.volume ?? null).toBeNull();
    expect(s.all()).toMatch(/i pesi saranno scaricati a ogni avvio/);
  });

  it('init --no-volume con un volume configurato nello stesso datacenter: non lo usa più e avvisa che costa ancora', async () => {
    const s = sandbox({ answers: { secret: [SECRETS.RUNPOD_API_KEY, ''], ask: [false] } });
    s.store.writeConfig({ dataCenterId: 'EU-RO-1', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-RO-1' } });
    const runpod = runpodFake();
    expect(await s.run(['init', '--no-volume', '--datacenter', 'EU-RO-1'], { runpod })).toBe(0);
    expect(s.store.readConfig().volume ?? null).toBeNull();
    expect(s.all()).toMatch(/llmpod-pesi.*continua a costare/);
  });

  it('init --no-volume lascia configurato un volume di un altro datacenter (resta gestibile con destroy-volume)', async () => {
    const s = sandbox({ answers: { secret: [SECRETS.RUNPOD_API_KEY, ''], ask: [false] } });
    s.store.writeConfig({ dataCenterId: 'US-X', volume: { id: 'vol9', name: 'llmpod-pesi', size: 150, dataCenterId: 'US-X' } });
    const runpod = runpodFake();
    expect(await s.run(['init', '--no-volume', '--datacenter', 'EU-RO-1'], { runpod })).toBe(0);
    expect(s.store.readConfig()).toMatchObject({ dataCenterId: 'EU-RO-1', volume: { id: 'vol9' } });
  });
});

describe('CLI: search, plan, save', () => {
  it('search mostra parser e nasconde i modelli senza chat template', async () => {
    const s = sandbox();
    expect(await s.run(['search', 'qwen', 'coder'], { hf: hfFake() })).toBe(0);
    const out = s.out();
    expect(out).toContain('Qwen/Qwen3-Coder-30B-A3B-Instruct');
    expect(out).toContain('qwen3_coder');
    expect(out).toMatch(/strano\/Modello.*nessuno/);
    expect(out).not.toContain('base/SenzaTemplate');
    const s2 = sandbox();
    await s2.run(['search', 'x', '--all'], { hf: hfFake() });
    expect(s2.out()).toContain('base/SenzaTemplate');
  });

  it('plan richiede init', async () => {
    const s = sandbox();
    expect(await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'], { hf: hfFake(), runpod: runpodFake() })).toBe(1);
    expect(s.err()).toMatch(/Errore \[INVALID_INPUT\].*datacenter/i);
  });

  it('plan stampa il piano e lo salva; save crea il profilo senza mostrare la chiave', async () => {
    const s = sandbox();
    s.store.writeEnv(SECRETS);
    s.store.writeConfig({ dataCenterId: 'EU-RO-1', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-RO-1' } });
    expect(await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'], { hf: hfFake(), runpod: runpodFake() })).toBe(0);
    const out = s.out();
    expect(out).toContain('qwen3_coder');
    expect(out).toContain('NVIDIA A100 80GB PCIe');
    expect(out).toContain('1,79 $/h');
    expect(out).toContain('llmpod save');
    expect(s.store.readJson('last-plan.json').gpu).toEqual({ id: 'NVIDIA A100 80GB PCIe', count: 1 });

    expect(await s.run(['save', 'qwen3-coder'])).toBe(0);
    const key = s.store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    expect(key).toBeTruthy();
    expect(s.all()).not.toContain(key);
    expect(s.store.readProfile('qwen3-coder').servedName).toBe('qwen3-coder');
  });

  it('plan --json produce JSON valido su stdout', async () => {
    const s = sandbox();
    s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
    expect(await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', '--json', '--context', '32768'], { hf: hfFake(), runpod: runpodFake() })).toBe(0);
    expect(JSON.parse(s.out()).context).toBe(32768);
  });
});
