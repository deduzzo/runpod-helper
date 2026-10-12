import { LlmpodError, Codes } from '../errors.js';
import { redact } from '../secrets.js';
import { proxyUrl } from '../runpod.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RANK = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
const OOM_RE = /out of memory|OutOfMemoryError|insufficient memory|No available memory for the cache blocks/i;
// Righe che indicano la causa di un errore (non i frame dello stack): servono perché la coda dei log di vLLM contiene
// spesso solo la traceback dell'APIServer, mentre la causa vera è stampata prima dal processo EngineCore.
const CAUSE_RE = /(\b[A-Z]\w*(Error|Exception)\b|CUDA error|out of memory|not supported|unsupported|NotImplemented|AssertionError|Errore)/;
const FRAME_RE = /^\s*(\([\w.-]+ pid=\d+\)\s*)?(File "|\^+\s*$|Traceback \(most recent call last\)|return |raise$)/;
export function causeLines(lines, max = 8) {
  const out = [];
  for (const l of lines) {
    if (!CAUSE_RE.test(l) || FRAME_RE.test(l)) continue;
    const clean = l.replace(/^\([\w.-]+ pid=\d+\)\s*/, '').trim();
    if (!clean || out.includes(clean)) continue;
    out.push(clean);
  }
  return out.slice(-max);
}

export function rankCandidates({ profile, catalogs, cloud = 'SECURE' }) {
  const key = cloud.toLowerCase();
  const wanted = [profile.gpu, ...(profile.alternatives ?? [])].filter(Boolean);
  const inVolumeDc = [];
  const otherDcs = [];
  for (const w of wanted) {
    const g = (catalogs[w.count] ?? []).find((x) => x.id === w.id);
    const hourly = Math.round((g?.price?.[key] ?? 0) * w.count * 1000) / 1000;
    const dcs = g?.dataCenters ?? [];
    const here = dcs.find((d) => d.id === profile.dataCenterId);
    inVolumeDc.push({ id: w.id, count: w.count, dataCenterId: profile.dataCenterId, withVolume: Boolean(profile.volume?.id), hourly, availability: here?.availability ?? 'NONE' });
    for (const d of dcs.filter((x) => x.id !== profile.dataCenterId && x.availability !== 'NONE')) {
      otherDcs.push({ id: w.id, count: w.count, dataCenterId: d.id, withVolume: false, hourly, availability: d.availability });
    }
  }
  otherDcs.sort((a, b) => a.hourly - b.hourly || RANK[a.availability] - RANK[b.availability]);
  return { inVolumeDc, otherDcs };
}

export async function createWithFallback({ runpod, candidates, buildBody, onAttempt = () => {}, beforeAttempt = async () => true, findExisting = async () => null, sleep = defaultSleep }) {
  let last = null;
  for (const c of candidates) {
    await beforeAttempt(c);
    onAttempt(c);
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await runpod.createPod(buildBody(c));
      if (r.status === 200 || r.status === 201) return { pod: r.data, candidate: c };
      last = r;
      const detail = redact([r.data?.detail, ...(r.data?.errors ?? [])].filter(Boolean).join('; '));
      if (r.status === 402) throw new LlmpodError(Codes.INSUFFICIENT_BALANCE, `Credito Runpod insufficiente: ${detail}`, { hint: 'Ricarica il credito su https://www.runpod.io/console/user/billing' });
      if (r.status === 401) throw new LlmpodError(Codes.RUNPOD_AUTH, `Chiave Runpod non valida: ${detail}`);
      if (r.status === 422) throw new LlmpodError(Codes.REQUEST_INVALID, `Richiesta di creazione Pod non valida: ${detail}`);
      if (r.status >= 500) {
        // la creazione potrebbe essere andata a buon fine nonostante l'errore: evita un secondo Pod
        const existing = await findExisting();
        if (existing) return { pod: existing, candidate: c };
        await sleep(2000 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  const detail = redact(last?.data?.detail ?? `HTTP ${last?.status}`);
  throw new LlmpodError(Codes.NO_GPU_AVAILABLE, `Nessuna GPU disponibile tra i candidati (ultimo errore: ${detail})`, {
    hint: 'Riprova più tardi, aggiungi alternative al profilo (llmpod plan) o consenti altri datacenter senza volume',
  });
}

export async function waitForRunning({ runpod, podId, timeoutMs = 600_000, sleep = defaultSleep, now = Date.now }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const pod = await runpod.getPod(podId);
    if (!pod) throw new LlmpodError(Codes.VLLM_ERROR, `Il Pod ${podId} non esiste più`);
    if (pod.status === 'RUNNING') return pod;
    if (['ERROR', 'TERMINATED', 'EXITED'].includes(pod.status)) throw new LlmpodError(Codes.VLLM_ERROR, `Il Pod ${podId} è in stato ${pod.status}`);
    await sleep(5000);
  }
  throw new LlmpodError(Codes.POD_START_TIMEOUT, `Il Pod ${podId} non è partito entro ${Math.round(timeoutMs / 60000)} minuti`);
}

export function createSupervisorClient({ http, podId, apiKey, baseUrl = proxyUrl(podId, 8001) }) {
  const headers = { authorization: `Bearer ${apiKey}` };
  const get = async (path) => {
    try {
      const r = await http.request('GET', `${baseUrl}${path}`, { headers, timeoutMs: 20_000, retry: false });
      return r.ok ? r.data : null;
    } catch {
      return null; // proxy non ancora pronto
    }
  };
  return {
    status: () => get('/status'),
    logs: (since = 0) => get(`/logs?since=${since}`),
    reload: (args) => http.request('POST', `${baseUrl}/reload`, { headers, json: { args }, timeoutMs: 20_000 }),
    // Cambia i limiti di spegnimento sul Pod avviato; un supervisore vecchio risponde 404.
    setWatchdog: ({ idleMinutes, maxHours }) => http.request('POST', `${baseUrl}/watchdog`, { headers, json: { idleMinutes, maxHours }, timeoutMs: 20_000 }),
  };
}

// Dopo POST /reload: il supervisore imposta args e fase 'loading' prima di fermare il vecchio vLLM. Si attende di vederli
// (oppure 'error'), altrimenti waitForReady potrebbe leggere 'ready' dal processo che sta morendo. false se non succede entro il limite.
export async function waitReloadStarted({ sup, args, timeoutMs = 60_000, sleep = defaultSleep, now = Date.now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const st = await sup.status();
    if (st && (st.phase === 'error' || (JSON.stringify(st.args) === JSON.stringify(args) && st.phase !== 'ready'))) return true;
    if (now() >= deadline) return false;
    await sleep(2000);
  }
}

const GiB = 1024 ** 3;
// Avanzamento dell'avvio dallo stato del supervisore. Il download misura i byte del modello nella cache di Hugging Face; il
// caricamento usa la barra di vLLM ("Loading safetensors checkpoint shards", in loadProgress), che sui modelli grandi e
// multi-GPU può durare più del download.
export function progressOf(st) {
  if (st.phase === 'downloading' && st.totalBytes) {
    const ratio = Math.min(1, st.downloadedBytes / st.totalBytes);
    // In fase di download non si dichiara mai il 100%: il passaggio al caricamento lo segnala il supervisore.
    const pct = Math.min(99, Math.round(ratio * 100));
    return { message: `Download dei pesi: ${pct}% (${Math.round(st.downloadedBytes / GiB)} di ${Math.round(st.totalBytes / GiB)} GiB)`, ratio };
  }
  const lp = st.loadProgress;
  if (st.phase === 'loading' && lp?.total) {
    if (lp.done >= lp.total) return { message: 'Pesi caricati: inizializzazione di vLLM (KV cache, compilazione, CUDA graph)' };
    let eta = '';
    if (Number.isFinite(lp.remainingSeconds)) eta = lp.remainingSeconds < 60 ? ', meno di un minuto rimanente' : `, circa ${Math.round(lp.remainingSeconds / 60)} min rimanenti`;
    return { message: `Caricamento dei pesi: ${lp.done}/${lp.total} file${eta}`, ratio: lp.done / lp.total };
  }
  return { message: { loading: 'Caricamento del modello in GPU', ready: 'vLLM pronto' }[st.phase] ?? `Fase: ${st.phase}` };
}

const NCCL_RE = /NCCL error|NCCL WARN|ncclUnhandledCudaError|ncclSystemError|ncclInternalError|possibile problema NCCL/i;
const NCCL_HINT = 'Errore NCCL tra le GPU: su GPU senza NVLink completo (RTX, RTX PRO, L40S, A40, NVL…) llmpod avvia il Pod in modalità NCCL sicura '
  + '(NCCL_P2P_DISABLE=1 o NCCL_P2P_LEVEL=NVL, --disable-custom-all-reduce), salvo profili creati con --no-nccl-safe (rigenera il piano senza). '
  + 'Se succede comunque, scegli una sola GPU più grande o GPU SXM con NVLink (H100/H200/B200)';
// Righe d'errore NCCL di vLLM (non quelle del supervisore, che elencano solo le variabili d'ambiente).
export const isNcclError = (lines) => lines.some((l) => !String(l).startsWith('[llmpod] ambiente') && NCCL_RE.test(String(l)));

export const readyTimeoutMs = (weightsBytes) => Math.round((weightsBytes / 50e6) * 1000) + 600_000;
// Attesa di up: almeno 1,5 volte la stima dell'avvio (modelli grandi e multi-GPU caricano molto più lentamente di 50 MB/s).
export const startupTimeoutMs = (weightsBytes, estimate) => Math.max(readyTimeoutMs(weightsBytes), Math.round(1.5 * (estimate?.totalSeconds ?? 0) * 1000));

// `since`: cursore dei log da cui ripartire (dopo un riavvio di vLLM). Il cursore raggiunto è in `logCursor`
// sul valore restituito e in `details.logCursor` degli errori.
export async function waitForReady({ sup, timeoutMs, since: sinceOpt = 0, sleep = defaultSleep, now = Date.now, onStatus = () => {}, onLog = () => {} }) {
  const deadline = now() + timeoutMs;
  let since = sinceOpt;
  const recent = [];
  const causes = []; // righe di causa viste durante tutta l'attesa (non solo le ultime 200)
  while (now() < deadline) {
    const logs = await sup.logs(since);
    for (const l of logs?.lines ?? []) {
      since = Math.max(since, l.n);
      recent.push(l.line);
      if (recent.length > 200) recent.shift();
      if (CAUSE_RE.test(l.line) && !FRAME_RE.test(l.line)) { causes.push(l.line); if (causes.length > 50) causes.shift(); }
      onLog(l.line);
    }
    const st = await sup.status();
    if (st) {
      onStatus(st);
      if (st.phase === 'ready') return { ...st, logCursor: since };
      if (st.phase === 'error' || st.phase === 'terminating') {
        const oom = recent.some((l) => OOM_RE.test(l)) || causes.some((l) => OOM_RE.test(l));
        const rootCause = causeLines(causes);
        // La causa scelta dal supervisore (errore non transitorio) vale più dell'ultima riga di causa vista nei log.
        if (st.errorCause && !rootCause.includes(st.errorCause)) rootCause.push(st.errorCause);
        const cause = st.errorCause ?? rootCause.at(-1);
        const what = st.lastError ?? st.terminateReason ?? st.phase;
        const withCause = cause && !String(what).includes(cause.slice(0, 120)) ? ` — causa: ${cause.slice(0, 300)}` : '';
        const nccl = isNcclError([cause ?? '', String(st.lastError ?? ''), ...rootCause, ...recent]);
        throw new LlmpodError(oom ? Codes.OOM : Codes.VLLM_ERROR, `vLLM non è partito: ${what}${withCause}`, {
          hint: oom ? 'Memoria GPU insufficiente: riduci --context, usa --set kv-cache-dtype=fp8 o scegli una GPU più grande' : nccl ? NCCL_HINT : 'Controlla i log mostrati sopra',
          details: { lastLines: rootCause.length ? [...rootCause, '…', ...recent.slice(-22)] : recent.slice(-30), rootCause, logCursor: since, nccl, ...(st.phase === 'terminating' ? { terminating: true } : {}) },
        });
      }
    }
    await sleep(5000);
  }
  throw new LlmpodError(Codes.POD_START_TIMEOUT, `vLLM non è pronto dopo ${Math.round(timeoutMs / 60000)} minuti`, { details: { logCursor: since } });
}
