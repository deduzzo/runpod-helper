import { describe, it, expect, vi } from 'vitest';
import { createJobs } from '../../src/server/jobs.js';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('jobs: domande a scelta', () => {
  const options = [{ id: 'a', label: 'Prima' }, { id: 'b', label: 'Seconda' }];

  it('choose: la domanda espone opzioni e predefinita; la risposta è l\'id scelto', async () => {
    const seen = [];
    const jobs = createJobs({ onEvent: (e) => seen.push(e) });
    const job = jobs.start('up:p', async ({ choose }) => ({ picked: await choose('Quale GPU?', options, 'b') }));
    await tick();
    const q = jobs.get(job.id).question;
    expect(q).toMatchObject({ kind: 'choice', text: 'Quale GPU?', options, defaultId: 'b' });
    expect(jobs.answer(job.id, q.id, 'a')).toBe(true);
    await tick(); await tick();
    expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: { picked: 'a' } });
    expect(seen.find((e) => e.type === 'question')).toMatchObject({ kind: 'choice', options, defaultId: 'b' });
    expect(seen.find((e) => e.type === 'answer')).toMatchObject({ answer: 'a' });
  });

  it('una domanda sì/no ha kind "confirm"', async () => {
    const jobs = createJobs();
    const job = jobs.start('up:p', async ({ ask }) => ask('Confermi?', false));
    await tick();
    expect(jobs.get(job.id).question).toMatchObject({ kind: 'confirm' });
  });

  it('senza risposta alla scadenza vale null (nessuna scelta: il job annulla, niente spesa)', async () => {
    vi.useFakeTimers();
    try {
      const jobs = createJobs({ questionTimeoutMs: 1000 });
      const job = jobs.start('up:p', async ({ choose }) => choose('Quale?', options, 'a'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: null });
      expect(jobs.events(job.id).find((e) => e.type === 'answer')).toMatchObject({ answer: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answer rifiuta un id che non è tra le opzioni (il job resta in attesa) e un booleano; null = annulla', async () => {
    const jobs = createJobs();
    const job = jobs.start('up:p', async ({ choose }) => choose('Quale?', options, 'a'));
    await tick();
    const q = jobs.get(job.id).question;
    expect(jobs.answer(job.id, q.id, 'zzz')).toBe(false);
    expect(jobs.get(job.id).question).not.toBeNull();
    expect(jobs.answer(job.id, q.id, true)).toBe(false);
    expect(jobs.answer(job.id, q.id, null)).toBe(true);
    await tick(); await tick();
    expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: null });
  });

  it('con l\'interfaccia in chiusura choose risponde subito null; testo ed etichette sono mascherati', async () => {
    clearSecrets();
    registerSecret('SEGRETO-SCELTA-12345');
    const jobs = createJobs();
    const job = jobs.start('up:p', async ({ choose }) => choose('Scegli SEGRETO-SCELTA-12345', [{ id: 'a', label: 'x SEGRETO-SCELTA-12345' }], 'a'));
    await tick();
    const q = jobs.get(job.id).question;
    expect(q.text).toBe('Scegli <REDATTO>');
    expect(q.options[0].label).toBe('x <REDATTO>');
    jobs.close();
    await tick(); await tick();
    expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: null });
    const late = jobs.start('up:q', async ({ choose }) => choose('Ancora?', options, 'a'));
    await tick(); await tick();
    expect(jobs.get(late.id)).toMatchObject({ status: 'done', result: null });
  });
});
