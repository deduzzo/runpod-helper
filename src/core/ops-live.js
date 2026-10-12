// Operazioni su un Pod già avviato, pensate anche per un agente (Claude Code, server MCP): metriche di vLLM, log del
// supervisore e tuning degli argomenti con ricarica di vLLM (il Pod resta acceso).
import { LlmpodError, Codes } from './errors.js';
import { registerSecret, redact } from './secrets.js';
import { proxyUrl } from './runpod.js';
import { confirmAction, fmtUSD } from './confirm.js';
import { snapshotMetrics, summarizeMetrics } from './metrics.js';
import { computeTune } from './tune.js';
import { memoryCheck } from './advisor/advice.js';
import { loadFlags } from './planner/vllm-args.js';
import { syncDerivedFields } from './planner/plan.js';
import { argsForCount } from './pod/body.js';
import { profileDownloadBytes } from './planner/vram.js';
import { createSupervisorClient, waitForReady, waitReloadStarted, readyTimeoutMs } from './pod/launcher.js';
import { smokeTest } from './pod/smoke.js';

export const RELOAD_NOTE = 'vLLM verrà ricaricato: interruzione di alcuni minuti; il Pod resta acceso';
const WINDOW_RANGE = [1, 300];

export function createLiveOps({ store, runpod, http, events, ask, now, sleep, findPod, keyOf, refreshZcode }) {
  // Pod avviato del profilo con il client del supervisore (chiave del profilo registrata come segreto).
  async function livePod(name) {
    const profile = store.readProfile(name);
    const pod = await findPod(name);
    if (!pod) throw new LlmpodError(Codes.NOT_FOUND, `Nessun Pod attivo per il profilo ${name}`, { hint: `Esegui: llmpod up ${name}` });
    if (pod.status !== 'RUNNING') throw new LlmpodError(Codes.INVALID_INPUT, `Il Pod ${pod.id} non è ancora avviato (${pod.status}): riprova quando è pronto`);
    const apiKey = keyOf(name);
    if (!apiKey) throw new LlmpodError(Codes.INVALID_INPUT, `Manca la chiave vLLM del profilo ${name}`, { hint: `Esegui: llmpod rotate-key ${name}` });
    registerSecret(apiKey);
    return { profile, pod, apiKey, sup: createSupervisorClient({ http, podId: pod.id, apiKey }) };
  }

  async function readMetrics(podId) {
    // /metrics di vLLM non richiede la chiave e non conta come attività per lo spegnimento per inattività.
    const r = await http.request('GET', `${proxyUrl(podId, 8000)}/metrics`, { timeoutMs: 20_000, retry: false }).catch(() => null);
    if (!r?.ok || typeof r.data !== 'string') throw new LlmpodError(Codes.HTTP, `Metriche di vLLM non disponibili (HTTP ${r?.status ?? 'nessuna risposta'}): vLLM potrebbe essere ancora in avvio`);
    return snapshotMetrics(r.data);
  }

  const supervisorView = (st) => st && {
    phase: st.phase, idleSeconds: st.idleSeconds, idleLimitSeconds: st.idleLimitSeconds, uptimeSeconds: st.uptimeSeconds,
    maxSeconds: st.maxSeconds, restarts: st.restarts, lastError: st.lastError ? redact(st.lastError) : null, kvCacheTokens: st.kvCacheTokens ?? null,
  };

  async function metrics(name, { window = 10 } = {}) {
    if (!Number.isFinite(window) || window < WINDOW_RANGE[0] || window > WINDOW_RANGE[1]) {
      throw new LlmpodError(Codes.INVALID_INPUT, `La finestra deve essere tra ${WINDOW_RANGE[0]} e ${WINDOW_RANGE[1]} secondi`);
    }
    const { profile, pod, sup } = await livePod(name);
    const st = await sup.status();
    const base = {
      profile: name, podId: pod.id, gpu: pod.gpu ?? null, hourlyUSD: pod.cost ?? null, model: profile.model.id,
      context: profile.context, mtp: profile.mtp ?? null, activeArgs: st?.args ?? null, supervisor: supervisorView(st),
    };
    let summary = null;
    let metricsError = null;
    try {
      const a = await readMetrics(pod.id);
      await sleep(window * 1000);
      const b = await readMetrics(pod.id);
      summary = summarizeMetrics(a, b, window);
    } catch (err) {
      metricsError = err.message;
    }
    return { ...base, metrics: summary, ...(metricsError ? { metricsError } : {}) };
  }

  async function logs(name, { since = 0 } = {}) {
    const { pod, sup } = await livePod(name);
    const r = await sup.logs(Number.isInteger(since) && since > 0 ? since : 0);
    if (!r) throw new LlmpodError(Codes.HTTP, `Il supervisore del Pod ${pod.id} non risponde`, { hint: 'Il Pod potrebbe essere ancora in avvio: riprova tra poco' });
    const lines = (r.lines ?? []).map((l) => ({ n: l.n, line: redact(l.line) }));
    return { profile: name, podId: pod.id, lines, cursor: lines.length ? lines[lines.length - 1].n : since };
  }

  // Memoria per GPU con i nuovi argomenti sulla GPU del Pod (stima del profilo, scalata con contesto e dtype della KV).
  async function memoryFor(profile, pod, args) {
    const id = pod.gpu?.id ?? profile.gpu?.id;
    const count = pod.gpu?.count ?? profile.gpu?.count ?? 1;
    const opt = profile.options?.find((o) => o.id === id && o.count === count);
    let memoryGiB = opt?.memoryGiB ?? null;
    if (!memoryGiB) {
      const cfg = store.readConfig();
      const catalog = await runpod.listGpus({ count, cloud: profile.cloud, minCudaVersion: cfg.minCudaVersion }).catch(() => []);
      memoryGiB = catalog.find((g) => g.id === id)?.memory ?? null;
    }
    const perGpuGiB = opt?.perGpuGiB ?? (count === profile.gpu?.count ? profile.estimate?.perGpuGiB : null);
    if (!memoryGiB || !Number.isFinite(perGpuGiB) || !profile.estimate?.weightsGiB) return { gpu: id, count, memoryGiB, fits: null, note: 'Stima di memoria non disponibile per questa GPU' };
    const m = memoryCheck({ estimate: profile.estimate, context: profile.context }, { count, memoryGiB, perGpuGiB })(args);
    return { gpu: id, count, memoryGiB, ...m };
  }

  // expectedArgs (server MCP): argomenti attivi visti nell'anteprima; se sul Pod sono cambiati nel frattempo si rifiuta.
  async function prepareTune(name, { set = [], extra = [], expectedArgs = null }) {
    const live = await livePod(name);
    const st = await live.sup.status();
    if (!st) throw new LlmpodError(Codes.HTTP, `Il supervisore del Pod ${live.pod.id} non risponde`, { hint: 'Riprova tra poco, oppure controlla con: llmpod status' });
    if (!Array.isArray(st.args) || !st.args.length) throw new LlmpodError(Codes.INVALID_INPUT, `Il supervisore del Pod ${live.pod.id} non riporta gli argomenti attivi`);
    // Solo da 'ready': da 'error' gli argomenti attivi sono quelli rotti e il ritorno indietro tornerebbe a quelli.
    if (st.phase !== 'ready') {
      throw new LlmpodError(Codes.INVALID_INPUT, `vLLM è in fase "${st.phase}": tune parte solo da un vLLM pronto`, {
        hint: st.phase === 'error' ? `Guarda i log (llmpod logs ${name}); per ripartire da capo: llmpod down ${name} e llmpod up ${name}` : 'Attendi che vLLM sia pronto (llmpod status)',
      });
    }
    if (expectedArgs && JSON.stringify(expectedArgs) !== JSON.stringify(st.args)) {
      throw new LlmpodError(Codes.INVALID_INPUT, 'Gli argomenti attivi sul Pod sono cambiati dall\'anteprima', { hint: 'Rifai tune_preview e mostra di nuovo il diff all\'utente' });
    }
    const t = computeTune({ currentArgs: st.args, set, extra, flags: loadFlags(), maxContext: live.profile.model.maxContext });
    const memory = await memoryFor(live.profile, live.pod, t.args);
    if (memory.fits === false) {
      throw new LlmpodError(Codes.INVALID_INPUT, `Con i nuovi argomenti il modello non entra nella GPU del Pod (${memory.gpu} ×${memory.count}): servono circa ${memory.neededGiB} GiB per GPU, disponibili ${memory.availableGiB} GiB`, {
        hint: 'Riduci --max-model-len o max-num-seqs, oppure usa --set kv-cache-dtype=fp8',
      });
    }
    return { ...live, st, ...t, memory };
  }

  const previewOf = (name, p) => ({
    profile: name, podId: p.pod.id, gpu: p.pod.gpu ?? null, hourlyUSD: p.pod.cost ?? null, phase: p.st.phase,
    before: p.st.args, after: p.args, changes: p.changes, unknownFlags: p.unknown, contextChange: p.contextChange, memory: p.memory,
    note: RELOAD_NOTE,
  });

  async function tunePreview(name, opts = {}) {
    return previewOf(name, await prepareTune(name, opts));
  }

  // Ricarica vLLM con `args`, attende ready con quegli argomenti ed esegue lo smoke test. Lancia in caso di errore.
  async function applyArgs({ profile, pod, apiKey, sup }, args) {
    const last = await sup.logs(0);
    const cursor = Math.max(0, ...(last?.lines ?? []).map((l) => l.n));
    const r = await sup.reload(args).catch((e) => ({ ok: false, status: 0, data: { error: e.message } }));
    if (!r.ok) throw new LlmpodError(Codes.HTTP, `Il supervisore ha rifiutato la ricarica: HTTP ${r.status}${r.data?.error ? ` ${redact(String(r.data.error)).slice(0, 200)}` : ''}`, { details: { notReloaded: true } });
    events.emit('phase', { message: 'Ricarica di vLLM con i nuovi argomenti' });
    if (!(await waitReloadStarted({ sup, args, sleep, now }))) throw new LlmpodError(Codes.VLLM_ERROR, 'Il supervisore non ha confermato la ricarica di vLLM entro 60 secondi');
    const st = await waitForReady({
      sup, since: cursor, sleep, now, timeoutMs: readyTimeoutMs(profileDownloadBytes(profile)),
      onStatus: (s) => events.emit('progress', { message: s.phase === 'ready' ? 'vLLM pronto' : `Fase: ${s.phase}` }),
      onLog: (line) => events.emit('log', { line }),
    });
    events.emit('phase', { message: 'Smoke test con chiamata a strumento' });
    const smoke = await smokeTest({ http, baseUrl: proxyUrl(pod.id, 8000), apiKey, model: profile.servedName });
    if (!smoke.ok) {
      const failed = [smoke.models, smoke.messages, smoke.chat].filter((x) => !x.ok).map((x) => x.detail).join(' | ');
      throw new LlmpodError(Codes.SMOKE_TEST_FAILED, `Smoke test fallito dopo la ricarica: ${failed}`, { details: smoke });
    }
    return { st, smoke };
  }

  // confirmed: la conferma della ricarica è già stata data (server MCP, confirm: true); a differenza di yes, il ritorno agli
  // argomenti precedenti in caso di errore resta una domanda.
  // isCancelled (server MCP, job_cancel): se diventa vero dopo una ricarica riuscita si torna agli argomenti precedenti come
  // dopo un errore (il Pod resta acceso).
  async function tune(name, { set = [], extra = [], yes = false, confirmed = false, dryRun = false, save = false, expectedArgs = null, isCancelled = () => false } = {}) {
    const p = await prepareTune(name, { set, extra, expectedArgs });
    const preview = previewOf(name, p);
    if (dryRun) return { dryRun: true, ...preview };
    await confirmAction({
      description: `Applicare i nuovi argomenti di vLLM al Pod ${p.pod.id} (${name}). ${RELOAD_NOTE} (${p.pod.cost ? `${fmtUSD(p.pod.cost)}/h` : 'costo orario non noto'})`,
      yes: yes || confirmed, ask,
    });
    let result;
    try {
      result = await applyArgs(p, p.args);
      if (isCancelled()) throw new LlmpodError(Codes.CANCELLED, 'Tune annullato');
    } catch (err) {
      if (err.details?.notReloaded) throw err;
      events.emit('warning', { message: `Ricarica non riuscita: ${err.message}` });
      let revert = true;
      try { revert = yes || await ask('Tornare agli argomenti precedenti (ricarica di vLLM con quelli che funzionavano)?', true, { timeoutValue: true }); } catch { revert = true; }
      let reverted = false;
      if (revert) {
        try {
          await applyArgs(p, p.st.args);
          reverted = true;
          events.emit('info', { message: 'vLLM di nuovo attivo con gli argomenti precedenti' });
        } catch (e) {
          events.emit('warning', { message: `Ritorno agli argomenti precedenti non riuscito: ${e.message}. Controlla con: llmpod logs ${name}` });
        }
      }
      err.details = { ...(err.details ?? {}), reverted };
      err.hint = reverted
        ? `vLLM è di nuovo attivo con gli argomenti precedenti (verifica con llmpod metrics ${name}); se non risponde, elimina il Pod con llmpod down ${name}`
        : `vLLM potrebbe non rispondere e il Pod continua a costare: controlla con llmpod logs ${name} e, se non riparte, eliminalo con llmpod down ${name}`;
      throw err;
    }
    let saved = false;
    if (save) {
      const profile = store.readProfile(name);
      profile.vllm.args = argsForCount(p.args, profile.gpu.count);
      syncDerivedFields(profile);
      if (p.contextChange) profile.context = p.contextChange.to;
      store.writeProfile(profile);
      saved = true;
      if (p.contextChange) {
        await refreshZcode({ baseUrl: proxyUrl(p.pod.id, 8000), apiKey: p.apiKey, servedName: profile.servedName, context: profile.context, reasoning: Boolean(profile.parsers?.reasoning) });
      }
    } else if (p.contextChange) {
      events.emit('warning', { message: `Il profilo ${name} ha ancora un contesto di ${p.contextChange.from} token: i client configurati da llmpod lo useranno finché non salvi (--save)` });
    }
    return { ...preview, kvCacheTokens: result.st.kvCacheTokens ?? null, smoke: result.smoke, saved, reverted: false };
  }

  return { metrics, logs, tunePreview, tune };
}
