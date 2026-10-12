import { describe, it, expect } from 'vitest';
import { optionOf, parseGpuSpec, findOption, applyGpuChoice, optionLabel } from '../../src/core/planner/gpu-choice.js';

const opt = (id, count, hourly, availabilityHere, elsewhere = [], extra = {}) => optionOf({
  gpuId: id, name: id, count, memoryGiB: 80, hourly, perGpuGiB: 40 / count, headroomGiB: 10, availabilityHere, elsewhere, ...extra,
});

const makePlan = () => ({
  gpu: { id: 'A', count: 1 }, hourlyUSD: 1,
  alternatives: [{ id: 'B', count: 1, hourly: 2 }],
  elsewhere: [],
  estimate: { perGpuGiB: 40 },
  vllm: { args: ['--tensor-parallel-size', '1', '--max-model-len', '1024'] },
  warnings: ['altro avviso'],
  options: [
    opt('A', 1, 1, 'HIGH'),
    opt('B', 1, 2, 'LOW'),
    opt('B', 2, 2.5, 'HIGH'),
    opt('C', 1, 3, 'NONE', [{ id: 'US-1', availability: 'MEDIUM' }]),
    opt('D', 1, 4, 'NONE'),
  ],
});

describe('optionOf', () => {
  it('calcola la disponibilità nel datacenter preferito e globale', () => {
    expect(opt('A', 1, 1, 'HIGH')).toMatchObject({ id: 'A', availableHere: true, available: true });
    expect(opt('C', 1, 3, 'NONE', [{ id: 'US-1', availability: 'LOW' }])).toMatchObject({ availableHere: false, available: true });
    expect(opt('D', 1, 4, 'NONE')).toMatchObject({ availableHere: false, available: false });
  });
});

describe('parseGpuSpec', () => {
  it('accetta <id> e <id>x<count>', () => {
    expect(parseGpuSpec('NVIDIA A100 80GB PCIe')).toEqual({ id: 'NVIDIA A100 80GB PCIe', count: null });
    expect(parseGpuSpec('NVIDIA A100 80GB PCIex2')).toEqual({ id: 'NVIDIA A100 80GB PCIe', count: 2 });
    expect(parseGpuSpec('B×4')).toEqual({ id: 'B', count: 4 });
  });
  it('rifiuta stringhe vuote', () => {
    expect(() => parseGpuSpec('  ')).toThrow(/GPU/);
  });
});

describe('findOption', () => {
  it('senza numero sceglie la configurazione disponibile più economica di quella GPU', () => {
    expect(findOption(makePlan(), { id: 'B', count: null })).toMatchObject({ id: 'B', count: 1 });
  });
  it('con numero sceglie quella esatta', () => {
    expect(findOption(makePlan(), { id: 'B', count: 2 })).toMatchObject({ id: 'B', count: 2 });
  });
  it('confronta l\'id senza distinguere le maiuscole', () => {
    expect(findOption(makePlan(), { id: 'a', count: null }).id).toBe('A');
  });
  it('errore se la GPU non è tra le opzioni, con l\'elenco nei suggerimenti', () => {
    expect(() => findOption(makePlan(), { id: 'Z', count: null })).toThrow(/non è tra le opzioni/);
  });
  it('errore se non è disponibile ora in nessun datacenter', () => {
    expect(() => findOption(makePlan(), { id: 'D', count: null })).toThrow(/non disponibile/);
  });
  it('un id con numero che non esiste dà errore', () => {
    expect(() => findOption(makePlan(), { id: 'A', count: 8 })).toThrow(/non è tra le opzioni/);
  });
});

describe('applyGpuChoice', () => {
  it('imposta gpu, costo, memoria per GPU e tensor-parallel-size; la scelta esce dalle alternative', () => {
    const plan = applyGpuChoice(makePlan(), { id: 'B', count: 2 });
    expect(plan.gpu).toEqual({ id: 'B', count: 2 });
    expect(plan.hourlyUSD).toBe(2.5);
    expect(plan.estimate.perGpuGiB).toBe(20);
    expect(plan.vllm.args).toEqual(['--tensor-parallel-size', '2', '--max-model-len', '1024']);
    // alternative: le altre configurazioni disponibili nel datacenter preferito, per costo
    expect(plan.alternatives).toEqual([{ id: 'A', count: 1, hourly: 1 }, { id: 'B', count: 1, hourly: 2 }]);
  });

  it('una configurazione disponibile solo altrove diventa la scelta', () => {
    const plan = applyGpuChoice(makePlan(), { id: 'C', count: 1 });
    expect(plan.gpu).toEqual({ id: 'C', count: 1 });
    expect(plan.hourlyUSD).toBe(3);
    expect(plan.alternatives.map((a) => a.id)).toEqual(['A', 'B', 'B']);
  });

  it('toglie l\'avviso NO_GPU_AVAILABLE quando prima non c\'era alcuna scelta', () => {
    const p = makePlan();
    p.gpu = null; p.hourlyUSD = null; p.warnings.push('NO_GPU_AVAILABLE: nessuna GPU');
    applyGpuChoice(p, { id: 'C', count: 1 });
    expect(p.warnings).toEqual(['altro avviso']);
  });

  it('lascia invariato il piano se la scelta non è valida', () => {
    const p = makePlan();
    expect(() => applyGpuChoice(p, { id: 'D', count: 1 })).toThrow();
    expect(p.gpu).toEqual({ id: 'A', count: 1 });
  });

  it('piano senza opzioni: errore chiaro', () => {
    expect(() => applyGpuChoice({ options: [] }, { id: 'A', count: null })).toThrow(/opzioni/);
  });
});

describe('optionLabel', () => {
  it('riassume nome, numero, VRAM, costo e disponibilità', () => {
    expect(optionLabel(opt('A', 2, 3.5, 'HIGH'), 'EU-1')).toBe('A ×2 · 80 GB · 3,50 $/h · HIGH in EU-1');
    expect(optionLabel(opt('C', 1, 3, 'NONE', [{ id: 'US-1', availability: 'MEDIUM' }]), 'EU-1')).toBe('C ×1 · 80 GB · 3,00 $/h · solo altrove (US-1)');
    expect(optionLabel(opt('D', 1, 4, 'NONE'), 'EU-1')).toBe('D ×1 · 80 GB · 4,00 $/h · non disponibile ora');
  });
});
