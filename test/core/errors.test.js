import { describe, it, expect } from 'vitest';
import { LlmpodError, Codes } from '../../src/core/errors.js';

describe('LlmpodError', () => {
  it('conserva codice, messaggio e suggerimento', () => {
    const err = new LlmpodError(Codes.NO_GPU_AVAILABLE, 'Nessuna GPU', { hint: 'Prova un altro datacenter' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LlmpodError');
    expect(err.code).toBe('NO_GPU_AVAILABLE');
    expect(err.hint).toBe('Prova un altro datacenter');
  });

  it('espone tutti i codici della spec', () => {
    for (const c of ['NO_GPU_AVAILABLE', 'INSUFFICIENT_BALANCE', 'GATED_MODEL', 'HF_AUTH', 'OOM',
      'UNKNOWN_TOOL_PARSER', 'ZCODE_RUNNING', 'DOCKER_NOT_RUNNING', 'POD_START_TIMEOUT',
      'SMOKE_TEST_FAILED', 'CONFIG_PERMISSIONS']) {
      expect(Codes[c]).toBe(c);
    }
    expect(Object.isFrozen(Codes)).toBe(true);
  });
});
