import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, parseEnv, serializeEnv, configDir, assertProfileName, profileKeyVar } from '../../src/core/config.js';
import { redact, clearSecrets } from '../../src/core/secrets.js';

let dir;
beforeEach(() => {
  clearSecrets();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-'));
  dir = path.join(dir, 'cfg');
});
const mode = (p) => fs.statSync(p).mode & 0o777;

describe('config', () => {
  it('configDir rispetta LLMPOD_CONFIG_DIR', () => {
    expect(configDir({ LLMPOD_CONFIG_DIR: '/x/y' })).toBe('/x/y');
  });

  it('parseEnv / serializeEnv gestiscono commenti, virgolette e uguali nei valori', () => {
    const env = parseEnv('# commento\nA=1\nB="due = 2"\n\nC=x=y\n');
    expect(env).toEqual({ A: '1', B: 'due = 2', C: 'x=y' });
    expect(parseEnv(serializeEnv(env))).toEqual(env);
  });

  it('writeEnv crea cartella 700 e file 600, unisce e registra i segreti', () => {
    const s = createStore({ dir, platform: 'linux' });
    s.writeEnv({ RUNPOD_API_KEY: 'rpa_SEGRETOFINTO1234' });
    s.writeEnv({ HF_TOKEN: 'hf_TOKENFINTO1234567' });
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, '.env'))).toBe(0o600);
    expect(s.readEnv()).toEqual({ RUNPOD_API_KEY: 'rpa_SEGRETOFINTO1234', HF_TOKEN: 'hf_TOKENFINTO1234567' });
    expect(redact('x rpa_SEGRETOFINTO1234')).toBe('x <REDATTO>');
  });

  it('checkPermissions rifiuta un .env leggibile da altri', () => {
    const s = createStore({ dir, platform: 'linux' });
    s.writeEnv({ A: '1' });
    fs.chmodSync(path.join(dir, '.env'), 0o644);
    expect(() => s.checkPermissions()).toThrow(expect.objectContaining({ code: 'CONFIG_PERMISSIONS' }));
  });

  it('profili: nome valido, round-trip, elenco', () => {
    const s = createStore({ dir, platform: 'linux' });
    s.writeProfile({ name: 'qwen3-coder', model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' } });
    expect(s.readProfile('qwen3-coder').model.id).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');
    expect(s.listProfiles()).toEqual(['qwen3-coder']);
    expect(mode(path.join(dir, 'profiles', 'qwen3-coder.json'))).toBe(0o600);
    expect(() => s.readProfile('inesistente')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('assertProfileName e profileKeyVar', () => {
    expect(() => assertProfileName('Org/Model')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => assertProfileName('qwen3-coder-30b')).not.toThrow();
    expect(profileKeyVar('qwen3-coder-30b')).toBe('LLMPOD_KEY_QWEN3_CODER_30B');
  });

  it('readConfig fornisce i default', () => {
    const s = createStore({ dir, platform: 'linux' });
    expect(s.readConfig()).toMatchObject({ cloud: 'SECURE', vllmImage: 'vllm/vllm-openai:v0.30.0-cu129', volumePricePerGbMonth: 0.07, watchdog: { idleMinutes: 30, maxHours: 8 } });
    s.writeConfig({ dataCenterId: 'EU-RO-1' });
    expect(s.readConfig().dataCenterId).toBe('EU-RO-1');
  });

  it('con LLMPOD_HOST_OS=windows (file montati 0777) niente controllo dei permessi né chmod', () => {
    const s = createStore({ dir, platform: 'linux', env: { LLMPOD_HOST_OS: 'windows' } });
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    s.writeEnv({ A: '1' });
    fs.chmodSync(path.join(dir, '.env'), 0o777);
    expect(() => s.checkPermissions()).not.toThrow();
    expect(mode(dir)).toBe(0o755); // chmod 700 della cartella saltato
    const normal = createStore({ dir, platform: 'linux', env: {} });
    expect(() => normal.checkPermissions()).toThrow(expect.objectContaining({ code: 'CONFIG_PERMISSIONS' }));
  });
});
