import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { sandbox } from './helpers.js';
import { getSet } from '../../src/core/model-sets.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const gpu = (id, memory, price, dc) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: [{ id: dc, availability: 'HIGH' }] });
const SHA = 'aedc6ce29b7b0c84c7fadfb59fb8524357f8014c';
// Il primo modello del set abliterated è il Qwen3.8-27B GPTQ delle fixture (stessa revisione).
const hfFake = () => ({
  searchModels: vi.fn(async () => []),
  getModel: vi.fn(async () => fx('model-qwen38-27b-gptq-mtp.json')),
  resolveSha: vi.fn(async () => SHA),
  listFiles: vi.fn(async () => fx('tree-qwen38-27b-gptq-mtp.json')),
  getConfig: vi.fn(async () => fx('config-qwen38-27b-gptq-mtp.json')),
  getWeightIndex: vi.fn(async () => fx('index-qwen38-27b-gptq-mtp.json').weight_map),
});
const runpodFake = () => ({ listGpus: vi.fn(async ({ count }) => (count === 1 ? [gpu('NVIDIA A100 80GB PCIe', 80, 1.79, 'EU-RO-1')] : [])) });

describe('CLI: search --sets / --set', () => {
  it('--sets elenca i set con numero di modelli, senza chiamare Hugging Face', async () => {
    const s = sandbox();
    const hf = hfFake();
    expect(await s.run(['search', '--sets'], { hf })).toBe(0);
    expect(s.out()).toMatch(/abliterated\s.*Abliterated/);
    expect(s.out()).toContain(String(getSet('abliterated').models.length));
    expect(hf.searchModels).not.toHaveBeenCalled();
  });

  it('--set <id> mostra solo i modelli del set con modello, variante, formato, pesi, MTP e contesto, più l\'avviso', async () => {
    const s = sandbox();
    const hf = hfFake();
    expect(await s.run(['search', '--set', 'abliterated'], { hf })).toBe(0);
    const out = s.out();
    for (const h of ['Modello', 'Variante', 'Formato', 'Pesi', 'MTP', 'Contesto']) expect(out).toContain(h);
    const set = getSet('abliterated');
    for (const m of set.models) expect(out).toContain(m.id);
    expect(out).toContain('18,2 GiB');
    expect(out).toMatch(/GPTQ/);
    expect(out).toContain('262.144');
    expect(s.all()).toMatch(/responsabil/i);
    expect(out).toContain('llmpod plan abliterated/<n>');
    expect(hf.searchModels).not.toHaveBeenCalled();
  });

  it('--set con testo filtra dentro il set mantenendo la numerazione', async () => {
    const s = sandbox();
    expect(await s.run(['search', 'glm', '--set', 'abliterated'], { hf: hfFake() })).toBe(0);
    const out = s.out();
    expect(out).toContain('dealignai/GLM-5.3-Flash-UNCENSORED-FP8');
    expect(out).not.toContain('llmfan46/Qwen3.8-27B');
    const n = getSet('abliterated').models.findIndex((m) => m.family.startsWith('GLM')) + 1;
    expect(out).toMatch(new RegExp(`(^|\\n)\\s*${n}\\s`));
  });

  it('--set --json produce i modelli del set con la posizione', async () => {
    const s = sandbox();
    expect(await s.run(['search', '--set', 'abliterated', '--json'], { hf: hfFake() })).toBe(0);
    const rows = JSON.parse(s.out());
    expect(rows[0]).toMatchObject({ n: 1, id: getSet('abliterated').models[0].id, revision: SHA });
  });

  it('set inesistente → errore con i set disponibili', async () => {
    const s = sandbox();
    expect(await s.run(['search', '--set', 'boh'], { hf: hfFake() })).toBe(1);
    expect(s.err()).toContain('Set di modelli "boh" inesistente');
    expect(s.err()).toContain('abliterated');
  });

  it('senza testo e senza set → errore che spiega cosa indicare; la ricerca globale resta com\'era', async () => {
    const s = sandbox();
    const hf = hfFake();
    expect(await s.run(['search'], { hf })).toBe(1);
    expect(s.err()).toMatch(/--set/);
    const s2 = sandbox();
    expect(await s2.run(['search', 'qwen'], { hf })).toBe(0);
    expect(hf.searchModels).toHaveBeenCalledWith('qwen', { limit: 20 });
  });
});

describe('CLI: plan <set>/<n>', () => {
  it('usa il modello del set alla revisione verificata e il contesto consigliato', async () => {
    const s = sandbox();
    s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
    const hf = hfFake();
    expect(await s.run(['plan', 'abliterated/1', '--no-advisor', '--json'], { hf, runpod: runpodFake() })).toBe(0);
    const plan = JSON.parse(s.out());
    const m = getSet('abliterated').models[0];
    expect(plan.model).toMatchObject({ id: m.id, revision: SHA, requestedRevision: SHA });
    expect(plan.context).toBe(m.recommendedContext);
    expect(hf.resolveSha).not.toHaveBeenCalled();
  });

  it('--context esplicito vince sul contesto consigliato', async () => {
    const s = sandbox();
    s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
    expect(await s.run(['plan', 'abliterated/1', '--no-advisor', '--json', '--context', '32768'], { hf: hfFake(), runpod: runpodFake() })).toBe(0);
    expect(JSON.parse(s.out()).context).toBe(32768);
  });

  it('numero fuori dal set → errore senza chiamate', async () => {
    const s = sandbox();
    s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
    const hf = hfFake();
    expect(await s.run(['plan', 'abliterated/999', '--no-advisor'], { hf, runpod: runpodFake() })).toBe(1);
    expect(s.err()).toContain('abliterated/999 non esiste');
    expect(hf.getModel).not.toHaveBeenCalled();
  });
});
