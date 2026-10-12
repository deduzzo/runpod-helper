import { describe, it, expect } from 'vitest';
import { hasNvlink, needsNcclSafe, ncclEnv, refreshNcclWarning, NCCL_WARNING } from '../../src/core/planner/nccl.js';
import { buildPodBody } from '../../src/core/pod/body.js';
import { profileFromPlan } from '../../src/core/ops.js';

describe('hasNvlink: NVLink presunto solo per GPU SXM/HGX', () => {
  it.each([
    'NVIDIA H100 80GB HBM3', 'NVIDIA H100 SXM', 'NVIDIA H200', 'NVIDIA H200 SXM', 'NVIDIA B200', 'NVIDIA B300',
    'NVIDIA A100-SXM4-80GB', 'NVIDIA A100 SXM4 40GB', 'NVIDIA GB200', 'NVIDIA H100 NVL',
  ])('%s → sì', (id) => expect(hasNvlink(id)).toBe(true));

  it.each([
    'NVIDIA RTX PRO 6000 Blackwell Server Edition', 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition', 'NVIDIA GeForce RTX 5090',
    'NVIDIA GeForce RTX 4090', 'NVIDIA RTX 6000 Ada Generation', 'NVIDIA RTX A6000', 'NVIDIA RTX A5000', 'NVIDIA L4', 'NVIDIA L40',
    'NVIDIA L40S', 'NVIDIA A40', 'NVIDIA A10', 'NVIDIA A16', 'NVIDIA A100 80GB PCIe', 'NVIDIA H100 PCIe', 'GPU sconosciuta', '', null,
  ])('%s → no', (id) => expect(hasNvlink(id)).toBe(false));
});

describe('needsNcclSafe / ncclEnv', () => {
  it('solo con più GPU senza NVLink', () => {
    expect(needsNcclSafe('NVIDIA RTX PRO 6000 Blackwell Server Edition', 2)).toBe(true);
    expect(needsNcclSafe('NVIDIA RTX PRO 6000 Blackwell Server Edition', 1)).toBe(false);
    expect(needsNcclSafe('NVIDIA H100 80GB HBM3', 4)).toBe(false);
  });

  it('NCCL_P2P_DISABLE=1 (e non NCCL_IB_DISABLE), salvo ncclSafe: false', () => {
    expect(ncclEnv({ gpuId: 'NVIDIA L40S', count: 2 })).toEqual({ NCCL_P2P_DISABLE: '1' });
    expect(ncclEnv({ gpuId: 'NVIDIA L40S', count: 2, ncclSafe: false })).toEqual({});
    expect(ncclEnv({ gpuId: 'NVIDIA L40S', count: 1 })).toEqual({});
    expect(ncclEnv({ gpuId: 'NVIDIA B200', count: 8 })).toEqual({});
  });
});

describe('refreshNcclWarning: avviso del piano sulla GPU scelta', () => {
  const plan = (gpu, extra = {}) => ({ gpu, warnings: ['altro'], ...extra });

  it('multi-GPU PCIe: avviso con la variabile e come disattivarla', () => {
    const p = refreshNcclWarning(plan({ id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', count: 2 }));
    const w = p.warnings.filter((x) => x.startsWith(NCCL_WARNING));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/NCCL_P2P_DISABLE=1/);
    expect(w[0]).toMatch(/--no-nccl-safe/);
    expect(p.warnings).toContain('altro');
  });

  it('rigenerato al cambio di GPU; nessun avviso con una GPU o con NVLink', () => {
    const p = refreshNcclWarning(plan({ id: 'NVIDIA L40S', count: 2 }));
    p.gpu = { id: 'NVIDIA L40S', count: 1 };
    expect(refreshNcclWarning(p).warnings.some((x) => x.startsWith(NCCL_WARNING))).toBe(false);
    expect(refreshNcclWarning(plan({ id: 'NVIDIA H200', count: 2 })).warnings).toEqual(['altro']);
  });

  it('con ncclSafe: false l\'avviso dice che la protezione è disattivata', () => {
    const p = refreshNcclWarning(plan({ id: 'NVIDIA L40S', count: 2 }, { ncclSafe: false }));
    expect(p.warnings.find((x) => x.startsWith(NCCL_WARNING))).toMatch(/disattivat/);
  });
});

describe('Pod: variabili NCCL nell\'ambiente del container', () => {
  const profile = {
    name: 'big', servedName: 'big', cloud: 'SECURE',
    model: { id: 'org/m', revision: 'abc', weightsBytes: 10e9, gated: false },
    vllm: { image: 'vllm/vllm-openai:v0.30.0', args: ['--tensor-parallel-size', '1'] },
    volume: null, watchdog: { idleMinutes: 30, maxHours: 8 },
  };
  const body = (candidate, p = profile) => buildPodBody({ profile: p, candidate: { dataCenterId: 'X', withVolume: false, ...candidate }, apiKey: 'k', minCudaVersion: '12.9' });

  it('2× RTX PRO 6000 Server Edition → NCCL_P2P_DISABLE=1; una GPU o NVLink → nessuna variabile', () => {
    expect(body({ id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', count: 2 }).env.NCCL_P2P_DISABLE).toBe('1');
    expect(body({ id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', count: 1 }).env.NCCL_P2P_DISABLE).toBeUndefined();
    expect(body({ id: 'NVIDIA H100 80GB HBM3', count: 2 }).env.NCCL_P2P_DISABLE).toBeUndefined();
    expect(body({ id: 'NVIDIA L40S', count: 2 }).env.NCCL_IB_DISABLE).toBeUndefined();
  });

  it('profilo con ncclSafe: false → nessuna variabile', () => {
    expect(body({ id: 'NVIDIA L40S', count: 2 }, { ...profile, ncclSafe: false }).env.NCCL_P2P_DISABLE).toBeUndefined();
  });

  it('il profilo eredita ncclSafe dal piano (predefinito true)', () => {
    const plan = { model: profile.model, gpu: { id: 'NVIDIA L40S', count: 2 }, alternatives: [], vllm: profile.vllm, estimate: {}, warnings: [] };
    expect(profileFromPlan(plan, { name: 'x', volume: null, watchdog: profile.watchdog }).ncclSafe).toBe(true);
    expect(profileFromPlan({ ...plan, ncclSafe: false }, { name: 'x', volume: null, watchdog: profile.watchdog }).ncclSafe).toBe(false);
  });
});
