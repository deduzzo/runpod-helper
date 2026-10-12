import { LlmpodError, Codes } from '../errors.js';
import { redact } from '../secrets.js';
import { proxyUrl } from '../runpod.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RANK = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
const OOM_RE = /out of memory|OutOfMemoryError|insufficient memory|No available memory for the cache blocks/i;

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

export const readyTimeoutMs = (weightsBytes) => Math.round((weightsBytes / 50e6) * 1000) + 600_000;

// `since`: cursore dei log da cui ripartire (dopo un riavvio di vLLM). Il cursore raggiunto è in `logCursor`
// sul valore restituito e in `details.logCursor` degli errori.
export async function waitForReady({ sup, timeoutMs, since: sinceOpt = 0, sleep = defaultSleep, now = Date.now, onStatus = () => {}, onLog = () => {} }) {
  const deadline = now() + timeoutMs;
  let since = sinceOpt;
  const recent = [];
  while (now() < deadline) {
    const logs = await sup.logs(since);
    for (const l of logs?.lines ?? []) {
      since = Math.max(since, l.n);
      recent.push(l.line);
      if (recent.length > 200) recent.shift();
      onLog(l.line);
    }
    const st = await sup.status();
    if (st) {
      onStatus(st);
      if (st.phase === 'ready') return { ...st, logCursor: since };
      if (st.phase === 'error' || st.phase === 'terminating') {
        const oom = recent.some((l) => OOM_RE.test(l));
        throw new LlmpodError(oom ? Codes.OOM : Codes.VLLM_ERROR, `vLLM non è partito: ${st.lastError ?? st.terminateReason ?? st.phase}`, {
          hint: oom ? 'Memoria GPU insufficiente: riduci --context, usa --set kv-cache-dtype=fp8 o scegli una GPU più grande' : 'Controlla i log mostrati sopra',
          details: { lastLines: recent.slice(-30), logCursor: since, ...(st.phase === 'terminating' ? { terminating: true } : {}) },
        });
      }
    }
    await sleep(5000);
  }
  throw new LlmpodError(Codes.POD_START_TIMEOUT, `vLLM non è pronto dopo ${Math.round(timeoutMs / 60000)} minuti`, { details: { logCursor: since } });
}
