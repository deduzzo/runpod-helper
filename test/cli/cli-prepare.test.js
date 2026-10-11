import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-PREPARE-FINTA-1234567';

function setup() {
  const s = sandbox();
  s.store.writeEnv({ ...SECRETS, LLMPOD_KEY_QWEN3_CODER: KEY });
  s.store.writeProfile({ name: 'qwen3-coder', servedName: 'qwen3-coder', context: 65536, parsers: { tool: 'qwen3_coder', reasoning: null }, model: { id: 'Q/Q' }, gpu: { id: 'G', count: 1 }, vllm: { args: [] } });
  s.store.writeState({ pods: { 'qwen3-coder': { podId: 'pod1' } } });
  const runpod = { getPod: async () => ({ id: 'pod1', name: 'llmpod-qwen3-coder', status: 'RUNNING' }), listPods: async () => [] };
  return { ...s, runpod };
}

describe('llmpod prepare', () => {
  it('sh: export e exec, percorsi tradotti per OpenCode', async () => {
    const t = setup();
    expect(await t.run(['prepare', 'opencode', '--format', 'sh', '--host-config-dir', '/Users/io/.config/llmpod'], { runpod: t.runpod })).toBe(0);
    const out = t.out();
    expect(out).toContain("export OPENCODE_CONFIG='/Users/io/.config/llmpod/clients/opencode.json'");
    expect(out).toContain(`export LLMPOD_API_KEY='${KEY}'`);
    expect(out.trim().split('\n').at(-1)).toBe("exec 'opencode'");
    expect(fs.existsSync(path.join(t.env.LLMPOD_CONFIG_DIR, 'clients', 'opencode.json'))).toBe(true);
  });

  it('ps1 per pi con argomenti', async () => {
    const t = setup();
    expect(await t.run(['prepare', 'pi', '--format', 'ps1', '--host-pi-dir', 'C:\\Users\\io\\.pi\\agent'], { runpod: t.runpod })).toBe(0);
    const lines = t.out().trim().split('\n');
    expect(lines).toContain(`$env:LLMPOD_API_KEY = '${KEY}'`);
    expect(lines.at(-1)).toBe("& 'pi' '--provider' 'llmpod' '--model' 'qwen3-coder'; exit $LASTEXITCODE");
  });

  it('zcode non ammesso', async () => {
    const t = setup();
    expect(await t.run(['prepare', 'zcode'], { runpod: t.runpod })).toBe(1);
    expect(t.err()).toMatch(/llmpod run zcode/);
  });
});
