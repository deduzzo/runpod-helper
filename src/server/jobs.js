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
    const job = { id: randomUUID(), kind, status: 'running', startedAt: new Date().toISOString(), log: [], question: null, result: null, error: null };
    jobs.set(job.id, job);
    const emit = (event) => {
      const safe = redactObject(event);
      job.log.push(safe);
      if (job.log.length > MAX_EVENTS) job.log.shift();
      onEvent({ jobId: job.id, ...safe });
    };
    const ask = (text, defYes = false) => new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => settle(defYes), questionTimeoutMs);
      timer.unref?.();
      function settle(value) {
        clearTimeout(timer);
        if (job.question?.id !== id) return;
        job.question = null;
        emit({ type: 'answer', questionId: id, answer: Boolean(value) });
        resolve(Boolean(value));
      }
      job.question = { id, text, defYes, settle };
      emit({ type: 'question', questionId: id, text, defYes });
    });
    Promise.resolve()
      .then(() => run({ ask, emit }))
      .then((result) => {
        job.status = 'done';
        job.result = redactObject(result ?? null);
        emit({ type: 'done', result: job.result });
      }, (err) => {
        job.status = 'failed';
        job.question = null;
        job.error = { code: err.code ?? 'ERROR', message: redact(err.message), hint: err.hint ? redact(err.hint) : undefined };
        emit({ type: 'failed', error: job.error });
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
    events: (id, since = 0) => (jobs.has(id) ? jobs.get(id).log.slice(since) : null),
  };
}
