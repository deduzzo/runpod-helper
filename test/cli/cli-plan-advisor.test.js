import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const tree = JSON.parse(fs.readFileSync(new URL('../fixtures/recipes/tree.json', import.meta.url), 'utf8'));
const hf = () => ({
  getModel: vi.fn(async () => fx('model-qwen3-coder-30b.json')),
  resolveSha: vi.fn(async () => 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120'),
  listFiles: vi.fn(async () => fx('tree-qwen3-coder-30b.json')),
  getConfig: vi.fn(async () => fx('config-qwen3-coder-30b.json')),
  getReadme: vi.fn(async () => '# Qwen3-Coder'),
});
const runpod = () => ({ listGpus: vi.fn(async ({ count }) => (count === 1 ? [{ id: 'GPU80', name: 'GPU80', memory: 80, price: { secure: 1.79 }, maxCount: { secure: 8 }, dataCenters: [{ id: 'EU-RO-1', availability: 'HIGH' }] }] : [])) });
const advisorHttp = (content) => ({ request: vi.fn(async (m, url) => {
  if (url.includes('/git/trees/')) return { ok: true, status: 200, data: tree };
  if (url.includes('raw.githubusercontent.com')) return { ok: true, status: 200, data: 'ricetta' };
  return { ok: true, status: 200, data: { choices: [{ message: { content } }] } };
}) });

function setup(answers) {
  const s = sandbox({ answers });
  s.store.writeConfig({ dataCenterId: 'EU-RO-1', advisor: { enabled: true } });
  s.store.writeEnv({ LLMPOD_ADVISOR_PRESET: 'zai', LLMPOD_ADVISOR_API_KEY: 'CHIAVE-CONSULENTE-FINTA-1' });
  return s;
}
const PROPOSAL = '{"set":{"enable-prefix-caching":true,"api-key":"x"},"rationale":"suggerito dalla recipe","warnings":["controlla la licenza"]}';

describe('plan con consulente', () => {
  it('mostra la proposta e la applica se confermata', async () => {
    const s = setup({ ask: [true] });
    expect(await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'], { hf: hf(), runpod: runpod(), http: advisorHttp(PROPOSAL) })).toBe(0);
    const out = s.out();
    expect(out).toContain('suggerito dalla recipe');
    expect(out).toContain('+ --enable-prefix-caching');
    expect(out).toMatch(/api-key.*vietato/);
    const plan = s.store.readJson('last-plan.json');
    expect(plan.vllm.args).toContain('--enable-prefix-caching');
    expect(plan.advisor).toMatchObject({ preset: 'zai', applied: true, rationale: 'suggerito dalla recipe', notes: ['controlla la licenza'], recipePath: 'Qwen/Qwen3-Coder-480B-A35B.md' });
  });

  it('proposta rifiutata: argomenti di base, applied false', async () => {
    const s = setup({ ask: [false] });
    await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'], { hf: hf(), runpod: runpod(), http: advisorHttp(PROPOSAL) });
    const plan = s.store.readJson('last-plan.json');
    expect(plan.vllm.args).not.toContain('--enable-prefix-caching');
    expect(plan.advisor.applied).toBe(false);
  });

  it('--no-advisor non chiama il consulente; consulente in errore → avviso e piano comunque', async () => {
    const s = setup();
    const http = advisorHttp(PROPOSAL);
    expect(await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', '--no-advisor'], { hf: hf(), runpod: runpod(), http })).toBe(0);
    expect(http.request).not.toHaveBeenCalled();
    const s2 = setup();
    const broken = { request: vi.fn(async () => ({ ok: false, status: 500, data: {} })) };
    expect(await s2.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'], { hf: hf(), runpod: runpod(), http: broken })).toBe(0);
    expect(s2.all()).toMatch(/Consulente non disponibile/);
    expect(s2.store.readJson('last-plan.json').advisor).toBeNull();
  });

  it('--yes applica senza chiedere e save porta le note nel profilo', async () => {
    const s = setup();
    s.store.writeEnv({ RUNPOD_API_KEY: 'rpa_FINTA_CHIAVE_RUNPOD_123' });
    await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', '--yes'], { hf: hf(), runpod: runpod(), http: advisorHttp(PROPOSAL) });
    expect(s.prompt.ask).not.toHaveBeenCalled();
    expect(await s.run(['save', 'qwen3-coder'])).toBe(0);
    expect(s.store.readProfile('qwen3-coder').advisor).toMatchObject({ applied: true });
  });
});
