import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { selectGpus } from '../../src/core/planner/gpu-select.js';

const gpu = (id, memory, price, dcs, maxCount = 8) => ({
  id, name: id, memory, price: { secure: price, community: 0 }, maxCount: { secure: maxCount, community: 0 },
  dataCenters: dcs.map(([dc, availability]) => ({ id: dc, name: dc, availability })),
});

describe('selectGpus', () => {
  const needs = (tp) => [0, 70.9, 36.4, 19.2, 10.6][Math.log2(tp) + 1];

  it('sceglie il candidato più economico disponibile nel datacenter, anche multi-GPU', () => {
    const catalogs = {
      1: [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU48', 48, 0.6, [['EU-A', 'LOW']])],
      2: [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU48', 48, 0.6, [['EU-A', 'LOW']])],
    };
    const r = selectGpus({ catalogs, dataCenterId: 'EU-A', needs, tpSizes: [1, 2] });
    expect(r.choice).toMatchObject({ gpuId: 'GPU48', count: 2, hourly: 1.2 });
    expect(r.alternatives.map((c) => `${c.gpuId}x${c.count}`)).toEqual(['GPU80x1', 'GPU80x2']);
  });

  it('separa i candidati disponibili solo altrove', () => {
    const catalogs = { 1: [gpu('GPU80', 80, 1.5, [['US-B', 'MEDIUM']])] };
    const r = selectGpus({ catalogs, dataCenterId: 'EU-A', needs, tpSizes: [1] });
    expect(r.choice).toBeNull();
    expect(r.elsewhere[0]).toMatchObject({ gpuId: 'GPU80', elsewhere: [{ id: 'US-B', availability: 'MEDIUM' }] });
  });

  it('scarta GPU non offerte nel cloud o con maxCount insufficiente', () => {
    const catalogs = { 2: [gpu('NOPRICE', 80, 0, [['EU-A', 'HIGH']]), gpu('MAX1', 80, 1, [['EU-A', 'HIGH']], 1)] };
    expect(selectGpus({ catalogs, dataCenterId: 'EU-A', needs, tpSizes: [2] }).all).toEqual([]);
  });

  it('sulle fixture reali: risultati ordinati per prezzo e tutti con VRAM sufficiente', () => {
    const c1 = JSON.parse(fs.readFileSync(new URL('../fixtures/runpod/catalog-gpus-count1.json', import.meta.url))).gpus;
    const c2 = JSON.parse(fs.readFileSync(new URL('../fixtures/runpod/catalog-gpus-count2.json', import.meta.url))).gpus;
    const r = selectGpus({ catalogs: { 1: c1, 2: c2 }, dataCenterId: 'EU-RO-1', needs, tpSizes: [1, 2] });
    const prices = r.all.map((c) => c.hourly);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    for (const c of r.all) expect(c.perGpuGiB).toBeLessThanOrEqual(c.memoryGiB * 0.9);
  });
});
