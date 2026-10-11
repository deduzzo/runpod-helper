import { describe, it, expect } from 'vitest';
import { parseAdvice, reviewAdvice, diffArgs, makeFitsWith, LOCKED, ADVISOR_ALLOWED, FLAG_TYPES } from '../../src/core/advisor/advice.js';
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
    for (const x of r.rejected) expect(x.reason).toMatch(/^valore non valido/);
  });

  it('numeri negativi o zero per un flag intero: rifiutati', () => {
    for (const v of [-1, '-1', 0, '0', -1e-7, '-1e-7']) {
      const r = reviewAdvice({ advice: { set: { 'max-num-seqs': v }, rationale: '', warnings: [] }, baseArgs: base, flags });
      expect(r.args).toEqual(base);
      expect(r.rejected).toEqual([{ key: 'max-num-seqs', reason: expect.stringMatching(/^valore non valido/) }]);
    }
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
    expect(r.rejected).toEqual([{ key: 'tool-call-parser', reason: expect.stringMatching(/^valore non valido/) }]);
  });

  it('valore troppo lungo su un flag ammesso: valore non valido', () => {
    const r = reviewAdvice({ advice: { set: { 'tokenizer-mode': 'x'.repeat(301) }, rationale: '', warnings: [] }, baseArgs: base, flags });
    expect(r.rejected).toEqual([{ key: 'tokenizer-mode', reason: expect.stringMatching(/^valore non valido/) }]);
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

describe('tipo e caratteri dei valori proposti', () => {
  const review = (set) => reviewAdvice({ advice: { set, rationale: '', warnings: [] }, baseArgs: base, flags });
  const reason = (r, key) => r.rejected.find((x) => x.key === key)?.reason;

  it('ogni flag dell\'allowlist ha un tipo', () => {
    expect(Object.keys(FLAG_TYPES).sort()).toEqual([...ADVISOR_ALLOWED].sort());
  });

  it('booleani: solo true/false', () => {
    for (const v of ['yes', 'true', 1, 0, 'sì', null, {}]) {
      const r = review({ 'enforce-eager': v });
      expect(r.args).toEqual(base);
      expect(reason(r, 'enforce-eager')).toMatch(/^valore non valido: atteso true o false/);
    }
    expect(review({ 'enforce-eager': true }).args).toContain('--enforce-eager');
    expect(review({ 'enable-auto-tool-choice': false }).args).not.toContain('--enable-auto-tool-choice');
  });

  it('interi positivi: max-num-seqs e max-num-batched-tokens', () => {
    for (const v of [true, -1e-7, 1.5, 'abc', '8 ', 1e21, '1e3', [8]]) {
      const r = review({ 'max-num-seqs': v });
      expect(r.args).toEqual(base);
      expect(reason(r, 'max-num-seqs')).toMatch(/^valore non valido: atteso un intero positivo/);
    }
    expect(review({ 'max-num-seqs': 8 }).args).toEqual(expect.arrayContaining(['--max-num-seqs', '8']));
    expect(review({ 'max-num-batched-tokens': '8192' }).args).toEqual(expect.arrayContaining(['--max-num-batched-tokens', '8192']));
  });

  it('gpu-memory-utilization: 0 < x <= 0.98', () => {
    for (const v of ['abc', 1.5, 0, -0.5, 0.99, '1', true, 'NaN', Infinity]) {
      const r = review({ 'gpu-memory-utilization': v });
      expect(r.args).toEqual(base);
      expect(reason(r, 'gpu-memory-utilization')).toMatch(/^valore non valido: atteso un numero/);
    }
    expect(review({ 'gpu-memory-utilization': 0.95 }).args).toEqual(expect.arrayContaining(['--gpu-memory-utilization', '0.95']));
    expect(review({ 'gpu-memory-utilization': '0.98' }).args).toEqual(expect.arrayContaining(['--gpu-memory-utilization', '0.98']));
  });

  it('stringhe semplici: parser, kv-cache-dtype, tokenizer-mode; true e valori con simboli rifiutati', () => {
    for (const v of [true, 'con spazio', 'a;b', '$(x)', '--x', '-x', '', 5, {}]) {
      const r = review({ 'reasoning-parser': v });
      expect(r.args).toEqual(base);
      expect(reason(r, 'reasoning-parser')).toMatch(/^valore non valido/);
    }
    expect(review({ 'reasoning-parser': 'qwen3' }).args).toEqual(expect.arrayContaining(['--reasoning-parser', 'qwen3']));
    expect(review({ 'kv-cache-dtype': 'fp8_e4m3' }).args).toEqual(expect.arrayContaining(['--kv-cache-dtype', 'fp8_e4m3']));
    expect(review({ 'tool-call-parser': false }).args).not.toContain('--tool-call-parser');
  });

  it('default-chat-template-kwargs: solo un oggetto JSON', () => {
    const r = review({ 'default-chat-template-kwargs': '{"enable_thinking": false}' });
    expect(r.rejected).toEqual([]);
    expect(r.args).toEqual(expect.arrayContaining(['--default-chat-template-kwargs', '{"enable_thinking": false}']));
    for (const v of ['[1]', 'testo', '{"a":', 5]) expect(reason(review({ 'default-chat-template-kwargs': v }), 'default-chat-template-kwargs')).toMatch(/^valore non valido/);
  });

  it('caratteri di controllo (ANSI, NUL) nel valore: rifiutati con motivo chiaro', () => {
    for (const v of ['qwen3\x1b[2K', 'qwen3\u0000', '\x1b[2Kqwen3', 'a\u007fb']) {
      const r = review({ 'reasoning-parser': v });
      expect(r.args).toEqual(base);
      expect(reason(r, 'reasoning-parser')).toBe('valore non valido: contiene caratteri di controllo');
    }
    expect(reason(review({ 'default-chat-template-kwargs': '{"a":"\x1b"}' }), 'default-chat-template-kwargs')).toMatch(/controllo/);
  });

  it('chiave con caratteri di controllo: ripulita nell\'elenco degli scartati', () => {
    const r = review({ 'flag\x1b[2K!': true });
    expect(r.rejected[0].key).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('parseAdvice ripulisce rationale e warnings da ANSI e NUL', () => {
    const j = JSON.stringify({ set: {}, rationale: 'ok \x1b[2Kfatto\u0000\nfine', warnings: ['\x1b[31mrosso\x1b[0m', 'a\u0007b'] });
    const a = parseAdvice(j);
    expect(a.rationale).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(a.rationale).toBe('ok [2Kfatto fine');
    expect(a.warnings.join('')).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(a.warnings).toEqual(['[31mrosso[0m', 'ab']);
  });
});
