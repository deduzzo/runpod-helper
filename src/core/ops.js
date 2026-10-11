import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LlmpodError, Codes } from './errors.js';
import { registerSecret, redactObject } from './secrets.js';
import { profileKeyVar } from './config.js';
import { proxyUrl } from './runpod.js';
import { confirmCost, confirmAction, fmtUSD } from './confirm.js';
import { buildPodBody } from './pod/body.js';
import { rankCandidates, createWithFallback, waitForRunning, createSupervisorClient, waitForReady, readyTimeoutMs } from './pod/launcher.js';
import { smokeTest } from './pod/smoke.js';
import { updateZcode, zcodeDir } from './clients/zcode.js';

const ACTIVE = (p) => !['TERMINATED', 'EXITED'].includes(p.status);
const podName = (profile) => `llmpod-${profile}`;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const generateKey = () => randomBytes(32).toString('base64url');

export function profileFromPlan(plan, { name, volume, watchdog }) {
  return {
    name,
    servedName: name,
    model: plan.model,
    context: plan.context,
    concurrency: plan.concurrency,
    vllm: plan.vllm,
    parsers: plan.parsers,
    gpu: plan.gpu,
    alternatives: plan.alternatives.map(({ id, count }) => ({ id, count })),
    cloud: plan.cloud,
    dataCenterId: plan.dataCenterId,
    volume: volume ? { id: volume.id, mountPath: '/workspace' } : null,
    allowFallbackWithoutVolume: 'ask',
    watchdog,
    estimate: { ...plan.estimate, hourlyUSD: plan.hourlyUSD },
    warnings: plan.warnings,
    createdAt: new Date().toISOString(),
  };
}

function progressOf(st) {
  if (st.phase === 'downloading' && st.totalBytes) {
    const ratio = Math.min(1, st.downloadedBytes / st.totalBytes);
    return { message: `Download dei pesi: ${Math.round(ratio * 100)}%`, ratio };
  }
  return { message: { loading: 'Caricamento del modello in GPU', ready: 'vLLM pronto' }[st.phase] ?? `Fase: ${st.phase}` };
}

function suggestContext(kvTokens, profile) {
  if (!kvTokens) return null;
  const perSeq = Math.floor(kvTokens / (profile.concurrency || 1));
  const suggestion = Math.min(profile.model.maxContext ?? Infinity, Math.floor(perSeq / 1024) * 1024);
  return suggestion > profile.context * 1.25 ? suggestion : null;
}

export function createOps({ store, runpod, hf, http, events, ask, now = Date.now, sleep = defaultSleep, zcode = { dir: zcodeDir() } }) {
  const keyOf = (name) => store.readEnv()[profileKeyVar(name)];

  function ensureKey(name) {
    let key = keyOf(name);
    if (!key) {
      key = generateKey();
      store.writeEnv({ [profileKeyVar(name)]: key });
    }
    registerSecret(key);
    return key;
  }

  function saveProfile(name) {
    const plan = store.readJson('last-plan.json', null);
    if (!plan) throw new LlmpodError(Codes.NOT_FOUND, 'Nessun piano da salvare', { hint: 'Esegui prima: llmpod plan <modello>' });
    const cfg = store.readConfig();
    const volume = cfg.volume && cfg.volume.dataCenterId === plan.dataCenterId ? cfg.volume : null;
    const profile = profileFromPlan(plan, { name, volume, watchdog: cfg.watchdog });
    store.writeProfile(profile);
    ensureKey(name);
    return profile;
  }

  async function findPod(name) {
    const st = store.readState().pods[name];
    if (st?.podId) {
      const pod = await runpod.getPod(st.podId);
      if (pod && ACTIVE(pod)) return pod;
    }
    return (await runpod.listPods()).find((p) => p.name === podName(name) && ACTIVE(p)) ?? null;
  }

  function forget(name) {
    const state = store.readState();
    delete state.pods[name];
    store.writeState(state);
  }

  async function terminate(name, podId) {
    events.emit('phase', { message: `Terminazione del Pod ${podId}` });
    await runpod.deletePod(podId);
    for (let i = 0; i < 12; i++) {
      const pod = await runpod.getPod(podId);
      if (!pod || pod.status === 'TERMINATED') {
        forget(name);
        return;
      }
      await sleep(5000);
    }
    throw new LlmpodError(Codes.RUNPOD_API, `Il Pod ${podId} risulta ancora attivo dopo la richiesta di terminazione`, { hint: 'Controlla su https://www.runpod.io/console/pods e riprova con: llmpod down' });
  }

  async function refreshZcode(endpoint) {
    const file = path.join(zcode.dir, 'config.json');
    try {
      if (!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file, 'utf8')).provider?.llmpod) return;
      await updateZcode(endpoint, zcode);
      events.emit('info', { message: 'URL aggiornato nella configurazione di ZCode' });
    } catch (err) {
      events.emit('warning', { message: `ZCode non aggiornato: ${err.message}. Esegui "llmpod run zcode" dopo averlo chiuso` });
    }
  }

  async function offerTerminate(name, podId, yes) {
    try {
      if (yes || await ask(`Terminare il Pod ${podId} per non continuare a pagare?`, true)) await terminate(name, podId);
    } catch (e) {
      events.emit('warning', { message: `Terminazione del Pod ${podId} non riuscita: ${e.message}. Controlla su https://www.runpod.io/console/pods` });
    }
  }

  async function up(name, { yes = false, dryRun = false } = {}) {
    const profile = store.readProfile(name);
    const cfg = store.readConfig();
    const env = store.readEnv();
    const apiKey = env[profileKeyVar(name)];
    if (!apiKey) throw new LlmpodError(Codes.INVALID_INPUT, `Manca la chiave vLLM del profilo ${name}`, { hint: `Esegui: llmpod rotate-key ${name}` });
    registerSecret(apiKey);

    events.emit('phase', { message: 'Controlli preliminari' });
    const running = (await runpod.listPods()).find((p) => p.name === podName(name) && ACTIVE(p));
    if (running) throw new LlmpodError(Codes.INVALID_INPUT, `Il profilo ${name} ha già un Pod attivo (${running.id})`, { hint: `Esegui: llmpod down ${name}` });
    if (profile.model.gated) {
      const access = await hf.checkAccess(profile.model.id, profile.model.revision);
      if (!access.ok) throw new LlmpodError(Codes.GATED_MODEL, `Nessun accesso a ${profile.model.id} (HTTP ${access.status})`, { hint: `Richiedi l'accesso su https://huggingface.co/${profile.model.id} e imposta HF_TOKEN con "llmpod init"` });
    }
    const { balance } = await runpod.getBalance();

    const counts = [...new Set([profile.gpu, ...profile.alternatives].filter(Boolean).map((g) => g.count))];
    const catalogs = {};
    for (const count of counts) catalogs[count] = await runpod.listGpus({ count, cloud: profile.cloud, minCudaVersion: cfg.minCudaVersion });
    const { inVolumeDc, otherDcs } = rankCandidates({ profile, catalogs, cloud: profile.cloud });
    let candidates = inVolumeDc.filter((c) => c.hourly > 0);
    if (!candidates.some((c) => c.availability !== 'NONE') && otherDcs.length) {
      const policy = profile.allowFallbackWithoutVolume ?? 'ask';
      const allow = policy === 'always' || (policy === 'ask' && (yes || dryRun || await ask(
        `Nel datacenter ${profile.dataCenterId} del volume non risultano GPU disponibili. Posso provare altri datacenter senza volume (pesi scaricati a ogni avvio)?`, true)));
      if (allow) candidates = [...candidates, ...otherDcs];
    }
    if (!candidates.length) throw new LlmpodError(Codes.NO_GPU_AVAILABLE, 'Nessun candidato GPU per questo profilo', { hint: 'Rigenera il piano con: llmpod plan' });

    const first = candidates[0];
    if (balance < first.hourly) {
      throw new LlmpodError(Codes.INSUFFICIENT_BALANCE, `Credito Runpod (${fmtUSD(balance)}) inferiore a un'ora di utilizzo (${fmtUSD(first.hourly)})`, { hint: 'Ricarica il credito su https://www.runpod.io/console/user/billing' });
    }
    const buildBody = (c) => buildPodBody({ profile, candidate: c, apiKey, hfToken: env.HF_TOKEN, minCudaVersion: cfg.minCudaVersion });
    const conf = await confirmCost({
      hourlyUSD: first.hourly, yes, dryRun, ask,
      description: `Avvio di ${name}: ${first.id} ×${first.count} in ${first.dataCenterId}${first.withVolume ? '' : ' (senza volume)'}`,
    });
    if (conf.dryRun) {
      const body = buildBody(first);
      return { dryRun: true, message: conf.message, candidates, body: redactObject({ ...body, env: { ...body.env, LLMPOD_SUPERVISOR_B64: '<supervisore omesso>' } }) };
    }

    const startedAt = now();
    let confirmedHourly = first.hourly;
    const findExisting = async () => (await runpod.listPods()).find((p) => p.name === podName(name) && ACTIVE(p)) ?? null;
    const NOT_AMBIGUOUS = [Codes.CANCELLED, Codes.REQUEST_INVALID, Codes.RUNPOD_AUTH, Codes.INSUFFICIENT_BALANCE, Codes.NO_GPU_AVAILABLE];
    let created;
    try {
      created = await createWithFallback({
        runpod, candidates, buildBody, sleep, findExisting,
        beforeAttempt: async (c) => {
          if (c.hourly > confirmedHourly) {
            await confirmCost({ hourlyUSD: c.hourly, yes, ask, description: `Il candidato successivo costa di più: ${c.id} ×${c.count} in ${c.dataCenterId}` });
            confirmedHourly = c.hourly;
          }
        },
        onAttempt: (c) => events.emit('phase', { message: `Creazione del Pod: ${c.id} ×${c.count} in ${c.dataCenterId}${c.withVolume ? '' : ' (senza volume)'}` }),
      });
    } catch (err) {
      if (!NOT_AMBIGUOUS.includes(err.code)) {
        // creazione ambigua (es. timeout del POST): il Pod potrebbe esistere e costare
        let stray = null;
        try { stray = await findExisting(); } catch { /* ricerca best effort */ }
        if (stray) {
          events.emit('pod', { podId: stray.id });
          const st = store.readState();
          st.pods[name] = { podId: stray.id, startedAt: new Date(startedAt).toISOString(), hourlyUSD: first.hourly, dataCenterId: first.dataCenterId, withVolume: first.withVolume };
          store.writeState(st);
          await offerTerminate(name, stray.id, yes);
        }
      }
      throw err;
    }
    const { pod, candidate } = created;
    events.emit('pod', { podId: pod.id });
    const state = store.readState();
    state.pods[name] = { podId: pod.id, startedAt: new Date(startedAt).toISOString(), hourlyUSD: candidate.hourly, dataCenterId: candidate.dataCenterId, withVolume: candidate.withVolume };
    store.writeState(state);

    try {
      events.emit('phase', { message: 'Attesa dell\'avvio del Pod' });
      const runningPod = await waitForRunning({ runpod, podId: pod.id, sleep, now });
      const sup = createSupervisorClient({ http, podId: pod.id, apiKey });
      events.emit('phase', { message: 'Avvio di vLLM (download e caricamento dei pesi)' });
      const readyOpts = { sup, sleep, now, onStatus: (s) => events.emit('progress', progressOf(s)), onLog: (line) => events.emit('log', { line }) };
      let st;
      let timeoutMs = readyTimeoutMs(profile.model.weightsBytes);
      for (;;) {
        try {
          st = await waitForReady({ ...readyOpts, timeoutMs });
          break;
        } catch (err) {
          if (err.code !== Codes.POD_START_TIMEOUT || yes || !(await ask('vLLM non è ancora pronto. Aspettare altri 15 minuti?', true))) throw err;
          timeoutMs = 15 * 60_000;
        }
      }
      const baseUrl = proxyUrl(pod.id, 8000);
      events.emit('phase', { message: 'Smoke test con chiamata a strumento' });
      const smoke = await smokeTest({ http, baseUrl, apiKey, model: profile.servedName });
      if (!smoke.ok) {
        const failed = [smoke.models, smoke.messages, smoke.chat].filter((r) => !r.ok).map((r) => r.detail).join(' | ');
        throw new LlmpodError(Codes.SMOKE_TEST_FAILED, `Smoke test fallito: ${failed}`, { hint: 'Verifica tool-call parser e chat template (llmpod plan … --set tool-call-parser=<nome>)', details: smoke });
      }
      await refreshZcode({ baseUrl, apiKey, servedName: profile.servedName, context: profile.context, reasoning: Boolean(profile.parsers?.reasoning) });
      return {
        podId: pod.id, baseUrl, hourlyUSD: runningPod.cost ?? candidate.hourly, candidate,
        startupSeconds: Math.round((now() - startedAt) / 1000), kvCacheTokens: st.kvCacheTokens ?? null,
        contextSuggestion: suggestContext(st.kvCacheTokens, profile), smoke,
      };
    } catch (err) {
      events.emit('warning', { message: `Avvio non riuscito: ${err.message}` });
      await offerTerminate(name, pod.id, yes);
      throw err;
    }
  }

  async function down(name, { yes = false, dryRun = false } = {}) {
    const pod = await findPod(name);
    if (!pod) {
      forget(name);
      return { podId: null };
    }
    const conf = await confirmAction({ description: `Terminare il Pod ${pod.id} (${name}, ${fmtUSD(pod.cost ?? 0)}/h)?`, yes, dryRun, ask });
    if (conf.dryRun) return { dryRun: true, podId: pod.id };
    const uptime = pod.runtime?.uptime ?? 0;
    await terminate(name, pod.id);
    return { podId: pod.id, sessionUSD: ((pod.cost ?? 0) * uptime) / 3600 };
  }

  async function status() {
    const [pods, balance] = await Promise.all([runpod.listPods(), runpod.getBalance().catch(() => null)]);
    const state = store.readState();
    const env = store.readEnv();
    const cfg = store.readConfig();
    const ours = pods.filter((p) => p.name?.startsWith('llmpod-') && ACTIVE(p));
    const rows = await Promise.all(ours.map(async (p) => {
      const profile = p.name.slice('llmpod-'.length);
      const uptimeSeconds = p.runtime?.uptime ?? (p.startedAt ? Math.round((now() - Date.parse(p.startedAt)) / 1000) : 0);
      const key = env[profileKeyVar(profile)];
      const sup = key && p.status === 'RUNNING' ? await createSupervisorClient({ http, podId: p.id, apiKey: key }).status() : null;
      return {
        profile, podId: p.id, status: p.status, gpu: p.gpu ?? null, hourlyUSD: p.cost ?? 0, uptimeSeconds,
        sessionUSD: ((p.cost ?? 0) * uptimeSeconds) / 3600, orphan: state.pods[profile]?.podId !== p.id,
        supervisor: sup ? { phase: sup.phase, idleSeconds: sup.idleSeconds, idleLimitSeconds: sup.idleLimitSeconds, uptimeSeconds: sup.uptimeSeconds, maxSeconds: sup.maxSeconds } : null,
      };
    }));
    const volume = cfg.volume ? { ...cfg.volume, monthlyUSD: Math.round(cfg.volume.size * cfg.volumePricePerGbMonth * 100) / 100 } : null;
    return { pods: rows, balance, volume };
  }

  async function endpoint(name) {
    const profile = store.readProfile(name);
    const pod = await findPod(name);
    if (!pod) throw new LlmpodError(Codes.NOT_FOUND, `Nessun Pod attivo per il profilo ${name}`, { hint: `Esegui: llmpod up ${name}` });
    const apiKey = keyOf(name);
    registerSecret(apiKey);
    return { baseUrl: proxyUrl(pod.id, 8000), apiKey, servedName: profile.servedName, context: profile.context, reasoning: Boolean(profile.parsers?.reasoning), podId: pod.id };
  }

  async function rotateKey(name) {
    store.readProfile(name);
    const key = generateKey();
    store.writeEnv({ [profileKeyVar(name)]: key });
    registerSecret(key);
    const pod = await findPod(name);
    if (pod) events.emit('warning', { message: `Il Pod ${pod.id} usa ancora la chiave precedente: riavvialo con "llmpod down ${name}" e "llmpod up ${name}"` });
    return { activePodId: pod?.id ?? null };
  }

  async function resolveProfile(name) {
    if (name) return name;
    const active = Object.keys(store.readState().pods);
    if (active.length === 1) return active[0];
    const all = store.listProfiles();
    if (all.length === 1) return all[0];
    throw new LlmpodError(Codes.INVALID_INPUT, 'Specifica il profilo con --profile', { hint: all.length ? `Profili: ${all.join(', ')}` : 'Crea un profilo con: llmpod plan <modello> e llmpod save <nome>' });
  }

  return { saveProfile, up, down, status, endpoint, rotateKey, resolveProfile };
}
