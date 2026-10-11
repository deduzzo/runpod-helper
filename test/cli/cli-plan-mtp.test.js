import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const gpu = (id, memory, price, dc) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: [{ id: dc, availability: 'HIGH' }] });
const REF = 'llmfan46/Qwen3.8-27B-Uncensored-Heretic-Native-MTP-Preserved-GPTQ-Int4';
const hfFake = (index = fx('index-qwen38-27b-gptq-mtp.json').weight_map) => ({
  getModel: vi.fn(async () => fx('model-qwen38-27b-gptq-mtp.json')),
  resolveSha: vi.fn(async () => 'aedc6ce29b7b0c84c7fadfb59fb8524357f8014c'),
  listFiles: vi.fn(async () => fx('tree-qwen38-27b-gptq-mtp.json')),
  getConfig: vi.fn(async () => fx('config-qwen38-27b-gptq-mtp.json')),
  getWeightIndex: vi.fn(async () => index),
});
const runpodFake = () => ({ listGpus: vi.fn(async ({ count }) => (count === 1 ? [gpu('NVIDIA A100 80GB PCIe', 80, 1.79, 'EU-RO-1')] : [])) });

describe('CLI: plan con MTP', () => {
  it('mostra la riga MTP attiva e il comando con --speculative-config tra apici', async () => {
    const s = sandbox();
    s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
    expect(await s.run(['plan', REF, '--no-advisor'], { hf: hfFake(), runpod: runpodFake() })).toBe(0);
    expect(s.out()).toContain('MTP:       attivo (decodifica speculativa, 1 token)');
    expect(s.out()).toContain(`--speculative-config '{"method":"mtp","num_speculative_tokens":1}'`);
  });

  it('--set speculative-config=false: MTP presente ma disattivato', async () => {
    const s = sandbox();
    s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
    expect(await s.run(['plan', REF, '--no-advisor', '--set', 'speculative-config=false'], { hf: hfFake(), runpod: runpodFake() })).toBe(0);
    expect(s.out()).toContain('MTP:       presente nei pesi ma disattivato');
    expect(s.out()).not.toContain('--speculative-config');
  });

  it('senza tensori mtp.*: "assente nei pesi"', async () => {
    const s = sandbox();
    s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
    const wm = Object.fromEntries(Object.entries(fx('index-qwen38-27b-gptq-mtp.json').weight_map).filter(([k]) => !k.startsWith('mtp.')));
    expect(await s.run(['plan', REF, '--no-advisor'], { hf: hfFake(wm), runpod: runpodFake() })).toBe(0);
    expect(s.out()).toContain('MTP:       assente nei pesi');
  });
});
