import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { sandbox, SECRETS } from './helpers.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct';
const g = (id, memory, price, dcs) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: dcs.map(([d, availability]) => ({ id: d, availability })) });
// 4 configurazioni che entrano: una non disponibile ovunque, una cheapest disponibile, una LOW, una solo altrove.
const GPUS = [
  g('GPU-NOW', 80, 1.2, [['EU-RO-1', 'NONE']]),
  g('GPU-A', 80, 1.79, [['EU-RO-1', 'HIGH']]),
  g('GPU-B', 96, 2.5, [['EU-RO-1', 'LOW']]),
  g('GPU-C', 80, 3, [['EU-RO-1', 'NONE'], ['US-1', 'MEDIUM']]),
];
const hfFake = () => ({
  getModel: vi.fn(async () => fx('model-qwen3-coder-30b.json')),
  resolveSha: vi.fn(async () => 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120'),
  listFiles: vi.fn(async () => fx('tree-qwen3-coder-30b.json')),
  getConfig: vi.fn(async () => fx('config-qwen3-coder-30b.json')),
});
const runpodFake = () => ({ listGpus: vi.fn(async ({ count }) => (count === 1 ? GPUS : [])), listPods: vi.fn(async () => []) });

function planSandbox(opts) {
  const s = sandbox(opts);
  s.store.writeEnv(SECRETS);
  s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
  return s;
}
const go = (s, args) => s.run(['plan', MODEL, ...args], { hf: hfFake(), runpod: runpodFake() });

describe('plan: scelta della GPU', () => {
  it('non interattivo: nessuna domanda, vale la più economica disponibile e il piano salvato ha le opzioni', async () => {
    const s = planSandbox();
    expect(await go(s, [])).toBe(0);
    expect(s.prompt.askText).not.toHaveBeenCalled();
    const plan = s.store.readJson('last-plan.json');
    expect(plan.gpu).toEqual({ id: 'GPU-A', count: 1 });
    expect(plan.options.map((o) => o.id)).toEqual(['GPU-NOW', 'GPU-A', 'GPU-B', 'GPU-C']);
    expect(s.out()).toContain('non disponibile ora');
  });

  it('--gpu imposta la GPU senza fare domande e riordina le alternative', async () => {
    const s = planSandbox({ answers: { interactive: true } });
    expect(await go(s, ['--gpu', 'GPU-B'])).toBe(0);
    expect(s.prompt.askText).not.toHaveBeenCalled();
    const plan = s.store.readJson('last-plan.json');
    expect(plan.gpu).toEqual({ id: 'GPU-B', count: 1 });
    expect(plan.hourlyUSD).toBe(2.5);
    expect(plan.alternatives.map((a) => a.id)).toEqual(['GPU-A']);
    expect(s.out()).toContain('GPU-B ×1 a 2,50 $/h');
  });

  it('--gpu <id>x<n> con un numero che non esiste, o una GPU non disponibile, dà errore e non salva il piano', async () => {
    const s = planSandbox();
    expect(await go(s, ['--gpu', 'GPU-Ax4'])).toBe(1);
    expect(s.err()).toMatch(/INVALID_INPUT.*non è tra le opzioni/);
    const s2 = planSandbox();
    expect(await go(s2, ['--gpu', 'GPU-NOW'])).toBe(1);
    expect(s2.err()).toMatch(/NO_GPU_AVAILABLE.*non disponibile ora/);
    expect(s2.store.readJson('last-plan.json', null)).toBeNull();
  });

  it('interattivo: elenca le opzioni disponibili numerate (predefinita la più economica) e salva quella scelta', async () => {
    const s = planSandbox({ answers: { interactive: true, text: ['2'] } });
    expect(await go(s, [])).toBe(0);
    const err = s.err();
    expect(err).toContain('Quale GPU usare?');
    expect(err).toMatch(/1\) GPU-A ×1 · 80 GB · 1,79 \$\/h · HIGH in EU-RO-1  \(predefinita\)/);
    expect(err).toMatch(/2\) GPU-B ×1 · 96 GB · 2,50 \$\/h · LOW in EU-RO-1/);
    expect(err).toMatch(/3\) GPU-C ×1 · 80 GB · 3,00 \$\/h · solo altrove \(US-1\)/);
    expect(err).not.toContain('GPU-NOW ×1 · 80 GB');
    expect(s.prompt.askText).toHaveBeenCalledWith('Scelta:', '1');
    expect(s.store.readJson('last-plan.json').gpu).toEqual({ id: 'GPU-B', count: 1 });
    expect(s.out()).toContain('GPU-B ×1 a 2,50 $/h');
  });

  it('interattivo: invio = predefinita; una risposta non valida viene richiesta', async () => {
    const s = planSandbox({ answers: { interactive: true, text: ['9', 'boh'] } });
    expect(await go(s, [])).toBe(0);
    expect(s.err()).toContain('Scelta non valida');
    // terza risposta: il mock restituisce il valore predefinito
    expect(s.store.readJson('last-plan.json').gpu).toEqual({ id: 'GPU-A', count: 1 });
    expect(s.prompt.askText).toHaveBeenCalledTimes(3);
  });

  it('con --yes o --json non chiede nulla anche se interattivo', async () => {
    const s = planSandbox({ answers: { interactive: true } });
    expect(await go(s, ['--yes'])).toBe(0);
    const s2 = planSandbox({ answers: { interactive: true } });
    expect(await go(s2, ['--json'])).toBe(0);
    expect(s.prompt.askText).not.toHaveBeenCalled();
    expect(s2.prompt.askText).not.toHaveBeenCalled();
    expect(JSON.parse(s2.out()).options).toHaveLength(4);
  });
});
