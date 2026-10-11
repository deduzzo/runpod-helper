import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlan, applyAdvice } from '../../src/core/plan-flow.js';
import { createStore } from '../../src/core/config.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
function ctxWith({ config = { dataCenterId: 'EU-RO-1' }, provider = null, providerThrows = null } = {}) {
  const store = createStore({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-pf-')), 'cfg'), platform: 'linux' });
  store.writeConfig(config);
  return {
    store,
    hf: {
      getModel: vi.fn(async () => fx('model-qwen3-coder-30b.json')),
      resolveSha: vi.fn(async () => 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120'),
      listFiles: vi.fn(async () => fx('tree-qwen3-coder-30b.json')),
      getConfig: vi.fn(async () => fx('config-qwen3-coder-30b.json')),
      getReadme: vi.fn(async () => '# scheda'),
    },
    runpod: { listGpus: vi.fn(async ({ count }) => (count === 1 ? [{ id: 'G80', name: 'G80', memory: 80, price: { secure: 1.79 }, maxCount: { secure: 8 }, dataCenters: [{ id: 'EU-RO-1', availability: 'HIGH' }] }] : [])) },
    http: { request: vi.fn(async () => ({ ok: false, status: 404, data: null })) },
    advisor: {
      active: () => store.readConfig().advisor?.enabled === true,
      provider: () => { if (providerThrows) throw providerThrows; return provider; },
      config: () => ({ preset: 'zai' }),
    },
  };
}

describe('runPlan', () => {
  it('senza datacenter → INVALID_INPUT', async () => {
    await expect(runPlan({ ctx: ctxWith({ config: {} }), modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('senza consulente: advice null', async () => {
    const r = await runPlan({ ctx: ctxWith(), modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' });
    expect(r).toMatchObject({ advice: null, advisorError: null, advisorSkipped: null });
    expect(r.plan.advisor).toBeNull();
    expect(r.plan.gpu).toEqual({ id: 'G80', count: 1 });
  });

  it('con consulente: proposta non applicata finché non si chiama applyAdvice', async () => {
    const provider = { label: 'finto', complete: vi.fn(async () => ({ text: '{"set":{"enable-prefix-caching":true},"rationale":"r","warnings":[]}' })) };
    const r = await runPlan({ ctx: ctxWith({ config: { dataCenterId: 'EU-RO-1', advisor: { enabled: true } }, provider }), modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' });
    expect(r.advice.accepted).toEqual(['enable-prefix-caching=true']);
    expect(r.plan.vllm.args).not.toContain('--enable-prefix-caching');
    expect(r.plan.advisor).toMatchObject({ preset: 'zai', applied: false, rationale: 'r', proposed: { added: ['--enable-prefix-caching'] } });
    applyAdvice(r.plan, r.advice);
    expect(r.plan.vllm.args).toContain('--enable-prefix-caching');
    expect(r.plan.advisor.applied).toBe(true);
  });

  it('errore del consulente → advisorError, piano comunque; advisor:false lo salta', async () => {
    const ctx = ctxWith({ config: { dataCenterId: 'EU-RO-1', advisor: { enabled: true } }, providerThrows: Object.assign(new Error('Consulente "custom" incompleto'), { code: 'ADVISOR_NOT_CONFIGURED' }) });
    const r = await runPlan({ ctx, modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' });
    expect(r.advisorError).toMatch(/incompleto/);
    expect(r.plan.gpu).not.toBeNull();
    const r2 = await runPlan({ ctx, modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', advisor: false });
    expect(r2.advisorError).toBeNull();
  });

  it('advisor:true forza il consulente anche se non attivo e senza provider → advisorSkipped', async () => {
    const provider = vi.fn(() => null);
    const ctx = ctxWith();
    ctx.advisor.provider = provider;
    const r = await runPlan({ ctx, modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', advisor: true });
    expect(provider).toHaveBeenCalledWith(undefined, { force: true });
    expect(r.advisorSkipped).toMatch(/non configurato/);
    expect(r.plan.advisor).toBeNull();
  });
});
