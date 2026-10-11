import { describe, it, expect, vi } from 'vitest';
import { confirmCost, confirmAction, fmtUSD } from '../../src/core/confirm.js';
import { createEvents } from '../../src/core/events.js';

describe('conferme', () => {
  it('fmtUSD usa la virgola decimale', () => {
    expect(fmtUSD(1.389)).toBe('1,39 $');
  });

  it('dry-run non chiede e non procede', async () => {
    const ask = vi.fn();
    const r = await confirmCost({ hourlyUSD: 1.5, description: 'Avvio', dryRun: true, ask });
    expect(r).toMatchObject({ proceed: false, dryRun: true });
    expect(r.message).toContain('1,50 $/h');
    expect(ask).not.toHaveBeenCalled();
  });

  it('--yes procede senza chiedere', async () => {
    const ask = vi.fn();
    expect((await confirmCost({ hourlyUSD: 1, description: 'x', yes: true, ask })).proceed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('mostra il costo mensile e annulla se l\'utente rifiuta', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    await expect(confirmCost({ monthlyUSD: 10.5, description: 'Volume', ask })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(ask.mock.calls[0][0]).toContain('10,50 $ al mese');
  });

  it('confirmAction chiede senza costo', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    expect((await confirmAction({ description: 'Terminare il Pod abc?', ask })).proceed).toBe(true);
  });

  it('events: on/emit/off', () => {
    const ev = createEvents();
    const seen = [];
    const off = ev.on((e) => seen.push(e));
    ev.emit('phase', { message: 'uno' });
    off();
    ev.emit('phase', { message: 'due' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'phase', message: 'uno' });
  });
});
