import { describe, it, expect, vi } from 'vitest';
import { searchRows } from '../../src/core/search.js';

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
});
