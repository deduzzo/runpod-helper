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

  it('senza risposta entro il timeout vale NO, anche se il pulsante predefinito è sì; timeoutValue lo cambia', async () => {
    vi.useFakeTimers();
    try {
      const jobs = createJobs({ questionTimeoutMs: 1000 });
      const a = jobs.start('up:a', async ({ ask }) => ask('Aspettare ancora?', true));
      const b = jobs.start('down:b', async ({ ask }) => ask('Terminare il Pod?', true, { timeoutValue: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(jobs.get(a.id).question.defYes).toBe(true);
      await vi.advanceTimersByTimeAsync(1001);
      expect(jobs.get(a.id)).toMatchObject({ status: 'done', result: false });
      expect(jobs.get(b.id)).toMatchObject({ status: 'done', result: true });
      expect(jobs.events(a.id).find((e) => e.type === 'answer')).toMatchObject({ answer: false });
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

    it('seq monotono per job; la rotazione scarta solo i log e non fa saltare eventi', async () => {
      const jobs = createJobs();
      const job = jobs.start('x', async ({ emit }) => { for (let i = 0; i < 1500; i++) emit({ type: 'log', i }); return null; });
      await tick(); await tick();
      const all = jobs.events(job.id);
      expect(all.length).toBe(1001); // 1000 log + done
      const seqs = all.map((e) => e.seq);
      expect(seqs[0]).toBe(500); // 1500 log (seq 0..1499) + done (1500): restano gli ultimi 1000 log
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

    it('gli eventi non log non vengono mai scartati dalla rotazione', async () => {
      const jobs = createJobs();
      const job = jobs.start('x', async ({ emit, ask }) => {
        emit({ type: 'phase', message: 'inizio' });
        const q = ask('Domanda?', false);
        for (let i = 0; i < 2000; i++) emit({ type: 'log', i });
        await q;
        return null;
      });
      await tick();
      jobs.answer(job.id, jobs.get(job.id).question.id, true);
      await tick(); await tick();
      const types = jobs.events(job.id).map((e) => e.type);
      expect(types.filter((t) => t === 'log').length).toBe(1000);
      for (const t of ['phase', 'question', 'answer', 'done']) expect(types).toContain(t);
      expect(jobs.events(job.id)[0]).toMatchObject({ type: 'phase', seq: 0 });
    });

    it('una seconda ask chiude la precedente come scaduta (no, salvo timeoutValue)', async () => {
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
      expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: { first: false, second: true } });
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

describe('jobs: chiusura (spegnimento di llmpod ui)', () => {
  it('close() chiude le domande pendenti con il loro timeoutValue e le nuove ask rispondono subito', async () => {
    const jobs = createJobs();
    const a = jobs.start('up:a', async ({ ask }) => ask('Aspettare?', true));
    const b = jobs.start('down:b', async ({ ask }) => ask('Terminare il Pod?', true, { timeoutValue: true }));
    const c = jobs.start('up:c', async ({ ask, emit }) => {
      await new Promise((r) => setTimeout(r, 30));
      emit({ type: 'phase', message: 'dopo la chiusura' });
      return ask('Altra domanda?', true, { timeoutValue: true });
    });
    await tick();
    expect(jobs.get(a.id).question).not.toBeNull();
    jobs.close();
    await tick(); await tick();
    expect(jobs.get(a.id)).toMatchObject({ status: 'done', result: false, question: null });
    expect(jobs.get(b.id)).toMatchObject({ status: 'done', result: true, question: null });
    await new Promise((r) => setTimeout(r, 60));
    expect(jobs.get(c.id)).toMatchObject({ status: 'done', result: true });
    expect(jobs.events(c.id).some((e) => e.type === 'question')).toBe(false);
  });
});

describe('jobs: annullamento e scadenze per domanda', () => {
  it('timeoutMs della singola domanda sostituisce la scadenza predefinita', async () => {
    vi.useFakeTimers();
    try {
      const jobs = createJobs({ questionTimeoutMs: 600_000 });
      const job = jobs.start('up:p', async ({ ask }) => ({ ok: await ask('Aspettare?', true, { timeoutValue: false, timeoutMs: 180_000 }) }));
      await vi.advanceTimersByTimeAsync(180_001);
      expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: { ok: false } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel: chiude la domanda col valore sicuro, segnala l\'annullamento al lavoro, lo stato resta "cancelled"', async () => {
    const jobs = createJobs();
    let aborted = false;
    let answerSeen;
    const job = jobs.start('up:p', async ({ ask, signal }) => {
      signal.addEventListener('abort', () => { aborted = true; });
      answerSeen = await ask('Terminare?', true, { timeoutValue: true });
      const again = await ask('Altra domanda?', true, { timeoutValue: false });
      return { again };
    });
    await tick();
    expect(jobs.cancel(job.id, 'annullato da down')).toBe(true);
    expect(await jobs.wait(job.id, 1000)).toBe(true);
    expect(aborted).toBe(true);
    expect(answerSeen).toBe(true);
    expect(jobs.get(job.id)).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' }, question: null, result: null });
    expect(jobs.events(job.id).some((e) => e.type === 'cancelled')).toBe(true);
    expect(jobs.cancel(job.id)).toBe(false);
  });

  it('wait: false se il lavoro non finisce entro il limite', async () => {
    const jobs = createJobs();
    const job = jobs.start('up:p', () => new Promise(() => {}));
    expect(await jobs.wait(job.id, 20)).toBe(false);
  });
});
