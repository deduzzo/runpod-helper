import { describe, it, expect } from 'vitest';
import { parsePrometheus, snapshotMetrics, summarizeMetrics } from '../../src/core/metrics.js';
import { metricsText } from '../fixtures/vllm-metrics.js';


describe('parsePrometheus', () => {
  it('legge nome, etichette e valore; ignora commenti e righe non valide', () => {
    const s = parsePrometheus('# HELP x\nfoo{a="1",b="due, tre"} 2.5\nbar 3\nrotto\nbaz{a="x"} NaN\n');
    expect(s).toEqual([
      { name: 'foo', labels: { a: '1', b: 'due, tre' }, value: 2.5 },
      { name: 'bar', labels: {}, value: 3 },
    ]);
  });
});

describe('snapshotMetrics', () => {
  it('somma per nome e separa gli esiti delle richieste, la speculazione per posizione e gli errori HTTP', () => {
    const s = snapshotMetrics(metricsText());
    expect(s).toMatchObject({ promptTokens: 1000, generationTokens: 500, running: 1, waiting: 0, kvUsage: 0.25, preemptions: 0, aborted: 1, completed: 13, http4xx: 2, http5xx: 0 });
    expect(s.spec).toEqual({ drafts: 100, draftTokens: 200, acceptedTokens: 150, perPosition: [90, 60] });
  });
  it('senza decodifica speculativa spec è null; la KV legacy (gpu_cache_usage_perc) vale come uso KV', () => {
    const text = metricsText({ legacyKv: true, kv: 0.5 }).split('\n').filter((l) => !l.includes('spec_decode')).join('\n');
    const s = snapshotMetrics(text);
    expect(s.spec).toBeNull();
    expect(s.kvUsage).toBe(0.5);
  });
});

describe('summarizeMetrics', () => {
  it('calcola i tassi sulla finestra e l\'accettazione MTP (totale e nella finestra, per posizione)', () => {
    const a = snapshotMetrics(metricsText());
    const b = snapshotMetrics(metricsText({ prompt: 3000, gen: 1500, drafts: 200, draftTokens: 400, accepted: 250, pos: [170, 80], success: 14, http5: 1, kv: 0.875 }));
    const r = summarizeMetrics(a, b, 10);
    expect(r.windowSeconds).toBe(10);
    expect(r.throughput).toEqual({ generationTokensPerSec: 100, promptTokensPerSec: 200 });
    expect(r.requests).toEqual({ running: 1, waiting: 0, completedInWindow: 4 });
    expect(r.kvCacheUsagePct).toBe(87.5);
    // totale: 250/400 accettati, lunghezza media 1 + 250/200
    expect(r.speculative.total).toEqual({ drafts: 200, acceptanceRatePct: 62.5, meanAcceptedLength: 2.25, perPositionPct: [85, 40] });
    // finestra: 100 bozze, 200 token proposti, 100 accettati (80 in posizione 0, 20 in posizione 1)
    expect(r.speculative.window).toEqual({ drafts: 100, acceptanceRatePct: 50, meanAcceptedLength: 2, perPositionPct: [80, 20] });
    expect(r.errors).toEqual({ aborted: 1, preemptions: 0, http4xx: 2, http5xx: 1, http5xxInWindow: 1 });
  });
  it('senza traffico nella finestra: tassi a zero e accettazione della finestra null', () => {
    const a = snapshotMetrics(metricsText());
    const r = summarizeMetrics(a, a, 10);
    expect(r.throughput.generationTokensPerSec).toBe(0);
    expect(r.speculative.window).toBeNull();
    expect(r.speculative.total.acceptanceRatePct).toBe(75);
  });
  it('senza speculazione speculative è null', () => {
    const text = metricsText().split('\n').filter((l) => !l.includes('spec_decode')).join('\n');
    const s = snapshotMetrics(text);
    expect(summarizeMetrics(s, s, 5).speculative).toBeNull();
  });
  it('contatori azzerati (vLLM ricaricato tra le due letture): tassi mai negativi', () => {
    const a = snapshotMetrics(metricsText({ gen: 5000 }));
    const b = snapshotMetrics(metricsText({ gen: 100 }));
    expect(summarizeMetrics(a, b, 10).throughput.generationTokensPerSec).toBe(0);
  });
});
