import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LlmpodError, Codes } from './errors.js';
import { registerSecret, redactObject } from './secrets.js';
import { profileKeyVar } from './config.js';
import { proxyUrl } from './runpod.js';
import { confirmCost, confirmAction, fmtUSD } from './confirm.js';
import { validateWatchdog, maxCostUSD, fmtHours, idleText, exceedsDefaults, DEFAULT_WATCHDOG, MIN_REMAINING_SECONDS } from './watchdog.js';
import { buildPodBody, argsForCount } from './pod/body.js';
import { adviseRepair } from './advisor/advisor.js';
import { diffArgs, fitsForOption } from './advisor/advice.js';
import { loadFlags } from './planner/vllm-args.js';
import { syncDerivedFields } from './planner/plan.js';
import { profileDownloadBytes } from './planner/vram.js';
import { rankCandidates, createWithFallback, waitForRunning, createSupervisorClient, waitForReady, readyTimeoutMs } from './pod/launcher.js';
import { smokeTest } from './pod/smoke.js';
import { updateZcode, zcodeDir } from './clients/zcode.js';
import { applyGpuChoice, vramLabel } from './planner/gpu-choice.js';
import { podState, STOPPED_STATUSES } from './pod-state.js';

// ACTIVE: Pod acceso (o in avvio). Un Pod EXITED (spento) non è attivo ma ESISTE ancora e costa lo spazio su disco:
// llmpod lo elimina sempre (DELETE), non lo "ferma" mai.
const RECENTLY_TERMINATED_MS = 5 * 60_000;
const ACTIVE = (p) => p.status !== 'TERMINATED' && !STOPPED_STATUSES.includes(p.status);
const EXISTS = (p) => p.status !== 'TERMINATED';
const podName = (profile) => `llmpod-${profile}`;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const generateKey = () => randomBytes(32).toString('base64url');

// Limiti di spegnimento fuori dal predefinito (inattività mai o più di 8 ore): la conferma dell'avvio li mostra con il costo massimo.
function watchdogNote(wd, hourly) {
  if (!exceedsDefaults(wd)) return '';
  return `; ${idleText(wd.idleMinutes)}, massimo ${wd.maxHours} h → costo massimo ${fmtUSD(wd.maxHours * hourly)}`;
}

export const AMBIGUOUS_CREATE_WARNING = 'Potrebbe essere stato creato un Pod non ancora visibile: controlla tra un minuto con "llmpod status" o su https://www.runpod.io/console/pods';

// GPU e alternative del profilo. Senza GPU nel datacenter del volume si ripiega sui candidati "altrove":
// up li offrirà (con consenso) in altri datacenter senza volume.
function pickGpus(plan) {
  const seen = new Set();
  const ordered = [];
  const push = (id, count) => {
    const k = `${id}×${count}`;
    if (!seen.has(k)) { seen.add(k); ordered.push({ id, count }); }
  };
  if (plan.gpu) push(plan.gpu.id, plan.gpu.count);
  for (const a of plan.alternatives ?? []) push(a.id, a.count);
  if (!plan.gpu) for (const e of plan.elsewhere ?? []) push(e.gpuId, e.count);
  if (!ordered.length) {
    throw new LlmpodError(Codes.NO_GPU_AVAILABLE, 'Nessuna GPU adatta disponibile per questo piano, né nel datacenter del volume né altrove', { hint: 'Riprova più tardi con: llmpod plan <modello>' });
  }
  return { gpu: ordered[0], alternatives: ordered.slice(1) };
}

export function profileFromPlan(plan, { name, volume, watchdog }) {
  const { gpu, alternatives } = pickGpus(plan);
  return {
    name,
    servedName: name,
    model: plan.model,
    context: plan.context,
    concurrency: plan.concurrency,
    vllm: plan.vllm,
    parsers: plan.parsers,
    gpu,
    alternatives,
    // tutte le configurazioni compatibili con la stima: `up` le ripropone in base alla disponibilità attuale
    options: plan.options ?? null,
    cloud: plan.cloud,
    dataCenterId: plan.dataCenterId,
    volume: volume ? { id: volume.id, mountPath: '/workspace' } : null,
    allowFallbackWithoutVolume: 'ask',
    watchdog,
    estimate: { ...plan.estimate, hourlyUSD: plan.hourlyUSD },
    warnings: plan.warnings,
    advisor: plan.advisor ?? null,
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

export function createOps({ store, runpod, hf, http, events, ask, askChoice = null, now = Date.now, sleep = defaultSleep, zcode = { dir: zcodeDir() }, advisor = null }) {
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

  // gpu: scelta dell'utente tra le opzioni del piano ({ id, count }); si applica a una copia, last-plan.json non cambia.
  function saveProfile(name, { gpu } = {}) {
    const plan = store.readJson('last-plan.json', null);
    if (!plan) throw new LlmpodError(Codes.NOT_FOUND, 'Nessun piano da salvare', { hint: 'Esegui prima: llmpod plan <modello>' });
    if (gpu) applyGpuChoice(plan, { id: gpu.id, count: gpu.count ?? null });
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

  // Tutti i Pod del profilo ancora esistenti, accesi o spenti (gli accesi per primi): `down` li elimina tutti.
  async function findAllPods(name) {
    const mine = (await runpod.listPods()).filter((p) => p.name === podName(name) && EXISTS(p));
    const st = store.readState().pods[name];
    if (st?.podId && !mine.some((p) => p.id === st.podId)) {
      const pod = await runpod.getPod(st.podId);
      if (pod && EXISTS(pod)) mine.push(pod);
    }
    return mine.sort((a, b) => Number(ACTIVE(b)) - Number(ACTIVE(a)));
  }

  function forget(name, podId = null) {
    const state = store.readState();
    delete state.pods[name];
    // Ricorda per qualche minuto i Pod appena eliminati: l'elenco di Runpod può mostrarli ancora come RUNNING.
    if (podId) {
      const cutoff = now() - RECENTLY_TERMINATED_MS;
      state.terminated = Object.fromEntries(Object.entries(state.terminated ?? {}).filter(([, t]) => t > cutoff));
      state.terminated[podId] = now();
    }
    store.writeState(state);
  }

  async function terminate(name, podId) {
    events.emit('phase', { message: `Terminazione del Pod ${podId}` });
    await runpod.deletePod(podId);
    for (let i = 0; i < 12; i++) {
      const pod = await runpod.getPod(podId);
      if (!pod || pod.status === 'TERMINATED') {
        forget(name, podId);
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
    let ok = true;
    try { ok = yes || await ask(`Terminare il Pod ${podId} per non continuare a pagare?`, true, { timeoutValue: true }); } catch { ok = true; } // Ctrl+C al prompt: meglio spegnere
    if (!ok) return;
    try {
      await terminate(name, podId);
    } catch (e) {
      events.emit('warning', { message: `Terminazione del Pod ${podId} non riuscita: ${e.message}. Controlla su https://www.runpod.io/console/pods` });
    }
  }

  const REPAIRABLE = [Codes.OOM, Codes.VLLM_ERROR, Codes.SMOKE_TEST_FAILED];

  async function repairWithAdvisor({ err, attempts, yes, endpoint, profile, currentArgs, sup, hourly }) {
    if (!advisor || yes || attempts >= 3 || err.details?.terminating || !REPAIRABLE.includes(err.code)) return null;
    let provider;
    try {
      provider = advisor.provider(endpoint);
    } catch (e) {
      events.emit('warning', { message: `Consulente non disponibile: ${e.message}` });
      return null;
    }
    if (!provider) return null;
    if (provider.podOnly && err.code !== Codes.SMOKE_TEST_FAILED) return null;
    if (!(await ask(`Avvio non riuscito (${err.code}). Chiedere una correzione al consulente? Il Pod continua a costare ${fmtUSD(hourly)}/h`, true))) return null;
    let advice;
    try {
      events.emit('phase', { message: `Consulto ${provider.label} (tentativo ${attempts + 1}/3)` });
      advice = await adviseRepair({ provider, profile, args: currentArgs, error: { code: err.code, message: err.message }, lastLines: err.details?.lastLines ?? [], smoke: err.code === Codes.SMOKE_TEST_FAILED ? err.details : null, flags: loadFlags() });
    } catch (e) {
      events.emit('warning', { message: `Consulente non disponibile: ${e.message}` });
      return null;
    }
    // Gli argomenti proposti vanno riallineati (tool-call-parser <=> --enable-auto-tool-choice) PRIMA di mostrarli e applicarli.
    const fixed = syncDerivedFields({ vllm: { args: [...advice.args] } });
    const changes = diffArgs(currentArgs, fixed.vllm.args);
    events.emit('advice', { rationale: advice.rationale, changes, rejected: advice.rejected, warnings: advice.warnings });
    if (!advice.accepted.length) {
      events.emit('warning', { message: 'Il consulente non ha proposto modifiche applicabili' });
      return null;
    }
    if (!(await ask('Applicare le modifiche e riavviare vLLM sul Pod?', true))) return null;
    const r = await sup.reload(fixed.vllm.args).catch((e) => ({ ok: false, status: 0, data: e.message }));
    if (!r.ok) {
      events.emit('warning', { message: `Riavvio di vLLM non riuscito (HTTP ${r.status})` });
      return null;
    }
    events.emit('phase', { message: 'Riavvio di vLLM con gli argomenti corretti' });
    // Il supervisore imposta args e fase 'loading' prima di fermare il vecchio vLLM: si attende di vederli,
    // altrimenti waitForReady potrebbe leggere 'ready' dal processo che sta morendo.
    const deadline = now() + 60_000;
    for (;;) {
      const st = await sup.status();
      if (st && (st.phase === 'error' || (JSON.stringify(st.args) === JSON.stringify(fixed.vllm.args) && st.phase !== 'ready'))) return fixed.vllm.args;
      if (now() >= deadline) {
        events.emit('warning', { message: 'Il supervisore non ha confermato il riavvio di vLLM entro 60 secondi' });
        return null;
      }
      await sleep(2000);
    }
  }

  function saveProfileArgs(name, args) {
    const profile = store.readProfile(name);
    profile.vllm.args = argsForCount(args, profile.gpu.count);
    syncDerivedFields(profile);
    store.writeProfile(profile);
    return profile;
  }

  async function up(name, { yes = false, dryRun = false } = {}) {
    const profile = store.readProfile(name);
    const cfg = store.readConfig();
    const env = store.readEnv();
    const apiKey = env[profileKeyVar(name)];
    if (!apiKey) throw new LlmpodError(Codes.INVALID_INPUT, `Manca la chiave vLLM del profilo ${name}`, { hint: `Esegui: llmpod rotate-key ${name}` });
    registerSecret(apiKey);

    events.emit('phase', { message: 'Controlli preliminari' });
    const existing = (await runpod.listPods()).filter((p) => p.name === podName(name) && EXISTS(p));
    const running = existing.find(ACTIVE);
    if (running) throw new LlmpodError(Codes.INVALID_INPUT, `Il profilo ${name} ha già un Pod attivo (${running.id})`, { hint: `Esegui: llmpod down ${name}` });
    // Un Pod spento continua a costare (disco): prima di crearne uno nuovo va eliminato. Se l'utente rifiuta (o la domanda
    // scade, nell'interfaccia web) up si ferma senza creare nulla; con --yes lo elimina.
    for (const old of existing) {
      if (dryRun) {
        events.emit('warning', { message: `Il Pod ${old.id} è spento ma costa ancora lo spazio su disco: un avvio reale lo eliminerebbe prima di crearne uno nuovo` });
      } else if (yes || await ask(`Il profilo ${name} ha un Pod spento (${old.id}) che costa ancora lo spazio su disco. Eliminarlo prima di crearne uno nuovo?`, true, { timeoutValue: false })) {
        await terminate(name, old.id);
      } else {
        throw new LlmpodError(Codes.INVALID_INPUT, `Elimina prima il Pod spento ${old.id} (llmpod down ${name})`, { hint: 'Un Pod spento continua a costare lo spazio su disco: nessun nuovo Pod è stato creato' });
      }
    }
    if (profile.model.gated) {
      const access = await hf.checkAccess(profile.model.id, profile.model.revision);
      if (!access.ok) throw new LlmpodError(Codes.GATED_MODEL, `Nessun accesso a ${profile.model.id} (HTTP ${access.status})`, { hint: `Richiedi l'accesso su https://huggingface.co/${profile.model.id} e imposta HF_TOKEN con "llmpod init"` });
    }
    const { balance } = await runpod.getBalance();

    // Con la scelta dell'utente (terminale interattivo o web) si considerano TUTTE le opzioni salvate nel profilo; altrimenti
    // (o per profili vecchi senza `options`) solo la GPU del profilo e le sue alternative, con ripieghi.
    const choiceMode = Boolean(askChoice) && !yes && !dryRun;
    const wantedAlternatives = choiceMode && profile.options?.length
      ? profile.options.map((o) => ({ id: o.id, count: o.count }))
      : (profile.alternatives ?? []);
    const wanted = [];
    for (const g of [profile.gpu, ...wantedAlternatives].filter(Boolean)) if (!wanted.some((w) => w.id === g.id && w.count === g.count)) wanted.push({ id: g.id, count: g.count });
    const counts = [...new Set(wanted.map((g) => g.count))];
    const catalogs = {};
    for (const count of counts) catalogs[count] = await runpod.listGpus({ count, cloud: profile.cloud, minCudaVersion: cfg.minCudaVersion });
    const { inVolumeDc, otherDcs } = rankCandidates({ profile: { ...profile, gpu: wanted[0], alternatives: wanted.slice(1) }, catalogs, cloud: profile.cloud });
    let candidates = inVolumeDc.filter((c) => c.hourly > 0);
    if (choiceMode) {
      // Modalità scelta: niente domanda di ripiego, la scelta stessa è il consenso. Si propongono anche le opzioni
      // disponibili in altri datacenter (senza volume), salvo allowFallbackWithoutVolume "never". Si escludono le GPU non disponibili ora e quelle che con gli argomenti
      // salvati del profilo non entrerebbero in memoria.
      const optionOf = (c) => profile.options?.find((o) => o.id === c.id && o.count === c.count);
      const fits = (c) => {
        const o = optionOf(c);
        if (!o) return true;
        if (o.fits === false) return false;
        const memoryGiB = o.memoryGiB ?? (catalogs[c.count] ?? []).find((g) => g.id === c.id)?.memory;
        if (!memoryGiB || !profile.estimate?.weightsGiB || !Number.isFinite(o.perGpuGiB)) return true;
        return fitsForOption({ estimate: profile.estimate, kvCacheDtype: null }, { count: c.count, memoryGiB, perGpuGiB: o.perGpuGiB })(profile.vllm.args);
      };
      // allowFallbackWithoutVolume "never": mai opzioni di altri datacenter (senza volume).
      const elsewhere = profile.allowFallbackWithoutVolume === 'never' ? [] : otherDcs;
      candidates = [...candidates, ...elsewhere].filter((c) => c.hourly > 0 && c.availability !== 'NONE' && fits(c)).sort((a, b) => a.hourly - b.hourly);
    } else if (!candidates.some((c) => c.availability !== 'NONE') && otherDcs.length) {
      const policy = profile.allowFallbackWithoutVolume ?? 'ask';
      const allow = policy === 'always' || (policy === 'ask' && (yes || dryRun || await ask(
        `Nel datacenter ${profile.dataCenterId} del volume non risultano GPU disponibili. Posso provare altri datacenter senza volume (pesi scaricati a ogni avvio)?`, true)));
      if (allow) candidates = [...candidates, ...otherDcs];
    }
    if (choiceMode) {
      // Scelta della GPU (terminale interattivo o interfaccia web, mai con --yes): tra le configurazioni disponibili ORA.
      // Con una sola si usa quella (la conferma del costo mostra la GPU che verrà davvero creata); con nessuna si ferma qui.
      // Dopo la scelta si usa solo quella: niente ripieghi silenziosi su altre GPU.
      const avail = candidates;
      if (!avail.length) {
        const all = wanted.map((g) => `${g.id}${g.count > 1 ? ` ×${g.count}` : ''}`).join(', ');
        throw new LlmpodError(Codes.NO_GPU_AVAILABLE, `Nessuna GPU disponibile ora tra le opzioni del profilo (${all})`, { hint: 'Riprova più tardi' });
      }
      if (avail.length > 1) {
        const key = (c) => `${c.id}|${c.count}|${c.dataCenterId}`;
        const memory = (c) => (catalogs[c.count] ?? []).find((g) => g.id === c.id)?.memory;
        const where = (c) => (c.withVolume ? c.dataCenterId : `(senza volume, ${c.dataCenterId})`);
        const label = (c) => `${c.id} ×${c.count} · ${memory(c) != null ? vramLabel({ count: c.count, memoryGiB: memory(c) }) : '? GB'} · ${fmtUSD(c.hourly)}/h · ${where(c)} · ${c.availability}`;
        const def = avail.find((c) => c.id === profile.gpu?.id && c.count === profile.gpu?.count && c.dataCenterId === profile.dataCenterId) ?? avail[0];
        const picked = await askChoice('Quale GPU usare per l\'avvio?', avail.map((c) => ({ id: key(c), label: label(c) })), key(def));
        const chosen = picked == null ? null : avail.find((c) => key(c) === picked);
        if (!chosen) throw new LlmpodError(Codes.CANCELLED, 'Nessuna GPU scelta: operazione annullata, nessun Pod creato');
        candidates = [chosen];
      }
    } else if (!candidates.length) {
      throw new LlmpodError(Codes.NO_GPU_AVAILABLE, 'Nessun candidato GPU per questo profilo', { hint: 'Rigenera il piano con: llmpod plan' });
    }

    const first = candidates[0];
    if (balance < first.hourly) {
      throw new LlmpodError(Codes.INSUFFICIENT_BALANCE, `Credito Runpod (${fmtUSD(balance)}) inferiore a un'ora di utilizzo (${fmtUSD(first.hourly)})`, { hint: 'Ricarica il credito su https://www.runpod.io/console/user/billing' });
    }
    const buildBody = (c) => buildPodBody({ profile, candidate: c, apiKey, hfToken: env.HF_TOKEN, minCudaVersion: cfg.minCudaVersion });
    const conf = await confirmCost({
      hourlyUSD: first.hourly, yes, dryRun, ask,
      description: `Avvio di ${name}: ${first.id} ×${first.count} in ${first.dataCenterId}${first.withVolume ? '' : ' (senza volume)'}${watchdogNote(profile.watchdog, first.hourly)}`,
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
        } else {
          events.emit('warning', { message: AMBIGUOUS_CREATE_WARNING });
        }
      }
      throw err;
    }
    const { pod, candidate } = created;
    events.emit('pod', { podId: pod.id });

    try {
      const state = store.readState();
      state.pods[name] = { podId: pod.id, startedAt: new Date(startedAt).toISOString(), hourlyUSD: candidate.hourly, dataCenterId: candidate.dataCenterId, withVolume: candidate.withVolume };
      store.writeState(state);
      events.emit('phase', { message: 'Attesa dell\'avvio del Pod' });
      const runningPod = await waitForRunning({ runpod, podId: pod.id, sleep, now });
      const sup = createSupervisorClient({ http, podId: pod.id, apiKey });
      events.emit('phase', { message: 'Avvio di vLLM (download e caricamento dei pesi)' });
      const readyOpts = { sup, sleep, now, onStatus: (s) => events.emit('progress', progressOf(s)), onLog: (line) => events.emit('log', { line }) };
      const baseUrl = proxyUrl(pod.id, 8000);
      const endpoint = { baseUrl, apiKey, servedName: profile.servedName, context: profile.context, reasoning: Boolean(profile.parsers?.reasoning) };
      let currentArgs = argsForCount(profile.vllm.args, candidate.count);
      let repairedArgs = null;
      let attempts = 0;
      let st;
      let smoke;
      let cursor = 0; // cursore dei log del supervisore: dopo un riavvio non si rileggono i log del run precedente
      for (;;) {
        try {
          let timeoutMs = readyTimeoutMs(profileDownloadBytes(profile));
          for (;;) {
            try {
              st = await waitForReady({ ...readyOpts, since: cursor, timeoutMs });
              cursor = st.logCursor ?? cursor;
              break;
            } catch (err) {
              cursor = err.details?.logCursor ?? cursor;
              if (err.code !== Codes.POD_START_TIMEOUT || yes || !(await ask('vLLM non è ancora pronto. Aspettare altri 15 minuti?', true))) throw err;
              timeoutMs = 15 * 60_000;
            }
          }
          events.emit('phase', { message: 'Smoke test con chiamata a strumento' });
          smoke = await smokeTest({ http, baseUrl, apiKey, model: profile.servedName });
          if (!smoke.ok) {
            const failed = [smoke.models, smoke.messages, smoke.chat].filter((r) => !r.ok).map((r) => r.detail).join(' | ');
            throw new LlmpodError(Codes.SMOKE_TEST_FAILED, `Smoke test fallito: ${failed}`, { hint: 'Verifica tool-call parser e chat template (llmpod plan … --set tool-call-parser=<nome>)', details: smoke });
          }
          break;
        } catch (err) {
          const next = await repairWithAdvisor({ err, attempts, yes, endpoint, profile, currentArgs, sup, hourly: candidate.hourly });
          if (!next) throw err;
          attempts += 1;
          currentArgs = next;
          repairedArgs = next;
          // il parser di reasoning può essere cambiato dalla riparazione: i client (ZCode, pi) devono vederlo
          endpoint.reasoning = Boolean(syncDerivedFields({ vllm: { args: [...next] } }).parsers.reasoning);
        }
      }
      await refreshZcode(endpoint);
      return {
        podId: pod.id, baseUrl, hourlyUSD: runningPod.cost ?? candidate.hourly, candidate,
        startupSeconds: Math.round((now() - startedAt) / 1000), kvCacheTokens: st.kvCacheTokens ?? null,
        contextSuggestion: suggestContext(st.kvCacheTokens, profile), smoke, repairedArgs,
      };
    } catch (err) {
      events.emit('warning', { message: `Avvio non riuscito: ${err.message}` });
      await offerTerminate(name, pod.id, yes);
      throw err;
    }
  }

  // Elimina (DELETE, mai stop) tutti i Pod del profilo, anche quelli spenti: un Pod spento costa ancora lo spazio su disco.
  async function down(name, { yes = false, dryRun = false } = {}) {
    const pods = await findAllPods(name);
    if (!pods.length) {
      forget(name);
      return { podId: null };
    }
    let sessionUSD = 0;
    const deleted = [];
    for (const pod of pods) {
      const stopped = !ACTIVE(pod);
      const conf = await confirmAction({
        description: stopped ? `Eliminare il Pod spento ${pod.id} (${name}), che costa ancora lo spazio su disco` : `Terminare il Pod ${pod.id} (${name}, ${fmtUSD(pod.cost ?? 0)}/h)`,
        yes, dryRun, ask,
      });
      if (conf.dryRun) continue;
      const uptime = pod.runtime?.uptime ?? 0;
      await terminate(name, pod.id);
      sessionUSD += ((pod.cost ?? 0) * uptime) / 3600;
      deleted.push({ podId: pod.id, stopped });
    }
    if (dryRun) return { dryRun: true, podId: pods[0].id, podIds: pods.map((p) => p.id), stopped: !ACTIVE(pods[0]) };
    return { podId: deleted[0].podId, podIds: deleted.map((d) => d.podId), stopped: deleted[0].stopped, sessionUSD };
  }

  // Cambia i limiti di spegnimento (inattività, durata massima dall'avvio) di un Pod già avviato, senza riavviarlo.
  // Con `save` aggiorna anche il profilo, per i prossimi avvii. `yes` salta le conferme (costo massimo se la spesa possibile
  // aumenta; profilo con inattività mai o più di 8 ore).
  async function keep(name, { idleMinutes, maxHours, save = false, yes = false } = {}) {
    const wanted = validateWatchdog({ idleMinutes, maxHours });
    const profile = store.readProfile(name); // NOT_FOUND se il profilo non esiste
    const pod = await findPod(name);
    if (!pod) throw new LlmpodError(Codes.NOT_FOUND, `Nessun Pod attivo per il profilo ${name}`, { hint: `Esegui: llmpod up ${name}` });
    if (pod.status !== 'RUNNING') throw new LlmpodError(Codes.INVALID_INPUT, `Il Pod ${pod.id} non è ancora avviato (${pod.status}): riprova quando è pronto`);
    const apiKey = keyOf(name);
    registerSecret(apiKey);
    const sup = createSupervisorClient({ http, podId: pod.id, apiKey });
    const current = await sup.status();
    if (!current) throw new LlmpodError(Codes.HTTP, `Il supervisore del Pod ${pod.id} non risponde`, { hint: 'Il Pod potrebbe essere ancora in avvio: riprova tra poco, oppure controlla con: llmpod status' });
    // Un supervisore vecchio non dichiara la funzione: lo si scopre prima di chiedere conferme.
    const oldSupervisor = () => new LlmpodError(Codes.INVALID_INPUT, `Il supervisore del Pod ${pod.id} è di una versione precedente e non supporta la modifica dei limiti`, { hint: `Serve un Pod avviato con questa versione di llmpod: "llmpod down ${name}" e poi "llmpod up ${name}"` });
    if (!current.features?.includes('watchdog')) throw oldSupervisor();

    const hourlyUSD = pod.cost || profile.estimate?.hourlyUSD || null;
    const curIdleMinutes = current.idleLimitSeconds / 60;
    const newMaxSeconds = wanted.maxHours != null ? wanted.maxHours * 3600 : current.maxSeconds;
    const newIdleMinutes = wanted.idleMinutes ?? curIdleMinutes;
    if (wanted.maxHours != null && newMaxSeconds <= current.uptimeSeconds + MIN_REMAINING_SECONDS) {
      throw new LlmpodError(Codes.INVALID_INPUT, `Il Pod è acceso da ${fmtHours(current.uptimeSeconds)}: con un massimo di ${fmtHours(newMaxSeconds)} verrebbe eliminato subito. Per spegnerlo usa llmpod down ${name}`, { hint: `Scegli un massimo che lasci almeno 5 minuti oltre il tempo già trascorso, oppure spegni il Pod con: llmpod down ${name}` });
    }
    // La spesa possibile aumenta con più ore massime, con l'inattività disattivata o con una soglia più alta.
    const idleRaised = wanted.idleMinutes != null && curIdleMinutes !== 0 && (wanted.idleMinutes === 0 || wanted.idleMinutes > curIdleMinutes);
    const hoursRaised = wanted.maxHours != null && newMaxSeconds > current.maxSeconds;
    if ((idleRaised || hoursRaised) && !yes) {
      const remaining = newMaxSeconds - current.uptimeSeconds;
      const cost = maxCostUSD({ hourlyUSD, maxSeconds: newMaxSeconds, uptimeSeconds: current.uptimeSeconds });
      await confirmAction({
        description: `Cambiare i limiti del Pod ${pod.id} (${name}): ${idleText(newIdleMinutes)}, massimo ${fmtHours(newMaxSeconds)} dall'avvio — resterà acceso al massimo ${fmtHours(remaining)} ancora, ${cost == null ? 'costo orario non noto' : `costo massimo stimato ${fmtUSD(cost)} (${fmtUSD(hourlyUSD)}/h)`}`,
        ask,
      });
    }
    let nextWatchdog = null;
    if (save) {
      nextWatchdog = { ...DEFAULT_WATCHDOG, ...profile.watchdog, ...(wanted.idleMinutes != null && { idleMinutes: wanted.idleMinutes }), ...(wanted.maxHours != null && { maxHours: wanted.maxHours }) };
      if (exceedsDefaults(nextWatchdog) && !yes) {
        const cost = hourlyUSD ? ` → costo massimo ${fmtUSD(nextWatchdog.maxHours * hourlyUSD)} a ogni avvio` : '';
        await confirmAction({ description: `Salvare nel profilo ${name} ${idleText(nextWatchdog.idleMinutes)}, massimo ${fmtHours(nextWatchdog.maxHours * 3600)}${cost}: i prossimi Pod resteranno accesi così a lungo`, ask });
      }
    }
    const r = await sup.setWatchdog(wanted);
    if (r.status === 404) throw oldSupervisor();
    if (!r.ok) throw new LlmpodError(Codes.HTTP, `Il supervisore ha rifiutato i nuovi limiti: HTTP ${r.status}${r.data?.error ? ` ${String(r.data.error).slice(0, 200)}` : ''}`);
    const idleLimitSeconds = r.data?.idleLimitSeconds ?? current.idleLimitSeconds;
    const maxSeconds = r.data?.maxSeconds ?? newMaxSeconds;
    const uptimeSeconds = r.data?.uptimeSeconds ?? current.uptimeSeconds;
    const remainingSeconds = Math.max(0, maxSeconds - uptimeSeconds);
    if (save) store.writeProfile({ ...store.readProfile(name), watchdog: nextWatchdog });
    return {
      podId: pod.id, idleLimitSeconds, maxSeconds, uptimeSeconds, remainingSeconds,
      expiresAt: new Date(now() + remainingSeconds * 1000).toISOString(),
      hourlyUSD, maxCostUSD: maxCostUSD({ hourlyUSD, maxSeconds, uptimeSeconds }), saved: save,
    };
  }

  async function status() {
    const [pods, balance] = await Promise.all([runpod.listPods(), runpod.getBalance().catch(() => null)]);
    const state = store.readState();
    const env = store.readEnv();
    const cfg = store.readConfig();
    const ours = pods.filter((p) => p.name?.startsWith('llmpod-') && EXISTS(p));
    const rows = await Promise.all(ours.map(async (p) => {
      const profile = p.name.slice('llmpod-'.length);
      // startedAt dà un valore preciso; runtime.uptime di Runpod si aggiorna solo a intervalli.
      const uptimeSeconds = p.startedAt && !Number.isNaN(Date.parse(p.startedAt)) ? Math.max(0, Math.round((now() - Date.parse(p.startedAt)) / 1000)) : (p.runtime?.uptime ?? 0);
      const key = env[profileKeyVar(profile)];
      const sup = key && p.status === 'RUNNING' ? await createSupervisorClient({ http, podId: p.id, apiKey: key }).status() : null;
      const terminatedAt = state.terminated?.[p.id];
      const terminating = terminatedAt != null && now() - terminatedAt < RECENTLY_TERMINATED_MS;
      const { state: podStateName, label } = terminating ? { state: 'terminating', label: 'in eliminazione' } : podState(p.status);
      const stopped = podStateName === 'stopped';
      // Un Pod spento non ha uptime né costo orario della GPU; costa lo spazio su disco (se Runpod ne indica il costo).
      return {
        profile, podId: p.id, status: p.status, state: podStateName, stateLabel: label, gpu: p.gpu ?? null,
        hourlyUSD: stopped ? null : (p.cost ?? 0), diskGB: p.disk ?? null,
        uptimeSeconds: stopped ? 0 : uptimeSeconds,
        sessionUSD: stopped ? null : ((p.cost ?? 0) * uptimeSeconds) / 3600, orphan: !terminating && state.pods[profile]?.podId !== p.id,
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

  return { saveProfile, saveProfileArgs, up, down, keep, status, endpoint, rotateKey, resolveProfile };
}
