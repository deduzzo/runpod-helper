import { describe, it, expect } from 'vitest';
import { fmtHours } from '../../src/core/watchdog.js';
import { mtpLabel } from '../../src/core/planner/mtp-label.js';
import { syncDerivedFields } from '../../src/core/planner/plan.js';

describe('rifiniture del collaudo', () => {
  it('fmtHours mostra fino a due decimali (0,25 h, non 0,3 h)', () => {
    expect(fmtHours(900)).toBe('0,25 h');
    expect(fmtHours(3600)).toBe('1 h');
    expect(fmtHours(5400)).toBe('1,5 h');
  });

  it('riga MTP con il numero reale di token speculativi', () => {
    const t = { vllm: { args: ['--speculative-config', '{"method":"mtp","num_speculative_tokens":3}'] }, mtp: { present: true, enabled: false } };
    syncDerivedFields(t);
    expect(t.mtp).toMatchObject({ enabled: true, tokens: 3 });
    expect(mtpLabel(t.mtp)).toBe('attivo (decodifica speculativa, 3 token per passo)');
    expect(mtpLabel({ present: true, enabled: true })).toBe('attivo (decodifica speculativa, 1 token)');
    expect(mtpLabel({ present: true, enabled: false })).toBe('presente nei pesi ma disattivato');
  });
});
