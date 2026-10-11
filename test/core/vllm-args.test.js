import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { detectParsers, buildArgs, applyOverrides, loadFlags, validateArgs } from '../../src/core/planner/vllm-args.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const cfg = (architectures, model_type) => ({ architectures, model_type });

describe('detectParsers', () => {
  it.each([
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', fx('config-qwen3-coder-30b.json'), 'qwen3_coder', null],
    ['Qwen/Qwen3-30B-A3B-Thinking-2507', cfg(['Qwen3MoeForCausalLM'], 'qwen3_moe'), 'hermes', 'qwen3'],
    ['Qwen/Qwen3-30B-A3B-Instruct-2507', cfg(['Qwen3MoeForCausalLM'], 'qwen3_moe'), 'hermes', null],
    ['zai-org/GLM-4.6', fx('config-glm.json'), 'glm45', 'glm45'],
    ['zai-org/GLM-4.7', cfg(['Glm4MoeForCausalLM'], 'glm4_moe'), 'glm47', 'glm47'],
    ['zai-org/GLM-5.3', cfg(['GlmMoeDsaForCausalLM'], 'glm_moe_dsa'), 'glm47', 'glm47'],
    ['deepseek-ai/DeepSeek-V3-0324', fx('config-deepseek-v3.json'), 'deepseek_v3', 'deepseek_v3'],
    ['moonshotai/Kimi-K2-Instruct', cfg(['DeepseekV3ForCausalLM'], 'kimi_k2'), 'kimi_k2', null],
    ['moonshotai/Kimi-K2-Thinking', cfg(['DeepseekV3ForCausalLM'], 'kimi_k2'), 'kimi_k2', 'kimi_k2'],
    ['openai/gpt-oss-120b', cfg(['GptOssForCausalLM'], 'gpt_oss'), 'openai', 'openai_gptoss'],
    ['Qwen/Qwen3-Coder-Next', cfg(['Qwen3NextForCausalLM'], 'qwen3_next'), 'qwen3_coder', null],
    ['Qwen/Qwen3-Next-80B-A3B-Instruct', cfg(['Qwen3NextForCausalLM'], 'qwen3_next'), 'hermes', 'qwen3'],
    ['unsloth/Llama-3.3-70B-Instruct', fx('config-llama.json'), 'llama3_json', null],
  ])('%s → %s / %s', (modelId, config, tool, reasoning) => {
    const p = detectParsers({ modelId, config });
    expect(p.tool).toBe(tool);
    expect(p.reasoning).toBe(reasoning);
  });

  it('Kimi-K2 non viene scambiato per DeepSeek (model_type prima di architectures)', () => {
    expect(detectParsers({ modelId: 'x/Kimi', config: cfg(['DeepseekV3ForCausalLM'], 'kimi_k2') }).tool).toBe('kimi_k2');
  });

  it('Mistral aggiunge --tokenizer-mode mistral', () => {
    expect(detectParsers({ modelId: 'mistralai/Devstral-Small-2507', config: cfg(['MistralForCausalLM'], 'mistral') }).extraArgs)
      .toEqual(['--tokenizer-mode', 'mistral']);
    expect(detectParsers({ modelId: 'mistralai/Magistral-Small-2509', config: cfg(['X'], 'mistral3') })).toMatchObject({ tool: 'mistral', reasoning: 'mistral' });
  });

  it('architettura sconosciuta → nessun parser e avviso', () => {
    const p = detectParsers({ modelId: 'x/y', config: cfg(['FooForCausalLM'], 'foo') });
    expect(p.tool).toBeNull();
    expect(p.warnings[0]).toMatch(/UNKNOWN_TOOL_PARSER/);
  });
});

describe('buildArgs e override', () => {
  const parsers = { tool: 'qwen3_coder', reasoning: null, extraArgs: [], warnings: [] };

  it('costruisce gli argomenti di base', () => {
    expect(buildArgs({ context: 65536, tp: 1, revision: 'abc', parsers })).toEqual([
      '--max-model-len', '65536', '--tensor-parallel-size', '1', '--gpu-memory-utilization', '0.9',
      '--revision', 'abc', '--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_coder',
    ]);
  });

  it('aggiunge reasoning parser, kv-cache-dtype ed extraArgs', () => {
    const a = buildArgs({ context: 8192, tp: 2, revision: 'r', parsers: { tool: 'mistral', reasoning: 'mistral', extraArgs: ['--tokenizer-mode', 'mistral'] }, kvCacheDtype: 'fp8' });
    expect(a).toEqual(expect.arrayContaining(['--reasoning-parser', 'mistral', '--kv-cache-dtype', 'fp8', '--tokenizer-mode', 'mistral']));
  });

  it('senza tool parser non abilita auto-tool-choice', () => {
    expect(buildArgs({ context: 1, tp: 1, revision: 'r', parsers: { tool: null } })).not.toContain('--enable-auto-tool-choice');
  });

  it('applyOverrides sostituisce, aggiunge, toglie flag', () => {
    const base = ['--max-model-len', '65536', '--enable-prefix-caching'];
    expect(applyOverrides(base, { set: ['max-model-len=32768', 'enforce-eager=true', 'enable-prefix-caching=false'], extra: ['--seed', '1'] }))
      .toEqual(['--max-model-len', '32768', '--enforce-eager', '--seed', '1']);
  });
});

describe('validateArgs', () => {
  const flags = loadFlags();

  it('il file dei flag v0.30.0 contiene i flag principali', () => {
    for (const f of ['--max-model-len', '--tool-call-parser', '--reasoning-parser', '--kv-cache-dtype', '--tensor-parallel-size']) {
      expect(flags.has(f)).toBe(true);
    }
  });

  it('segnala flag sconosciuti e vietati', () => {
    const r = validateArgs(['--max-model-len', '1', '--inventato', '--api-key', 'x', '--host', '0.0.0.0', '--trust-remote-code'], flags);
    expect(r.unknown).toEqual(['--inventato']);
    expect(r.forbidden).toEqual(['--api-key', '--host', '--trust-remote-code']);
    expect(validateArgs(['--trust-remote-code'], flags, { allowTrustRemoteCode: true }).forbidden).toEqual([]);
  });

  it.each([
    ['--api_key', '--api_key'],
    ['--HOST', '--HOST'],
    ['--por', '--por'],
    ['--config', '--config'],
    ['--API_KEY=x', '--API_KEY'],
    ['--served_model_name', '--served_model_name'],
    ['--allowed-local', '--allowed-local'],
  ])('normalizza e vieta %s', (token, reported) => {
    expect(validateArgs([token, 'x'], flags).forbidden).toEqual([reported]);
  });

  it('il prefisso vale anche per --trust-remote-code solo se non consentito', () => {
    expect(validateArgs(['--trust-remote'], flags).forbidden).toEqual(['--trust-remote']);
    expect(validateArgs(['--trust-remote'], flags, { allowTrustRemoteCode: true }).forbidden).toEqual([]);
  });

  it('i flag legittimi non vengono scambiati per vietati', () => {
    expect(validateArgs(['--max_model_len', '1', '--tensor-parallel-size', '2', '--po'], flags).forbidden).toEqual([]);
  });

  it('accetta la forma --flag=valore', () => {
    expect(validateArgs(['--max-model-len=4096'], flags)).toEqual({ unknown: [], forbidden: [] });
  });
});
