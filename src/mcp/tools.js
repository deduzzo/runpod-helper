// Strumenti MCP di llmpod. Le domande che nella CLI sono interattive qui diventano: anteprima (…_preview) → conferma esplicita
// nei parametri (confirm: true). Nessuna spesa senza confirm: true; up e tune girano come job in background con domande pendenti.
import { fileURLToPath } from 'node:url';
import { LlmpodError, Codes } from '../core/errors.js';
import { assertProfileName } from '../core/config.js';
import { createEvents } from '../core/events.js';
import { searchRows } from '../core/search.js';
import { runPlan } from '../core/plan-flow.js';
import { optionLabel } from '../core/planner/gpu-choice.js';
import { listSets, getSet, filterSetModels, resolveSetRef } from '../core/model-sets.js';

const PROJECT_DIR = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const denyAsk = async () => false; // strumenti sincroni: nessuna domanda deve restare senza risposta (vale "no")
// Mentre un Pod costa (tune, oppure up dopo la creazione del Pod) le domande dei job scadono presto col valore sicuro.
export const COSTLY_QUESTION_TIMEOUT_MS = 3 * 60_000;
const cancelledError = () => new LlmpodError(Codes.CANCELLED, 'Operazione annullata');

// Strumenti di sola lettura (nessuna spesa, nessuna modifica ai Pod): permessi senza conferma in .claude/settings.json.
export const READ_ONLY_TOOLS = ['status', 'metrics', 'logs', 'search', 'plan', 'model_sets', 'profiles', 'job_status', 'job_events', 'up_preview', 'tune_preview', 'keep_preview', 'client_commands'];
// Strumenti che spendono, modificano o distruggono: sempre con domanda all'utente ("ask" in .claude/settings.json).
export const ASK_TOOLS = ['up', 'tune', 'keep', 'down', 'save_profile', 'job_answer', 'job_cancel'];

// sleep annullabile: un job annullato (down, job_cancel, chiusura del server) esce dalle attese invece di continuare.
function abortableSleep(base, signal) {
  return (ms) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelledError()); return; }
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(base(ms)).then(() => { signal.removeEventListener('abort', onAbort); resolve(); }, reject);
  });
}

const S = {
  profile: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$', description: 'Nome del profilo llmpod' },
  confirm: { const: true, description: 'true solo dopo che l\'utente ha visto anteprima e costo e ha confermato esplicitamente' },
  args: { type: 'array', maxItems: 40, items: { type: 'string', minLength: 1, maxLength: 400 } },
  jobId: { type: 'string', minLength: 1, maxLength: 100 },
  gpu: {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: { id: { type: 'string', minLength: 1, maxLength: 100 }, count: { type: 'integer', minimum: 1, maximum: 8 }, dataCenterId: { type: 'string', minLength: 1, maxLength: 60 } },
  },
};
const obj = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, required });

export function createTools({ ctx, jobs, log = (m) => process.stderr.write(`[llmpod-mcp] ${m}\n`) }) {
  const syncOps = () => ctx.makeOps({ ask: denyAsk, events: createEvents() });
  const meta = new Map(); // jobId → { kind, profile, podId }

  // Un solo job per profilo (up, tune) e niente keep/down/save mentre è in corso.
  const assertNotBusy = (profile) => {
    const busy = jobs.list().find((j) => j.status === 'running' && j.kind.endsWith(`:${profile}`));
    if (busy) throw new LlmpodError(Codes.INVALID_INPUT, `Per il profilo "${profile}" c'è già un'operazione in corso (${busy.kind.split(':')[0]}, job ${busy.id})`, { hint: 'Controlla con job_status e attendi che finisca' });
  };

  function startJob(kind, profile, fn) {
    assertNotBusy(profile);
    // interrupt: interruzione "morbida" (job_cancel su un tune): fa uscire dall'attesa in corso senza annullare il job,
    // che poi riporta vLLM agli argomenti precedenti; viene sostituito a ogni uso, così le attese successive funzionano.
    // interruptPending: un job_cancel arrivato mentre non c'era un'attesa in corso (es. durante una chiamata HTTP) non va
    // perso: la prossima attesa lo consuma. reverting: il tune sta già tornando agli argomenti precedenti.
    const m = { kind, profile, podId: null, cancelRequested: false, interrupt: new AbortController(), interruptPending: false, reverting: false };
    const job = jobs.start(`${kind}:${profile}`, async ({ ask, emit, signal }) => {
      const events = createEvents();
      events.on((e) => {
        if (e.type === 'pod') m.podId = e.podId;
        emit(e);
      });
      // Il Pod costa sempre durante tune e, in up, da quando è stato creato: domande brevi (3 min) col valore sicuro.
      const costly = () => kind === 'tune' || Boolean(m.podId);
      // Dopo job_cancel ogni domanda vale subito il suo valore sicuro (per tune: tornare agli argomenti precedenti).
      // In un tune l'unica domanda è il ritorno agli argomenti precedenti: da lì in poi job_cancel non interrompe più.
      const jobAsk = (text, defYes, opts = {}) => {
        if (kind === 'tune') {
          m.reverting = true;
          m.interruptPending = false; // l'interruzione è già arrivata (siamo nel ritorno indietro): non deve fermarlo
        }
        return m.cancelRequested
          ? Promise.resolve(opts.timeoutValue ?? false)
          : ask(text, defYes, { ...opts, ...(costly() ? { timeoutMs: COSTLY_QUESTION_TIMEOUT_MS } : {}) });
      };
      const hardSleep = abortableSleep(ctx.sleep, signal);
      const sleep = async (ms) => {
        if (m.interruptPending) { m.interruptPending = false; throw cancelledError(); }
        const ctl = m.interrupt;
        try {
          await abortableSleep(hardSleep, ctl.signal)(ms);
        } catch (err) {
          if (ctl.signal.aborted) m.interruptPending = false; // interruzione consumata da questa attesa
          throw err;
        }
      };
      const ops = ctx.makeOps({ ask: jobAsk, askChoice: null, events, sleep });
      return fn({ ops, ask: jobAsk, emit, m });
    });
    meta.set(job.id, m);
    return { jobId: job.id, status: job.status, next: 'Segui l\'avanzamento con job_status / job_events; se compare una domanda, mostrala all\'utente e rispondi con job_answer solo con la sua risposta (scade in expiresAt)' };
  }

  // Annulla i job in corso del profilo (domanda pendente chiusa col valore sicuro) e attende che escano (max 60 s).
  async function cancelJobsOf(profile, reason) {
    const running = jobs.list().filter((j) => j.status === 'running' && j.kind.endsWith(`:${profile}`));
    for (const j of running) jobs.cancel(j.id, reason);
    await Promise.all(running.map((j) => jobs.wait(j.id, 60_000)));
    return running.map((j) => j.id);
  }

  async function downAndList(profile, cancelledJobs = []) {
    const ops = syncOps();
    const r = await ops.down(profile, { yes: true });
    const after = await ops.status();
    return { ...r, cancelledJobs, allPods: after.pods.map((p) => ({ profile: p.profile, podId: p.podId, state: p.state, hourlyUSD: p.hourlyUSD })) };
  }

  // Chiusura del server: annulla i job; per gli up in corso con un Pod già creato (quindi non ancora pronto) elimina il Pod.
  // Tempo massimo complessivo `timeoutMs`.
  async function shutdown({ timeoutMs = 60_000 } = {}) {
    const running = jobs.list().filter((j) => j.status === 'running');
    if (!running.length) return { terminated: [] };
    log(`chiusura: annullo ${running.length} operazioni in corso`);
    const terminated = [];
    const work = (async () => {
      for (const j of running) jobs.cancel(j.id, 'Server MCP in chiusura');
      await Promise.all(running.map((j) => jobs.wait(j.id, timeoutMs)));
      for (const j of running) {
        const m = meta.get(j.id);
        if (m?.kind !== 'up' || !m.podId) continue;
        log(`chiusura: elimino il Pod ${m.podId} (${m.profile}), avviato ma non ancora pronto`);
        try {
          await syncOps().terminatePod(m.profile, m.podId); // solo il Pod creato dal job
          terminated.push(m.podId);
        } catch (err) {
          log(`chiusura: eliminazione del Pod ${m.podId} non riuscita: ${err.message}. Controlla su https://www.runpod.io/console/pods`);
        }
      }
    })();
    let timer;
    const finished = await Promise.race([work.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); timer.unref?.(); })]);
    clearTimeout(timer);
    if (!finished) log(`chiusura: tempo massimo (${Math.round(timeoutMs / 1000)} s) superato; controlla i Pod su https://www.runpod.io/console/pods`);
    return { terminated };
  }

  const planView = (plan, { advice, advisorError, fromSet }) => ({
    model: plan.model, fromSet: fromSet ? { setId: fromSet.setId, key: fromSet.model.key, warning: fromSet.warning } : null,
    context: plan.context, concurrency: plan.concurrency, estimate: plan.estimate, kvCacheDtype: plan.kvCacheDtype,
    dataCenterId: plan.dataCenterId, gpu: plan.gpu, hourlyUSD: plan.hourlyUSD,
    options: (plan.options ?? []).map((o) => ({
      id: o.id, name: o.name, count: o.count, memoryGiB: o.memoryGiB, perGpuGiB: o.perGpuGiB, headroomGiB: o.headroomGiB,
      hourlyUSD: o.hourly, availabilityHere: o.availabilityHere, availableElsewhere: (o.elsewhere ?? []).map((d) => d.id),
      available: o.available, fits: o.fits !== false, label: optionLabel(o, plan.dataCenterId),
    })),
    vllmImage: plan.vllm.image, vllmArgs: plan.vllm.args, parsers: plan.parsers, mtp: plan.mtp, ncclSafe: plan.ncclSafe !== false, warnings: plan.warnings,
    advisor: advice ? { rationale: advice.rationale, changes: advice.changes, rejected: advice.rejected, warnings: advice.warnings } : null,
    advisorError: advisorError ?? null,
    next: 'Proponi all\'utente le opzioni GPU disponibili con prezzo e disponibilità e fai scegliere; poi save_profile con la gpu scelta',
  });

  const tools = [
    {
      name: 'model_sets', description: 'Set di modelli consigliati (verificati, con MTP/DSpark). Senza "set": elenco dei set; con "set": modelli del set con planRef da passare a plan.',
      inputSchema: obj({ set: { type: 'string', minLength: 1, maxLength: 60 }, query: { type: 'string', maxLength: 200 } }),
      run: ({ set, query }) => {
        if (!set) return { sets: listSets() };
        const s = getSet(set);
        return {
          set: s.id, name: s.name, description: s.description, warning: s.warning,
          models: filterSetModels(s, query).map(({ n, model }) => ({ n, planRef: `${s.id}/${model.key}`, ...model })),
        };
      },
    },
    {
      name: 'search', description: 'Cerca su Hugging Face modelli text-generation adatti all\'uso agentico (varianti con MTP prima).',
      inputSchema: obj({ query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, all: { type: 'boolean' } }, ['query']),
      run: async ({ query, limit = 20, all = false }) => ({ rows: await searchRows(ctx.hf, query, { limit, all }) }),
    },
    {
      name: 'plan', description: 'Calcola il piano: stima VRAM, opzioni GPU con prezzo e disponibilità, argomenti di vLLM, MTP. model: org/modello[@rev], URL o <set>/<id> di model_sets. Salva il piano per save_profile. Non spende nulla.',
      inputSchema: obj({
        model: { type: 'string', minLength: 1, maxLength: 300 },
        context: { type: 'integer', minimum: 1024, maximum: 1048576 }, concurrency: { type: 'integer', minimum: 1, maximum: 256 },
        set: { ...S.args, description: 'argomenti vLLM chiave=valore' }, extra: S.args,
        gpu: { type: 'string', minLength: 1, maxLength: 100, description: '<id>[x<numero>] tra le opzioni' },
        ncclSafe: { type: 'boolean', description: 'predefinito true: modalità NCCL sicura (variabili NCCL e --disable-custom-all-reduce) sui Pod multi-GPU senza NVLink completo; false solo se l\'utente lo chiede' },
      }, ['model']),
      // Mai il consulente esterno: plan è consentito senza conferma e non deve inviare dati a servizi di terzi.
      run: async ({ model, context, concurrency = 2, set = [], extra = [], gpu, ncclSafe = true }) => {
        const fromSet = resolveSetRef(model);
        const r = await runPlan({ ctx, modelRef: fromSet ? fromSet.modelRef : model, context: context ?? fromSet?.recommendedContext ?? 65536, concurrency, set, extra, gpu, ncclSafe, advisor: false });
        ctx.store.writeJson('last-plan.json', r.plan);
        return planView(r.plan, { ...r, fromSet });
      },
    },
    {
      name: 'save_profile', description: 'Salva l\'ultimo piano come profilo con la GPU scelta dall\'utente. model: il modello del piano mostrato (org/modello o <set>/<id>): se l\'ultimo piano è di un altro modello, rifiuta. Genera la chiave vLLM del profilo (mai mostrata).',
      inputSchema: obj({ name: S.profile, model: { type: 'string', minLength: 1, maxLength: 300 }, gpu: S.gpu }, ['name', 'model', 'gpu']),
      run: ({ name, model, gpu }) => {
        assertProfileName(name);
        assertNotBusy(name);
        const plan = ctx.store.readJson('last-plan.json', null);
        const wanted = (resolveSetRef(model)?.model.id ?? model.split('@')[0]).toLowerCase();
        if (plan && plan.model?.id?.toLowerCase() !== wanted) {
          throw new LlmpodError(Codes.INVALID_INPUT, `L'ultimo piano è di ${plan.model?.id}, non di ${model}`, { hint: 'Ricalcola il piano del modello scelto (plan) e mostralo di nuovo all\'utente' });
        }
        const p = syncOps().saveProfile(name, { gpu: { id: gpu.id, count: gpu.count ?? null } });
        return { profile: { name: p.name, model: p.model.id, gpu: p.gpu, alternatives: p.alternatives, context: p.context, hourlyUSD: p.estimate?.hourlyUSD ?? null, volume: Boolean(p.volume), watchdog: p.watchdog }, next: `Avvio: up_preview { profile: "${name}" }` };
      },
    },
    {
      name: 'profiles', description: 'Profili salvati: modello, GPU, contesto, costo stimato, limiti di spegnimento, MTP, argomenti.',
      inputSchema: obj(),
      run: () => ({
        profiles: ctx.store.listProfiles().map((name) => {
          const p = ctx.store.readProfile(name);
          return { name, model: p.model?.id, revision: p.model?.revision, context: p.context, concurrency: p.concurrency, gpu: p.gpu, alternatives: p.alternatives ?? [], hourlyUSD: p.estimate?.hourlyUSD ?? null, watchdog: p.watchdog, mtp: p.mtp ?? null, parsers: p.parsers, vllmArgs: p.vllm?.args, dataCenterId: p.dataCenterId, volume: Boolean(p.volume) };
        }),
      }),
    },
    {
      name: 'status', description: 'Tutti i Pod llmpod raggruppati: avviati, in avvio, spenti (costano ancora il disco), in eliminazione; credito, volume, job in corso.',
      inputSchema: obj({ all: { type: 'boolean', description: 'anche gli altri Pod dell\'account (non llmpod-*), in sola lettura' } }),
      run: async ({ all = false }) => {
        const s = await syncOps().status({ all });
        const by = (state) => s.pods.filter((p) => p.state === state);
        return {
          running: by('running'), starting: by('starting'), stopped: by('stopped'), terminating: by('terminating'), other: by('unknown'),
          ...(all ? { otherAccountPods: s.otherPods } : { note: 'Solo i Pod llmpod-*: con all: true anche gli altri Pod dell\'account' }),
          balanceUSD: s.balance?.balance ?? null, volume: s.volume, jobs: jobs.list().filter((j) => j.status === 'running'),
        };
      },
    },
    {
      name: 'metrics', description: 'Metriche di vLLM sul Pod avviato: token/s, richieste in corso/in coda, uso KV %, accettazione MTP/DSpark (totale, per posizione, lunghezza media), errori; tassi su una finestra.',
      inputSchema: obj({ profile: S.profile, window: { type: 'integer', minimum: 1, maximum: 60 } }, ['profile']),
      run: ({ profile, window = 10 }) => syncOps().metrics(profile, { window }),
    },
    {
      name: 'logs', description: 'Log di vLLM dal supervisore (mascherati). since: cursore restituito dalla chiamata precedente; limit: ultime righe.',
      inputSchema: obj({ profile: S.profile, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, ['profile']),
      run: async ({ profile, since = 0, limit = 200 }) => {
        const r = await syncOps().logs(profile, { since });
        return { ...r, truncated: r.lines.length > limit, lines: r.lines.slice(-limit) };
      },
    },
    {
      name: 'up_preview', description: 'Anteprima dell\'avvio (nessuna spesa): rilegge la disponibilità e restituisce le GPU avviabili ora con costo orario, costo massimo secondo il watchdog e stima del tempo e del costo dell\'avvio (startup: download + caricamento dei pesi, pagati prima che il modello sia pronto). Da mostrare all\'utente prima di up.',
      inputSchema: obj({ profile: S.profile, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Numero massimo di opzioni (predefinito 12, una per GPU×numero×volume, in ordine di costo)' } }, ['profile']),
      run: ({ profile, limit }) => syncOps().upPreview(profile, { limit }),
    },
    {
      name: 'up', description: 'Avvia il Pod (COSTA). Richiede gpu scelta dall\'utente, confirm: true e expectedHourlyUSD uguale a quello di up_preview (se il prezzo è cambiato: errore). Parte in background: restituisce jobId.',
      inputSchema: obj({ profile: S.profile, gpu: S.gpu, confirm: S.confirm, expectedHourlyUSD: { type: 'number', minimum: 0 } }, ['profile', 'gpu', 'confirm', 'expectedHourlyUSD']),
      annotations: { destructiveHint: false },
      run: async ({ profile, gpu, expectedHourlyUSD }) => {
        assertNotBusy(profile);
        const preview = await syncOps().upPreview(profile);
        if (preview.activePod) throw new LlmpodError(Codes.INVALID_INPUT, `Il profilo ${profile} ha già un Pod attivo (${preview.activePod.podId})`, { hint: 'Usa status e, se serve, down' });
        const match = preview.options.filter((o) => o.gpu.id === gpu.id && (gpu.count == null || o.gpu.count === gpu.count) && (!gpu.dataCenterId || o.gpu.dataCenterId === gpu.dataCenterId));
        const chosen = match.find((o) => o.withVolume) ?? match[0];
        if (!chosen) throw new LlmpodError(Codes.NO_GPU_AVAILABLE, `${gpu.id} non è avviabile ora per il profilo ${profile}`, { hint: 'Rileggi le opzioni con up_preview e fai scegliere di nuovo' });
        if (Math.abs(chosen.hourlyUSD - expectedHourlyUSD) > 0.0005) {
          throw new LlmpodError(Codes.PRICE_CHANGED, `Il prezzo è cambiato: ${gpu.id} costa ora ${chosen.hourlyUSD} $/h invece di ${expectedHourlyUSD} $/h`, { hint: 'Mostra il nuovo prezzo all\'utente e chiedi di nuovo conferma: nessun Pod è stato creato' });
        }
        const choice = { ...chosen.gpu };
        return startJob('up', profile, async ({ ops, ask, emit }) => {
          const r = await ops.up(profile, { gpu: choice, expectedHourlyUSD, costConfirmed: true, autoTerminate: true });
          if (r?.contextSuggestion) emit({ type: 'info', message: `La KV cache consente fino a ${r.contextSuggestion} token per richiesta: si può rigenerare il profilo con un contesto maggiore` });
          if (r?.repairedArgs && await ask('Salvare nel profilo gli argomenti corretti dal consulente?', true)) {
            ops.saveProfileArgs(profile, r.repairedArgs);
            emit({ type: 'info', message: `Profilo ${profile} aggiornato` });
          }
          return r;
        });
      },
    },
    {
      name: 'job_status', description: 'Stato di un job (up, tune): running/done/failed, esito o errore, domanda pendente da mostrare all\'utente.',
      inputSchema: obj({ jobId: S.jobId }, ['jobId']),
      run: ({ jobId }) => {
        const job = jobs.get(jobId);
        if (!job) throw new LlmpodError(Codes.NOT_FOUND, `Job ${jobId} non trovato`);
        return { job, ...(job.question ? { next: 'Mostra la domanda all\'utente (con il costo, se indicato) e rispondi con job_answer solo con la sua risposta' } : {}) };
      },
    },
    {
      name: 'job_events', description: 'Eventi di un job con numero progressivo (seq): fasi, avanzamento, avvisi, domande, esito. since: ultimo seq visto + 1. includeLogs: anche le righe di log di vLLM.',
      inputSchema: obj({ jobId: S.jobId, since: { type: 'integer', minimum: 0 }, includeLogs: { type: 'boolean' } }, ['jobId']),
      run: ({ jobId, since = 0, includeLogs = false }) => {
        const all = jobs.events(jobId, since);
        if (!all) throw new LlmpodError(Codes.NOT_FOUND, `Job ${jobId} non trovato`);
        const events = includeLogs ? all : all.filter((e) => e.type !== 'log');
        return { events, nextSince: all.length ? all[all.length - 1].seq + 1 : since, question: jobs.get(jobId).question };
      },
    },
    {
      name: 'job_answer', description: 'Risponde alla domanda pendente di un job. Usalo SOLO dopo aver mostrato la domanda all\'utente e con la sua risposta: true/false per le conferme, id dell\'opzione (o null) per le scelte.',
      inputSchema: obj({ jobId: S.jobId, questionId: { type: 'string', minLength: 1, maxLength: 100 }, answer: { type: ['boolean', 'string', 'null'] } }, ['jobId', 'questionId', 'answer']),
      run: ({ jobId, questionId, answer }) => {
        const q = jobs.get(jobId)?.question;
        if (!q || q.id !== questionId) throw new LlmpodError(Codes.INVALID_INPUT, 'La domanda non è più attiva', { hint: 'Rileggi job_status' });
        if (q.kind === 'choice' ? !(answer === null || q.options.some((o) => o.id === answer)) : typeof answer !== 'boolean') {
          throw new LlmpodError(Codes.INVALID_INPUT, q.kind === 'choice' ? 'La risposta deve essere l\'id di una delle opzioni (oppure null)' : 'La risposta deve essere true o false');
        }
        if (!jobs.answer(jobId, questionId, answer)) throw new LlmpodError(Codes.INVALID_INPUT, 'La domanda non è più attiva');
        return { ok: true };
      },
    },
    {
      name: 'tune_preview', description: 'Anteprima del tuning (nessuna modifica): argomenti attivi sul Pod, diff, stima di memoria sulla GPU del Pod; rifiuta se non entra.',
      inputSchema: obj({ profile: S.profile, set: { ...S.args, description: 'argomenti vLLM chiave=valore (valore false = rimuove)' }, extra: S.args }, ['profile']),
      run: ({ profile, set = [], extra = [] }) => syncOps().tunePreview(profile, { set, extra }),
    },
    {
      name: 'tune', description: 'Applica il tuning: ricarica vLLM sul Pod (interruzione di alcuni minuti, il Pod resta e continua a costare), attende ready ed esegue lo smoke test. Richiede confirm: true. In background: jobId. Se fallisce, chiede (domanda pendente) se tornare agli argomenti precedenti.',
      inputSchema: obj({ profile: S.profile, set: S.args, extra: S.args, expectedArgs: { ...S.args, maxItems: 200, description: 'il campo "before" di tune_preview: se gli argomenti attivi sono cambiati, rifiuta' }, confirm: S.confirm, save: { type: 'boolean', description: 'salva gli argomenti nel profilo' } }, ['profile', 'expectedArgs', 'confirm']),
      annotations: { destructiveHint: true },
      run: async ({ profile, set = [], extra = [], expectedArgs, save = false }) => {
        assertNotBusy(profile);
        await syncOps().tunePreview(profile, { set, extra, expectedArgs }); // errori subito (flag, memoria, argomenti cambiati)
        return startJob('tune', profile, async ({ ops, m }) => {
          try {
            return await ops.tune(profile, { set, extra, expectedArgs, confirmed: true, save, isCancelled: () => m.cancelRequested });
          } catch (err) {
            if (!m.cancelRequested) throw err;
            const reverted = err.details?.reverted === true;
            throw new LlmpodError(Codes.CANCELLED, reverted
              ? 'Tune annullato: vLLM è di nuovo attivo con gli argomenti precedenti; il Pod resta acceso'
              : 'Tune annullato, ma il ritorno agli argomenti precedenti non è riuscito; il Pod resta acceso', {
              hint: reverted ? 'Verifica con metrics' : `Controlla con logs; se vLLM non riparte chiedi all'utente se eliminare il Pod (down ${profile})`,
              details: { reverted },
            });
          }
        });
      },
    },
    {
      name: 'keep_preview', description: 'Anteprima del cambio dei limiti di spegnimento di un Pod avviato: nuovi limiti, scadenza e costo massimo. Nessuna modifica.',
      inputSchema: obj({ profile: S.profile, idleMinutes: { type: 'integer', minimum: 0, maximum: 1440 }, maxHours: { type: 'number', minimum: 0.25, maximum: 168 } }, ['profile']),
      run: ({ profile, idleMinutes, maxHours }) => syncOps().keep(profile, { idleMinutes, maxHours, preview: true }),
    },
    {
      name: 'keep', description: 'Cambia i limiti di spegnimento (inattività in minuti, 0 = mai; ore massime dall\'avvio) di un Pod avviato senza riavviarlo. Può aumentare la spesa: richiede confirm: true dopo keep_preview.',
      inputSchema: obj({ profile: S.profile, idleMinutes: { type: 'integer', minimum: 0, maximum: 1440 }, maxHours: { type: 'number', minimum: 0.25, maximum: 168 }, save: { type: 'boolean' }, confirm: S.confirm }, ['profile', 'confirm']),
      run: ({ profile, idleMinutes, maxHours, save = false }) => {
        assertNotBusy(profile);
        return syncOps().keep(profile, { idleMinutes, maxHours, save, yes: true });
      },
    },
    {
      name: 'down', description: 'ELIMINA (mai ferma) tutti i Pod del profilo, accesi o spenti; il network volume resta. Se è in corso un up o un tune del profilo, lo annulla (domanda pendente chiusa col valore sicuro). Richiede confirm: true. Restituisce l\'elenco dei Pod llmpod per la verifica finale.',
      inputSchema: obj({ profile: S.profile, confirm: S.confirm }, ['profile', 'confirm']),
      annotations: { destructiveHint: true },
      run: async ({ profile }) => {
        assertProfileName(profile);
        return downAndList(profile, await cancelJobsOf(profile, 'Annullato: Pod eliminato con down'));
      },
    },
    {
      name: 'job_cancel', description: 'Annulla un job in corso. up (Pod non ancora pronto): annulla ed ELIMINA il Pod appena creato. tune: interrompe l\'attesa e riporta vLLM agli argomenti precedenti (ricarica), il Pod RESTA acceso; l\'esito arriva nell\'evento finale del job. Per eliminare un Pod in uso serve down, con il permesso dell\'utente. Richiede confirm: true.',
      inputSchema: obj({ jobId: S.jobId, confirm: S.confirm }, ['jobId', 'confirm']),
      annotations: { destructiveHint: true },
      run: async ({ jobId }) => {
        const job = jobs.get(jobId);
        const m = meta.get(jobId);
        if (!job || !m) throw new LlmpodError(Codes.NOT_FOUND, `Job ${jobId} non trovato`);
        if (job.status !== 'running') throw new LlmpodError(Codes.INVALID_INPUT, `Il job ${jobId} non è in corso (${job.status})`, { hint: 'Per eliminare un Pod usa down, con il permesso dell\'utente' });
        if (m.kind === 'tune') {
          // Non si tocca il Pod: si esce dall'attesa e il job stesso torna agli argomenti precedenti.
          const next = 'vLLM viene riportato agli argomenti precedenti (alcuni minuti): segui job_status / job_events; l\'esito è nell\'evento finale';
          if (m.cancelRequested) return { jobId, ignored: true, message: 'Annullamento già in corso', next };
          if (jobs.get(jobId).question) {
            m.cancelRequested = true;
            jobs.settlePending(jobId); // domanda di ritorno: sì
            return { jobId, interrupted: true, podKept: true, next };
          }
          if (m.reverting) return { jobId, ignored: true, message: 'Ritorno agli argomenti precedenti già in corso', next };
          m.cancelRequested = true;
          m.interruptPending = true;
          const old = m.interrupt;
          m.interrupt = new AbortController();
          old.abort();
          return { jobId, interrupted: true, podKept: true, next };
        }
        // up: si elimina SOLO il Pod creato da questo job (mai altri Pod del profilo); se non c'è ancora, si annulla e basta.
        jobs.cancel(jobId, 'Annullato con job_cancel');
        await jobs.wait(jobId, 60_000);
        const ops = syncOps();
        if (m.podId) await ops.terminatePod(m.profile, m.podId);
        const after = await ops.status();
        return { jobId, cancelled: true, terminatedPodId: m.podId, allPods: after.pods.map((p) => ({ profile: p.profile, podId: p.podId, state: p.state, hourlyUSD: p.hourlyUSD })) };
      },
    },
    {
      name: 'client_commands', description: 'Comandi da eseguire nel terminale per usare il Pod con Claude Code, OpenCode, pi o ZCode. Non contengono la chiave: llmpod la legge dalla configurazione locale.',
      inputSchema: obj({ profile: S.profile }, ['profile']),
      run: ({ profile }) => {
        ctx.store.readProfile(profile);
        const cmd = (client) => `llmpod run ${client} --profile ${profile}`;
        return {
          commands: { claude: cmd('claude'), opencode: cmd('opencode'), pi: cmd('pi'), zcode: cmd('zcode') },
          withoutGlobalCommand: `node ${PROJECT_DIR}/src/cli/index.js run <client> --profile ${profile}`,
          note: 'Non mostrare né chiedere mai la chiave vLLM: i comandi la passano al client senza stamparla. Per lavorare in un\'altra cartella aggiungi --cwd <cartella> al comando (es. llmpod run claude --profile NOME --cwd ~/mio-progetto)',
        };
      },
    },
  ];
  return {
    tools: tools.map((t) => ({
      ...t,
      annotations: { title: t.name, readOnlyHint: READ_ONLY_TOOLS.includes(t.name), destructiveHint: false, openWorldHint: true, ...t.annotations },
    })),
    shutdown,
  };
}
