import { describe, it, expect } from 'vitest';
import { estimateStartup, startupText } from '../../src/core/planner/startup.js';

const GiB = 1024 ** 3;

describe('estimateStartup: tempo e costo dell\'avvio prima che il modello sia pronto', () => {
  it('collaudo reale: 126 GiB su 2 GPU PCIe → caricamento vicino a 206 shard × 7 s', () => {
    const e = estimateStartup({ downloadBytes: 126 * GiB, weightsBytes: 126 * GiB, count: 2, hourlyUSD: 3.6 });
    expect(Math.abs(e.loadSeconds - 206 * 7) / (206 * 7)).toBeLessThan(0.1);
    expect(e.downloadSeconds).toBe(Math.round((126 * GiB) / 100e6));
    expect(e.totalSeconds).toBe(e.fixedSeconds + e.downloadSeconds + e.loadSeconds);
    expect(e.costUSD).toBeCloseTo((e.totalSeconds / 3600) * 3.6, 2);
  });

  it('una GPU e modello piccolo: caricamento molto più rapido; fattori separati per multi-GPU e > 100 GiB', () => {
    const small = estimateStartup({ downloadBytes: 40 * GiB, weightsBytes: 40 * GiB, count: 1, hourlyUSD: 1.5 });
    const multi = estimateStartup({ downloadBytes: 40 * GiB, weightsBytes: 40 * GiB, count: 2, hourlyUSD: 1.5 });
    const big = estimateStartup({ downloadBytes: 120 * GiB, weightsBytes: 120 * GiB, count: 1, hourlyUSD: 1.5 });
    expect(small.loadSeconds).toBe(80);
    expect(multi.loadSeconds).toBe(small.loadSeconds * 3);
    expect(big.loadSeconds).toBe(120 * 2 * 2);
  });

  it('senza costo orario: costUSD null', () => {
    expect(estimateStartup({ downloadBytes: GiB, weightsBytes: GiB, count: 1 }).costUSD).toBeNull();
  });

  it('startupText: minuti e costo in forma leggibile', () => {
    const e = { totalSeconds: 3120, downloadSeconds: 1353, loadSeconds: 1512, fixedSeconds: 255, costUSD: 3.12 };
    expect(startupText(e)).toBe('avvio stimato ~52 min (download ~23, caricamento dei pesi ~25) ≈ 3,12 $ prima che il modello sia pronto');
  });
});
