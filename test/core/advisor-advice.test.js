import { describe, it, expect } from 'vitest';
import { parseAdvice, reviewAdvice, diffArgs, makeFitsWith, LOCKED, ADVISOR_ALLOWED } from '../../src/core/advisor/advice.js';
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

  it('blocco bash seguito da blocco json: usa il primo JSON valido', () => {
    const j = '{"set":{"tool-call-parser":"qwen3_coder"},"rationale":"perché","warnings":[]}';
    expect(parseAdvice(`\`\`\`bash\necho ciao\n\`\`\`\n\`\`\`json\n${j}\n\`\`\``).rationale).toBe('perché');
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
    expect(reasons['chat-template']).toMatch(/non consentito/);
    expect(reasons['kv-cache-dtype']).toMatch(/valore/);
    expect(reasons['bad name!']).toMatch(/nome/);
  });

  it('valori di contrabbando che iniziano con "-" sono rifiutati e gli args restano invariati', () => {
    const advice = { set: {
      'enable-auto-tool-choice': '--trust-remote-code',
      'enable-prefix-caching': '--api-key=x',
      'enforce-eager': '--revision=main',
      'max-num-seqs': '-tp=8',
    }, rationale: '', warnings: [] };
    const r = reviewAdvice({ advice, baseArgs: base, flags });
    expect(r.args).toEqual(base);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.key).sort()).toEqual(['enable-auto-tool-choice', 'enable-prefix-caching', 'enforce-eager', 'max-num-seqs']);
    for (const x of r.rejected) expect(x.reason).toBe('valore non valido');
  });

  it('numero negativo come valore di un flag ammesso: accettato', () => {
    const r1 = reviewAdvice({ advice: { set: { 'max-num-seqs': -1 }, rationale: '', warnings: [] }, baseArgs: base, flags });
    expect(r1.rejected).toEqual([]);
    expect(r1.args).toEqual(expect.arrayContaining(['--max-num-seqs', '-1']));
    const r2 = reviewAdvice({ advice: { set: { 'max-num-seqs': '-1' }, rationale: '', warnings: [] }, baseArgs: base, flags });
    expect(r2.rejected).toEqual([]);
    expect(r2.args).toEqual(expect.arrayContaining(['--max-num-seqs', '-1']));
  });

  it('flag reali ma fuori dall\'allowlist: non consentiti', () => {
    const names = ['tool-parser-plugin', 'hf-overrides', 'otlp-traces-endpoint', 'uds', 'kv-cache-memory-bytes'];
    const set = Object.fromEntries(names.map((n) => [n, 'x']));
    const r = reviewAdvice({ advice: { set, rationale: '', warnings: [] }, baseArgs: base, flags });
    expect(r.args).toEqual(base);
    for (const n of names) expect(Object.fromEntries(r.rejected.map((x) => [x.key, x.reason]))[n]).toMatch(/non consentito al consulente/);
  });

  it('ogni nome dell\'allowlist esiste tra i flag di vLLM', () => {
    for (const n of ADVISOR_ALLOWED) expect(flags.has(`--${n}`)).toBe(true);
  });

  it('true su un flag che nella base ha già un valore: rifiutato', () => {
    const r = reviewAdvice({ advice: { set: { 'tool-call-parser': true }, rationale: '', warnings: [] }, baseArgs: base, flags });
    expect(r.args).toEqual(base);
    expect(r.rejected).toEqual([{ key: 'tool-call-parser', reason: 'valore non valido' }]);
  });

  it('valore troppo lungo su un flag ammesso: valore non valido', () => {
    const r = reviewAdvice({ advice: { set: { 'tokenizer-mode': 'x'.repeat(301) }, rationale: '', warnings: [] }, baseArgs: base, flags });
    expect(r.rejected).toEqual([{ key: 'tokenizer-mode', reason: 'valore non valido' }]);
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

  const mk = (kvDtype, kvCacheDtype) => ({ gpu: { id: 'G74', count: 1 }, kvCacheDtype, estimate: { weightsGiB: 56.87, kvGiB: 6, perGpuGiB: 64.87, kvDtype }, candidates: [{ gpuId: 'G74', count: 1, memoryGiB: 74 }] });

  it('makeFitsWith: base della stima FP8 anche se --set kv-cache-dtype=auto ha azzerato plan.kvCacheDtype', () => {
    const fits = makeFitsWith(mk('fp8', null));
    expect(fits(['--kv-cache-dtype', 'fp8'])).toBe(true);
    expect(fits(['--kv-cache-dtype', 'auto'])).toBe(false);
  });

  it('makeFitsWith: base della stima BF16 anche se --set kv-cache-dtype=fp8 ha impostato plan.kvCacheDtype', () => {
    const fits = makeFitsWith(mk('auto', 'fp8'));
    expect(fits(['--kv-cache-dtype', 'fp8'])).toBe(true);
    expect(fits(['--kv-cache-dtype', 'auto'])).toBe(true);
  });
});
