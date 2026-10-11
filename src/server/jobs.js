import { randomUUID } from 'node:crypto';
import { LlmpodError, Codes } from '../core/errors.js';
import { redact, redactObject } from '../core/secrets.js';

const MAX_EVENTS = 1000;

export function createJobs({ questionTimeoutMs = 600_000, onEvent = () => {} } = {}) {
  const jobs = new Map();
  const view = (j) => ({ id: j.id, kind: j.kind, status: j.status, startedAt: j.startedAt, question: j.question ? { id: j.question.id, text: j.question.text, defYes: j.question.defYes } : null, result: j.result, error: j.error });

  function start(kind, run) {
    for (const j of jobs.values()) {
      if (j.kind === kind && j.status === 'running') throw new LlmpodError(Codes.INVALID_INPUT, `Un'operazione "${kind}" è già in corso`);
    }
    const job = { id: randomUUID(), kind, status: 'running', startedAt: new Date().toISOString(), log: [], seq: 0, question: null, result: null, error: null };
    jobs.set(job.id, job);
    // seq: contatore monotono per job (parte da 0); jobId e seq non sono sovrascrivibili dall'evento.
    const emit = (event) => {
      const safe = { ...redactObject(event), seq: job.seq++ };
      job.log.push(safe);
      if (job.log.length > MAX_EVENTS) job.log.shift();
      try {
        onEvent({ ...safe, jobId: job.id });
      } catch (err) {
        console.error(`[llmpod] listener degli eventi: ${redact(String(err?.message ?? err))}`);
      }
    };
    const closeQuestion = () => {
      const q = job.question;
      if (!q) return;
      clearTimeout(q.timer);
      job.question = null;
    };
    const ask = (text, defYes = false) => new Promise((resolve) => {
      if (job.status !== 'running') { resolve(Boolean(defYes)); return; }
      // Una sola domanda pendente: la precedente viene chiusa col suo valore predefinito.
      if (job.question) job.question.settle(job.question.defYes);
      const id = randomUUID();
      const shown = redact(String(text));
      const timer = setTimeout(() => settle(defYes), questionTimeoutMs);
      timer.unref?.();
      function settle(value) {
        if (job.question?.id !== id) return;
        closeQuestion();
        emit({ type: 'answer', questionId: id, answer: Boolean(value) });
        resolve(Boolean(value));
      }
      job.question = { id, text: shown, defYes, settle, timer };
      emit({ type: 'question', questionId: id, text: shown, defYes });
    });
    const fail = (err) => {
      const e = err ?? {};
      closeQuestion();
      job.status = 'failed';
      job.error = { code: e.code ?? 'INTERNAL', message: redact(String(e.message ?? e)), hint: e.hint ? redact(String(e.hint)) : undefined };
      emit({ type: 'failed', error: job.error });
    };
    Promise.resolve()
      .then(() => run({ ask, emit }))
      .then((result) => {
        const safeResult = redactObject(result ?? null);
        closeQuestion();
        job.status = 'done';
        job.result = safeResult;
        emit({ type: 'done', result: safeResult });
      })
      .catch((err) => {
        if (job.status === 'running') fail(err);
        else console.error(`[llmpod] errore nel job ${job.kind}: ${redact(String(err?.message ?? err))}`);
      })
      .catch((err) => {
        // Rete di sicurezza: nessuna unhandled rejection.
        job.status = 'failed';
        closeQuestion();
        job.error ??= { code: 'INTERNAL', message: redact(String(err?.message ?? err)) };
        console.error(`[llmpod] errore nel job ${job.kind}: ${redact(String(err?.message ?? err))}`);
      });
    return view(job);
  }

  function answer(jobId, questionId, value) {
    const j = jobs.get(jobId);
    if (!j?.question || j.question.id !== questionId) return false;
    j.question.settle(value);
    return true;
  }

  return {
    start,
    answer,
    get: (id) => (jobs.has(id) ? view(jobs.get(id)) : null),
    list: () => [...jobs.values()].map(view),
    // Eventi con seq >= since: il client passa (ultimo seq visto + 1).
    events: (id, since = 0) => (jobs.has(id) ? jobs.get(id).log.filter((e) => e.seq >= since) : null),
  };
}
