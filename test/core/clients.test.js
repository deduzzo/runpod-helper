import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatEnv } from '../../src/core/clients/env-format.js';
import { updateJsonFile } from '../../src/core/clients/json-file.js';
import { claudeEnv, maxOutputTokens, prepareClaude } from '../../src/core/clients/claude-code.js';
import { opencodeConfig, prepareOpencode } from '../../src/core/clients/opencode.js';
import { mergeZcodeConfig, updateZcode, isZcodeRunning } from '../../src/core/clients/zcode.js';
import { mergePiModels, preparePi } from '../../src/core/clients/pi.js';

const endpoint = { baseUrl: 'https://p1-8000.proxy.runpod.net', apiKey: 'CHIAVE-FINTA-1234567890', servedName: 'qwen3-coder', context: 65536, reasoning: false };
let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-cl-')); });
const mode = (p) => fs.statSync(p).mode & 0o777;

describe('formatEnv', () => {
  it('sh, ps1 e json con apici', () => {
    const env = { A: "x'y", B: '1' };
    expect(formatEnv(env, 'sh')).toBe("export A='x'\\''y'\nexport B='1'");
    expect(formatEnv(env, 'ps1')).toBe("$env:A = 'x''y'\n$env:B = '1'");
    expect(JSON.parse(formatEnv(env, 'json'))).toEqual(env);
  });
});

describe('Claude Code', () => {
  it('variabili d\'ambiente previste dalla spec', () => {
    expect(claudeEnv(endpoint)).toEqual({
      ANTHROPIC_BASE_URL: 'https://p1-8000.proxy.runpod.net',
      ANTHROPIC_AUTH_TOKEN: 'CHIAVE-FINTA-1234567890',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384',
      API_TIMEOUT_MS: '600000',
    });
    expect(prepareClaude(endpoint).command).toBe('claude');
  });

  it('maxOutputTokens', () => {
    expect(maxOutputTokens(65536)).toBe(16384);
    expect(maxOutputTokens(262144)).toBe(32000);
    expect(maxOutputTokens(2048)).toBe(1024);
  });
});

describe('OpenCode', () => {
  it('config con provider openai-compatible e chiave da variabile', () => {
    const c = opencodeConfig(endpoint);
    expect(c.model).toBe('llmpod/qwen3-coder');
    expect(c.provider.llmpod).toMatchObject({ npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://p1-8000.proxy.runpod.net/v1', apiKey: '{env:LLMPOD_API_KEY}' } });
    expect(c.provider.llmpod.models['qwen3-coder'].limit).toEqual({ context: 65536, output: 16384 });
  });

  it('prepareOpencode scrive un file senza segreti e passa la chiave via env', () => {
    const p = prepareOpencode(endpoint, { dir: tmp });
    expect(p.env.OPENCODE_CONFIG).toBe(path.join(tmp, 'clients', 'opencode.json'));
    expect(p.env.LLMPOD_API_KEY).toBe(endpoint.apiKey);
    expect(fs.readFileSync(p.env.OPENCODE_CONFIG, 'utf8')).not.toContain(endpoint.apiKey);
    expect(mode(p.env.OPENCODE_CONFIG)).toBe(0o600);
  });
});

describe('updateJsonFile', () => {
  it('JSON non valido: errore e file intatto', () => {
    const f = path.join(tmp, 'c.json');
    fs.writeFileSync(f, '{ rotto');
    expect(() => updateJsonFile(f, (c) => c, { invalidCode: 'ZCODE_CONFIG_INVALID', label: 'ZCode' })).toThrow(expect.objectContaining({ code: 'ZCODE_CONFIG_INVALID' }));
    expect(fs.readFileSync(f, 'utf8')).toBe('{ rotto');
  });

  it('backup e permessi 600', () => {
    const f = path.join(tmp, 'c.json');
    fs.writeFileSync(f, '{"a":1}');
    updateJsonFile(f, (c) => ({ ...c, b: 2 }), { invalidCode: 'X', label: 'x' });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ a: 1, b: 2 });
    expect(fs.readFileSync(`${f}.llmpod-bak`, 'utf8')).toBe('{"a":1}');
    expect(mode(f)).toBe(0o600);
    expect(mode(`${f}.llmpod-bak`)).toBe(0o600);
  });
});

describe('ZCode', () => {
  it('merge preserva gli altri provider', () => {
    const existing = { provider: { 'builtin:zai': { kind: 'anthropic', models: { 'GLM-5.3': {} } } } };
    const out = mergeZcodeConfig(existing, endpoint);
    expect(out.provider['builtin:zai']).toEqual(existing.provider['builtin:zai']);
    expect(out.provider.llmpod).toMatchObject({ kind: 'openai-compatible', source: 'custom', options: { baseURL: 'https://p1-8000.proxy.runpod.net/v1', apiKey: endpoint.apiKey, apiKeyRequired: true } });
    expect(out.provider.llmpod.models['qwen3-coder'].limit).toEqual({ context: 65536, output: 16384 });
  });

  it('rifiuta se ZCode è aperto', async () => {
    await expect(updateZcode(endpoint, { dir: tmp, isRunning: async () => true })).rejects.toMatchObject({ code: 'ZCODE_RUNNING' });
  });

  it('scrive config.json quando ZCode è chiuso', async () => {
    const file = await updateZcode(endpoint, { dir: tmp, isRunning: async () => false });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).provider.llmpod.kind).toBe('openai-compatible');
  });

  it('isZcodeRunning: pgrep su macOS/Linux, tasklist su Windows', async () => {
    const execOk = vi.fn().mockResolvedValue({ stdout: '123\n' });
    expect(await isZcodeRunning({ platform: 'darwin', exec: execOk })).toBe(true);
    expect(execOk).toHaveBeenCalledWith('pgrep', ['-x', 'ZCode']);
    const execFail = vi.fn().mockRejectedValue(Object.assign(new Error('exit 1'), { code: 1 }));
    expect(await isZcodeRunning({ platform: 'linux', exec: execFail })).toBe(false);
    const execWin = vi.fn().mockResolvedValue({ stdout: 'INFO: No tasks are running' });
    expect(await isZcodeRunning({ platform: 'win32', exec: execWin })).toBe(false);
  });
});

describe('pi', () => {
  it('merge di models.json con chiave interpolata, mai in chiaro', () => {
    const out = mergePiModels({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }, { ...endpoint, reasoning: true });
    expect(out.providers.ollama).toEqual({ baseUrl: 'http://localhost:11434/v1' });
    expect(out.providers.llmpod).toEqual({
      baseUrl: 'https://p1-8000.proxy.runpod.net/v1', api: 'openai-completions', apiKey: '$LLMPOD_API_KEY',
      models: [{ id: 'qwen3-coder', name: 'qwen3-coder (llmpod)', contextWindow: 65536, maxTokens: 16384, reasoning: true }],
    });
  });

  it('preparePi scrive models.json e prepara il comando', () => {
    const p = preparePi(endpoint, { dir: tmp });
    expect(p).toEqual({ command: 'pi', args: ['--provider', 'llmpod', '--model', 'qwen3-coder'], env: { LLMPOD_API_KEY: endpoint.apiKey } });
    const text = fs.readFileSync(path.join(tmp, 'models.json'), 'utf8');
    expect(text).not.toContain(endpoint.apiKey);
    expect(JSON.parse(text).$schema).toBe('https://pi.dev/schemas/models.schema.json');
  });
});
