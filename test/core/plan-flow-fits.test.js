import { describe, it, expect } from 'vitest';
import { applyAdvice } from '../../src/core/plan-flow.js';
import { findOption } from '../../src/core/planner/gpu-choice.js';

// Piano BF16: pesi 40 GiB, KV 20; una GPU da 80 GB (62 GiB) e una da 70 GB (62 GiB, margine stretto).
const opt = (id, memoryGiB, hourly) => ({ id, name: id, count: 1, memoryGiB, perGpuGiB: 62, headroomGiB: memoryGiB * 0.9 - 62, hourly, availabilityHere: 'HIGH', elsewhere: [], availableHere: true, available: true });
const makePlan = () => ({
  gpu: { id: 'G80', count: 1 }, hourlyUSD: 1.5, alternatives: [{ id: 'G70', count: 1, hourly: 1.2 }], kvCacheDtype: null,
  estimate: { weightsGiB: 40, kvGiB: 20, perGpuGiB: 62 }, mtp: null, parsers: {}, warnings: [],
  vllm: { image: 'x', args: ['--tensor-parallel-size', '1', '--max-model-len', '65536'] },
  options: [opt('G70', 70, 1.2), opt('G80', 80, 1.5)], candidates: [],
  advisor: { applied: false },
});

describe('applyAdvice e opzioni che non entrano più', () => {
  it('dopo un consiglio che riduce il margine l\'opzione stretta non è più selezionabile', () => {
    const plan = makePlan();
    expect(findOption(plan, { id: 'G70', count: 1 }).id).toBe('G70');
    // il consiglio porta --gpu-memory-utilization a 0,85: 62 > 70 × 0,85 = 59,5, ma 62 ≤ 80 × 0,85 = 68
    applyAdvice(plan, { args: [...plan.vllm.args, '--gpu-memory-utilization', '0.85'] });
    expect(plan.options.map((o) => [o.id, o.fits])).toEqual([['G70', false], ['G80', true]]);
    expect(() => findOption(plan, { id: 'G70', count: 1 })).toThrow(/non entra in memoria/);
    expect(findOption(plan, { id: 'G80', count: 1 }).id).toBe('G80');
  });

  it('un consiglio che non cambia la memoria lascia tutto selezionabile', () => {
    const plan = makePlan();
    applyAdvice(plan, { args: [...plan.vllm.args, '--enable-prefix-caching'] });
    expect(plan.options.every((o) => o.fits === true)).toBe(true);
  });

  it('le alternative che non entrano più vengono tolte, così up --yes non ripiega su GPU dove il modello non entra', () => {
    const plan = makePlan();
    expect(plan.alternatives.map((a) => a.id)).toEqual(['G70']);
    applyAdvice(plan, { args: [...plan.vllm.args, '--gpu-memory-utilization', '0.85'] });
    expect(plan.alternatives).toEqual([]);
  });

  it('le alternative che entrano ancora restano', () => {
    const plan = makePlan();
    applyAdvice(plan, { args: [...plan.vllm.args, '--enable-prefix-caching'] });
    expect(plan.alternatives.map((a) => a.id)).toEqual(['G70']);
  });
});
