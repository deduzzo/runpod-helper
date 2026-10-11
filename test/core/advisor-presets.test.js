import { describe, it, expect } from 'vitest';
import { Codes } from '../../src/core/errors.js';
import { PRESETS, resolveAdvisorConfig, ZAI_NOTICE } from '../../src/core/advisor/presets.js';

describe('preset del consulente', () => {
  it('codici d\'errore nuovi', () => {
    for (const c of ['ADVISOR_NOT_CONFIGURED', 'ADVISOR_FAILED', 'ADVISOR_INVALID']) expect(Codes[c]).toBe(c);
  });

  it('nessun preset configurato → null', () => {
    expect(resolveAdvisorConfig({})).toBeNull();
  });

  it('zai-coding-plan: endpoint Anthropic di Z.ai, glm-5.3, bearer', () => {
    expect(resolveAdvisorConfig({ LLMPOD_ADVISOR_PRESET: 'zai-coding-plan', LLMPOD_ADVISOR_API_KEY: 'k'.repeat(20) })).toEqual({
      preset: 'zai-coding-plan', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3',
      apiKey: 'k'.repeat(20), auth: 'bearer', timeoutMs: 120000,
    });
    expect(ZAI_NOTICE).toMatch(/strumenti supportati/);
  });

  it('anthropic usa x-api-key e il modello predefinito, sovrascrivibile', () => {
    const c = resolveAdvisorConfig({ LLMPOD_ADVISOR_PRESET: 'anthropic', LLMPOD_ADVISOR_API_KEY: 'x', LLMPOD_ADVISOR_MODEL: 'claude-opus-5-5' });
    expect(c).toMatchObject({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', auth: 'x-api-key' });
  });

  it('zai a consumo e openai (modello obbligatorio)', () => {
    expect(resolveAdvisorConfig({ LLMPOD_ADVISOR_PRESET: 'zai', LLMPOD_ADVISOR_API_KEY: 'x' })).toMatchObject({ protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4' });
    expect(() => resolveAdvisorConfig({ LLMPOD_ADVISOR_PRESET: 'openai', LLMPOD_ADVISOR_API_KEY: 'x' }))
      .toThrow(expect.objectContaining({ code: 'ADVISOR_NOT_CONFIGURED', message: expect.stringContaining('LLMPOD_ADVISOR_MODEL') }));
  });

  it('custom richiede protocollo, base URL, modello; https o http locale', () => {
    const env = { LLMPOD_ADVISOR_PRESET: 'custom', LLMPOD_ADVISOR_API_KEY: 'x', LLMPOD_ADVISOR_MODEL: 'm', LLMPOD_ADVISOR_PROTOCOL: 'openai', LLMPOD_ADVISOR_BASE_URL: 'https://llm.example.com/v1/' };
    expect(resolveAdvisorConfig(env)).toMatchObject({ protocol: 'openai', baseUrl: 'https://llm.example.com/v1', auth: 'bearer' });
    expect(resolveAdvisorConfig({ ...env, LLMPOD_ADVISOR_BASE_URL: 'http://localhost:11434/v1' }).baseUrl).toBe('http://localhost:11434/v1');
    expect(() => resolveAdvisorConfig({ ...env, LLMPOD_ADVISOR_BASE_URL: 'http://evil.example.com' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => resolveAdvisorConfig({ ...env, LLMPOD_ADVISOR_PROTOCOL: 'grpc' })).toThrow(expect.objectContaining({ code: 'ADVISOR_NOT_CONFIGURED' }));
  });

  it('claude-cli non richiede chiave', () => {
    expect(resolveAdvisorConfig({ LLMPOD_ADVISOR_PRESET: 'claude-cli' })).toEqual({ preset: 'claude-cli', protocol: 'claude-cli', timeoutMs: 180000 });
  });

  it('pod: solo livello 3, usa l\'endpoint del Pod', () => {
    expect(resolveAdvisorConfig({ LLMPOD_ADVISOR_PRESET: 'pod' })).toEqual({ preset: 'pod', protocol: 'openai', podOnly: true });
    const ep = { baseUrl: 'https://p-8000.proxy.runpod.net', apiKey: 'chiave', servedName: 'qwen3-coder' };
    expect(resolveAdvisorConfig({ LLMPOD_ADVISOR_PRESET: 'pod' }, { endpoint: ep })).toEqual({
      preset: 'pod', protocol: 'openai', baseUrl: 'https://p-8000.proxy.runpod.net/v1', model: 'qwen3-coder', apiKey: 'chiave', auth: 'bearer', timeoutMs: 90000, podOnly: true,
    });
  });

  it('preset sconosciuto → INVALID_INPUT', () => {
    expect(() => resolveAdvisorConfig({ LLMPOD_ADVISOR_PRESET: 'boh' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('ogni preset ha un\'etichetta', () => {
    for (const p of Object.values(PRESETS)) expect(p.label).toBeTruthy();
  });
});
