import { describe, it, expect, vi } from 'vitest';
import { searchRows } from '../../src/core/search.js';

const mlx = { id: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit', params: 30.5e9, paramsByDtype: { U32: 30531911680, BF16: 210944 }, dtypes: ['U32', 'BF16'], license: 'apache-2.0', gated: false, downloads: 5, lastModified: null, architectures: ['Qwen3MoeForCausalLM'], modelType: 'qwen3_moe', hasChatTemplate: true, isMlx: true, quantBits: 4 };
const models = [
  { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', params: 30.5e9, paramsByDtype: { BF16: 30.5e9 }, dtypes: ['BF16'], license: 'apache-2.0', gated: false, downloads: 10, lastModified: '2025-07-31', architectures: ['Qwen3MoeForCausalLM'], modelType: 'qwen3_moe', hasChatTemplate: true },
  { id: 'x/Strano', params: 7e9, paramsByDtype: null, dtypes: [], license: null, gated: 'manual', downloads: 1, lastModified: null, architectures: ['FooForCausalLM'], modelType: 'foo', hasChatTemplate: true },
  { id: 'x/Base', params: 1e9, paramsByDtype: null, dtypes: [], license: null, gated: false, downloads: 1, lastModified: null, architectures: [], modelType: null, hasChatTemplate: false },
];

describe('searchRows', () => {
  it('calcola parser e pesi, filtra i modelli senza chat template', async () => {
    const hf = { searchModels: vi.fn(async () => models) };
    const rows = await searchRows(hf, 'qwen', { limit: 5 });
    expect(hf.searchModels).toHaveBeenCalledWith('qwen', { limit: 5 });
    expect(rows.map((r) => r.id)).toEqual(['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'x/Strano']);
    expect(rows[0]).toMatchObject({ parser: 'qwen3_coder', weightsGiB: expect.closeTo(56.8, 1) });
    expect(rows[1]).toMatchObject({ parser: null, weightsGiB: null });
    expect((await searchRows(hf, 'q', { all: true })).length).toBe(3);
  });

  it('R3: i modelli MLX sono esclusi salvo all; con all i pesi compressi usano i bits', async () => {
    const hf = { searchModels: vi.fn(async () => [...models, mlx]) };
    expect((await searchRows(hf, 'qwen')).map((r) => r.id)).not.toContain(mlx.id);
    const all = await searchRows(hf, 'qwen', { all: true });
    const row = all.find((r) => r.id === mlx.id);
    expect(row.weightsGiB).toBeCloseTo((30531911680 + 210944) / 2 / 1024 ** 3, 3);
  });

  it('R4a: AWQ con I32 compressi: ~14 GiB e senza bits "?" (null), non 112 GiB', async () => {
    const awq = { ...models[0], id: 'QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ', paramsByDtype: { I32: 29896998912, BF16: 635123712 }, dtypes: ['I32', 'BF16'], quantBits: 4 };
    const hf = { searchModels: vi.fn(async () => [awq, { ...awq, id: 'x/senza-bits', quantBits: null }]) };
    const [a, b] = await searchRows(hf, 'q');
    expect(a.weightsGiB).toBeCloseTo(14.2, 1);
    expect(b.weightsGiB).toBeNull();
  });
});
