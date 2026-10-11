import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { pickRecipe, createRecipes } from '../../src/core/advisor/recipes.js';

const tree = JSON.parse(fs.readFileSync(new URL('../fixtures/recipes/tree.json', import.meta.url), 'utf8'));
const paths = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);

describe('pickRecipe', () => {
  it.each([
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'Qwen/Qwen3-Coder-480B-A35B.md'],
    ['Qwen/Qwen3-Next-80B-A3B-Instruct', 'Qwen/Qwen3-Next.md'],
    ['zai-org/GLM-4.6', 'GLM/GLM.md'],
    ['deepseek-ai/DeepSeek-V3-0324', 'DeepSeek/DeepSeek-V3.md'],
    ['moonshotai/Kimi-K2-Instruct', 'moonshotai/Kimi-K2.md'],
    ['MiniMaxAI/MiniMax-M2', 'MiniMax/MiniMax-M2.md'],
    ['openai/gpt-oss-120b', 'OpenAI/GPT-OSS.md'],
  ])('%s → %s', (model, expected) => {
    expect(pickRecipe(model, paths)).toBe(expected);
  });

  it('nessuna corrispondenza → null; esclude README e cartelle nascoste', () => {
    expect(pickRecipe('foo/Bar-7B', paths)).toBeNull();
    expect(pickRecipe('x/README', paths)).toBeNull();
    expect(pickRecipe('x/skill', paths)).toBeNull();
  });
});

describe('createRecipes', () => {
  it('scarica l\'albero una volta, poi il file raw troncato', async () => {
    const http = { request: vi.fn(async (m, url) => (url.includes('/git/trees/')
      ? { ok: true, status: 200, data: tree }
      : { ok: true, status: 200, data: `# Qwen3-Coder\n${'x'.repeat(20000)}` })) };
    const r = createRecipes({ http });
    const first = await r.find('Qwen/Qwen3-Coder-30B-A3B-Instruct');
    expect(first.path).toBe('Qwen/Qwen3-Coder-480B-A35B.md');
    expect(first.text.length).toBe(12000);
    await r.find('zai-org/GLM-4.6');
    const treeCalls = http.request.mock.calls.filter(([, url]) => url.includes('/git/trees/'));
    expect(treeCalls).toHaveLength(1);
    expect(http.request.mock.calls[1][1]).toBe('https://raw.githubusercontent.com/vllm-project/recipes/main/Qwen/Qwen3-Coder-480B-A35B.md');
  });

  it('errori → null, senza eccezioni', async () => {
    const down = createRecipes({ http: { request: vi.fn(async () => { throw new Error('rete'); }) } });
    expect(await down.find('Qwen/Qwen3-Coder-30B-A3B-Instruct')).toBeNull();
    const notFound = createRecipes({ http: { request: vi.fn(async () => ({ ok: false, status: 403, data: {} })) } });
    expect(await notFound.find('Qwen/Qwen3-Coder-30B-A3B-Instruct')).toBeNull();
  });
});
