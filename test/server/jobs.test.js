import { describe, it, expect, vi } from 'vitest';
import { createJobs } from '../../src/server/jobs.js';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('jobs', () => {
  it('domanda → risposta → risultato', async () => {
    const seen = [];
    const jobs = createJobs({ onEvent: (e) => seen.push(e) });
    const job = jobs.start('up:p', async ({ ask, emit }) => {
      emit({ type: 'phase', message: 'inizio' });
      const ok = await ask('Confermi?', false);
      return { ok };
    });
    await tick();
    const q = jobs.get(job.id).question;
    expect(q).toMatchObject({ text: 'Confermi?', defYes: false });
    expect(jobs.answer(job.id, 'sbagliato', true)).toBe(false);
    expect(jobs.answer(job.id, q.id, true)).toBe(true);
    await tick(); await tick();
    expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: { ok: true }, question: null });
    expect(seen.map((e) => e.type)).toEqual(['phase', 'question', 'answer', 'done']);
    expect(seen.every((e) => e.jobId === job.id)).toBe(true);
    expect(jobs.events(job.id, 2).map((e) => e.type)).toEqual(['answer', 'done']);
  });

  it('senza risposta entro il timeout vale il default', async () => {
    vi.useFakeTimers();
    try {
      const jobs = createJobs({ questionTimeoutMs: 1000 });
      const job = jobs.start('down:p', async ({ ask }) => ask('Terminare il Pod?', true));
      await vi.advanceTimersByTimeAsync(1001);
      expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('errore mascherato e un solo job attivo per tipo', async () => {
    clearSecrets();
    registerSecret('SEGRETO-DEL-JOB-12345');
    const jobs = createJobs();
    let release;
    const gate = new Promise((r) => { release = r; });
    const a = jobs.start('up:p', async () => { await gate; throw Object.assign(new Error('boom SEGRETO-DEL-JOB-12345'), { code: 'VLLM_ERROR', hint: 'h' }); });
    expect(() => jobs.start('up:p', async () => 1)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => jobs.start('up:altro', async () => 1)).not.toThrow();
    release();
    await tick(); await tick();
    expect(jobs.get(a.id)).toMatchObject({ status: 'failed', error: { code: 'VLLM_ERROR', message: 'boom <REDATTO>', hint: 'h' } });
    expect(jobs.list().length).toBe(2);
  });

  it('gli eventi sono mascherati', async () => {
    clearSecrets();
    registerSecret('SEGRETO-EVENTO-999999');
    const jobs = createJobs();
    const job = jobs.start('x', async ({ emit }) => { emit({ type: 'log', line: 'chiave SEGRETO-EVENTO-999999' }); return null; });
    await tick(); await tick();
    expect(jobs.events(job.id)[0].line).toBe('chiave <REDATTO>');
  });
});
