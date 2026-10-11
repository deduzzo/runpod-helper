import { describe, it, expect, beforeEach } from 'vitest';
import { registerSecret, redact, redactObject, clearSecrets } from '../../src/core/secrets.js';

describe('segreti', () => {
  beforeEach(() => clearSecrets());

  it('sostituisce i segreti registrati ovunque compaiano', () => {
    registerSecret('rpa_SEGRETOFINTO1234');
    expect(redact('Bearer rpa_SEGRETOFINTO1234 e ancora rpa_SEGRETOFINTO1234'))
      .toBe('Bearer <REDATTO> e ancora <REDATTO>');
  });

  it('ignora valori troppo corti per non oscurare testo normale', () => {
    registerSecret('abc');
    expect(redact('abc def')).toBe('abc def');
  });

  it('serializza gli oggetti prima di mascherare', () => {
    registerSecret('hf_TOKENFINTO123456');
    expect(redact({ a: 'hf_TOKENFINTO123456' })).toBe('{"a":"<REDATTO>"}');
  });

  it('redactObject maschera per nome di chiave anche segreti non registrati', () => {
    const out = redactObject({
      env: { VLLM_API_KEY: 'x'.repeat(40), HF_TOKEN: 'y', HF_HOME: '/workspace/hf' },
      headers: { Authorization: 'Bearer zzz' },
      list: [{ apiKey: 'k' }],
    });
    expect(out.env.VLLM_API_KEY).toBe('<REDATTO>');
    expect(out.env.HF_TOKEN).toBe('<REDATTO>');
    expect(out.env.HF_HOME).toBe('/workspace/hf');
    expect(out.headers.Authorization).toBe('<REDATTO>');
    expect(out.list[0].apiKey).toBe('<REDATTO>');
  });

  it('redactObject maschera i segreti registrati dentro valori non sensibili', () => {
    registerSecret('SEGRETO-NEL-TESTO-123');
    expect(redactObject({ cmd: ['echo SEGRETO-NEL-TESTO-123'] }).cmd[0]).toBe('echo <REDATTO>');
  });
});
