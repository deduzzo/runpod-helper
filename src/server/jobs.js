import { randomUUID } from 'node:crypto';
import { LlmpodError, Codes } from '../core/errors.js';
import { redact, redactObject } from '../core/secrets.js';

const MAX_EVENTS = 1000;

// Domanda pendente come la vede il client: `confirm` (sì/no, defYes) o `choice` (id tra le opzioni, defaultId).
// expiresAt: quando la domanda scade (vale il valore sicuro).
const questionView = (q) => (q.kind === 'choice'
  ? { id: q.id, kind: 'choice', text: q.text, options: q.options, defaultId: q.defaultId, expiresAt: q.expiresAt }
  : { id: q.id, kind: 'confirm', text: q.text, defYes: q.defYes, expiresAt: q.expiresAt });

export function createJobs({ questionTimeoutMs = 600_000, onEvent = () => {} } = {}) {
  const jobs = new Map();
  let closing = false;
  const view = (j) => ({ id: j.id, kind: j.kind, status: j.status, startedAt: j.startedAt, question: j.question ? questionView(j.question) : null, result: j.result, error: j.error });

  function start(kind, run) {
    for (const j of jobs.values()) {
      if (j.kind === kind && j.status === 'running') throw new LlmpodError(Codes.INVALID_INPUT, `Un'operazione "${kind}" è già in corso`);
    }
    const controller = new AbortController();
    const job = { id: randomUUID(), kind, status: 'running', startedAt: new Date().toISOString(), log: [], logCount: 0, seq: 0, question: null, result: null, error: null, controller, finished: null };
    jobs.set(job.id, job);
    // seq: contatore monotono per job (parte da 0); jobId e seq non sono sovrascrivibili dall'evento.
    const emit = (event) => {
      const safe = { ...redactObject(event), seq: job.seq++ };
      job.log.push(safe);
      // La rotazione scarta solo gli eventi `log`: domande, risposte, fasi ed esito non vanno mai persi.
      if (safe.type === 'log' && ++job.logCount > MAX_EVENTS) {
        job.log.splice(job.log.findIndex((e) => e.type === 'log'), 1);
        job.logCount -= 1;
      }
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
    // Una sola domanda pendente: la precedente viene chiusa come se fosse scaduta. Senza risposta (scadenza, chiusura) vale
    // SEMPRE `timeoutValue`, così un job non confermato non continua a spendere. Con l'interfaccia in chiusura nessuno può
    // rispondere: vale subito il valore di default (mai domande nuove).
    // `accepts(value)` decide se una risposta è valida; `normalize` la porta al valore del job e dell'evento `answer`.
    // `timeoutMs` (facoltativo) sostituisce la scadenza predefinita per questa domanda.
    const openQuestion = ({ kind, text, timeoutValue, accepts, normalize, extra, announce, timeoutMs }) => new Promise((resolve) => {
      if (job.status !== 'running' || closing) { resolve(timeoutValue); return; }
      if (job.question) job.question.settle(job.question.timeoutValue);
      const id = randomUUID();
      const shown = redact(String(text));
      const ms = timeoutMs ?? questionTimeoutMs;
      const timer = setTimeout(() => settle(timeoutValue), ms);
      timer.unref?.();
      function settle(value) {
        if (job.question?.id !== id) return;
        closeQuestion();
        const v = normalize(value);
        emit({ type: 'answer', questionId: id, answer: v });
        resolve(v);
      }
      job.question = { id, kind, text: shown, timeoutValue, settle, timer, accepts, expiresAt: new Date(Date.now() + ms).toISOString(), ...extra };
      emit({ type: 'question', questionId: id, text: shown, kind, ...announce(job.question) });
    });
    // `defYes` è solo il pulsante predefinito mostrato all'utente. Senza risposta vale `opts.timeoutValue` (predefinito: no).
    const ask = (text, defYes = false, opts) => openQuestion({
      kind: 'confirm', text, timeoutValue: Boolean(opts?.timeoutValue ?? false),
      accepts: (v) => typeof v === 'boolean', normalize: Boolean, extra: { defYes }, announce: () => ({ defYes }), timeoutMs: opts?.timeoutMs,
    });
    // Scelta tra opzioni { id, label }: la risposta è l'id (oppure null = annulla); senza risposta vale null.
    const choose = (text, options, defaultId = null) => {
      const shownOptions = options.map((o) => ({ id: String(o.id), label: redact(String(o.label)) }));
      return openQuestion({
        kind: 'choice', text, timeoutValue: null,
        accepts: (v) => v === null || (typeof v === 'string' && shownOptions.some((o) => o.id === v)),
        normalize: (v) => v ?? null, extra: { options: shownOptions, defaultId }, announce: (q) => ({ options: q.options, defaultId: q.defaultId }),
      });
    };
    const fail = (err) => {
      const e = err ?? {};
      closeQuestion();
      job.status = 'failed';
      job.error = { code: e.code ?? 'INTERNAL', message: redact(String(e.message ?? e)), hint: e.hint ? redact(String(e.hint)) : undefined };
      emit({ type: 'failed', error: job.error });
    };
    job.cancel = (reason) => {
      if (job.status !== 'running') return false;
      // La domanda pendente si chiude col suo valore sicuro; da qui ogni nuova domanda risponde subito così.
      job.status = 'cancelled';
      job.error = { code: 'CANCELLED', message: redact(String(reason ?? 'Operazione annullata')) };
      job.question?.settle(job.question.timeoutValue);
      controller.abort();
      emit({ type: 'cancelled', error: job.error });
      return true;
    };
    job.finished = Promise.resolve()
      .then(() => run({ ask, choose, emit, signal: controller.signal }))
      .then((result) => {
        if (job.status !== 'running') return; // annullato: l'esito tardivo non cambia lo stato
        const safeResult = redactObject(result ?? null);
        closeQuestion();
        job.status = 'done';
        job.result = safeResult;
        emit({ type: 'done', result: safeResult });
      })
      .catch((err) => {
        if (job.status === 'running') fail(err);
        else if (job.status !== 'cancelled') console.error(`[llmpod] errore nel job ${job.kind}: ${redact(String(err?.message ?? err))}`);
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
    if (!j?.question || j.question.id !== questionId || !j.question.accepts(value)) return false;
    j.question.settle(value);
    return true;
  }

  // Annulla un job in corso (domanda pendente chiusa col valore sicuro, segnale di annullamento al lavoro in corso).
  function cancel(jobId, reason) {
    return jobs.get(jobId)?.cancel?.(reason) ?? false;
  }

  // Chiude la domanda pendente col suo valore sicuro, senza annullare il job.
  function settlePending(jobId) {
    const q = jobs.get(jobId)?.question;
    if (!q) return false;
    q.settle(q.timeoutValue);
    return true;
  }

  // Attende la fine del lavoro di un job (anche annullato), al massimo `timeoutMs`; true se è finito.
  async function wait(jobId, timeoutMs = 60_000) {
    const j = jobs.get(jobId);
    if (!j?.finished) return true;
    let timer;
    const done = await Promise.race([j.finished.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); timer.unref?.(); })]);
    clearTimeout(timer);
    return done;
  }

  // Spegnimento: le domande pendenti si chiudono col loro timeoutValue e le nuove ask rispondono subito.
  function close() {
    closing = true;
    for (const j of jobs.values()) j.question?.settle(j.question.timeoutValue);
  }

  return {
    start,
    answer,
    cancel,
    settlePending,
    wait,
    close,
    get: (id) => (jobs.has(id) ? view(jobs.get(id)) : null),
    list: () => [...jobs.values()].map(view),
    // Eventi con seq >= since: il client passa (ultimo seq visto + 1).
    events: (id, since = 0) => (jobs.has(id) ? jobs.get(id).log.filter((e) => e.seq >= since) : null),
  };
}
