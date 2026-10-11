import { describe, it, expect } from 'vitest';
import { sandbox } from './helpers.js';
import { dockerCommands } from '../../src/cli/render.js';

describe('suggerimenti dentro Docker', () => {
  it('dockerCommands riscrive "Esegui: llmpod …" e "llmpod <comando>" in bin/llmpod, solo con LLMPOD_IN_DOCKER=1', () => {
    const on = { LLMPOD_IN_DOCKER: '1' };
    expect(dockerCommands('Esegui: llmpod init', on)).toBe('Esegui: bin/llmpod init');
    expect(dockerCommands('Fermalo con llmpod down qwen o llmpod status', on)).toBe('Fermalo con bin/llmpod down qwen o bin/llmpod status');
    expect(dockerCommands('Esegui: chmod 600 /config/.env', on)).toBe('Esegui: chmod 600 /config/.env');
    expect(dockerCommands('volume llmpod-pesi, bin/llmpod up x', on)).toBe('volume llmpod-pesi, bin/llmpod up x');
    expect(dockerCommands('Esegui: llmpod init', {})).toBe('Esegui: llmpod init');
    expect(dockerCommands(undefined, on)).toBeUndefined();
  });

  it('errori della CLI: dentro Docker l\'hint mostra bin/llmpod', async () => {
    const s = sandbox();
    s.env.LLMPOD_IN_DOCKER = '1';
    expect(await s.run(['status'])).toBe(1);
    expect(s.err()).toContain('Suggerimento: Esegui: bin/llmpod init');
    const s2 = sandbox();
    expect(await s2.run(['status'])).toBe(1);
    expect(s2.err()).toContain('Suggerimento: Esegui: llmpod init');
  });
});
