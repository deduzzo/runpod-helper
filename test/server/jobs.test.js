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

  describe('robustezza (giro 1)', () => {
    it('throw null / undefined → job failed con codice INTERNAL', async () => {
      const jobs = createJobs();
      const a = jobs.start('a', async () => { throw null; });
      const b = jobs.start('b', async () => { throw undefined; });
      await tick(); await tick();
      expect(jobs.get(a.id)).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
      expect(jobs.get(b.id)).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
    });

    it('un onEvent che lancia non rompe il job', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const jobs = createJobs({ onEvent: () => { throw new Error('listener rotto'); } });
        const job = jobs.start('x', async ({ emit }) => { emit({ type: 'log', line: 'a' }); return 7; });
        await tick(); await tick();
        expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: 7 });
      } finally {
        spy.mockRestore();
      }
    });

    it('risultato non serializzabile (circolare) → job failed, nessuna unhandled rejection', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const jobs = createJobs();
        const job = jobs.start('x', async () => { const o = {}; o.self = o; return o; });
        await tick(); await tick(); await tick();
        expect(jobs.get(job.id)).toMatchObject({ status: 'failed', result: null });
        expect(jobs.get(job.id).error.code).toBeTruthy();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('il testo della domanda è mascherato in get(), start() ed evento', async () => {
      clearSecrets();
      registerSecret('SEGRETO-DOMANDA-77777');
      const seen = [];
      const jobs = createJobs({ onEvent: (e) => seen.push(e) });
      const job = jobs.start('x', async ({ ask }) => ask('Usare SEGRETO-DOMANDA-77777?', false));
      await tick();
      expect(jobs.get(job.id).question.text).toBe('Usare <REDATTO>?');
      expect(jobs.list()[0].question.text).toBe('Usare <REDATTO>?');
      expect(seen.find((e) => e.type === 'question').text).toBe('Usare <REDATTO>?');
    });

    it('seq monotono per job; la rotazione oltre MAX_EVENTS non fa saltare eventi', async () => {
      const jobs = createJobs();
      const job = jobs.start('x', async ({ emit }) => { for (let i = 0; i < 1500; i++) emit({ type: 'log', i }); return null; });
      await tick(); await tick();
      const all = jobs.events(job.id);
      expect(all.length).toBe(1000);
      const seqs = all.map((e) => e.seq);
      expect(seqs[0]).toBe(501); // 1500 log + done = 1501 eventi (seq 0..1500), restano gli ultimi 1000
      expect(seqs.at(-1)).toBe(1500);
      expect(seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1)).toBe(true);
      expect(jobs.events(job.id, 1498).map((e) => e.seq)).toEqual([1498, 1499, 1500]);
      expect(jobs.events(job.id, 1501)).toEqual([]);
    });

    it('seq e jobId non sono sovrascrivibili dall\'evento', async () => {
      const seen = [];
      const jobs = createJobs({ onEvent: (e) => seen.push(e) });
      const job = jobs.start('x', async ({ emit }) => { emit({ type: 'log', jobId: 'falso', seq: 99 }); return null; });
      await tick(); await tick();
      expect(seen[0]).toMatchObject({ jobId: job.id, seq: 0 });
    });

    it('una seconda ask chiude la precedente col suo default', async () => {
      const jobs = createJobs();
      let first;
      const job = jobs.start('x', async ({ ask }) => {
        first = ask('Prima?', true);
        const second = await ask('Seconda?', false).then((v) => v);
        return { first: await first, second };
      });
      await tick();
      const q = jobs.get(job.id).question;
      expect(q.text).toBe('Seconda?');
      jobs.answer(job.id, q.id, true);
      await tick(); await tick();
      expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: { first: true, second: true } });
    });

    it('a job concluso: question azzerata, timer cancellato, answer() non emette', async () => {
      vi.useFakeTimers();
      try {
        const seen = [];
        const jobs = createJobs({ questionTimeoutMs: 1000, onEvent: (e) => seen.push(e) });
        // il job termina senza attendere la domanda
        const job = jobs.start('x', async ({ ask }) => { ask('Pendente?', true); return 1; });
        await vi.advanceTimersByTimeAsync(10);
        expect(jobs.get(job.id)).toMatchObject({ status: 'done', question: null });
        const n = seen.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(vi.getTimerCount()).toBe(0);
        expect(seen.length).toBe(n);
        expect(jobs.answer(job.id, 'qualsiasi', true)).toBe(false);
        // anche in caso di errore
        const f = jobs.start('y', async ({ ask }) => { ask('Pendente?', true); throw new Error('x'); });
        await vi.advanceTimersByTimeAsync(10);
        expect(jobs.get(f.id)).toMatchObject({ status: 'failed', question: null });
        await vi.advanceTimersByTimeAsync(5000);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
