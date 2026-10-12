import { describe, it, expect } from 'vitest';
import { buildPodBody, argsForCount, START_CMD } from '../../src/core/pod/body.js';

const profile = {
  name: 'qwen3-coder', servedName: 'qwen3-coder', cloud: 'SECURE',
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'abc', weightsBytes: 61066575656, gated: false },
  vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  volume: { id: 'vol1' }, watchdog: { idleMinutes: 30, maxHours: 8 },
};

describe('buildPodBody', () => {
  it('con volume: mount, HF_HOME sul volume, disco piccolo, supervisore in base64', () => {
    const b = buildPodBody({ profile, candidate: { id: 'GPU80', count: 1, dataCenterId: 'EU-RO-1', withVolume: true }, apiKey: 'k'.repeat(40), minCudaVersion: '12.9' });
    expect(b).toMatchObject({
      name: 'llmpod-qwen3-coder', image: 'vllm/vllm-openai:v0.30.0-cu129', cloud: 'SECURE',
      gpu: { id: 'GPU80', count: 1, minCudaVersion: '12.9' }, dataCenterIds: ['EU-RO-1'],
      ports: ['8000/http', '8001/http'], entrypoint: ['/bin/sh', '-c'], cmd: [START_CMD], disk: 20,
      mounts: { network: [{ volumeId: 'vol1', path: '/workspace' }] },
    });
    expect(b.env).toMatchObject({ HF_HOME: '/workspace/hf', LLMPOD_MODEL: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', LLMPOD_SERVED_NAME: 'qwen3-coder', LLMPOD_IDLE_MINUTES: '30', LLMPOD_MAX_HOURS: '8', LLMPOD_MODEL_BYTES: '61066575656', VLLM_API_KEY: 'k'.repeat(40) });
    expect(Buffer.from(b.env.LLMPOD_SUPERVISOR_B64, 'base64').toString()).toContain('class Supervisor');
    expect(b.env.HF_TOKEN).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(100_000);
  });

  it('senza volume: disco dimensionato sui pesi, HF_HOME locale, nessun mount', () => {
    const b = buildPodBody({ profile, candidate: { id: 'GPU80', count: 2, dataCenterId: 'US-KS-2', withVolume: false }, apiKey: 'k', minCudaVersion: '12.9' });
    expect(b.mounts).toBeUndefined();
    expect(b.env.HF_HOME).toBe('/root/.cache/huggingface');
    expect(b.disk).toBe(Math.ceil(61.066575656 * 1.2) + 20);
    // GPU sconosciuta ×2: trattata come PCIe senza NVLink → modalità NCCL sicura
    expect(JSON.parse(b.env.LLMPOD_VLLM_ARGS)).toEqual(['--max-model-len', '65536', '--tensor-parallel-size', '2', '--disable-custom-all-reduce']);
  });

  it('senza volume: disco e LLMPOD_MODEL_BYTES sul totale da scaricare (estimate.downloadBytes), non sui soli pesi in VRAM', () => {
    // Devstral-Small-2507: pesi 43,9 GiB (shard) ma il repository ha anche consolidated.safetensors: da scaricare ~87,8 GiB
    const p = { ...profile, model: { ...profile.model, weightsBytes: 47144848872 }, estimate: { downloadBytes: 94289695744 } };
    const b = buildPodBody({ profile: p, candidate: { id: 'GPU80', count: 1, dataCenterId: 'X', withVolume: false }, apiKey: 'k', minCudaVersion: '12.9' });
    expect(b.disk).toBe(Math.ceil(94.289695744 * 1.2) + 20);
    expect(b.env.LLMPOD_MODEL_BYTES).toBe('94289695744');
    // profili vecchi senza il campo: ripiego su weightsBytes
    const old = buildPodBody({ profile: { ...profile, estimate: {} }, candidate: { id: 'GPU80', count: 1, dataCenterId: 'X', withVolume: false }, apiKey: 'k', minCudaVersion: '12.9' });
    expect(old.disk).toBe(Math.ceil(61.066575656 * 1.2) + 20);
  });

  it('HF_TOKEN solo per modelli gated', () => {
    const gated = { ...profile, model: { ...profile.model, gated: 'manual' } };
    const b = buildPodBody({ profile: gated, candidate: { id: 'G', count: 1, dataCenterId: 'X', withVolume: true }, apiKey: 'k', hfToken: 'hf_x', minCudaVersion: '12.9' });
    expect(b.env.HF_TOKEN).toBe('hf_x');
  });

  it('argsForCount aggiorna il tensor parallel', () => {
    expect(argsForCount(['--tensor-parallel-size', '1'], 4)).toEqual(['--tensor-parallel-size', '4']);
  });
});
