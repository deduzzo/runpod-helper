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
});
