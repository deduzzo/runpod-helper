import { describe, it, expect } from 'vitest';
import { estimateStartup, startupText, weightsOnVolume, rememberWeightsOnVolume } from '../../src/core/planner/startup.js';
import { startupTimeoutMs, readyTimeoutMs } from '../../src/core/pod/launcher.js';

const GiB = 1024 ** 3;

describe('estimateStartup: tempo e costo dell\'avvio prima che il modello sia pronto', () => {
  it('collaudo reale: 126 GiB dal volume di rete su 2 GPU PCIe → caricamento vicino a 206 shard × 7 s', () => {
    const e = estimateStartup({ downloadBytes: 126 * GiB, weightsBytes: 126 * GiB, count: 2, withVolume: true, hourlyUSD: 3.6 });
    expect(Math.abs(e.loadSeconds - 206 * 7) / (206 * 7)).toBeLessThan(0.1);
    expect(e.downloadSeconds).toBe(Math.round((126 * GiB) / 100e6));
    expect(e.totalSeconds).toBe(e.fixedSeconds + e.downloadSeconds + e.loadSeconds);
    expect(e.costUSD).toBeCloseTo((e.totalSeconds / 3600) * 3.6, 2);
  });

  it('il fattore principale è il volume di rete; più GPU pesano meno', () => {
    const local = estimateStartup({ downloadBytes: 40 * GiB, weightsBytes: 40 * GiB, count: 1 });
    const multi = estimateStartup({ downloadBytes: 40 * GiB, weightsBytes: 40 * GiB, count: 2 });
    const volume = estimateStartup({ downloadBytes: 40 * GiB, weightsBytes: 40 * GiB, count: 1, withVolume: true });
    expect(local.loadSeconds).toBe(80);
    expect(multi.loadSeconds).toBe(120);
    expect(volume.loadSeconds).toBe(320);
  });

  it('curva continua nella dimensione (nessun salto a 100 GiB)', () => {
    const a = estimateStartup({ downloadBytes: 99.9 * GiB, weightsBytes: 99.9 * GiB, count: 2 });
    const b = estimateStartup({ downloadBytes: 100.1 * GiB, weightsBytes: 100.1 * GiB, count: 2 });
    expect(b.loadSeconds - a.loadSeconds).toBeLessThan(2);
  });

  it('pesi già sul volume con la stessa revisione: niente download', () => {
    const e = estimateStartup({ downloadBytes: 40 * GiB, weightsBytes: 40 * GiB, count: 1, withVolume: true, cached: true, hourlyUSD: 1 });
    expect(e.downloadSeconds).toBe(0);
    expect(e.cached).toBe(true);
    expect(startupText(e)).toMatch(/pesi già sul volume/);
  });

  it('senza costo orario: costUSD null', () => {
    expect(estimateStartup({ downloadBytes: GiB, weightsBytes: GiB, count: 1 }).costUSD).toBeNull();
  });

  it('startupText: minuti e costo in forma leggibile', () => {
    const e = { totalSeconds: 3120, downloadSeconds: 1353, loadSeconds: 1512, fixedSeconds: 255, costUSD: 3.12, cached: false };
    expect(startupText(e)).toBe('avvio stimato ~52 min (download ~23, caricamento dei pesi ~25) ≈ 3,12 $ prima che il modello sia pronto');
  });
});

describe('pesi già sul volume', () => {
  const profile = { model: { id: 'org/m', revision: 'a'.repeat(40) }, volume: { id: 'vol1' } };

  it('solo con il volume del candidato, lo stesso volume e la stessa revisione', () => {
    const state = rememberWeightsOnVolume({ pods: {} }, profile);
    expect(weightsOnVolume(state, profile, { withVolume: true })).toBe(true);
    expect(weightsOnVolume(state, profile, { withVolume: false })).toBe(false);
    expect(weightsOnVolume(state, { ...profile, model: { ...profile.model, revision: 'b'.repeat(40) } }, { withVolume: true })).toBe(false);
    expect(weightsOnVolume(state, { ...profile, volume: { id: 'vol2' } }, { withVolume: true })).toBe(false);
    expect(weightsOnVolume({ pods: {} }, profile, { withVolume: true })).toBe(false);
  });
});

describe('startupTimeoutMs: attesa di up proporzionata alla stima', () => {
  it('il massimo tra il limite sui byte e 1,5 × la stima dell\'avvio', () => {
    const small = estimateStartup({ downloadBytes: GiB, weightsBytes: GiB, count: 1 });
    expect(startupTimeoutMs(GiB, small)).toBe(readyTimeoutMs(GiB));
    const big = estimateStartup({ downloadBytes: 126 * GiB, weightsBytes: 126 * GiB, count: 2, withVolume: true });
    expect(startupTimeoutMs(126 * GiB, big)).toBe(Math.round(1.5 * big.totalSeconds * 1000));
    expect(startupTimeoutMs(126 * GiB, big)).toBeGreaterThan(readyTimeoutMs(126 * GiB));
  });
});
