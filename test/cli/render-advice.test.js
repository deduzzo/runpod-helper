import { describe, it, expect } from 'vitest';
import { renderAdvice } from '../../src/cli/render.js';

describe('renderAdvice', () => {
  it('toglie i caratteri di controllo da testo, chiavi e motivi', () => {
    const lines = [];
    const io = { out: (t) => lines.push(t) };
    renderAdvice(io, {
      rationale: 'ok \x1b[2Kfatto', warnings: ['w\x1b[31m'],
      changes: { added: ['--a\x1b[2K 1'], removed: [], changed: [{ flag: '--b', from: null, to: 'x\u0000' }] },
      rejected: [{ key: 'chiave\x1b[2J', reason: 'motivo\u0000 strano\x07' }],
    });
    const out = lines.join('\n');
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(out).toContain('scartato chiave[2J: motivo strano');
    expect(out).toContain('~ --b: (senza valore) → x');
  });
});
