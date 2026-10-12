import { describe, it, expect } from 'vitest';
import { computeTune, TUNE_LOCKED } from '../../src/core/tune.js';
import { memoryCheck, fitsForOption } from '../../src/core/advisor/advice.js';
import { loadFlags } from '../../src/core/planner/vllm-args.js';

const flags = loadFlags();
const BASE = ['--max-model-len', '65536', '--tensor-parallel-size', '1', '--gpu-memory-utilization', '0.9', '--revision', 'a'.repeat(40), '--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_coder'];
const tune = (o) => computeTune({ currentArgs: BASE, flags, maxContext: 262144, ...o });

describe('computeTune', () => {
  it('applica --set ed --extra-arg agli argomenti attivi e riporta il diff', () => {
    const r = tune({ set: ['max-num-seqs=8', 'kv-cache-dtype=fp8'], extra: ['--enable-prefix-caching'] });
    expect(r.args).toEqual([...BASE, '--max-num-seqs', '8', '--kv-cache-dtype', 'fp8', '--enable-prefix-caching']);
    expect(r.changes.added).toEqual(['--max-num-seqs 8', '--kv-cache-dtype fp8', '--enable-prefix-caching']);
    expect(r.contextChange).toBeNull();
    expect(r.unknown).toEqual([]);
  });

  it('qui si può cambiare max-model-len (al consulente esterno resta bloccato)', () => {
    const r = tune({ set: ['max-model-len=32768'] });
    expect(r.changes.changed).toEqual([{ flag: '--max-model-len', from: '65536', to: '32768' }]);
    expect(r.contextChange).toEqual({ from: 65536, to: 32768 });
  });

  it('rifiuta max-model-len non valido o oltre il massimo del modello', () => {
    for (const v of ['abc', '0', '512', '1e5', '300000']) {
      expect(() => tune({ set: [`max-model-len=${v}`] }), v).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });

  it('rifiuta gpu-memory-utilization fuori da (0, 0,98] e max-num-seqs non intero', () => {
    expect(() => tune({ set: ['gpu-memory-utilization=0.99'] })).toThrow(/gpu-memory-utilization/);
    expect(() => tune({ set: ['max-num-seqs=-1'] })).toThrow(/max-num-seqs/);
  });

  it('mai revision, tensor-parallel-size, served-model-name, api-key, host, port (anche via --extra-arg)', () => {
    expect(TUNE_LOCKED).toEqual(expect.arrayContaining(['revision', 'tensor-parallel-size', 'served-model-name', 'api-key', 'host', 'port']));
    for (const set of [['revision=main'], ['tensor-parallel-size=2'], ['served-model-name=x'], ['api-key=x'], ['host=0.0.0.0'], ['port=1'], ['revision=false']]) {
      expect(() => tune({ set }), set[0]).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    for (const extra of [['--revision=main'], ['--api_key', 'x'], ['--por', '1'], ['--trust-remote-code']]) {
      expect(() => tune({ extra }), extra[0]).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });

  it('nessuna modifica → errore', () => {
    expect(() => tune({ set: ['max-model-len=65536'] })).toThrow(/Nessuna modifica/);
    expect(() => tune({})).toThrow(/Nessuna modifica/);
  });

  it('riallinea tool-call-parser ed enable-auto-tool-choice; i flag sconosciuti sono segnalati', () => {
    const r = tune({ set: ['tool-call-parser=false'], extra: ['--flag-inventato'] });
    expect(r.args).not.toContain('--enable-auto-tool-choice');
    expect(r.unknown).toEqual(['--flag-inventato']);
  });
});

describe('memoryCheck', () => {
  const base = { context: 65536, estimate: { weightsGiB: 40, perGpuGiB: 62, extraGiB: 0, kvDtype: 'auto' } };
  const option = { count: 1, memoryGiB: 80, perGpuGiB: 62 };
  it('scala la KV con max-model-len e con la KV in fp8', () => {
    // fisso: 40 + 2 = 42; KV: 20 GiB a 65536 token
    expect(memoryCheck(base, option)(BASE)).toMatchObject({ neededGiB: 62, availableGiB: 72, fits: true });
    const longer = BASE.map((a) => (a === '65536' ? '131072' : a));
    expect(memoryCheck(base, option)(longer)).toMatchObject({ neededGiB: 82, fits: false });
    expect(memoryCheck(base, option)([...longer, '--kv-cache-dtype', 'fp8'])).toMatchObject({ neededGiB: 62, fits: true });
  });
  it('fitsForOption resta invariato senza contesto di riferimento', () => {
    expect(fitsForOption({ estimate: base.estimate }, option)(BASE.map((a) => (a === '65536' ? '131072' : a)))).toBe(true);
  });
});
