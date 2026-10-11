import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { parseModelRef, summarizeModel, createHf } from '../../src/core/hf.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const fakeHttp = (routes) => ({
  request: vi.fn(async (method, url) => {
    for (const [re, res] of routes) if (re.test(`${method} ${url}`)) return typeof res === 'function' ? res(url) : res;
    throw new Error(`rotta non prevista: ${method} ${url}`);
  }),
});

describe('parseModelRef', () => {
  it.each([
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'main'],
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct@b2cff64', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'b2cff64'],
    ['https://huggingface.co/zai-org/GLM-4.6', 'zai-org/GLM-4.6', 'main'],
    ['https://huggingface.co/zai-org/GLM-4.6/tree/v1.0', 'zai-org/GLM-4.6', 'v1.0'],
    ['https://huggingface.co/zai-org/GLM-4.6/blob/main/config.json', 'zai-org/GLM-4.6', 'main'],
    ['hf.co/meta-llama/Llama-3.3-70B-Instruct', 'meta-llama/Llama-3.3-70B-Instruct', 'main'],
    ['  org/model  ', 'org/model', 'main'],
  ])('%s', (input, id, revision) => {
    expect(parseModelRef(input)).toEqual({ id, revision });
  });

  it.each(['', 'solo-nome', 'a/b/c d', 'https://example.com/org/model'])('rifiuta %j', (input) => {
    expect(() => parseModelRef(input)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('summarizeModel', () => {
  it('estrae i campi utili dal modello reale', () => {
    const s = summarizeModel(fx('model-qwen3-coder-30b.json'));
    expect(s).toMatchObject({
      id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', gated: false, params: 30532122624, dtypes: ['BF16'],
      architectures: ['Qwen3MoeForCausalLM'], modelType: 'qwen3_moe', hasChatTemplate: true,
    });
    expect(typeof s.license).toBe('string');
  });

  it('R3: riconosce i modelli MLX (library_name o tag) e legge i bit della quantizzazione', () => {
    const mlx = summarizeModel(fx('model-mlx-qwen3-coder-30b-4bit.json'));
    expect(mlx).toMatchObject({ isMlx: true, libraryName: 'mlx', quantBits: 4 });
    expect(summarizeModel({ id: 'a/b', library_name: 'mlx' }).isMlx).toBe(true);
    expect(summarizeModel({ id: 'a/b', library_name: 'transformers', tags: ['safetensors', 'mlx'] }).isMlx).toBe(true);
    const awq = summarizeModel(fx('model-awq-qwen3-coder-30b.json'));
    expect(awq).toMatchObject({ isMlx: false, quantBits: 4, dtypes: ['I32', 'BF16'] });
    expect(summarizeModel(fx('model-qwen3-coder-30b.json'))).toMatchObject({ isMlx: false, quantBits: null });
  });

  it('tollera campi mancanti (risultati di ricerca senza expand)', () => {
    const s = summarizeModel(fx('search-qwen3-coder.json')[0]);
    expect(s.params).toBeNull();
    expect(s.hasChatTemplate).toBe(false);
  });
});

describe('createHf', () => {
  it('searchModels chiede text-generation ordinati per download con expand', async () => {
    const http = fakeHttp([[/GET https:\/\/huggingface\.co\/api\/models$/, { ok: true, status: 200, data: fx('search-qwen3-coder.json') }]]);
    const hf = createHf({ http });
    const list = await hf.searchModels('qwen3 coder', { limit: 5 });
    const [, , opts] = http.request.mock.calls[0];
    expect(opts.query).toMatchObject({ search: 'qwen3 coder', filter: 'text-generation', sort: 'downloads', direction: -1, limit: 5 });
    expect(opts.query['expand[]']).toEqual(expect.arrayContaining(['safetensors', 'config', 'gated', 'cardData']));
    expect(list.length).toBeGreaterThan(0);
  });

  it('getWeightIndex legge weight_map di model.safetensors.index.json, null se manca o non leggibile', async () => {
    const http = fakeHttp([[/GET https:\/\/huggingface\.co\/o\/m\/resolve\/abc\/model\.safetensors\.index\.json$/, { ok: true, status: 200, data: { weight_map: { a: 'model-1.safetensors' } } }]]);
    expect(await createHf({ http }).getWeightIndex('o/m', 'abc')).toEqual({ a: 'model-1.safetensors' });
    const missing = fakeHttp([[/GET .*index\.json$/, { ok: false, status: 404, data: null }]]);
    expect(await createHf({ http: missing }).getWeightIndex('o/m', 'abc')).toBeNull();
    const broken = fakeHttp([[/GET .*index\.json$/, { ok: true, status: 200, data: 'non json' }]]);
    expect(await createHf({ http: broken }).getWeightIndex('o/m', 'abc')).toBeNull();
    const boom = { request: vi.fn(async () => { throw new Error('rete'); }) };
    expect(await createHf({ http: boom }).getWeightIndex('o/m', 'abc')).toBeNull();
  });

  it('listFiles segue la paginazione Link', async () => {
    const page1 = { ok: true, status: 200, data: [{ type: 'file', path: 'a.safetensors', size: 1 }],
      headers: new Headers({ link: '<https://huggingface.co/api/models/o/m/tree/abc?recursive=true&cursor=X>; rel="next"' }) };
    const page2 = { ok: true, status: 200, data: [{ type: 'file', path: 'b.safetensors', size: 2 }], headers: new Headers() };
    const http = fakeHttp([[/cursor=X/, page2], [/tree\/abc/, page1]]);
    const files = await createHf({ http }).listFiles('o/m', 'abc');
    expect(files.map((f) => f.path)).toEqual(['a.safetensors', 'b.safetensors']);
  });

  it('getConfig traduce 403 in GATED_MODEL con link', async () => {
    const http = fakeHttp([[/resolve/, { ok: false, status: 403, data: 'Access denied', headers: new Headers() }]]);
    await expect(createHf({ http, token: 'hf_x' }).getConfig('meta-llama/Llama-4', 'main'))
      .rejects.toMatchObject({ code: 'GATED_MODEL', hint: expect.stringContaining('https://huggingface.co/meta-llama/Llama-4') });
  });

  it('invia il token solo se presente', async () => {
    const http = fakeHttp([[/resolve/, { ok: true, status: 200, data: { a: 1 }, headers: new Headers() }]]);
    await createHf({ http, token: 'hf_TOKENFINTO123456' }).getConfig('o/m', 'abc');
    expect(http.request.mock.calls[0][2].headers.authorization).toBe('Bearer hf_TOKENFINTO123456');
    const http2 = fakeHttp([[/resolve/, { ok: true, status: 200, data: { a: 1 }, headers: new Headers() }]]);
    await createHf({ http: http2 }).getConfig('o/m', 'abc');
    expect(http2.request.mock.calls[0][2].headers.authorization).toBeUndefined();
  });

  it('401 con token invalido diventa HF_AUTH con messaggio "non valido"', async () => {
    const http = fakeHttp([[/resolve/, { ok: false, status: 401, data: 'Invalid credentials', headers: new Headers() }]]);
    await expect(createHf({ http, token: 'hf_x' }).getConfig('o/m', 'main'))
      .rejects.toMatchObject({ code: 'HF_AUTH', message: expect.stringContaining('non valido') });
  });

  it('401 senza token con x-error-code GatedRepo diventa GATED_MODEL', async () => {
    const http = fakeHttp([[/resolve/, { ok: false, status: 401, data: 'Unauthorized', headers: new Headers({ 'x-error-code': 'GatedRepo' }) }]]);
    await expect(createHf({ http }).getConfig('meta-llama/Llama-4', 'main'))
      .rejects.toMatchObject({ code: 'GATED_MODEL', hint: expect.stringContaining('https://huggingface.co/meta-llama/Llama-4') });
  });

  it('401 senza token e senza header diventa HF_AUTH', async () => {
    const http = fakeHttp([[/resolve/, { ok: false, status: 401, data: 'Unauthorized', headers: new Headers() }]]);
    await expect(createHf({ http }).getConfig('o/m', 'main'))
      .rejects.toMatchObject({ code: 'HF_AUTH', message: expect.stringContaining('serve un token') });
  });

  it('getConfig su 404 diventa NOT_FOUND', async () => {
    const http = fakeHttp([[/resolve/, { ok: false, status: 404, data: 'Not Found', headers: new Headers() }]]);
    await expect(createHf({ http }).getConfig('o/m', 'main'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
