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
  const p = await runpod.getPod(podId).catch(() => null);
  if (p && p.status !== 'TERMINATED') {
    await runpod.deletePod(podId);
    log(`Pod ${podId} terminato dallo script (sicurezza)`);
  }
  const left = (await runpod.listPods()).filter((x) => x.name === 'llmpod-e2e-cpu' && !['TERMINATED', 'EXITED'].includes(x.status));
  log(left.length ? `⚠ Pod di prova ancora attivi: ${left.map((x) => x.id).join(', ')}` : 'Nessun Pod di prova rimasto attivo');
}
const failed = checks.filter((c) => !c.ok);
log(failed.length ? `${failed.length} controlli falliti` : 'Tutti i controlli superati');
process.exit(failed.length ? 1 : 0);
