#!/usr/bin/env node
// Prova reale su Runpod con un Pod solo CPU (cpu3c, 2 vCPU, circa 0,06 $/h, circa 10 minuti).
// Verifica: supervisore pronto, autenticazione di :8001, proxy su :8000, streaming oltre 100 s,
// auto-terminazione per inattività con la chiave iniettata da Runpod. Termina sempre il Pod.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createStore } from '../src/core/config.js';
import { createHttp } from '../src/core/http.js';
import { createRunpod, proxyUrl } from '../src/core/runpod.js';
import { createSupervisorClient } from '../src/core/pod/launcher.js';
import { createPrompt } from '../src/cli/prompt.js';
import { registerSecret, redact } from '../src/core/secrets.js';

const IDLE_MINUTES = 3;
const yes = process.argv.includes('--yes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(redact(`[${new Date().toISOString().slice(11, 19)}] ${m}`));
const b64 = (rel) => fs.readFileSync(new URL(rel, import.meta.url)).toString('base64');

const store = createStore();
const env = store.readEnv();
if (!env.RUNPOD_API_KEY) {
  console.error('RUNPOD_API_KEY mancante: esegui prima "llmpod init"');
  process.exit(1);
}
const http = createHttp({ userAgent: 'llmpod-e2e/0.1.0' });
const runpod = createRunpod({ http, apiKey: env.RUNPOD_API_KEY });
const apiKey = randomBytes(24).toString('base64url');
registerSecret(apiKey);

const body = {
  name: 'llmpod-e2e-cpu',
  image: 'python:3.12-slim',
  cpu: { id: 'cpu3c', vcpuCount: 2 },
  cloud: 'SECURE',
  disk: 5,
  ports: ['8000/http', '8001/http'],
  env: {
    LLMPOD_SUPERVISOR_B64: b64('../src/core/pod/supervisor.py'),
    FAKE_VLLM_B64: b64('../test/supervisor/fake_vllm.py'),
    LLMPOD_VLLM_CMD: JSON.stringify(['python3', '/tmp/fake_vllm.py']),
    LLMPOD_MODEL: 'fake/model',
    LLMPOD_SERVED_NAME: 'fake',
    VLLM_API_KEY: apiKey,
    LLMPOD_IDLE_MINUTES: String(IDLE_MINUTES),
    LLMPOD_MAX_HOURS: '1',
    LLMPOD_CHECK_SECONDS: '20',
    FAKE_STREAM_SECONDS: '150',
  },
  entrypoint: ['/bin/sh', '-c'],
  cmd: ['echo "$FAKE_VLLM_B64" | base64 -d > /tmp/fake_vllm.py && echo "$LLMPOD_SUPERVISOR_B64" | base64 -d > /tmp/supervisor.py && exec python3 -u /tmp/supervisor.py'],
};

async function until(what, fn, timeoutMs, everyMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`timeout: ${what}`);
}

async function streamCheck(url) {
  const t0 = Date.now();
  let chunks = 0;
  let done = false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(220_000), headers: { 'user-agent': 'llmpod-e2e/0.1.0' } });
    const decoder = new TextDecoder();
    for await (const part of res.body) {
      const text = decoder.decode(part, { stream: true });
      chunks += (text.match(/data: \d+/g) ?? []).length;
      if (text.includes('[DONE]')) done = true;
    }
    return { ok: done && (Date.now() - t0) / 1000 > 100, seconds: Math.round((Date.now() - t0) / 1000), chunks, status: res.status };
  } catch (err) {
    return { ok: false, seconds: Math.round((Date.now() - t0) / 1000), chunks, error: err.message };
  }
}

const ALERT = (id) => `⚠ ATTENZIONE: il Pod ${id} potrebbe essere ancora attivo, terminalo da https://www.runpod.io/console/pods`;
const RUNNING_STATES = ['TERMINATED', 'EXITED'];
let cleanupFailed = false;
let cleanupPromise = null;

// Termina sempre il Pod (fino a 5 tentativi) e verifica che non restino Pod di prova attivi.
// Idempotente: le chiamate successive ricevono la stessa promise (già risolta o in corso).
function cleanup(podId) {
  if (!cleanupPromise) cleanupPromise = doCleanup(podId);
  return cleanupPromise;
}

async function doCleanup(podId) {
  let deleted = false;
  for (let attempt = 1; attempt <= 5 && !deleted; attempt++) {
    try {
      await runpod.deletePod(podId); // il 404 (Pod già assente) è tollerato da deletePod
      deleted = true;
      log(`Pod ${podId} terminato (tentativo ${attempt})`);
    } catch (err) {
      log(`Terminazione del Pod ${podId} fallita (tentativo ${attempt}/5): ${err.message}`);
      if (attempt < 5) await sleep(5000);
    }
  }
  if (!deleted) {
    console.error(redact(ALERT(podId)));
    cleanupFailed = true;
  }
  try {
    const left = (await runpod.listPods()).filter((x) => x.name === 'llmpod-e2e-cpu' && !RUNNING_STATES.includes(x.status));
    if (left.length) {
      for (const x of left) console.error(redact(ALERT(x.id)));
      cleanupFailed = true;
    } else {
      log('Nessun Pod di prova rimasto attivo');
    }
  } catch (err) {
    log(`Verifica dei Pod di prova fallita: ${err.message}`);
    console.error(redact(ALERT(podId)));
    cleanupFailed = true;
  }
}

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

const prompt = createPrompt();
if (!yes && !(await prompt.ask('Prova reale: Pod CPU cpu3c (2 vCPU) a 0,06 $/h per circa 10 minuti (circa 0,01 $). Procedere?', false))) process.exit(130);

const created = await runpod.createPod(body);
if (created.status !== 201) {
  console.error(redact(`Creazione fallita: HTTP ${created.status} ${JSON.stringify(created.data)}`));
  process.exit(1);
}
const podId = created.data.id;
log(`Pod ${podId} creato`);
let signals = 0;
const onSignal = (sig) => {
  signals += 1;
  if (signals > 1) {
    console.error(redact('Pulizia in corso, attendere…'));
    return;
  }
  console.error(redact(`Interrotto (${sig}): termino il Pod…`));
  cleanup(podId).then(() => process.exit(130));
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
try {
  await until('RUNNING', async () => (await runpod.getPod(podId))?.status === 'RUNNING', 300_000, 5000);
  const sup = createSupervisorClient({ http, podId, apiKey });
  const st = await until('supervisore pronto', async () => {
    const s = await sup.status();
    return s?.phase === 'ready' ? s : null;
  }, 300_000);
  check('Supervisore pronto e KV cache letta dai log', st.kvCacheTokens === 1000, `kvCacheTokens=${st.kvCacheTokens}`);

  const noAuth = await http.request('GET', `${proxyUrl(podId, 8001)}/status`, { retry: false });
  check('Server di stato :8001 rifiuta richieste senza chiave', noAuth.status === 401, `HTTP ${noAuth.status}`);

  const models = await http.request('GET', `${proxyUrl(podId, 8000)}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  check('Proxy HTTPS su :8000 con chiave', models.ok, `HTTP ${models.status}`);

  log('Streaming di 150 s attraverso il proxy (limite Cloudflare: 100 s)…');
  const s = await streamCheck(`${proxyUrl(podId, 8000)}/stream`);
  check('Streaming oltre 100 s attraverso il proxy', s.ok, `${s.seconds} s, ${s.chunks} blocchi${s.error ? `, errore: ${s.error}` : ''}`);

  log(`Attesa dell'auto-terminazione per inattività (${IDLE_MINUTES} min dal momento in cui è pronto)…`);
  const gone = await until('auto-terminazione', async () => {
    const p = await runpod.getPod(podId);
    return !p || p.status === 'TERMINATED';
  }, (IDLE_MINUTES * 60 + 240) * 1000, 15_000).catch(() => false);
  check('Auto-terminazione del Pod con la chiave iniettata', Boolean(gone));
} catch (err) {
  check('Esecuzione della prova', false, err.message);
} finally {
  await cleanup(podId);
}
const failed = checks.filter((c) => !c.ok);
log(failed.length ? `${failed.length} controlli falliti` : 'Tutti i controlli superati');
if (cleanupFailed) log('Pulizia del Pod non riuscita: verificare la console Runpod');
process.exit(failed.length || cleanupFailed ? 1 : 0);
