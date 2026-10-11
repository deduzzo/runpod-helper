import { describe, it, expect } from 'vitest';
import { parseAdvice, reviewAdvice, diffArgs, makeFitsWith, LOCKED } from '../../src/core/advisor/advice.js';
import { loadFlags } from '../../src/core/planner/vllm-args.js';

const flags = loadFlags();
const base = ['--max-model-len', '65536', '--tensor-parallel-size', '1', '--gpu-memory-utilization', '0.9', '--revision', 'abc', '--enable-auto-tool-choice', '--tool-call-parser', 'hermes'];

describe('parseAdvice', () => {
  it('JSON puro, tra testo e in blocco recintato', () => {
    const j = '{"set":{"tool-call-parser":"qwen3_coder"},"rationale":"perché","warnings":["w"]}';
    expect(parseAdvice(j)).toEqual({ set: { 'tool-call-parser': 'qwen3_coder' }, rationale: 'perché', warnings: ['w'] });
    expect(parseAdvice(`Ecco la proposta:\n${j}\nFine.`).set).toEqual({ 'tool-call-parser': 'qwen3_coder' });
    expect(parseAdvice(`\`\`\`json\n${j}\n\`\`\``).rationale).toBe('perché');
  });

  it('campi mancanti → valori vuoti; JSON non valido o set non oggetto → ADVISOR_INVALID', () => {
    expect(parseAdvice('{}')).toEqual({ set: {}, rationale: '', warnings: [] });
    expect(() => parseAdvice('nessun json qui')).toThrow(expect.objectContaining({ code: 'ADVISOR_INVALID' }));
    expect(() => parseAdvice('{"set":["a"]}')).toThrow(expect.objectContaining({ code: 'ADVISOR_INVALID' }));
    expect(() => parseAdvice('[1,2]')).toThrow(expect.objectContaining({ code: 'ADVISOR_INVALID' }));
  });
});

describe('reviewAdvice', () => {
  it('applica le modifiche valide e calcola la differenza', () => {
    const advice = { set: { 'tool-call-parser': 'qwen3_coder', 'enable-prefix-caching': true, 'max_num_seqs': 8 }, rationale: '', warnings: [] };
    const r = reviewAdvice({ advice, baseArgs: base, flags });
    expect(r.rejected).toEqual([]);
    expect(r.args).toEqual(expect.arrayContaining(['--tool-call-parser', 'qwen3_coder', '--enable-prefix-caching', '--max-num-seqs', '8']));
    expect(r.changes.changed).toEqual([{ flag: '--tool-call-parser', from: 'hermes', to: 'qwen3_coder' }]);
    expect(r.changes.added).toEqual(expect.arrayContaining(['--enable-prefix-caching', '--max-num-seqs 8']));
  });

  it('rifiuta bloccati, vietati, sconosciuti e valori non validi', () => {
    const advice = { set: {
      revision: 'main', 'tensor-parallel-size': '8', 'max-model-len': '999999',
      api_key: 'x', host: '0.0.0.0', 'trust-remote-code': true, 'flag-inventato': true,
      'tokenizer-mode': 'mistral\n--api-key x', 'chat-template': 'x'.repeat(301), 'kv-cache-dtype': { a: 1 }, 'bad name!': true,
    }, rationale: '', warnings: [] };
    const r = reviewAdvice({ advice, baseArgs: base, flags });
    expect(r.args).toEqual(base);
    const reasons = Object.fromEntries(r.rejected.map((x) => [x.key, x.reason]));
    for (const k of LOCKED) expect(reasons[k]).toMatch(/bloccato/);
    expect(reasons.api_key).toMatch(/vietato/);
    expect(reasons.host).toMatch(/vietato/);
    expect(reasons['trust-remote-code']).toMatch(/vietato/);
    expect(reasons['flag-inventato']).toMatch(/sconosciuto/);
    expect(reasons['tokenizer-mode']).toMatch(/valore/);
    expect(reasons['chat-template']).toMatch(/valore/);
    expect(reasons['kv-cache-dtype']).toMatch(/valore/);
    expect(reasons['bad name!']).toMatch(/nome/);
  });

  it('false rimuove un flag', () => {
    const r = reviewAdvice({ advice: { set: { 'enable-auto-tool-choice': false }, rationale: '', warnings: [] }, baseArgs: base, flags });
    expect(r.args).not.toContain('--enable-auto-tool-choice');
    expect(r.changes.removed).toEqual(['--enable-auto-tool-choice']);
  });

  it('scarta le modifiche di memoria che non entrano nella GPU', () => {
    const fitsWith = (args) => !args.includes('auto');
    const r = reviewAdvice({ advice: { set: { 'kv-cache-dtype': 'auto', 'tool-call-parser': 'qwen3_coder' }, rationale: '', warnings: [] }, baseArgs: [...base, '--kv-cache-dtype', 'fp8'], flags, fitsWith });
    expect(r.args).toEqual(expect.arrayContaining(['--kv-cache-dtype', 'fp8', '--tool-call-parser', 'qwen3_coder']));
    expect(r.rejected).toEqual([{ key: 'kv-cache-dtype', reason: expect.stringMatching(/memoria/) }]);
  });
});

describe('diffArgs e makeFitsWith', () => {
  it('diffArgs gestisce flag booleani e con valore', () => {
    expect(diffArgs(['--a', '1', '--b'], ['--a', '2', '--c'])).toEqual({ added: ['--c'], removed: ['--b'], changed: [{ flag: '--a', from: '1', to: '2' }] });
  });

  it('makeFitsWith: KV in BF16 su una GPU dove entra solo in FP8', () => {
    // Piano in FP8 su GPU da 74 GB: pesi 56,87 + KV 6 + 2 = 64,87 GiB ≤ 66,6; in BF16 sarebbero 70,87 > 66,6.
    const plan = { gpu: { id: 'G74', count: 1 }, kvCacheDtype: 'fp8', estimate: { weightsGiB: 56.87, kvGiB: 6, perGpuGiB: 64.87 }, candidates: [{ gpuId: 'G74', count: 1, memoryGiB: 74 }] };
    const fits = makeFitsWith(plan);
    expect(fits(['--kv-cache-dtype', 'fp8'])).toBe(true);
    expect(fits(['--kv-cache-dtype', 'auto'])).toBe(false);
    expect(fits(['--kv-cache-dtype', 'fp8', '--gpu-memory-utilization', '0.5'])).toBe(false);
    expect(fits(['--gpu-memory-utilization', '1.5'])).toBe(false);
    expect(makeFitsWith({ gpu: null, candidates: [] })([])).toBe(true);
  });
});
