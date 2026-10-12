import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { listSets, getSet, resolveSetRef, validateModelSets, filterSetModels, MODEL_FORMATS } from '../../src/core/model-sets.js';
import { detectParsers } from '../../src/core/planner/vllm-args.js';

const real = JSON.parse(fs.readFileSync(new URL('../../data/model-sets.json', import.meta.url), 'utf8'));
const SHA = 'aedc6ce29b7b0c84c7fadfb59fb8524357f8014c';
const model = (over = {}) => ({
  id: 'org/Modello-GPTQ', revision: SHA, family: 'Famiglia', variant: 'GPTQ Int4', format: 'gptq', quantization: 'GPTQ 4 bit',
  weightsGiB: 18.2, mtp: true, context: 262144, toolParser: 'qwen3_coder', reasoningParser: 'qwen3', license: 'apache-2.0',
  notes: 'nota', recommendedContext: 131072, architecture: 'Qwen3_5ForConditionalGeneration', modelType: 'qwen3_5', gated: false, ...over,
});
const doc = (models = [model()], over = {}) => ({
  version: 1, updatedAt: '2026-10-12',
  sets: [{ id: 'prova', name: 'Prova', description: 'descrizione', warning: 'avviso', models, ...over }],
});
const problems = (d) => {
  try { validateModelSets(d); return []; } catch (e) { expect(e.code).toBe('INVALID_INPUT'); return e.details.problems; }
};

describe('validazione dello schema dei set', () => {
  it('il file data/model-sets.json è valido', () => {
    expect(() => validateModelSets(real)).not.toThrow();
  });

  it('un documento minimo valido passa', () => {
    expect(problems(doc())).toEqual([]);
  });

  it.each([
    ['versione mancante', { ...doc(), version: undefined }, /version/],
    ['data non ISO', { ...doc(), updatedAt: '12/10/2026' }, /updatedAt/],
    ['nessun set', { ...doc(), sets: [] }, /sets/],
    ['id del set non valido', doc(undefined, { id: 'Set Strano' }), /id/],
    ['set senza avviso', doc(undefined, { warning: '' }), /warning/],
    ['set senza modelli', doc([]), /models/],
    ['id del modello non valido', doc([model({ id: 'senza-organizzazione' })]), /id/],
    ['revisione non sha', doc([model({ revision: 'main' })]), /revision/],
    ['formato non ammesso (GGUF)', doc([model({ format: 'gguf' })]), /format/],
    ['pesi non positivi', doc([model({ weightsGiB: 0 })]), /weightsGiB/],
    ['mtp non booleano', doc([model({ mtp: 'sì' })]), /mtp/],
    ['contesto consigliato oltre il massimo', doc([model({ recommendedContext: 524288 })]), /recommendedContext/],
    ['tool parser mancante', doc([model({ toolParser: null })]), /toolParser/],
    ['modello duplicato', doc([model(), model()]), /duplicat/],
  ])('%s → errore', (_, d, re) => {
    const p = problems(d);
    expect(p.length).toBeGreaterThan(0);
    expect(p.join('\n')).toMatch(re);
  });

  it('set duplicati → errore', () => {
    const d = doc();
    d.sets.push({ ...d.sets[0] });
    expect(problems(d).join('\n')).toMatch(/duplicat/);
  });
});

describe('set abliterated (dati verificati)', () => {
  const set = getSet('abliterated');

  it('esiste, ha l\'avviso sull\'uso responsabile e almeno un modello per famiglia richiesta', () => {
    expect(set.warning).toMatch(/responsabil/i);
    const families = new Set(set.models.map((m) => m.family));
    for (const f of ['GLM-5.3', 'GLM-5.3-Flash', 'DeepSeek-V4.1-Flash', 'Qwen3.8-27B']) expect(families).toContain(f);
    expect(set.models.map((m) => m.id)).toContain('llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved-GPTQ-Int4');
  });

  it('ogni modello ha i parser che llmpod sceglierebbe per la sua architettura (data/parsers.json)', () => {
    for (const m of set.models) {
      const p = detectParsers({ modelId: m.id, config: { architectures: [m.architecture], model_type: m.modelType } });
      expect(p.tool, m.id).toBe(m.toolParser);
      expect(p.reasoning ?? null, m.id).toBe(m.reasoningParser);
    }
  });

  it('solo formati caricabili da vLLM e niente GGUF/MLX/EXL3 nel nome', () => {
    for (const m of set.models) {
      expect(MODEL_FORMATS).toContain(m.format);
      expect(m.id).not.toMatch(/gguf|mlx|exl[23]/i);
    }
  });

  it('per ogni famiglia con MTP disponibile la variante proposta lo ha', () => {
    for (const f of ['GLM-5.3', 'GLM-5.3-Flash', 'DeepSeek-V4.1-Flash', 'DeepSeek-V4-Flash', 'Qwen3.8-27B', 'Qwen3.8-Flash-Next', 'Qwen3.6-35B-A3B']) {
      expect(set.models.filter((m) => m.family === f).every((m) => m.mtp), f).toBe(true);
    }
  });
});

describe('listSets, getSet, filterSetModels', () => {
  it('listSets riassume i set senza i modelli', () => {
    const sets = listSets();
    expect(sets.find((s) => s.id === 'abliterated')).toMatchObject({ name: expect.any(String), count: getSet('abliterated').models.length });
    expect(sets[0].models).toBeUndefined();
  });

  it('getSet di un set inesistente → NOT_FOUND con l\'elenco dei set', () => {
    expect(() => getSet('boh')).toThrow(expect.objectContaining({ code: 'NOT_FOUND', hint: expect.stringContaining('abliterated') }));
  });

  it('filterSetModels filtra per id, famiglia o variante (senza distinguere maiuscole) e conserva la posizione', () => {
    const set = getSet('abliterated');
    const rows = filterSetModels(set, 'glm-5.3-flash');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.model.family === 'GLM-5.3-Flash')).toBe(true);
    expect(rows[0].n).toBe(set.models.indexOf(rows[0].model) + 1);
    expect(filterSetModels(set, '')).toHaveLength(set.models.length);
  });
});

describe('resolveSetRef', () => {
  it('<set>/<n> → id@revisione verificata e contesto consigliato (n parte da 1)', () => {
    const m = getSet('abliterated').models[0];
    expect(resolveSetRef('abliterated/1')).toEqual({ setId: 'abliterated', n: 1, model: m, modelRef: `${m.id}@${m.revision}`, recommendedContext: m.recommendedContext });
  });

  it('un id Hugging Face normale non è un riferimento a un set', () => {
    expect(resolveSetRef('Qwen/Qwen3.8-27B')).toBeNull();
    expect(resolveSetRef('org/1')).toBeNull();
    expect(resolveSetRef('https://huggingface.co/abliterated/1')).toBeNull();
  });

  it('numero fuori intervallo → INVALID_INPUT con suggerimento', () => {
    const n = getSet('abliterated').models.length;
    for (const ref of ['abliterated/0', `abliterated/${n + 1}`]) {
      expect(() => resolveSetRef(ref)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', hint: expect.stringContaining('llmpod search --set abliterated') }));
    }
  });
});
