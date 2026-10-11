# llmpod — Piano 3: server locale, interfaccia web e proxy per Open WebUI

> **Per chi esegue con agenti:** SUB-SKILL RICHIESTA: usare superpowers:subagent-driven-development (consigliata) oppure superpowers:executing-plans. I passi usano le caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** `llmpod ui` avvia un server locale (solo `127.0.0.1`) con API JSON + SSE e un'interfaccia web React/Vite/Tailwind installabile come PWA che copre tutto il ciclo (modelli, piano con consulente, profili, up/down con conferme, stato e costi, client, prova veloce con Open WebUI), più un proxy OpenAI interno per Open WebUI verso il Pod attivo.

**Architettura:** il server riusa il core del piano 1 e 2. Le operazioni lunghe o con conferme (`up`, `down`) girano come **job**: ogni job ha la propria istanza di `ops` con un `ask` che pubblica una domanda sull'evento SSE e attende la risposta dell'interfaccia (o il default dopo 10 minuti). La logica del piano con consulente esce da `src/cli/commands/plan.js` verso `src/core/plan-flow.js` per essere condivisa da CLI e server. Il proxy di Open WebUI è un secondo listener HTTP che inoltra `/v1/*` al Pod del profilo scelto sostituendo la chiave.

**Tech stack:** Node ≥ 20 (`node:http`, `fetch`, `stream`), React 19 + Vite + Tailwind CSS 4 (`@tailwindcss/vite`), `vitest` + `@testing-library/react` + `jsdom` per i test dell'interfaccia. Dipendenze di runtime del server: nessuna nuova; le dipendenze web sono `devDependencies` (l'interfaccia viene compilata in `dist/web`).

**Spec:** `docs/superpowers/specs/2026-10-11-llmpod-design.md` (§8 Open WebUI, §9 Web UI). Piani 1 e 2 già eseguiti.

## Vincoli globali

- Tutti i vincoli dei piani 1 e 2 restano validi (segreti mai stampati/loggati, conferme di costo, messaggi in italiano, nessuna imitazione di client).
- Il server ascolta di default su `127.0.0.1:7860` (`LLMPOD_UI_HOST`/`LLMPOD_UI_PORT` per Docker); il proxy di Open WebUI su `127.0.0.1:8081` (`LLMPOD_PROXY_HOST`/`LLMPOD_PROXY_PORT`).
- Autenticazione: token casuale a ogni avvio (o `LLMPOD_UI_TOKEN` se impostato). `GET /?t=<token>` imposta il cookie `llmpod_session` (`HttpOnly; SameSite=Strict; Path=/`) e reindirizza a `/`. Tutte le `/api/*` (tranne `/api/health`) richiedono il cookie; confronto a tempo costante.
- Controlli anti-DNS-rebinding/CSRF: header `Host` ∈ {`127.0.0.1:<porta>`, `localhost:<porta>`}; se presente, `Origin` deve essere `http://<Host>`. Richieste POST solo con `Content-Type: application/json`, corpo ≤ 1 MB.
- Header di sicurezza sulle pagine: `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:3000 http://localhost:3000; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Le risposte API non contengono segreti, tranne `POST /api/env` (export richiesti esplicitamente dall'utente, come `llmpod env`).
- Eventi SSE su `GET /api/events`: ogni evento è `{ type, ... }` già mascherato con `redactObject`; heartbeat (commento) ogni 15 s.
- Job: un solo job attivo per tipo e profilo (`up:<profilo>`, `down:<profilo>`); domande con `{ questionId, text, defYes }`; senza risposta entro 10 minuti → risposta predefinita (per "Terminare il Pod?" è sì, per le spese è no).
- Proxy di Open WebUI: accetta solo `/v1/*`, richiede `Authorization: Bearer <LLMPOD_OPENWEBUI_KEY>` (generata e salvata in `.env` al primo avvio di `llmpod ui`), inoltra al Pod con la chiave del profilo e User-Agent `llmpod/<versione>`, streaming senza buffer, 503 con messaggio italiano se nessun Pod è attivo.
- Interfaccia: stile scuro futuristico (gradienti neon, glassmorphism, transizioni animate) come da `CLAUDE.md` dell'utente; PWA con `manifest.webmanifest` e service worker che memorizza solo la shell statica (mai `/api/*`). Testi in italiano.

## Focus della revisione

1. **Richiesta da un'altra origine o con Host diverso** (sito web malevolo che chiama `http://127.0.0.1:7860/api/jobs/up`) → rifiutata con 403 senza effetti. Test: Attività 2.
2. **Job `up` con domanda senza risposta** (scheda chiusa) → dopo 10 minuti si applica il default; se era "Terminare il Pod?" il Pod viene terminato. Test: Attività 1 e 3.
3. **Proxy senza Pod attivo o Pod che cade durante uno streaming** → 503/errore pulito, nessuna eccezione non gestita che fermi il server. Test: Attività 4.
4. **Percorso statico con `../`** → mai fuori da `dist/web`. Test: Attività 2.
5. **Segreti negli eventi SSE o nelle risposte** (chiave del profilo, chiave Runpod, token HF, chiave interna di Open WebUI) → mai presenti salvo `POST /api/env`. Test: Attività 3.

## Struttura dei file

```
src/core/plan-flow.js            runPlan / applyAdvice (condivisi da CLI e server)
src/core/search.js               searchRows (condivisa da CLI e server)
src/cli/context.js               (modifica) makeOps({ ask, events })
src/cli/commands/plan.js         (modifica) usa plan-flow
src/cli/commands/search.js       (modifica) usa searchRows
src/cli/commands/ui.js           llmpod ui
src/server/jobs.js               gestione job con domande
src/server/http-utils.js         cookie, json, body, sicurezza, statici
src/server/app.js                router e API
src/server/sse.js                flusso eventi
src/server/openwebui-proxy.js    proxy /v1 verso il Pod
web/                             interfaccia React (index.html, vite.config.js, src/**, public/**)
test/server/*.test.js            test/web/*.test.jsx
```

---
### Attività 1: Core condiviso (ricerca, piano con consulente, ops per job) e gestione dei job

**File:**
- Crea: `src/core/search.js`, `src/core/plan-flow.js`, `src/server/jobs.js`
- Modifica: `src/cli/commands/search.js`, `src/cli/commands/plan.js` (usano il core), `src/cli/context.js` (`makeOps`)
- Test: `test/core/search.test.js`, `test/core/plan-flow.test.js`, `test/server/jobs.test.js`

**Interfacce:**
- Produce:
  - `searchRows(hf, query, { limit = 20, all = false }) → Promise<Array<{ id, params, dtypes, license, gated, downloads, lastModified, hasChatTemplate, weightsGiB: number|null, parser: string|null }>>` (filtra i modelli senza chat template salvo `all`).
  - `runPlan({ ctx, modelRef, context = 65536, concurrency = 2, set = [], extra = [], image, allowTrustRemoteCode = false, advisor, onProgress }) → Promise<{ plan, advice: object|null, advisorError: string|null, advisorSkipped: string|null }>` — lancia `INVALID_INPUT` "Nessun datacenter configurato" (hint `llmpod init`) se manca `dataCenterId`; `advisor` è `true` (forza), `false` (salta) o `undefined` (usa `config.advisor.enabled`); con consulente `plan.advisor = { preset, applied: false, rationale, notes, recipePath, rejected, proposed: advice.changes }`, altrimenti `null`; gli errori del consulente diversi da `CANCELLED` finiscono in `advisorError`.
  - `applyAdvice(plan, advice) → plan` (imposta `plan.vllm.args = advice.args`, chiama `syncDerivedFields(plan)`, `plan.advisor.applied = true`).
  - `ctx.makeOps({ ask, events }) → ops` (nuova istanza di `createOps` con gli stessi `store`, `runpod`, `hf`, `http`, `zcode`, `advisor` del contesto ma `ask` ed `events` forniti).
  - `createJobs({ questionTimeoutMs = 600_000, onEvent = () => {} }) → { start(kind, run) → job, answer(jobId, questionId, value) → boolean, get(id) → job|null, list() → job[], events(id, since = 0) → event[]|null }`; `run({ ask, emit }) → Promise<result>`; `job = { id, kind, status: 'running'|'done'|'failed', startedAt, question: { id, text, defYes } | null, result, error: { code, message, hint } | null }`. Ogni evento emesso è passato da `redactObject`, conservato (max 1000 per job) e inoltrato a `onEvent({ jobId, ...evento })`. Eventi automatici: `question`, `answer`, `done`, `failed`. Un secondo `start` con lo stesso `kind` mentre il primo è `running` → `INVALID_INPUT`.

- [ ] **Passo 1: test che falliscono**

`test/core/search.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { searchRows } from '../../src/core/search.js';

const models = [
  { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', params: 30.5e9, paramsByDtype: { BF16: 30.5e9 }, dtypes: ['BF16'], license: 'apache-2.0', gated: false, downloads: 10, lastModified: '2025-07-31', architectures: ['Qwen3MoeForCausalLM'], modelType: 'qwen3_moe', hasChatTemplate: true },
  { id: 'x/Strano', params: 7e9, paramsByDtype: null, dtypes: [], license: null, gated: 'manual', downloads: 1, lastModified: null, architectures: ['FooForCausalLM'], modelType: 'foo', hasChatTemplate: true },
  { id: 'x/Base', params: 1e9, paramsByDtype: null, dtypes: [], license: null, gated: false, downloads: 1, lastModified: null, architectures: [], modelType: null, hasChatTemplate: false },
];

describe('searchRows', () => {
  it('calcola parser e pesi, filtra i modelli senza chat template', async () => {
    const hf = { searchModels: vi.fn(async () => models) };
    const rows = await searchRows(hf, 'qwen', { limit: 5 });
    expect(hf.searchModels).toHaveBeenCalledWith('qwen', { limit: 5 });
    expect(rows.map((r) => r.id)).toEqual(['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'x/Strano']);
    expect(rows[0]).toMatchObject({ parser: 'qwen3_coder', weightsGiB: expect.closeTo(56.8, 1) });
    expect(rows[1]).toMatchObject({ parser: null, weightsGiB: null });
    expect((await searchRows(hf, 'q', { all: true })).length).toBe(3);
  });
});
```

`test/core/plan-flow.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlan, applyAdvice } from '../../src/core/plan-flow.js';
import { createStore } from '../../src/core/config.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
function ctxWith({ config = { dataCenterId: 'EU-RO-1' }, provider = null, providerThrows = null } = {}) {
  const store = createStore({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-pf-')), 'cfg'), platform: 'linux' });
  store.writeConfig(config);
  return {
    store,
    hf: {
      getModel: vi.fn(async () => fx('model-qwen3-coder-30b.json')),
      resolveSha: vi.fn(async () => 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120'),
      listFiles: vi.fn(async () => fx('tree-qwen3-coder-30b.json')),
      getConfig: vi.fn(async () => fx('config-qwen3-coder-30b.json')),
      getReadme: vi.fn(async () => '# scheda'),
    },
    runpod: { listGpus: vi.fn(async ({ count }) => (count === 1 ? [{ id: 'G80', name: 'G80', memory: 80, price: { secure: 1.79 }, maxCount: { secure: 8 }, dataCenters: [{ id: 'EU-RO-1', availability: 'HIGH' }] }] : [])) },
    http: { request: vi.fn(async () => ({ ok: false, status: 404, data: null })) },
    advisor: {
      provider: () => { if (providerThrows) throw providerThrows; return provider; },
      config: () => ({ preset: 'zai' }),
    },
  };
}

describe('runPlan', () => {
  it('senza datacenter → INVALID_INPUT', async () => {
    await expect(runPlan({ ctx: ctxWith({ config: {} }), modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('senza consulente: advice null', async () => {
    const r = await runPlan({ ctx: ctxWith(), modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' });
    expect(r).toMatchObject({ advice: null, advisorError: null, advisorSkipped: null });
    expect(r.plan.advisor).toBeNull();
    expect(r.plan.gpu).toEqual({ id: 'G80', count: 1 });
  });

  it('con consulente: proposta non applicata finché non si chiama applyAdvice', async () => {
    const provider = { label: 'finto', complete: vi.fn(async () => ({ text: '{"set":{"enable-prefix-caching":true},"rationale":"r","warnings":[]}' })) };
    const r = await runPlan({ ctx: ctxWith({ config: { dataCenterId: 'EU-RO-1', advisor: { enabled: true } }, provider }), modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' });
    expect(r.advice.accepted).toEqual(['enable-prefix-caching=true']);
    expect(r.plan.vllm.args).not.toContain('--enable-prefix-caching');
    expect(r.plan.advisor).toMatchObject({ preset: 'zai', applied: false, rationale: 'r', proposed: { added: ['--enable-prefix-caching'] } });
    applyAdvice(r.plan, r.advice);
    expect(r.plan.vllm.args).toContain('--enable-prefix-caching');
    expect(r.plan.advisor.applied).toBe(true);
  });

  it('errore del consulente → advisorError, piano comunque; advisor:false lo salta', async () => {
    const ctx = ctxWith({ config: { dataCenterId: 'EU-RO-1', advisor: { enabled: true } }, providerThrows: Object.assign(new Error('Consulente "custom" incompleto'), { code: 'ADVISOR_NOT_CONFIGURED' }) });
    const r = await runPlan({ ctx, modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' });
    expect(r.advisorError).toMatch(/incompleto/);
    expect(r.plan.gpu).not.toBeNull();
    const r2 = await runPlan({ ctx, modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', advisor: false });
    expect(r2.advisorError).toBeNull();
  });
});
```

`test/server/jobs.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createJobs } from '../../src/server/jobs.js';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('jobs', () => {
  it('domanda → risposta → risultato', async () => {
    const seen = [];
    const jobs = createJobs({ onEvent: (e) => seen.push(e) });
    const job = jobs.start('up:p', async ({ ask, emit }) => {
      emit({ type: 'phase', message: 'inizio' });
      const ok = await ask('Confermi?', false);
      return { ok };
    });
    await tick();
    const q = jobs.get(job.id).question;
    expect(q).toMatchObject({ text: 'Confermi?', defYes: false });
    expect(jobs.answer(job.id, 'sbagliato', true)).toBe(false);
    expect(jobs.answer(job.id, q.id, true)).toBe(true);
    await tick(); await tick();
    expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: { ok: true }, question: null });
    expect(seen.map((e) => e.type)).toEqual(['phase', 'question', 'answer', 'done']);
    expect(seen.every((e) => e.jobId === job.id)).toBe(true);
    expect(jobs.events(job.id, 2).map((e) => e.type)).toEqual(['answer', 'done']);
  });

  it('senza risposta entro il timeout vale il default', async () => {
    vi.useFakeTimers();
    try {
      const jobs = createJobs({ questionTimeoutMs: 1000 });
      const job = jobs.start('down:p', async ({ ask }) => ask('Terminare il Pod?', true));
      await vi.advanceTimersByTimeAsync(1001);
      expect(jobs.get(job.id)).toMatchObject({ status: 'done', result: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('errore mascherato e un solo job attivo per tipo', async () => {
    clearSecrets();
    registerSecret('SEGRETO-DEL-JOB-12345');
    const jobs = createJobs();
    let release;
    const gate = new Promise((r) => { release = r; });
    const a = jobs.start('up:p', async () => { await gate; throw Object.assign(new Error('boom SEGRETO-DEL-JOB-12345'), { code: 'VLLM_ERROR', hint: 'h' }); });
    expect(() => jobs.start('up:p', async () => 1)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => jobs.start('up:altro', async () => 1)).not.toThrow();
    release();
    await tick(); await tick();
    expect(jobs.get(a.id)).toMatchObject({ status: 'failed', error: { code: 'VLLM_ERROR', message: 'boom <REDATTO>', hint: 'h' } });
    expect(jobs.list().length).toBe(2);
  });

  it('gli eventi sono mascherati', async () => {
    clearSecrets();
    registerSecret('SEGRETO-EVENTO-999999');
    const jobs = createJobs();
    const job = jobs.start('x', async ({ emit }) => { emit({ type: 'log', line: 'chiave SEGRETO-EVENTO-999999' }); return null; });
    await tick(); await tick();
    expect(jobs.events(job.id)[0].line).toBe('chiave <REDATTO>');
  });
});
```

- [ ] **Passo 2: verificare che falliscano** — `npx vitest run test/core/search.test.js test/core/plan-flow.test.js test/server/jobs.test.js` → FAIL (moduli mancanti).

- [ ] **Passo 3: `src/core/search.js`**

```js
import { detectParsers } from './planner/vllm-args.js';
import { bytesFromSafetensorsParams, GiB } from './planner/vram.js';

export async function searchRows(hf, query, { limit = 20, all = false } = {}) {
  const models = (await hf.searchModels(query, { limit })).filter((m) => all || m.hasChatTemplate);
  return models.map((m) => {
    const known = m.architectures.length || m.modelType;
    const p = known ? detectParsers({ modelId: m.id, config: { architectures: m.architectures, model_type: m.modelType } }) : { tool: null };
    const bytes = bytesFromSafetensorsParams(m.paramsByDtype);
    return {
      id: m.id, params: m.params, dtypes: m.dtypes, license: m.license, gated: m.gated, downloads: m.downloads,
      lastModified: m.lastModified, hasChatTemplate: m.hasChatTemplate,
      weightsGiB: bytes ? bytes / GiB : null, parser: p.tool ?? null,
    };
  });
}
```

In `src/cli/commands/search.js` sostituire il calcolo delle righe con `const rows = (await searchRows(ctx.hf, query.join(' '), { limit: opts.limit, all: opts.all })).map((r) => ({ ...r, parser: r.parser ?? '⚠ nessuno', weights: r.weightsGiB ? fmtGiB(r.weightsGiB) : '?' }));` (import `searchRows` da `../../core/search.js`; rimuovere gli import non più usati). La tabella e il `--json` restano invariati.

- [ ] **Passo 4: `src/core/plan-flow.js`**

```js
import { LlmpodError, Codes } from './errors.js';
import { makePlan, syncDerivedFields } from './planner/plan.js';
import { loadFlags } from './planner/vllm-args.js';
import { advisePlan } from './advisor/advisor.js';
import { makeFitsWith } from './advisor/advice.js';
import { createRecipes } from './advisor/recipes.js';

export async function runPlan({ ctx, modelRef, context = 65536, concurrency = 2, set = [], extra = [], image, allowTrustRemoteCode = false, advisor, onProgress = () => {} }) {
  const cfg = ctx.store.readConfig();
  if (!cfg.dataCenterId) throw new LlmpodError(Codes.INVALID_INPUT, 'Nessun datacenter configurato', { hint: 'Esegui: llmpod init' });
  const flags = loadFlags();
  const plan = await makePlan({
    hf: ctx.hf, runpod: ctx.runpod, modelRef, context, concurrency, cloud: cfg.cloud, dataCenterId: cfg.dataCenterId,
    minCudaVersion: cfg.minCudaVersion, vllmImage: image ?? cfg.vllmImage, set, extra, flags, allowTrustRemoteCode, onProgress,
  });
  plan.advisor = null;
  let advice = null;
  let advisorError = null;
  let advisorSkipped = null;
  if (advisor === true || (advisor !== false && cfg.advisor?.enabled)) {
    try {
      const provider = ctx.advisor.provider();
      if (!provider) {
        advisorSkipped = 'Consulente non configurato o disponibile solo per le correzioni dopo up';
      } else {
        onProgress(`Consulto ${provider.label}`);
        advice = await advisePlan({ provider, plan, hf: ctx.hf, recipes: createRecipes({ http: ctx.http }), flags, fitsWith: makeFitsWith(plan), allowTrustRemoteCode });
        plan.advisor = { preset: ctx.advisor.config()?.preset ?? null, applied: false, rationale: advice.rationale, notes: advice.warnings, recipePath: advice.recipePath, rejected: advice.rejected, proposed: advice.changes };
      }
    } catch (err) {
      if (err.code === Codes.CANCELLED) throw err;
      advisorError = err.message;
    }
  }
  return { plan, advice, advisorError, advisorSkipped };
}

export function applyAdvice(plan, advice) {
  plan.vllm.args = advice.args;
  syncDerivedFields(plan);
  if (plan.advisor) plan.advisor.applied = true;
  return plan;
}
```

In `src/cli/commands/plan.js` sostituire il blocco che va da `const off = attachRenderer(...)` fino a `ctx.store.writeJson('last-plan.json', plan);` compreso con:

```js
      const off = attachRenderer(ctx.events, ctx.io);
      let result;
      try {
        result = await runPlan({
          ctx, modelRef, context: opts.context, concurrency: opts.concurrency, set: opts.set, extra: opts.extraArg,
          image: opts.image, allowTrustRemoteCode: Boolean(opts.allowTrustRemoteCode), advisor: opts.advisor,
          onProgress: (message) => ctx.events.emit('phase', { message }),
        });
      } finally {
        off();
      }
      const { plan, advice, advisorError, advisorSkipped } = result;
      if (advisorSkipped) ctx.io.err(`ℹ ${advisorSkipped}: uso gli argomenti di base`);
      if (advisorError) ctx.io.err(`⚠ Consulente non disponibile: ${advisorError}; uso gli argomenti di base`);
      if (advice) {
        if (!opts.json) renderAdvice(ctx.io, advice);
        if (advice.accepted.length > 0 && (opts.yes || (!opts.json && await ctx.io.ask('Applicare le modifiche proposte dal consulente?', false)))) applyAdvice(plan, advice);
      }
      ctx.store.writeJson('last-plan.json', plan);
```

e togliere il controllo `if (!cfg.dataCenterId) …` iniziale (ora in `runPlan`; il messaggio è identico) e gli import non più usati (`makePlan`, `loadFlags` se non serve altrove, `advisePlan`, `makeFitsWith`, `createRecipes`, `syncDerivedFields`); importare `runPlan`, `applyAdvice` da `../../core/plan-flow.js`. Il messaggio "▸ Consulto …" ora arriva come evento `phase` dal renderer (resta su stderr).

- [ ] **Passo 5: `ctx.makeOps` in `src/cli/context.js`** — aggiungere nell'oggetto `ctx`:

```js
    makeOps({ ask, events: ev }) {
      return createOps({ store, runpod: ctx.runpod, hf: ctx.hf, http, events: ev, ask, zcode: { dir: zcodeDir(env), isRunning: ctx.isZcodeRunning }, advisor: ctx.advisor });
    },
```

e far usare `makeOps({ ask: io.ask, events })` al getter `ops` (`return (cache.ops ??= ctx.makeOps({ ask: io.ask, events }));`) per non duplicare la costruzione.

- [ ] **Passo 6: `src/server/jobs.js`**

```js
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
```

- [ ] **Passo 7: verificare** — `npx vitest run test/core/search.test.js test/core/plan-flow.test.js test/server/jobs.test.js` → PASS (9 test); `npm test` → tutto verde (in particolare i test esistenti di `search`, `plan` e del consulente in `plan`).

- [ ] **Passo 8: commit e push** — `git add src test && git commit -m "feat: core condiviso per CLI e server, gestione dei job" && git push`

---

### Attività 2: Server HTTP: sicurezza, autenticazione, file statici

**File:**
- Crea: `src/server/http-utils.js`, `src/server/app.js` (scheletro con salute, sessione e statici)
- Test: `test/server/app-security.test.js`

**Interfacce:**
- Produce:
  - `http-utils.js`: `sendJson(res, status, data)`, `readJson(req, maxBytes = 1_048_576) → Promise<object>` (415 se il content-type non è JSON, 413 oltre il limite, 400 se JSON non valido — come `HttpError { status, message }`), `parseCookies(header) → object`, `safeEqual(a, b) → boolean` (tempo costante, false se lunghezze diverse), `SECURITY_HEADERS` (oggetto con CSP, nosniff, no-referrer), `serveStatic(req, res, rootDir) → boolean` (solo GET/HEAD, risolve dentro `rootDir`, `index.html` come fallback per percorsi senza estensione, MIME per html/js/css/svg/png/json/webmanifest/ico, `false` se il file non esiste).
  - `app.js`: `createApp({ ctx, token, port, staticDir, jobs, routes? }) → (req, res) => void` e `class HttpError extends Error { status }`. Ordine dei controlli per ogni richiesta: Host ammesso (`127.0.0.1:<port>` o `localhost:<port>`) altrimenti 403; `Origin`, se presente, uguale a `http://<host>` altrimenti 403; `GET /api/health` → `{ ok: true }` senza autenticazione; `GET /?t=<token>` valido → `Set-Cookie: llmpod_session=<token>; HttpOnly; SameSite=Strict; Path=/` e 302 a `/` (token sbagliato → 401 con pagina di testo "Link non valido: riapri l'indirizzo stampato da llmpod ui"); `/api/*` senza cookie valido → 401 `{ error: { code: 'UNAUTHORIZED', message } }`; `GET /api/session` → `{ ok: true, version }`; le altre `/api/*` vanno al router di `routes` (Attività 3; per ora 404); qualsiasi altro GET → `serveStatic` con gli header di sicurezza, 404 se non trovato. Le eccezioni `HttpError` diventano JSON `{ error: { code: 'HTTP', message } }` con il loro status; le `LlmpodError` → 400 `{ error: { code, message, hint } }` (mascherati); altre → 500 `{ error: { code: 'INTERNAL', message: 'Errore interno' } }`.

- [ ] **Passo 1: test che falliscono**

`test/server/app-security.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server/app.js';

const TOKEN = 'token-di-prova-1234567890';
let server;
let port;
let staticDir;

function req(pathname, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: host ?? `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

beforeAll(async () => {
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-web-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>llmpod</title>');
  fs.mkdirSync(path.join(staticDir, 'assets'));
  fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(path.dirname(staticDir), 'segreto.txt'), 'NON DEVE USCIRE');
  server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  server.on('request', createApp({ ctx: {}, token: TOKEN, port, staticDir, jobs: null, version: '0.1.0' }));
});
afterAll(() => server.close());

describe('sicurezza del server', () => {
  it('Host non ammesso → 403 (DNS rebinding)', async () => {
    expect((await req('/api/health', { host: 'evil.example.com' })).status).toBe(403);
    expect((await req('/api/health', { host: `localhost:${port}` })).status).toBe(200);
  });

  it('Origin estranea → 403', async () => {
    const r = await req('/api/session', { headers: { origin: 'https://evil.example.com', cookie: `llmpod_session=${TOKEN}` } });
    expect(r.status).toBe(403);
  });

  it('token: link corretto imposta il cookie, sbagliato → 401', async () => {
    const ok = await req(`/?t=${TOKEN}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/');
    expect(ok.headers['set-cookie'][0]).toMatch(/^llmpod_session=token-di-prova-1234567890; HttpOnly; SameSite=Strict; Path=\//);
    expect((await req('/?t=sbagliato')).status).toBe(401);
  });

  it('API senza cookie → 401; con cookie → 200', async () => {
    expect((await req('/api/session')).status).toBe(401);
    const r = await req('/api/session', { headers: { cookie: `llmpod_session=${TOKEN}` } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, version: '0.1.0' });
  });

  it('statici con header di sicurezza, fallback SPA e niente path traversal', async () => {
    const page = await req('/profili');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>llmpod</title>');
    expect(page.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect((await req('/assets/app.js')).headers['content-type']).toMatch(/javascript/);
    for (const p of ['/../segreto.txt', '/assets/../../segreto.txt', '/%2e%2e/segreto.txt']) {
      const r = await req(p);
      expect(r.body).not.toContain('NON DEVE USCIRE');
    }
    expect((await req('/assets/mancante.js')).status).toBe(404);
  });
});
```

- [ ] **Passo 2: verificare che falliscano** — `npx vitest run test/server/app-security.test.js` → FAIL.

- [ ] **Passo 3: `src/server/http-utils.js`**

```js
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:3000 http://localhost:3000; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

export function readJson(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reject(new HttpError(415, 'Content-Type deve essere application/json'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new HttpError(413, 'Richiesta troppo grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON non valido')); }
    });
    req.on('error', reject);
  });
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p, ''] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
  }));
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function serveStatic(req, res, rootDir) {
  if (!['GET', 'HEAD'].includes(req.method) || !rootDir) return false;
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return false; }
  const root = path.resolve(rootDir);
  let file = path.resolve(root, `.${rel}`);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  if (!path.extname(file) || (fs.existsSync(file) && fs.statSync(file).isDirectory())) file = path.join(root, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}
```

- [ ] **Passo 4: `src/server/app.js`**

```js
import { LlmpodError } from '../core/errors.js';
import { redact } from '../core/secrets.js';
import { HttpError, SECURITY_HEADERS, sendJson, parseCookies, safeEqual, serveStatic } from './http-utils.js';

export { HttpError };
const COOKIE = 'llmpod_session';

export function createApp({ ctx, token, port, staticDir, jobs, version, routes = () => null }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function handle(req, res) {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Host non consentito' } });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Origine non consentita' } });
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!safeEqual(url.searchParams.get('t'), token)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        return res.end('Link non valido: riapri l\'indirizzo stampato da llmpod ui');
      }
      res.writeHead(302, { 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/', ...SECURITY_HEADERS });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      if (!safeEqual(parseCookies(req.headers.cookie)[COOKIE], token)) {
        return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Sessione non valida: apri il link stampato da llmpod ui' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') return sendJson(res, 200, { ok: true, version });
      const handler = routes(req.method, url.pathname);
      if (!handler) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Percorso API sconosciuto' } });
      return handler({ req, res, url, ctx, jobs, params: handler.params ?? {} });
    }

    if (serveStatic(req, res, staticDir)) return undefined;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Non trovato');
  }

  return (req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: 'HTTP', message: err.message } });
      if (err instanceof LlmpodError) return sendJson(res, 400, { error: { code: err.code, message: redact(err.message), hint: err.hint ? redact(err.hint) : undefined } });
      return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Errore interno' } });
    });
  };
}
```

- [ ] **Passo 5: verificare** — `npx vitest run test/server/app-security.test.js` → PASS (5 test); `npm test` verde.

- [ ] **Passo 6: commit e push** — `git add src/server test/server && git commit -m "feat: server locale con autenticazione a token e protezioni" && git push`

---
### Attività 3: API, job via HTTP ed eventi SSE

**File:**
- Crea: `src/server/sse.js`, `src/server/routes.js`
- Modifica: `src/core/clients/env-format.js` (aggiungere `clientExports`), `src/cli/commands/env.js` (usarla)
- Test: `test/server/api.test.js`

**Interfacce:**
- Consuma: `createApp` (Attività 2), `createJobs` (Attività 1), `searchRows`, `runPlan`, `applyAdvice`, `ctx.makeOps`, `ctx.ops`, `ctx.store`, `ctx.advisor`, `updateZcode`, `zcodeDir`, `assertProfileName`, `createEvents`.
- Produce:
  - `clientExports(ep) → env` (in `env-format.js`: `{ ...claudeEnv(ep), OPENAI_BASE_URL: ep.baseUrl + '/v1', OPENAI_API_KEY: ep.apiKey, LLMPOD_MODEL: ep.servedName, LLMPOD_API_KEY: ep.apiKey }`); `llmpod env` la usa.
  - `createSse() → { handler(req, res), broadcast(type, data), close(), size() }` — risposta `text/event-stream`, `cache-control: no-store`, primo commento `: ok`, heartbeat `: ping` ogni 15 s (timer `unref`), ogni evento come `event: <type>\ndata: <json mascherato con redactObject>\n\n`.
  - `createRoutes({ ctx, jobs, sse, state }) → (method, pathname) => handler | null` (`handler.params` con i gruppi del percorso). Rotte:

  | Metodo e percorso | Corpo / query | Risposta |
  |---|---|---|
  | `GET /api/overview` | — | `{ config: { dataCenterId, cloud, volume, watchdog, vllmImage, openwebuiProfile }, profiles: [{ name, model, gpu, context, hourlyUSD, advisorApplied }], advisor: { preset, enabled }, jobs: jobs.list() }` (nessun segreto) |
  | `GET /api/status` | — | `ctx.ops.status()` |
  | `GET /api/search` | `q`, `limit`, `all` | `{ rows: searchRows(...) }` |
  | `POST /api/plan` | `{ model, context, concurrency, set, extra, advisor }` | `{ plan, advice, advisorError, advisorSkipped }` — salva `last-plan.json` e conserva la proposta in `state.lastAdvice` |
  | `POST /api/plan/apply-advice` | `{}` | `{ plan }` (400 se non c'è una proposta pendente) |
  | `POST /api/profiles` | `{ name }` | `{ profile }` (`ops.saveProfile`) |
  | `GET /api/profiles/:name` | — | `{ profile }` |
  | `POST /api/jobs` | `{ action: 'up'\|'down', profile }` | `{ job }` — job `"<action>:<profile>"` con `ctx.makeOps({ ask, events })` dove gli eventi di `ops` vengono emessi nel job |
  | `GET /api/jobs` | — | `{ jobs }` |
  | `GET /api/jobs/:id` | `since` | `{ job, events }` (404 se assente) |
  | `POST /api/jobs/:id/answer` | `{ questionId, answer }` | `{ ok: true }` o 409 se la domanda non è più attiva |
  | `GET /api/events` | — | flusso SSE; gli eventi dei job arrivano come `event: job` con `{ jobId, type, ... }` |
  | `POST /api/env` | `{ profile }` | `{ env: clientExports(ep) }` (contiene la chiave: richiesta esplicita) |
  | `POST /api/clients/zcode` | `{ profile, zcodeClosed }` | `{ file }`; 400 se `zcodeClosed !== true` |
  | `POST /api/advisor/test` | `{}` | `{ ok: true, label }` |
  | `GET /api/openwebui` | — | `{ url: 'http://127.0.0.1:3000', profile, proxy: state.proxy }` |
  | `POST /api/openwebui/profile` | `{ profile }` | `{ ok: true }` (salva `openwebuiProfile` in `config.json`) |

- [ ] **Passo 1: test che falliscono**

`test/server/api.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server/app.js';
import { createRoutes } from '../../src/server/routes.js';
import { createSse } from '../../src/server/sse.js';
import { createJobs } from '../../src/server/jobs.js';
import { createStore } from '../../src/core/config.js';
import { clearSecrets, registerSecret } from '../../src/core/secrets.js';

const TOKEN = 'token-api-di-prova-0987654321';
const KEY = 'CHIAVE-PROFILO-API-FINTA-1234';
let server; let port; let store; let fakeOps; let sse; let jobs;

function call(pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: `127.0.0.1:${port}`, cookie: `llmpod_session=${TOKEN}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null, text }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

beforeEach(async () => {
  clearSecrets();
  registerSecret(KEY);
  store = createStore({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-api-')), 'cfg'), platform: 'linux' });
  store.writeEnv({ RUNPOD_API_KEY: 'rpa_FINTA_RUNPOD_KEY_123456', LLMPOD_KEY_QWEN3_CODER: KEY });
  store.writeConfig({ dataCenterId: 'EU-RO-1', advisor: { enabled: false } });
  store.writeProfile({ name: 'qwen3-coder', servedName: 'qwen3-coder', model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' }, gpu: { id: 'G80', count: 1 }, context: 65536, estimate: { hourlyUSD: 1.79 }, advisor: null, vllm: { args: [] } });
  fakeOps = {
    status: vi.fn(async () => ({ pods: [], balance: { balance: 42 }, volume: null })),
    saveProfile: vi.fn(() => ({ name: 'nuovo' })),
    endpoint: vi.fn(async () => ({ baseUrl: 'https://p1-8000.proxy.runpod.net', apiKey: KEY, servedName: 'qwen3-coder', context: 65536, reasoning: false })),
    up: vi.fn(async () => ({ podId: 'p1' })),
    down: vi.fn(async () => ({ podId: 'p1' })),
  };
  const ctx = {
    env: { ZCODE_DIR: path.join(store.dir, 'zcode') }, store,
    ops: fakeOps,
    makeOps: ({ ask, events }) => ({
      ...fakeOps,
      up: async (name) => { events.emit('phase', { message: `avvio ${name} con ${KEY}` }); const ok = await ask('Avvio di qwen3-coder — costo 1,79 $/h. Confermi?', false); return ok ? { podId: 'p1' } : null; },
    }),
    advisor: { config: () => null, provider: () => null },
    hf: {}, http: {},
  };
  sse = createSse();
  jobs = createJobs({ onEvent: (e) => sse.broadcast('job', e) });
  const state = { lastAdvice: null, proxy: { port: 8081, listening: true } };
  server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  server.on('request', createApp({ ctx, token: TOKEN, port, staticDir: null, jobs, version: '0.1.0', routes: createRoutes({ ctx, jobs, sse, state }) }));
});
afterEach(() => { sse.close(); server.close(); });

describe('API', () => {
  it('overview e status senza segreti', async () => {
    const o = await call('/api/overview');
    expect(o.status).toBe(200);
    expect(o.json.profiles).toEqual([{ name: 'qwen3-coder', model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', gpu: { id: 'G80', count: 1 }, context: 65536, hourlyUSD: 1.79, advisorApplied: false }]);
    expect(o.text).not.toContain(KEY);
    expect(o.text).not.toContain('rpa_FINTA');
    expect((await call('/api/status')).json.balance.balance).toBe(42);
  });

  it('job up: domanda, risposta, risultato; eventi mascherati via SSE', async () => {
    const received = [];
    const es = await new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, cookie: `llmpod_session=${TOKEN}` } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => received.push(c));
        resolve(r);
      });
    });
    const start = await call('/api/jobs', { method: 'POST', body: { action: 'up', profile: 'qwen3-coder' } });
    expect(start.status).toBe(200);
    const id = start.json.job.id;
    let job;
    for (let i = 0; i < 20 && !job?.question; i++) { job = (await call(`/api/jobs/${id}`)).json.job; await new Promise((r) => setTimeout(r, 10)); }
    expect(job.question.text).toMatch(/1,79 \$\/h/);
    expect((await call(`/api/jobs/${id}/answer`, { method: 'POST', body: { questionId: 'x', answer: true } })).status).toBe(409);
    expect((await call(`/api/jobs/${id}/answer`, { method: 'POST', body: { questionId: job.question.id, answer: true } })).status).toBe(200);
    for (let i = 0; i < 20 && job.status === 'running'; i++) { job = (await call(`/api/jobs/${id}`)).json.job; await new Promise((r) => setTimeout(r, 10)); }
    expect(job).toMatchObject({ status: 'done', result: { podId: 'p1' } });
    await new Promise((r) => setTimeout(r, 20));
    es.destroy();
    const stream = received.join('');
    expect(stream).toContain('event: job');
    expect(stream).toContain('"type":"question"');
    expect(stream).not.toContain(KEY);
    expect(stream).toContain('<REDATTO>');
  });

  it('azione o profilo non validi → 400', async () => {
    expect((await call('/api/jobs', { method: 'POST', body: { action: 'rm', profile: 'qwen3-coder' } })).status).toBe(400);
    expect((await call('/api/jobs', { method: 'POST', body: { action: 'up', profile: '../x' } })).status).toBe(400);
  });

  it('env su richiesta esplicita contiene la chiave; zcode richiede la conferma', async () => {
    const env = await call('/api/env', { method: 'POST', body: { profile: 'qwen3-coder' } });
    expect(env.json.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: KEY, OPENAI_BASE_URL: 'https://p1-8000.proxy.runpod.net/v1' });
    expect((await call('/api/clients/zcode', { method: 'POST', body: { profile: 'qwen3-coder' } })).status).toBe(400);
    const z = await call('/api/clients/zcode', { method: 'POST', body: { profile: 'qwen3-coder', zcodeClosed: true } });
    expect(z.status).toBe(200);
    expect(fs.existsSync(z.json.file)).toBe(true);
  });

  it('profili, Open WebUI e rotta sconosciuta', async () => {
    expect((await call('/api/profiles/qwen3-coder')).json.profile.name).toBe('qwen3-coder');
    expect((await call('/api/profiles', { method: 'POST', body: { name: 'nuovo' } })).json.profile.name).toBe('nuovo');
    expect((await call('/api/openwebui/profile', { method: 'POST', body: { profile: 'qwen3-coder' } })).status).toBe(200);
    expect((await call('/api/openwebui')).json).toMatchObject({ url: 'http://127.0.0.1:3000', profile: 'qwen3-coder', proxy: { port: 8081 } });
    expect((await call('/api/boh')).status).toBe(404);
    expect((await call('/api/plan/apply-advice', { method: 'POST', body: {} })).status).toBe(400);
  });
});
```

- [ ] **Passo 2: verificare che falliscano** — `npx vitest run test/server/api.test.js` → FAIL.

- [ ] **Passo 3: `clientExports`** — in `src/core/clients/env-format.js` aggiungere `import { claudeEnv } from './claude-code.js';` e:

```js
export function clientExports(ep) {
  return { ...claudeEnv(ep), OPENAI_BASE_URL: `${ep.baseUrl}/v1`, OPENAI_API_KEY: ep.apiKey, LLMPOD_MODEL: ep.servedName, LLMPOD_API_KEY: ep.apiKey };
}
```

e in `src/cli/commands/env.js` sostituire la costruzione manuale dell'oggetto con `clientExports(ep)` (comportamento invariato).

- [ ] **Passo 4: `src/server/sse.js`**

```js
import { redactObject } from '../core/secrets.js';

export function createSse({ heartbeatMs = 15_000 } = {}) {
  const clients = new Set();
  const timer = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, heartbeatMs);
  timer.unref?.();
  return {
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    broadcast(type, data) {
      const payload = `event: ${type}\ndata: ${JSON.stringify(redactObject(data))}\n\n`;
      for (const res of clients) res.write(payload);
    },
    close() {
      clearInterval(timer);
      for (const res of clients) res.end();
      clients.clear();
    },
    size: () => clients.size,
  };
}
```

- [ ] **Passo 5: `src/server/routes.js`**

```js
import { LlmpodError, Codes } from '../core/errors.js';
import { assertProfileName } from '../core/config.js';
import { createEvents } from '../core/events.js';
import { searchRows } from '../core/search.js';
import { runPlan, applyAdvice } from '../core/plan-flow.js';
import { clientExports } from '../core/clients/env-format.js';
import { updateZcode, zcodeDir } from '../core/clients/zcode.js';
import { HttpError, sendJson, readJson } from './http-utils.js';

const adviceView = (a) => a && { accepted: a.accepted, rejected: a.rejected, changes: a.changes, rationale: a.rationale, warnings: a.warnings, recipePath: a.recipePath };

export function createRoutes({ ctx, jobs, sse, state }) {
  const table = [];
  const add = (method, pattern, fn) => table.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
  const json = (fn) => async (c) => sendJson(c.res, 200, await fn(c));

  add('GET', '/api/overview', json(() => {
    const cfg = ctx.store.readConfig();
    const profiles = ctx.store.listProfiles().map((name) => {
      const p = ctx.store.readProfile(name);
      return { name, model: p.model?.id ?? null, gpu: p.gpu ?? null, context: p.context ?? null, hourlyUSD: p.estimate?.hourlyUSD ?? null, advisorApplied: Boolean(p.advisor?.applied) };
    });
    let advisor = { preset: null, enabled: Boolean(cfg.advisor?.enabled) };
    try { advisor = { preset: ctx.advisor.config()?.preset ?? null, enabled: Boolean(cfg.advisor?.enabled) }; } catch { /* configurazione incompleta */ }
    return {
      config: { dataCenterId: cfg.dataCenterId ?? null, cloud: cfg.cloud, volume: cfg.volume ?? null, watchdog: cfg.watchdog, vllmImage: cfg.vllmImage, openwebuiProfile: cfg.openwebuiProfile ?? null },
      profiles, advisor, jobs: jobs.list(),
    };
  }));

  add('GET', '/api/status', json(() => ctx.ops.status()));

  add('GET', '/api/search', json(async ({ url }) => ({
    rows: await searchRows(ctx.hf, url.searchParams.get('q') ?? '', { limit: Math.min(50, Number(url.searchParams.get('limit')) || 20), all: url.searchParams.get('all') === '1' }),
  })));

  add('POST', '/api/plan', json(async ({ req }) => {
    const b = await readJson(req);
    const r = await runPlan({ ctx, modelRef: String(b.model ?? ''), context: Number(b.context) || 65536, concurrency: Number(b.concurrency) || 2, set: Array.isArray(b.set) ? b.set.map(String) : [], extra: Array.isArray(b.extra) ? b.extra.map(String) : [], advisor: typeof b.advisor === 'boolean' ? b.advisor : undefined });
    ctx.store.writeJson('last-plan.json', r.plan);
    state.lastAdvice = r.advice && r.advice.accepted.length ? r.advice : null;
    return { plan: r.plan, advice: adviceView(r.advice), advisorError: r.advisorError, advisorSkipped: r.advisorSkipped };
  }));

  add('POST', '/api/plan/apply-advice', json(async ({ req }) => {
    await readJson(req);
    const plan = ctx.store.readJson('last-plan.json', null);
    if (!plan || !state.lastAdvice) throw new HttpError(400, 'Nessuna proposta del consulente da applicare');
    applyAdvice(plan, state.lastAdvice);
    ctx.store.writeJson('last-plan.json', plan);
    state.lastAdvice = null;
    return { plan };
  }));

  add('POST', '/api/profiles', json(async ({ req }) => ({ profile: ctx.ops.saveProfile(String((await readJson(req)).name ?? '')) })));
  add('GET', '/api/profiles/:name', json(({ params }) => ({ profile: ctx.store.readProfile(params.name) })));

  add('POST', '/api/jobs', json(async ({ req }) => {
    const { action, profile } = await readJson(req);
    if (!['up', 'down'].includes(action)) throw new HttpError(400, 'Azione non valida');
    assertProfileName(profile);
    const job = jobs.start(`${action}:${profile}`, ({ ask, emit }) => {
      const events = createEvents();
      events.on((e) => emit(e));
      const ops = ctx.makeOps({ ask, events });
      return action === 'up' ? ops.up(profile, {}) : ops.down(profile, {});
    });
    return { job };
  }));
  add('GET', '/api/jobs', json(() => ({ jobs: jobs.list() })));
  add('GET', '/api/jobs/:id', json(({ params, url }) => {
    const job = jobs.get(params.id);
    if (!job) throw new HttpError(404, 'Job non trovato');
    return { job, events: jobs.events(params.id, Number(url.searchParams.get('since')) || 0) };
  }));
  add('POST', '/api/jobs/:id/answer', async ({ req, res, params }) => {
    const b = await readJson(req);
    if (!jobs.answer(params.id, String(b.questionId ?? ''), Boolean(b.answer))) return sendJson(res, 409, { error: { code: 'CONFLICT', message: 'La domanda non è più attiva' } });
    return sendJson(res, 200, { ok: true });
  });

  add('GET', '/api/events', ({ req, res }) => sse.handler(req, res));

  add('POST', '/api/env', json(async ({ req }) => {
    const { profile } = await readJson(req);
    assertProfileName(profile);
    return { env: clientExports(await ctx.ops.endpoint(profile)) };
  }));

  add('POST', '/api/clients/zcode', json(async ({ req }) => {
    const { profile, zcodeClosed } = await readJson(req);
    assertProfileName(profile);
    if (zcodeClosed !== true) throw new HttpError(400, 'Conferma che ZCode è chiuso: lo riscrive all\'uscita e le modifiche andrebbero perse');
    const file = await updateZcode(await ctx.ops.endpoint(profile), { dir: zcodeDir(ctx.env), isRunning: async () => false });
    return { file };
  }));

  add('POST', '/api/advisor/test', json(async ({ req }) => {
    await readJson(req);
    const provider = ctx.advisor.provider();
    if (!provider) throw new LlmpodError(Codes.ADVISOR_NOT_CONFIGURED, 'Nessun consulente attivo', { hint: 'Configuralo con: llmpod advisor' });
    await provider.complete({ system: 'Reply ONLY with this JSON: {"set":{},"rationale":"ok","warnings":[]}', user: 'Test di connessione di llmpod.', maxTokens: 100 });
    return { ok: true, label: provider.label };
  }));

  add('GET', '/api/openwebui', json(() => ({ url: 'http://127.0.0.1:3000', profile: ctx.store.readConfig().openwebuiProfile ?? null, proxy: state.proxy ?? null })));
  add('POST', '/api/openwebui/profile', json(async ({ req }) => {
    const { profile } = await readJson(req);
    assertProfileName(profile);
    ctx.store.writeConfig({ openwebuiProfile: profile });
    return { ok: true };
  }));

  return (method, pathname) => {
    for (const r of table) {
      const m = r.method === method && pathname.match(r.re);
      if (m) {
        const handler = (c) => r.fn({ ...c, params: m.groups ?? {} });
        handler.params = m.groups ?? {};
        return handler;
      }
    }
    return null;
  };
}
```

Nota: `assertProfileName` lancia `LlmpodError(INVALID_INPUT)` che `createApp` trasforma in 400.

- [ ] **Passo 6: verificare** — `npx vitest run test/server/api.test.js` → PASS (5 test); `npm test` verde.

- [ ] **Passo 7: commit e push** — `git add src test && git commit -m "feat: API del server con job, conferme ed eventi SSE" && git push`

---

### Attività 4: Proxy OpenAI per Open WebUI

**File:**
- Crea: `src/server/openwebui-proxy.js`
- Test: `test/server/openwebui-proxy.test.js`

**Interfacce:**
- Produce:
  - `createOpenwebuiProxy({ resolveTarget, internalKey, userAgent, fetchImpl = fetch }) → (req, res) => Promise<void>`: solo percorsi che iniziano con `/v1/` (altrimenti 404); `Authorization: Bearer <internalKey>` obbligatoria (401); `resolveTarget()` → `{ baseUrl, apiKey } | null` (null → 503 "Nessun Pod attivo: avvia un profilo con \"llmpod up\" e scegli il profilo per Open WebUI"); inoltra metodo, query, corpo (max 10 MB), `content-type`, `accept` a `${baseUrl}${pathname}${search}` con `Authorization: Bearer <apiKey>` e `User-Agent`; risponde con lo stato e il `content-type` dell'upstream e lo stesso flusso (streaming); se il client chiude, la richiesta upstream viene annullata; errori di rete → 502 "Pod non raggiungibile: …" (mascherato). Gli errori sono nel formato OpenAI `{ error: { message, type: 'llmpod_proxy' } }`.
  - `createTargetResolver({ store, getOps, ttlMs = 30_000 }) → () => Promise<{ baseUrl, apiKey } | null>`: profilo = `config.openwebuiProfile`, altrimenti l'unico profilo in `state.pods`, altrimenti `null`; usa `getOps().endpoint(profilo)` (errore `NOT_FOUND` → `null`); risultato in cache per `ttlMs`.

- [ ] **Passo 1: test che falliscono**

`test/server/openwebui-proxy.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { createOpenwebuiProxy, createTargetResolver } from '../../src/server/openwebui-proxy.js';

const INTERNAL = 'chiave-interna-openwebui-123456';
const POD_KEY = 'chiave-del-pod-abcdef-123456';
let upstream; let upstreamPort; let seen = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, ua: req.headers['user-agent'], body });
      if (req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const t = setInterval(() => {
          res.write(`data: {"n":${i}}\n\n`);
          if (++i === 3) { clearInterval(t); res.end('data: [DONE]\n\n'); }
        }, 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3-coder' }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
});
afterAll(() => upstream.close());

async function withProxy(opts, fn) {
  const server = http.createServer(createOpenwebuiProxy({ internalKey: INTERNAL, userAgent: 'llmpod/0.1.0', ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const target = () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: POD_KEY });

describe('proxy Open WebUI', () => {
  it('sostituisce la chiave e inoltra lo streaming', async () => {
    seen = [];
    await withProxy({ resolveTarget: async () => target() }, async (base) => {
      const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' }, body: '{"model":"qwen3-coder","stream":true}' });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/event-stream/);
      const text = await r.text();
      expect(text).toContain('data: {"n":2}');
      expect(text).toContain('[DONE]');
      expect(seen[0]).toMatchObject({ url: '/v1/chat/completions', auth: `Bearer ${POD_KEY}`, ua: 'llmpod/0.1.0', body: '{"model":"qwen3-coder","stream":true}' });
      const models = await fetch(`${base}/v1/models?x=1`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect((await models.json()).data[0].id).toBe('qwen3-coder');
      expect(seen[1].url).toBe('/v1/models?x=1');
    });
  });

  it('chiave interna sbagliata → 401, percorso fuori da /v1 → 404, nessun Pod → 503', async () => {
    await withProxy({ resolveTarget: async () => null }, async (base) => {
      expect((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sbagliata' } })).status).toBe(401);
      expect((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${INTERNAL}` } })).status).toBe(404);
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect(r.status).toBe(503);
      expect((await r.json()).error.message).toMatch(/Nessun Pod attivo/);
    });
  });

  it('Pod irraggiungibile → 502 e il proxy resta in piedi', async () => {
    await withProxy({ resolveTarget: async () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: POD_KEY }) }, async (base) => {
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } });
      expect(r.status).toBe(502);
      expect(JSON.stringify(await r.json())).not.toContain(POD_KEY);
      expect((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INTERNAL}` } })).status).toBe(502);
    });
  });

  it('createTargetResolver: profilo configurato o unico attivo, cache', async () => {
    const endpoint = vi.fn(async (name) => ({ baseUrl: `https://${name}-8000.proxy.runpod.net`, apiKey: POD_KEY }));
    const store = { readConfig: () => ({}), readState: () => ({ pods: { solo: { podId: 'x' } } }) };
    const resolve = createTargetResolver({ store, getOps: () => ({ endpoint }) });
    expect(await resolve()).toEqual({ baseUrl: 'https://solo-8000.proxy.runpod.net', apiKey: POD_KEY });
    await resolve();
    expect(endpoint).toHaveBeenCalledTimes(1);
    const none = createTargetResolver({ store: { readConfig: () => ({}), readState: () => ({ pods: {} }) }, getOps: () => ({ endpoint }) });
    expect(await none()).toBeNull();
    const gone = createTargetResolver({ store: { readConfig: () => ({ openwebuiProfile: 'p' }), readState: () => ({ pods: {} }) }, getOps: () => ({ endpoint: async () => { throw Object.assign(new Error('x'), { code: 'NOT_FOUND' }); } }) });
    expect(await gone()).toBeNull();
  });
});
```

- [ ] **Passo 2: verificare che falliscano** — `npx vitest run test/server/openwebui-proxy.test.js` → FAIL.

- [ ] **Passo 3: implementazione** — `src/server/openwebui-proxy.js`:

```js
import { Readable } from 'node:stream';
import { redact } from '../core/secrets.js';
import { safeEqual } from './http-utils.js';

const MAX_BODY = 10 * 1024 * 1024;

function fail(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'llmpod_proxy' } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Richiesta troppo grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createOpenwebuiProxy({ resolveTarget, internalKey, userAgent, fetchImpl = fetch }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://proxy');
      if (!url.pathname.startsWith('/v1/')) return fail(res, 404, 'Percorso non supportato dal proxy di llmpod');
      if (!safeEqual(req.headers.authorization, `Bearer ${internalKey}`)) return fail(res, 401, 'Chiave del proxy non valida');
      const target = await resolveTarget();
      if (!target) return fail(res, 503, 'Nessun Pod attivo: avvia un profilo con "llmpod up" e scegli il profilo per Open WebUI');
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const upstream = await fetchImpl(`${target.baseUrl}${url.pathname}${url.search}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${target.apiKey}`,
          'content-type': req.headers['content-type'] ?? 'application/json',
          accept: req.headers.accept ?? '*/*',
          'user-agent': userAgent,
        },
        body,
        signal: ac.signal,
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
      return undefined;
    } catch (err) {
      return fail(res, 502, `Pod non raggiungibile: ${redact(err.message)}`);
    }
  };
}

export function createTargetResolver({ store, getOps, ttlMs = 30_000 }) {
  let cache = null;
  return async () => {
    const cfg = store.readConfig();
    const active = Object.keys(store.readState().pods ?? {});
    const profile = cfg.openwebuiProfile ?? (active.length === 1 ? active[0] : null);
    if (!profile) return null;
    if (cache && cache.profile === profile && Date.now() - cache.at < ttlMs) return cache.target;
    try {
      const ep = await getOps().endpoint(profile);
      cache = { profile, at: Date.now(), target: { baseUrl: ep.baseUrl, apiKey: ep.apiKey } };
      return cache.target;
    } catch (err) {
      if (err.code === 'NOT_FOUND') return null;
      throw err;
    }
  };
}
```

- [ ] **Passo 4: verificare** — `npx vitest run test/server/openwebui-proxy.test.js` → PASS (4 test); `npm test` verde.

- [ ] **Passo 5: commit e push** — `git add src/server/openwebui-proxy.js test/server/openwebui-proxy.test.js && git commit -m "feat: proxy OpenAI per Open WebUI verso il Pod attivo" && git push`

---

### Attività 5: Comando `llmpod ui`

**File:**
- Crea: `src/server/start.js`, `src/cli/commands/ui.js`
- Modifica: `src/cli/program.js` (registrare `ui`), `package.json` (script `build:web`, già usato dall'Attività 6)
- Test: `test/server/start.test.js`

**Interfacce:**
- Produce:
  - `startUi(ctx, { host = '127.0.0.1', port = 7860, proxyHost = '127.0.0.1', proxyPort = 8081, token, staticDir, proxy = true, version }) → Promise<{ url, port, proxyPort, close() }>`: genera e salva in `.env` `LLMPOD_OPENWEBUI_KEY` se manca (32 byte base64url); avvia il server dell'interfaccia (`createApp` + `createRoutes` + `createJobs` + `createSse`, eventi dei job inoltrati all'SSE) e, se `proxy`, il proxy (`createOpenwebuiProxy` + `createTargetResolver({ store: ctx.store, getOps: () => ctx.ops })`); `state.proxy = { port, listening }`; `url = http://127.0.0.1:<port>/?t=<token>`; `port: 0` usa una porta libera (per i test).
  - `llmpod ui [--host] [--port] [--proxy-port] [--no-proxy] [--no-open]`: valori di default da `LLMPOD_UI_HOST`, `LLMPOD_UI_PORT`, `LLMPOD_PROXY_PORT`; token da `LLMPOD_UI_TOKEN` o casuale; `staticDir` = `dist/web` del pacchetto (se manca `index.html` stampa `⚠ Interfaccia non compilata: esegui "npm run build:web"`); stampa l'URL con `io.raw` (il token serve all'utente); apre il browser (`open` su macOS, `xdg-open` su Linux, `cmd /c start ""` su Windows) salvo `--no-open` o `LLMPOD_IN_DOCKER=1`; resta attivo fino a SIGINT/SIGTERM, poi chiude i server.

- [ ] **Passo 1: test che falliscono**

`test/server/start.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startUi } from '../../src/server/start.js';
import { createStore } from '../../src/core/config.js';

function ctx() {
  const store = createStore({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-ui-')), 'cfg'), platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-RO-1' });
  return { store, env: {}, ops: { endpoint: async () => { throw Object.assign(new Error('x'), { code: 'NOT_FOUND' }); } }, makeOps: () => ({}), advisor: { config: () => null, provider: () => null } };
}

describe('startUi', () => {
  it('avvia interfaccia e proxy, genera la chiave interna, autentica con il token', async () => {
    const c = ctx();
    const ui = await startUi(c, { port: 0, proxyPort: 0, token: 'token-avvio-1234567890', staticDir: null, version: '0.1.0' });
    try {
      expect(ui.url).toBe(`http://127.0.0.1:${ui.port}/?t=token-avvio-1234567890`);
      const key = c.store.readEnv().LLMPOD_OPENWEBUI_KEY;
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await fetch(`http://127.0.0.1:${ui.port}/api/health`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${ui.port}/api/session`)).status).toBe(401);
      const r = await fetch(`http://127.0.0.1:${ui.proxyPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
      expect(r.status).toBe(503);
    } finally {
      await ui.close();
    }
  });

  it('riusa la chiave interna esistente e può fare a meno del proxy', async () => {
    const c = ctx();
    c.store.writeEnv({ LLMPOD_OPENWEBUI_KEY: 'chiave-esistente-1234567890' });
    const ui = await startUi(c, { port: 0, proxy: false, token: 't'.repeat(20), staticDir: null });
    try {
      expect(c.store.readEnv().LLMPOD_OPENWEBUI_KEY).toBe('chiave-esistente-1234567890');
      expect(ui.proxyPort).toBeNull();
    } finally {
      await ui.close();
    }
  });
});
```

- [ ] **Passo 2: verificare che falliscano** — `npx vitest run test/server/start.test.js` → FAIL.

- [ ] **Passo 3: `src/server/start.js`**

```js
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { createRoutes } from './routes.js';
import { createJobs } from './jobs.js';
import { createSse } from './sse.js';
import { createOpenwebuiProxy, createTargetResolver } from './openwebui-proxy.js';

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => resolve(server.address().port));
});

export async function startUi(ctx, { host = '127.0.0.1', port = 7860, proxyHost = '127.0.0.1', proxyPort = 8081, token, staticDir, proxy = true, version = '0.0.0' }) {
  let key = ctx.store.readEnv().LLMPOD_OPENWEBUI_KEY;
  if (!key) {
    key = randomBytes(32).toString('base64url');
    ctx.store.writeEnv({ LLMPOD_OPENWEBUI_KEY: key });
  }
  const sse = createSse();
  const jobs = createJobs({ onEvent: (e) => sse.broadcast('job', e) });
  const state = { lastAdvice: null, proxy: null };

  const uiServer = http.createServer();
  const actualPort = await listen(uiServer, port, host);
  uiServer.on('request', createApp({ ctx, token, port: actualPort, staticDir, jobs, version, routes: createRoutes({ ctx, jobs, sse, state }) }));

  let proxyServer = null;
  let actualProxyPort = null;
  if (proxy) {
    proxyServer = http.createServer(createOpenwebuiProxy({
      resolveTarget: createTargetResolver({ store: ctx.store, getOps: () => ctx.ops }),
      internalKey: key,
      userAgent: `llmpod/${version}`,
    }));
    actualProxyPort = await listen(proxyServer, proxyPort, proxyHost);
    state.proxy = { port: actualProxyPort, listening: true };
  }

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    proxyPort: actualProxyPort,
    close: async () => {
      sse.close();
      await new Promise((r) => uiServer.close(r));
      if (proxyServer) await new Promise((r) => proxyServer.close(r));
    },
  };
}
```

- [ ] **Passo 4: `src/cli/commands/ui.js`**

```js
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { startUi } from '../../server/start.js';
import { VERSION } from '../context.js';

const STATIC_DIR = new URL('../../../dist/web', import.meta.url).pathname;

function openBrowser(url, platform) {
  const [cmd, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* nessun browser disponibile */ }
}

export function register(program, getCtx) {
  program.command('ui')
    .description('Avvia l\'interfaccia web locale e il proxy per Open WebUI')
    .option('--host <host>', 'indirizzo di ascolto', process.env.LLMPOD_UI_HOST ?? '127.0.0.1')
    .option('--port <porta>', 'porta dell\'interfaccia', (v) => Number.parseInt(v, 10), Number(process.env.LLMPOD_UI_PORT) || 7860)
    .option('--proxy-port <porta>', 'porta del proxy per Open WebUI', (v) => Number.parseInt(v, 10), Number(process.env.LLMPOD_PROXY_PORT) || 8081)
    .option('--no-proxy', 'non avviare il proxy per Open WebUI')
    .option('--no-open', 'non aprire il browser')
    .action(async (opts) => {
      const ctx = getCtx();
      const staticDir = fs.existsSync(`${STATIC_DIR}/index.html`) ? STATIC_DIR : null;
      if (!staticDir) ctx.io.err('⚠ Interfaccia non compilata: esegui "npm run build:web" (le API funzionano comunque)');
      const token = process.env.LLMPOD_UI_TOKEN || randomBytes(24).toString('base64url');
      const ui = await startUi(ctx, {
        host: opts.host, port: opts.port, proxyHost: opts.host, proxyPort: opts.proxyPort,
        proxy: opts.proxy, token, staticDir, version: VERSION,
      });
      ctx.io.raw(`Interfaccia llmpod: ${ui.url}`);
      if (ui.proxyPort) ctx.io.out(`Proxy per Open WebUI su ${opts.host}:${ui.proxyPort}`);
      if (opts.open && process.env.LLMPOD_IN_DOCKER !== '1') openBrowser(ui.url, ctx.platform);
      await new Promise((resolve) => {
        const stop = () => { ui.close().then(resolve); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
}
```

In `src/cli/program.js` aggiungere `import * as ui from './commands/ui.js';` e `ui` in fondo a `COMMANDS`.

- [ ] **Passo 5: verificare** — `npx vitest run test/server/start.test.js` → PASS (2 test); `npm test` verde; prova manuale con cartella temporanea: `LLMPOD_CONFIG_DIR=$(mktemp -d) node src/cli/index.js ui --no-open --port 7999 --proxy-port 8099` stampa l'URL; `curl -s http://127.0.0.1:7999/api/health` → `{"ok":true}`; poi Ctrl+C.

- [ ] **Passo 6: commit e push** — `git add src test && git commit -m "feat: comando llmpod ui" && git push`

---
### Attività 6: Impalcatura dell'interfaccia web (Vite, React, Tailwind, PWA)

**File:**
- Crea: `web/index.html`, `web/vite.config.js`, `web/src/main.jsx`, `web/src/index.css`, `web/src/App.jsx`, `web/src/lib/api.js`, `web/src/lib/events.jsx`, `web/src/components/ui.jsx`, `web/src/components/QuestionModal.jsx`, `web/src/components/JobPanel.jsx`, `web/public/manifest.webmanifest`, `web/public/icon.svg`, `web/public/sw.js`, pagine segnaposto `web/src/pages/{Models,Profiles,Status,Clients,QuickTest}.jsx`
- Modifica: `package.json` (dipendenze di sviluppo, script `build:web`, `files`), `vitest.config.js` (plugin React, test `.jsx`), `.gitignore` (già esclude `dist/`)
- Test: `test/web/api.test.jsx`, `test/web/components.test.jsx`

**Interfacce:**
- Produce (usate dalle Attività 7-9):
  - `web/src/lib/api.js`: `api(path, { method = 'GET', body }) → Promise<data>` (fetch `same-origin`, JSON; non 2xx → `ApiError { status, code, hint, message }`), `ApiError`, `fmtUSD(n)` → `"1,79 $"`, `fmtGiB(n)` → `"56,9 GiB"`, `fmtDuration(s)` → `"1 h 5 min"`/`"3 min 20 s"`.
  - `web/src/lib/events.jsx`: `<EventsProvider>` (un solo `EventSource('/api/events')`, si riconnette da solo) e `useJobEvents(jobId, onEvent)` (chiama `onEvent` per gli eventi `job` di quel `jobId`).
  - `web/src/components/ui.jsx`: `Card({ title, children, className })`, `Button({ variant = 'primary'|'ghost'|'danger', loading, ...props })`, `Field({ label, children })`, `Badge({ tone = 'cyan'|'violet'|'amber'|'red'|'green', children })`, `Spinner()`, `ErrorBox({ error })` (mostra `message` e `hint`), `CodeBlock({ text, copy = true })` (bottone "Copia" con `navigator.clipboard`).
  - `QuestionModal({ question, onAnswer })`: overlay con il testo della domanda e i pulsanti "Sì"/"No" (il predefinito evidenziato); `onAnswer(boolean)`.
  - `JobPanel({ jobId, onFinished })`: carica `GET /api/jobs/:id`, ascolta gli eventi, mostra fasi (`phase`), avanzamento (`progress`), avvisi, log comprimibili (`log`, ultimi 200), la domanda attiva con `QuestionModal` (risposta via `POST /api/jobs/:id/answer`), l'esito (`done` → `onFinished(result)`, `failed` → `ErrorBox`).
  - `App`: verifica `GET /api/session`; se 401 mostra la schermata "Apri il link stampato da `llmpod ui`"; altrimenti intestazione con logo a gradiente e schede animate: Modelli, Profili, Stato, Client, Prova veloce.
  - PWA: `manifest.webmanifest` (nome "llmpod", `display: standalone`, colori scuri, icona SVG), `sw.js` che memorizza solo la shell statica e non intercetta mai `/api/*`, registrato in `main.jsx` solo in produzione.

- [ ] **Passo 1: dipendenze e configurazione**

```bash
npm install -D vite@6 @vitejs/plugin-react@4 react@19 react-dom@19 tailwindcss@4 @tailwindcss/vite@4 @testing-library/react@16 @testing-library/dom@10 jsdom@25
```

In `package.json`: aggiungere allo `scripts` `"build:web": "vite build --config web/vite.config.js"` e a `files` la voce `"dist"`.

`vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { include: ['test/**/*.test.js', 'test/**/*.test.jsx'], environment: 'node' },
});
```

`web/vite.config.js`:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  build: { outDir: new URL('../dist/web', import.meta.url).pathname, emptyOutDir: true },
});
```

`web/index.html`:

```html
<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#07070d" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <title>llmpod</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Passo 2: stile, PWA e punto d'ingresso**

`web/src/index.css`:

```css
@import "tailwindcss";

:root { color-scheme: dark; }
body {
  margin: 0;
  min-height: 100vh;
  color: #e5e7eb;
  background:
    radial-gradient(1200px 600px at 10% -10%, rgba(139, 92, 246, 0.25), transparent),
    radial-gradient(900px 500px at 110% 10%, rgba(34, 211, 238, 0.18), transparent),
    #07070d;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.glass {
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 1rem;
}
.neon-text {
  background: linear-gradient(90deg, #22d3ee, #8b5cf6, #e879f9);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.neon-border { box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.35), 0 0 24px rgba(139, 92, 246, 0.25); }
@keyframes fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.fade-up { animation: fade-up 0.35s ease-out both; }
@keyframes glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(34, 211, 238, 0.35); } 50% { box-shadow: 0 0 24px 4px rgba(34, 211, 238, 0.25); } }
.glow { animation: glow 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .fade-up, .glow { animation: none; } }
```

`web/public/manifest.webmanifest`:

```json
{
  "name": "llmpod",
  "short_name": "llmpod",
  "description": "LLM self-hosted su Runpod per i coding agent",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#07070d",
  "theme_color": "#07070d",
  "icons": [{ "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }]
}
```

`web/public/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#8b5cf6"/><stop offset="1" stop-color="#e879f9"/></linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="#07070d"/>
  <rect x="10" y="10" width="44" height="44" rx="10" fill="none" stroke="url(#g)" stroke-width="4"/>
  <path d="M22 40V24l10 8 10-8v16" fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

`web/public/sw.js`:

```js
const CACHE = 'llmpod-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
```

`web/src/main.jsx`:

```jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

- [ ] **Passo 3: test che falliscono**

`test/web/api.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, fmtUSD, fmtGiB, fmtDuration } from '../../web/src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

describe('api', () => {
  it('JSON, stessa origine e corpo', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await api('/api/plan', { method: 'POST', body: { model: 'x' } })).toEqual({ ok: 1 });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/plan');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{"model":"x"}' });
  });

  it('errori → ApiError con codice e suggerimento', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'GATED_MODEL', message: 'Accesso negato', hint: 'Richiedi l\'accesso' } }), { status: 400 }));
    const err = await api('/api/plan').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'GATED_MODEL', message: 'Accesso negato', hint: 'Richiedi l\'accesso' });
  });

  it('formattazione', () => {
    expect(fmtUSD(1.789)).toBe('1,79 $');
    expect(fmtUSD(null)).toBe('—');
    expect(fmtGiB(56.87)).toBe('56,9 GiB');
    expect(fmtDuration(3900)).toBe('1 h 5 min');
    expect(fmtDuration(200)).toBe('3 min 20 s');
  });
});
```

`test/web/components.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuestionModal } from '../../web/src/components/QuestionModal.jsx';
import { ErrorBox, Button } from '../../web/src/components/ui.jsx';

afterEach(cleanup);

describe('componenti', () => {
  it('QuestionModal mostra la domanda e risponde', () => {
    const onAnswer = vi.fn();
    render(<QuestionModal question={{ id: 'q1', text: 'Avvio a 1,79 $/h. Confermi?', defYes: false }} onAnswer={onAnswer} />);
    expect(screen.getByText('Avvio a 1,79 $/h. Confermi?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' }).className).toMatch(/ring/);
    fireEvent.click(screen.getByRole('button', { name: 'Sì' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it('ErrorBox mostra messaggio e suggerimento', () => {
    render(<ErrorBox error={{ message: 'Nessuna GPU', hint: 'Riprova più tardi' }} />);
    expect(screen.getByText('Nessuna GPU')).toBeTruthy();
    expect(screen.getByText('Riprova più tardi')).toBeTruthy();
  });

  it('Button in caricamento è disabilitato', () => {
    render(<Button loading>Avvia</Button>);
    expect(screen.getByRole('button').disabled).toBe(true);
  });
});
```

- [ ] **Passo 4: verificare che falliscano** — `npx vitest run test/web` → FAIL (moduli mancanti).

- [ ] **Passo 5: libreria e componenti**

`web/src/lib/api.js`:

```js
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Errore HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.hint = body?.error?.hint;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: { message: text } }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const fmtUSD = (n) => (n == null ? '—' : `${Number(n).toFixed(2).replace('.', ',')} $`);
export const fmtGiB = (n) => (n == null ? '—' : `${Number(n).toFixed(1).replace('.', ',')} GiB`);
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`;
}
```

`web/src/lib/events.jsx`:

```jsx
import { createContext, useContext, useEffect, useRef } from 'react';

const Ctx = createContext(null);

export function EventsProvider({ children }) {
  const listeners = useRef(new Set());
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('job', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      for (const fn of listeners.current) fn(data);
    });
    return () => es.close();
  }, []);
  return <Ctx.Provider value={listeners}>{children}</Ctx.Provider>;
}

export function useJobEvents(jobId, onEvent) {
  const listeners = useContext(Ctx);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!listeners || !jobId) return undefined;
    const fn = (e) => { if (e.jobId === jobId) cb.current(e); };
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, [listeners, jobId]);
}
```

`web/src/components/ui.jsx`:

```jsx
import { useState } from 'react';

export function Card({ title, children, className = '' }) {
  return (
    <section className={`glass fade-up p-5 ${className}`}>
      {title && <h2 className="mb-4 text-lg font-semibold neon-text">{title}</h2>}
      {children}
    </section>
  );
}

const VARIANTS = {
  primary: 'bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 text-black hover:brightness-110',
  ghost: 'border border-white/15 text-gray-200 hover:bg-white/5',
  danger: 'bg-rose-500/90 text-white hover:bg-rose-500',
};

export function Button({ variant = 'primary', loading = false, className = '', children, disabled, ...props }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all duration-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-gray-400">{label}</span>
      {children}
    </label>
  );
}

export const inputClass = 'rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-gray-100 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20';

const TONES = { cyan: 'bg-cyan-400/15 text-cyan-300', violet: 'bg-violet-400/15 text-violet-300', amber: 'bg-amber-400/15 text-amber-300', red: 'bg-rose-400/15 text-rose-300', green: 'bg-emerald-400/15 text-emerald-300' };
export function Badge({ tone = 'cyan', children }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="fade-up rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm">
      <p className="font-medium text-rose-300">{error.message}</p>
      {error.hint && <p className="mt-1 text-rose-200/80">{error.hint}</p>}
    </div>
  );
}

export function CodeBlock({ text, copy = true }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/50 p-3 text-xs text-cyan-100">{text}</pre>
      {copy && (
        <button
          type="button"
          className="absolute right-2 top-2 rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
        >
          {copied ? 'Copiato' : 'Copia'}
        </button>
      )}
    </div>
  );
}
```

`web/src/components/QuestionModal.jsx`:

```jsx
export function QuestionModal({ question, onAnswer }) {
  if (!question) return null;
  const highlight = (yes) => (question.defYes === yes ? 'ring-2 ring-cyan-300' : '');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="glass neon-border fade-up w-full max-w-md p-6">
        <p className="mb-6 text-base text-gray-100">{question.text}</p>
        <div className="flex justify-end gap-3">
          <button type="button" className={`rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5 ${highlight(false)}`} onClick={() => onAnswer(false)}>No</button>
          <button type="button" className={`rounded-xl bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-black ${highlight(true)}`} onClick={() => onAnswer(true)}>Sì</button>
        </div>
      </div>
    </div>
  );
}
```

`web/src/components/JobPanel.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useJobEvents } from '../lib/events.jsx';
import { QuestionModal } from './QuestionModal.jsx';
import { ErrorBox, Spinner, Badge } from './ui.jsx';

export function JobPanel({ jobId, onFinished }) {
  const [job, setJob] = useState(null);
  const [phases, setPhases] = useState([]);
  const [progress, setProgress] = useState(null);
  const [logs, setLogs] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [showLogs, setShowLogs] = useState(false);

  function apply(e) {
    if (e.type === 'phase') setPhases((p) => [...p, e.message]);
    else if (e.type === 'progress') setProgress(e.message);
    else if (e.type === 'log') setLogs((l) => [...l.slice(-199), e.line]);
    else if (e.type === 'warning') setWarnings((w) => [...w, e.message]);
    else if (e.type === 'question') setJob((j) => ({ ...j, question: { id: e.questionId, text: e.text, defYes: e.defYes } }));
    else if (e.type === 'answer') setJob((j) => ({ ...j, question: null }));
    else if (e.type === 'done') { setJob((j) => ({ ...j, status: 'done', result: e.result })); onFinished?.(e.result); }
    else if (e.type === 'failed') setJob((j) => ({ ...j, status: 'failed', error: e.error }));
  }

  useEffect(() => {
    let alive = true;
    api(`/api/jobs/${jobId}`).then(({ job: j, events }) => {
      if (!alive) return;
      setJob(j);
      events.forEach(apply);
    }).catch(() => {});
    return () => { alive = false; };
  }, [jobId]);

  useJobEvents(jobId, apply);

  async function answer(value) {
    const q = job?.question;
    if (!q) return;
    setJob((j) => ({ ...j, question: null }));
    await api(`/api/jobs/${jobId}/answer`, { method: 'POST', body: { questionId: q.id, answer: value } }).catch(() => {});
  }

  if (!job) return <Spinner />;
  return (
    <div className="fade-up space-y-3">
      <div className="flex items-center gap-2 text-sm">
        {job.status === 'running' && <><Spinner /><Badge tone="cyan">in corso</Badge></>}
        {job.status === 'done' && <Badge tone="green">completato</Badge>}
        {job.status === 'failed' && <Badge tone="red">non riuscito</Badge>}
        {progress && job.status === 'running' && <span className="text-gray-400">{progress}</span>}
      </div>
      <ol className="space-y-1 text-sm text-gray-300">
        {phases.map((p, i) => <li key={i} className="fade-up">▸ {p}</li>)}
      </ol>
      {warnings.map((w, i) => <p key={i} className="text-sm text-amber-300">⚠ {w}</p>)}
      {job.status === 'failed' && <ErrorBox error={job.error} />}
      {logs.length > 0 && (
        <div>
          <button type="button" className="text-xs text-cyan-300 hover:underline" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? 'Nascondi i log di vLLM' : `Mostra i log di vLLM (${logs.length})`}
          </button>
          {showLogs && <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-black/50 p-3 text-xs text-gray-300">{logs.join('\n')}</pre>}
        </div>
      )}
      <QuestionModal question={job.question} onAnswer={answer} />
    </div>
  );
}
```

`web/src/App.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { EventsProvider } from './lib/events.jsx';
import { Spinner } from './components/ui.jsx';
import Models from './pages/Models.jsx';
import Profiles from './pages/Profiles.jsx';
import Status from './pages/Status.jsx';
import Clients from './pages/Clients.jsx';
import QuickTest from './pages/QuickTest.jsx';

const TABS = [
  { id: 'models', label: 'Modelli', Page: Models },
  { id: 'profiles', label: 'Profili', Page: Profiles },
  { id: 'status', label: 'Stato e costi', Page: Status },
  { id: 'clients', label: 'Client', Page: Clients },
  { id: 'quick', label: 'Prova veloce', Page: QuickTest },
];

export default function App() {
  const [session, setSession] = useState('loading');
  const [tab, setTab] = useState(() => localStorage.getItem('llmpod.tab') ?? 'models');

  useEffect(() => {
    api('/api/session').then((s) => setSession(s)).catch(() => setSession(null));
  }, []);
  useEffect(() => { try { localStorage.setItem('llmpod.tab', tab); } catch { /* storage non disponibile */ } }, [tab]);

  if (session === 'loading') return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="glass fade-up max-w-md p-8 text-center">
          <h1 className="mb-3 text-2xl font-bold neon-text">llmpod</h1>
          <p className="text-gray-300">Sessione non valida. Apri il link stampato nel terminale da <code className="text-cyan-300">llmpod ui</code>.</p>
        </div>
      </div>
    );
  }
  const { Page } = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <EventsProvider>
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src="/icon.svg" alt="" className="glow h-10 w-10 rounded-xl" />
            <div>
              <h1 className="text-2xl font-bold neon-text">llmpod</h1>
              <p className="text-xs text-gray-400">LLM self-hosted su Runpod · v{session.version}</p>
            </div>
          </div>
          <nav className="glass flex flex-wrap gap-1 p-1">
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-sm transition-all duration-200 ${tab === t.id ? 'bg-gradient-to-r from-cyan-400/30 to-fuchsia-500/30 text-white neon-border' : 'text-gray-400 hover:text-white'}`}>
                {t.label}
              </button>
            ))}
          </nav>
        </header>
        <main key={tab} className="fade-up"><Page /></main>
      </div>
    </EventsProvider>
  );
}
```

Pagine segnaposto (sostituite nelle Attività 7-9), ad esempio `web/src/pages/Models.jsx`:

```jsx
import { Card } from '../components/ui.jsx';
export default function Models() { return <Card title="Modelli">In arrivo</Card>; }
```

(identiche per `Profiles.jsx` "Profili", `Status.jsx` "Stato e costi", `Clients.jsx` "Client", `QuickTest.jsx` "Prova veloce").

- [ ] **Passo 6: verificare** — `npx vitest run test/web` → PASS (6 test); `npm run build:web` crea `dist/web/index.html`; `npm test` verde. Prova manuale: `LLMPOD_CONFIG_DIR=$(mktemp -d) node src/cli/index.js ui --no-open --port 7999 --proxy-port 8099`, aprire l'URL stampato in un browser: si vede l'intestazione con le cinque schede.

- [ ] **Passo 7: commit e push** — `git add package.json package-lock.json vitest.config.js web test/web && git commit -m "feat: impalcatura dell'interfaccia web (React, Vite, Tailwind, PWA)" && git push`

---
### Attività 7: Pagina Modelli (ricerca, piano, consulente, salvataggio)

**File:**
- Modifica: `web/src/pages/Models.jsx`
- Crea: `web/src/components/PlanView.jsx`
- Test: `test/web/models.test.jsx`

**Interfacce:**
- Consuma: `api`, `fmtUSD`, `fmtGiB`, componenti `ui.jsx`; API `GET /api/search`, `POST /api/plan`, `POST /api/plan/apply-advice`, `POST /api/profiles`.
- Produce:
  - `Models`: campo di ricerca (invio o pulsante "Cerca") → tabella risultati (modello, parametri, pesi, licenza, gated, parser con badge ambra "nessuno"), clic su una riga → compila il modello nel modulo del piano; modulo del piano con campo "Modello (org/nome, org/nome@rev o URL)", contesto (select 16384/32768/65536/131072), richieste parallele (1–8), casella "Usa il consulente" (selezionata di default), pulsante "Calcola il piano" → `PlanView`; errori con `ErrorBox`.
  - `PlanView({ data, onPlanChange })` dove `data = { plan, advice, advisorError, advisorSkipped }`: riepilogo memoria (pesi, KV, per GPU, contesto × richieste), parser, tabella candidati GPU (GPU, N, VRAM, per GPU, margine, costo, disponibilità nel datacenter con badge), GPU scelta e costo, comando `vllm serve` in `CodeBlock`, avvisi; se `advice`: motivazione, differenze (`+`, `-`, `~`), scartati con motivo, pulsante "Applica la proposta" (`POST /api/plan/apply-advice` → `onPlanChange(plan)`) disabilitato se non ci sono modifiche accettate; avvisi `advisorError`/`advisorSkipped`; modulo "Salva come profilo" (nome con pattern `^[a-z0-9][a-z0-9-]{0,40}$`) → `POST /api/profiles` → messaggio "Profilo salvato: avvialo dalla scheda Profili".

- [ ] **Passo 1: test che fallisce**

`test/web/models.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Models from '../../web/src/pages/Models.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'b2cff646eb4bb1d6', requestedRevision: 'main', license: 'apache-2.0', gated: false },
  context: 65536, concurrency: 2, kvCacheDtype: null, parsers: { tool: 'qwen3_coder', reasoning: null },
  estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 }, gpu: { id: 'NVIDIA A100 80GB PCIe', count: 1 }, hourlyUSD: 1.79,
  candidates: [{ gpuId: 'NVIDIA A100 80GB PCIe', name: 'A100 80GB', count: 1, memoryGiB: 80, perGpuGiB: 70.9, headroomGiB: 1.1, hourly: 1.79, availabilityHere: 'HIGH' }],
  alternatives: [], dataCenterId: 'EU-RO-1', vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536'] }, warnings: ['Modello con licenza da verificare'],
};
const advice = { accepted: ['enable-prefix-caching=true'], rejected: [{ key: 'api-key', reason: 'flag vietato' }], changes: { added: ['--enable-prefix-caching'], removed: [], changed: [] }, rationale: 'Suggerito dalla recipe', warnings: [], recipePath: 'Qwen/Qwen3-Coder-480B-A35B.md' };

function mockApi(routes) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, init = {}) => {
    const key = `${init.method ?? 'GET'} ${String(path).split('?')[0]}`;
    const body = routes[key];
    if (!body) return new Response(JSON.stringify({ error: { message: `non previsto ${key}` } }), { status: 404 });
    return new Response(JSON.stringify(typeof body === 'function' ? body(init) : body), { status: 200 });
  });
}

describe('pagina Modelli', () => {
  it('ricerca, scelta del modello, piano con proposta, applica e salva', async () => {
    const fetchMock = mockApi({
      'GET /api/search': { rows: [{ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', params: 30.5e9, weightsGiB: 56.9, license: 'apache-2.0', gated: false, parser: 'qwen3_coder' }, { id: 'x/Strano', params: 7e9, weightsGiB: null, license: null, gated: 'manual', parser: null }] },
      'POST /api/plan': { plan, advice, advisorError: null, advisorSkipped: null },
      'POST /api/plan/apply-advice': { plan: { ...plan, vllm: { ...plan.vllm, args: ['--max-model-len', '65536', '--enable-prefix-caching'] } } },
      'POST /api/profiles': { profile: { name: 'qwen3-coder' } },
    });
    render(<Models />);
    fireEvent.change(screen.getByPlaceholderText(/cerca/i), { target: { value: 'qwen3 coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }));
    await screen.findByText('x/Strano');
    expect(screen.getByText('nessuno')).toBeTruthy();
    fireEvent.click(screen.getByText('Qwen/Qwen3-Coder-30B-A3B-Instruct'));
    expect(screen.getByLabelText(/Modello/).value).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');
    fireEvent.click(screen.getByRole('button', { name: 'Calcola il piano' }));
    await screen.findByText('Suggerito dalla recipe');
    expect(screen.getByText(/1,79 \$\/h/)).toBeTruthy();
    expect(screen.getByText(/\+ --enable-prefix-caching/)).toBeTruthy();
    expect(screen.getByText(/api-key: flag vietato/)).toBeTruthy();
    const planCall = fetchMock.mock.calls.find(([p, i]) => p === '/api/plan' && i?.method === 'POST');
    expect(JSON.parse(planCall[1].body)).toMatchObject({ model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', context: 65536, concurrency: 2, advisor: true });
    fireEvent.click(screen.getByRole('button', { name: 'Applica la proposta' }));
    await waitFor(() => expect(screen.getByText(/--enable-prefix-caching$/m)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'qwen3-coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/Profilo salvato/);
  });

  it('errore del piano mostrato con il suggerimento', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'GATED_MODEL', message: 'Accesso negato a meta-llama/X', hint: 'Richiedi l\'accesso' } }), { status: 400 }));
    render(<Models />);
    fireEvent.change(screen.getByLabelText(/Modello/), { target: { value: 'meta-llama/X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calcola il piano' }));
    await screen.findByText('Accesso negato a meta-llama/X');
    expect(screen.getByText('Richiedi l\'accesso')).toBeTruthy();
  });
});
```

- [ ] **Passo 2: verificare che fallisca** — `npx vitest run test/web/models.test.jsx` → FAIL.

- [ ] **Passo 3: `web/src/components/PlanView.jsx`**

```jsx
import { useState } from 'react';
import { api, fmtUSD, fmtGiB } from '../lib/api.js';
import { Card, Button, Field, Badge, ErrorBox, CodeBlock, inputClass } from './ui.jsx';

const AVAIL = { HIGH: 'green', MEDIUM: 'cyan', LOW: 'amber', NONE: 'red' };

export function PlanView({ data, onPlanChange }) {
  const { plan, advice, advisorError, advisorSkipped } = data;
  const [applied, setApplied] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function applyAdvice() {
    setBusy(true); setError(null);
    try { const r = await api('/api/plan/apply-advice', { method: 'POST', body: {} }); setApplied(true); onPlanChange(r.plan); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(null);
    try { const r = await api('/api/profiles', { method: 'POST', body: { name } }); setSaved(r.profile.name); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const m = plan.model;
  return (
    <div className="space-y-4">
      <Card title="Piano">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <p><span className="text-gray-400">Modello:</span> {m.id} <span className="text-gray-500">@ {m.revision.slice(0, 12)}</span></p>
          <p><span className="text-gray-400">Licenza:</span> {m.license ?? '?'} {m.gated ? <Badge tone="amber">gated</Badge> : null}</p>
          <p><span className="text-gray-400">Memoria:</span> pesi {fmtGiB(plan.estimate.weightsGiB)} · KV {fmtGiB(plan.estimate.kvGiB)} · per GPU {fmtGiB(plan.estimate.perGpuGiB)}</p>
          <p><span className="text-gray-400">Contesto:</span> {plan.context} token × {plan.concurrency} {plan.kvCacheDtype ? <Badge tone="violet">KV FP8</Badge> : null}</p>
          <p><span className="text-gray-400">Parser:</span> strumenti {plan.parsers.tool ?? 'nessuno'} · ragionamento {plan.parsers.reasoning ?? 'nessuno'}</p>
          <p><span className="text-gray-400">Scelta:</span> {plan.gpu ? <>{plan.gpu.id} ×{plan.gpu.count} a <strong className="neon-text">{fmtUSD(plan.hourlyUSD)}/h</strong></> : <Badge tone="red">nessuna GPU nel datacenter</Badge>}</p>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-gray-400"><tr><th className="py-1">GPU</th><th>N</th><th>VRAM</th><th>Per GPU</th><th>Margine</th><th>Costo</th><th>In {plan.dataCenterId}</th></tr></thead>
            <tbody>
              {plan.candidates.map((c) => (
                <tr key={`${c.gpuId}-${c.count}`} className="border-t border-white/5">
                  <td className="py-1">{c.name}</td><td>{c.count}</td><td>{c.memoryGiB} GB</td><td>{fmtGiB(c.perGpuGiB)}</td><td>{fmtGiB(c.headroomGiB)}</td><td>{fmtUSD(c.hourly)}/h</td>
                  <td><Badge tone={AVAIL[c.availabilityHere] ?? 'red'}>{c.availabilityHere}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4"><CodeBlock text={`vllm serve ${m.id} --served-model-name <profilo> ${plan.vllm.args.join(' ')}`} /></div>
        {plan.warnings.map((w) => <p key={w} className="mt-2 text-sm text-amber-300">⚠ {w}</p>)}
      </Card>

      {(advice || advisorError || advisorSkipped) && (
        <Card title="Consulente">
          {advisorError && <p className="text-sm text-amber-300">⚠ Consulente non disponibile: {advisorError}</p>}
          {advisorSkipped && <p className="text-sm text-gray-400">ℹ {advisorSkipped}</p>}
          {advice && (
            <div className="space-y-2 text-sm">
              {advice.rationale && <p className="text-gray-200">{advice.rationale}</p>}
              {advice.recipePath && <p className="text-xs text-gray-500">Recipe: {advice.recipePath}</p>}
              <ul className="font-mono text-xs">
                {advice.changes.added.map((a) => <li key={a} className="text-emerald-300">+ {a}</li>)}
                {advice.changes.removed.map((r) => <li key={r} className="text-rose-300">- {r}</li>)}
                {advice.changes.changed.map((c) => <li key={c.flag} className="text-cyan-300">~ {c.flag}: {c.from ?? '(senza valore)'} → {c.to ?? '(senza valore)'}</li>)}
              </ul>
              {advice.rejected.map((r) => <p key={r.key} className="text-xs text-gray-500">✗ scartato {r.key}: {r.reason}</p>)}
              {advice.warnings.map((w) => <p key={w} className="text-amber-300">⚠ {w}</p>)}
              <Button onClick={applyAdvice} loading={busy} disabled={applied || advice.accepted.length === 0}>{applied ? 'Proposta applicata' : 'Applica la proposta'}</Button>
            </div>
          )}
        </Card>
      )}

      <Card title="Salva come profilo">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Nome del profilo">
            <input aria-label="Nome del profilo" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} pattern="^[a-z0-9][a-z0-9-]{0,40}$" placeholder="qwen3-coder" />
          </Field>
          <Button onClick={save} loading={busy} disabled={!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)}>Salva come profilo</Button>
        </div>
        {saved && <p className="mt-3 text-sm text-emerald-300">Profilo salvato: avvialo dalla scheda Profili ({saved}).</p>}
      </Card>
      <ErrorBox error={error} />
    </div>
  );
}
```

- [ ] **Passo 4: `web/src/pages/Models.jsx`**

```jsx
import { useState } from 'react';
import { api, fmtGiB } from '../lib/api.js';
import { Card, Button, Field, Badge, ErrorBox, inputClass } from '../components/ui.jsx';
import { PlanView } from '../components/PlanView.jsx';

export default function Models() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(null);
  const [model, setModel] = useState('');
  const [context, setContext] = useState(65536);
  const [concurrency, setConcurrency] = useState(2);
  const [useAdvisor, setUseAdvisor] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function search() {
    setBusy('search'); setError(null);
    try { setRows((await api(`/api/search?q=${encodeURIComponent(query)}&limit=20`)).rows); } catch (e) { setError(e); } finally { setBusy(null); }
  }
  async function plan() {
    setBusy('plan'); setError(null); setResult(null);
    try { setResult(await api('/api/plan', { method: 'POST', body: { model, context: Number(context), concurrency: Number(concurrency), advisor: useAdvisor } })); } catch (e) { setError(e); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <Card title="Cerca su Hugging Face">
        <form className="flex gap-3" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <input className={`${inputClass} flex-1`} placeholder="Cerca un modello (es. qwen3 coder)" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" loading={busy === 'search'}>Cerca</Button>
        </form>
        {rows && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-gray-400"><tr><th className="py-1">Modello</th><th>Parametri</th><th>Pesi</th><th>Licenza</th><th>Gated</th><th>Parser</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer border-t border-white/5 transition hover:bg-white/5" onClick={() => setModel(r.id)}>
                    <td className="py-1 text-cyan-200">{r.id}</td>
                    <td>{r.params ? `${(r.params / 1e9).toFixed(1)} B` : '?'}</td>
                    <td>{fmtGiB(r.weightsGiB)}</td>
                    <td>{r.license ?? '?'}</td>
                    <td>{r.gated ? <Badge tone="amber">sì</Badge> : 'no'}</td>
                    <td>{r.parser ?? <Badge tone="amber">nessuno</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Piano">
        <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); plan(); }}>
          <div className="sm:col-span-2">
            <Field label="Modello (org/nome, org/nome@rev o URL)">
              <input aria-label="Modello" className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Qwen/Qwen3-Coder-30B-A3B-Instruct" />
            </Field>
          </div>
          <Field label="Contesto">
            <select className={inputClass} value={context} onChange={(e) => setContext(e.target.value)}>
              {[16384, 32768, 65536, 131072].map((c) => <option key={c} value={c}>{c.toLocaleString('it-IT')} token</option>)}
            </select>
          </Field>
          <Field label="Richieste parallele">
            <input type="number" min="1" max="8" className={inputClass} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-gray-300 sm:col-span-3">
            <input type="checkbox" checked={useAdvisor} onChange={(e) => setUseAdvisor(e.target.checked)} /> Usa il consulente
          </label>
          <Button type="submit" loading={busy === 'plan'} disabled={!model.trim()}>Calcola il piano</Button>
        </form>
      </Card>

      <ErrorBox error={error} />
      {result && <PlanView key={result.plan.model.revision + result.plan.vllm.args.join(' ')} data={result} onPlanChange={(p) => setResult((r) => ({ ...r, plan: p }))} />}
    </div>
  );
}
```

Nota: il test verifica `getByText(/--enable-prefix-caching$/m)` sul `CodeBlock` aggiornato dopo "Applica la proposta"; la `key` di `PlanView` cambia con gli argomenti, quindi lo stato interno (proposta applicata) si azzera insieme al nuovo piano: per mantenere il messaggio "Proposta applicata" usare come `key` solo `result.plan.model.revision` (correggere la riga di sopra di conseguenza se il test lo richiede).

- [ ] **Passo 5: verificare** — `npx vitest run test/web/models.test.jsx` → PASS (2 test); `npm run build:web` senza errori; `npm test` verde.

- [ ] **Passo 6: commit e push** — `git add web test/web && git commit -m "feat: pagina Modelli con piano e consulente" && git push`

---

### Attività 8: Pagine Profili e Stato e costi

**File:**
- Modifica: `web/src/pages/Profiles.jsx`, `web/src/pages/Status.jsx`
- Test: `test/web/profiles-status.test.jsx`

**Interfacce:**
- Consuma: `GET /api/overview`, `POST /api/jobs`, `GET /api/status`, `JobPanel`, componenti `ui.jsx`.
- Produce:
  - `Profiles`: carica `/api/overview`; per ogni profilo una scheda con modello, GPU, contesto, costo stimato, badge "consulente" se applicato, pulsanti "Avvia" e "Spegni" (`POST /api/jobs` con `{ action, profile }`) che mostrano sotto la scheda il `JobPanel` del job; i job già in corso (da `overview.jobs` con `status === 'running'`) vengono mostrati al caricamento; nessun profilo → messaggio "Nessun profilo: calcolane uno nella scheda Modelli".
  - `Status`: carica `/api/status` all'apertura e ogni 15 s (pulsante "Aggiorna"); tabella Pod (profilo con badge "orfano", Pod, stato, GPU, costo/h, uptime, costo della sessione, spegnimento: "inattivo da X su Y; massimo tra Z" oppure la fase); credito residuo; volume con costo mensile; nessun Pod → "Nessun Pod llmpod attivo".

- [ ] **Passo 1: test che fallisce**

`test/web/profiles-status.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Profiles from '../../web/src/pages/Profiles.jsx';
import Status from '../../web/src/pages/Status.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mockApi(routes) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, init = {}) => {
    const key = `${init.method ?? 'GET'} ${String(path).split('?')[0]}`;
    const body = routes[key];
    if (!body) return new Response(JSON.stringify({ error: { message: key } }), { status: 404 });
    return new Response(JSON.stringify(typeof body === 'function' ? body(init) : body), { status: 200 });
  });
}

describe('Profili', () => {
  it('elenca i profili e avvia un job con domanda', async () => {
    const fetchMock = mockApi({
      'GET /api/overview': { profiles: [{ name: 'qwen3-coder', model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', gpu: { id: 'A100', count: 1 }, context: 65536, hourlyUSD: 1.79, advisorApplied: true }], jobs: [], config: {}, advisor: {} },
      'POST /api/jobs': { job: { id: 'j1', kind: 'up:qwen3-coder', status: 'running' } },
      'GET /api/jobs/j1': { job: { id: 'j1', status: 'running', question: { id: 'q1', text: 'Avvio a 1,79 $/h. Confermi?', defYes: false } }, events: [{ type: 'phase', message: 'Controlli preliminari' }] },
      'POST /api/jobs/j1/answer': { ok: true },
    });
    render(<Profiles />);
    await screen.findByText('qwen3-coder');
    expect(screen.getByText(/1,79 \$\/h/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Avvia' }));
    await screen.findByText('Avvio a 1,79 $/h. Confermi?');
    expect(screen.getByText(/Controlli preliminari/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sì' }));
    const answer = fetchMock.mock.calls.find(([p]) => p === '/api/jobs/j1/answer');
    expect(JSON.parse(answer[1].body)).toEqual({ questionId: 'q1', answer: true });
    expect(JSON.parse(fetchMock.mock.calls.find(([p, i]) => p === '/api/jobs' && i?.method === 'POST')[1].body)).toEqual({ action: 'up', profile: 'qwen3-coder' });
  });

  it('nessun profilo', async () => {
    mockApi({ 'GET /api/overview': { profiles: [], jobs: [], config: {}, advisor: {} } });
    render(<Profiles />);
    await screen.findByText(/Nessun profilo/);
  });
});

describe('Stato e costi', () => {
  it('mostra Pod, sessione, spegnimento, credito e volume', async () => {
    mockApi({ 'GET /api/status': {
      pods: [{ profile: 'qwen3-coder', podId: 'p1', status: 'RUNNING', gpu: { id: 'A100', count: 1 }, hourlyUSD: 1.79, uptimeSeconds: 3900, sessionUSD: 1.94, orphan: true, supervisor: { phase: 'ready', idleSeconds: 300, idleLimitSeconds: 1800, uptimeSeconds: 3900, maxSeconds: 28800 } }],
      balance: { balance: 42.5 }, volume: { name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-RO-1', monthlyUSD: 10.5 },
    } });
    render(<Status />);
    await screen.findByText('p1');
    expect(screen.getByText('orfano')).toBeTruthy();
    expect(screen.getByText('1,94 $')).toBeTruthy();
    expect(screen.getByText(/inattivo da 5 min 0 s su 30 min 0 s/)).toBeTruthy();
    expect(screen.getByText(/42,50 \$/)).toBeTruthy();
    expect(screen.getByText(/10,50 \$ al mese/)).toBeTruthy();
  });
});
```

- [ ] **Passo 2: verificare che fallisca** — `npx vitest run test/web/profiles-status.test.jsx` → FAIL.

- [ ] **Passo 3: `web/src/pages/Profiles.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api, fmtUSD } from '../lib/api.js';
import { Card, Button, Badge, ErrorBox, Spinner } from '../components/ui.jsx';
import { JobPanel } from '../components/JobPanel.jsx';

export default function Profiles() {
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState({});
  const [error, setError] = useState(null);

  async function load() {
    try {
      const o = await api('/api/overview');
      setOverview(o);
      const running = {};
      for (const j of o.jobs ?? []) if (j.status === 'running') running[j.kind.split(':')[1]] = j.id;
      setJobs((prev) => ({ ...running, ...prev }));
    } catch (e) { setError(e); }
  }
  useEffect(() => { load(); }, []);

  async function start(action, profile) {
    setError(null);
    try {
      const { job } = await api('/api/jobs', { method: 'POST', body: { action, profile } });
      setJobs((j) => ({ ...j, [profile]: job.id }));
    } catch (e) { setError(e); }
  }

  if (!overview) return error ? <ErrorBox error={error} /> : <Spinner />;
  if (!overview.profiles.length) return <Card title="Profili"><p className="text-gray-400">Nessun profilo: calcolane uno nella scheda Modelli.</p></Card>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {overview.profiles.map((p) => (
        <Card key={p.name} title={p.name}>
          <div className="space-y-1 text-sm">
            <p className="text-gray-300">{p.model}</p>
            <p className="text-gray-400">{p.gpu ? `${p.gpu.id} ×${p.gpu.count}` : 'GPU da scegliere'} · contesto {p.context} · stimato {fmtUSD(p.hourlyUSD)}/h</p>
            {p.advisorApplied && <Badge tone="violet">consulente</Badge>}
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => start('up', p.name)}>Avvia</Button>
            <Button variant="ghost" onClick={() => start('down', p.name)}>Spegni</Button>
          </div>
          {jobs[p.name] && <div className="mt-4 border-t border-white/10 pt-4"><JobPanel jobId={jobs[p.name]} onFinished={load} /></div>}
        </Card>
      ))}
      <div className="md:col-span-2"><ErrorBox error={error} /></div>
    </div>
  );
}
```

- [ ] **Passo 4: `web/src/pages/Status.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api, fmtUSD, fmtDuration } from '../lib/api.js';
import { Card, Button, Badge, ErrorBox, Spinner } from '../components/ui.jsx';

function shutdown(p) {
  const s = p.supervisor;
  if (s?.idleSeconds == null) return s?.phase ?? '—';
  return `inattivo da ${fmtDuration(s.idleSeconds)} su ${fmtDuration(s.idleLimitSeconds)}; massimo tra ${fmtDuration(s.maxSeconds - s.uptimeSeconds)}`;
}

export default function Status() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try { setStatus(await api('/api/status')); setError(null); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  if (!status) return error ? <ErrorBox error={error} /> : <Spinner />;
  return (
    <div className="space-y-4">
      <Card title="Pod attivi">
        <div className="mb-3 flex justify-end"><Button variant="ghost" onClick={load} loading={busy}>Aggiorna</Button></div>
        {status.pods.length === 0 ? <p className="text-gray-400">Nessun Pod llmpod attivo.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-gray-400"><tr><th className="py-1">Profilo</th><th>Pod</th><th>Stato</th><th>GPU</th><th>Costo</th><th>Uptime</th><th>Sessione</th><th>Spegnimento</th></tr></thead>
              <tbody>
                {status.pods.map((p) => (
                  <tr key={p.podId} className="border-t border-white/5">
                    <td className="py-1">{p.profile} {p.orphan && <Badge tone="amber">orfano</Badge>}</td>
                    <td>{p.podId}</td>
                    <td><Badge tone={p.status === 'RUNNING' ? 'green' : 'cyan'}>{p.status}</Badge></td>
                    <td>{p.gpu ? `${p.gpu.id} ×${p.gpu.count}` : '?'}</td>
                    <td>{fmtUSD(p.hourlyUSD)}/h</td>
                    <td>{fmtDuration(p.uptimeSeconds)}</td>
                    <td>{fmtUSD(p.sessionUSD)}</td>
                    <td className="text-gray-300">{shutdown(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Credito Runpod"><p className="text-2xl font-semibold neon-text">{status.balance ? fmtUSD(status.balance.balance) : 'non disponibile'}</p></Card>
        <Card title="Volume dei pesi">
          {status.volume ? <p className="text-sm">{status.volume.name} · {status.volume.size} GB · {status.volume.dataCenterId} · <strong>{fmtUSD(status.volume.monthlyUSD)} al mese</strong></p> : <p className="text-gray-400">Nessun volume configurato.</p>}
        </Card>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
```

- [ ] **Passo 5: verificare** — `npx vitest run test/web/profiles-status.test.jsx` → PASS (3 test); `npm run build:web`; `npm test` verde.

- [ ] **Passo 6: commit e push** — `git add web test/web && git commit -m "feat: pagine Profili e Stato e costi" && git push`

---

### Attività 9: Pagine Client e Prova veloce, README e verifica nel browser

**File:**
- Modifica: `web/src/pages/Clients.jsx`, `web/src/pages/QuickTest.jsx`, `README.md`
- Test: `test/web/clients-quick.test.jsx`

**Interfacce:**
- Produce:
  - `Clients`: select del profilo (da `/api/overview`); sezione "Comandi" con `CodeBlock` per `llmpod run claude --profile <p>`, `llmpod run opencode --profile <p>`, `llmpod run pi --profile <p>`; pulsante "Mostra gli export" → `POST /api/env` → `CodeBlock` con le righe `export K='v'` (avviso "Contiene la chiave del profilo: non condividerla"); sezione ZCode con casella "ZCode è chiuso" e pulsante "Configura ZCode" (disabilitato senza la casella) → `POST /api/clients/zcode` → messaggio con il file aggiornato.
  - `QuickTest`: carica `/api/openwebui`; select del profilo per Open WebUI → `POST /api/openwebui/profile`; stato del proxy (porta, attivo); `iframe` su `http://127.0.0.1:3000` (titolo "Open WebUI", altezza 70vh) e link "Apri in una nuova scheda"; nota "Open WebUI si avvia con Docker (scripts/start) o manualmente; se la pagina resta vuota, non è in esecuzione".

- [ ] **Passo 1: test che fallisce**

`test/web/clients-quick.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Clients from '../../web/src/pages/Clients.jsx';
import QuickTest from '../../web/src/pages/QuickTest.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mockApi(routes) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, init = {}) => {
    const key = `${init.method ?? 'GET'} ${String(path).split('?')[0]}`;
    const body = routes[key];
    if (!body) return new Response(JSON.stringify({ error: { message: key } }), { status: 404 });
    return new Response(JSON.stringify(typeof body === 'function' ? body(init) : body), { status: 200 });
  });
}
const overview = { profiles: [{ name: 'qwen3-coder' }], jobs: [], config: { openwebuiProfile: null }, advisor: {} };

describe('Client', () => {
  it('comandi, export su richiesta e ZCode con conferma', async () => {
    const fetchMock = mockApi({
      'GET /api/overview': overview,
      'POST /api/env': { env: { ANTHROPIC_BASE_URL: 'https://p1-8000.proxy.runpod.net', ANTHROPIC_AUTH_TOKEN: "k'ey" } },
      'POST /api/clients/zcode': { file: '/home/u/.zcode/v2/config.json' },
    });
    render(<Clients />);
    await screen.findByText('llmpod run claude --profile qwen3-coder');
    fireEvent.click(screen.getByRole('button', { name: 'Mostra gli export' }));
    await screen.findByText(/export ANTHROPIC_AUTH_TOKEN='k'\\''ey'/);
    expect(screen.getByText(/Contiene la chiave del profilo/)).toBeTruthy();
    const zcode = screen.getByRole('button', { name: 'Configura ZCode' });
    expect(zcode.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/ZCode è chiuso/));
    fireEvent.click(zcode);
    await screen.findByText(/config\.json/);
    expect(JSON.parse(fetchMock.mock.calls.find(([p]) => p === '/api/clients/zcode')[1].body)).toEqual({ profile: 'qwen3-coder', zcodeClosed: true });
  });
});

describe('Prova veloce', () => {
  it('iframe di Open WebUI e scelta del profilo', async () => {
    const fetchMock = mockApi({
      'GET /api/overview': overview,
      'GET /api/openwebui': { url: 'http://127.0.0.1:3000', profile: null, proxy: { port: 8081, listening: true } },
      'POST /api/openwebui/profile': { ok: true },
    });
    render(<QuickTest />);
    const frame = await screen.findByTitle('Open WebUI');
    expect(frame.getAttribute('src')).toBe('http://127.0.0.1:3000');
    expect(screen.getByText(/8081/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Profilo per Open WebUI/), { target: { value: 'qwen3-coder' } });
    await screen.findByText(/Profilo impostato/);
    expect(JSON.parse(fetchMock.mock.calls.find(([p]) => p === '/api/openwebui/profile')[1].body)).toEqual({ profile: 'qwen3-coder' });
  });
});
```

- [ ] **Passo 2: verificare che fallisca** — `npx vitest run test/web/clients-quick.test.jsx` → FAIL.

- [ ] **Passo 3: `web/src/pages/Clients.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Button, Field, ErrorBox, CodeBlock, inputClass } from '../components/ui.jsx';

const shellQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

export default function Clients() {
  const [profiles, setProfiles] = useState([]);
  const [profile, setProfile] = useState('');
  const [env, setEnv] = useState(null);
  const [closed, setClosed] = useState(false);
  const [zcodeFile, setZcodeFile] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    api('/api/overview').then((o) => { setProfiles(o.profiles); setProfile(o.profiles[0]?.name ?? ''); }).catch(setError);
  }, []);

  async function showEnv() {
    setBusy('env'); setError(null);
    try { setEnv((await api('/api/env', { method: 'POST', body: { profile } })).env); } catch (e) { setError(e); } finally { setBusy(null); }
  }
  async function zcode() {
    setBusy('zcode'); setError(null);
    try { setZcodeFile((await api('/api/clients/zcode', { method: 'POST', body: { profile, zcodeClosed: closed } })).file); } catch (e) { setError(e); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <Card title="Profilo">
        <Field label="Profilo con Pod attivo">
          <select className={inputClass} value={profile} onChange={(e) => { setProfile(e.target.value); setEnv(null); setZcodeFile(null); }}>
            {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </Field>
      </Card>
      {profile && (
        <>
          <Card title="Comandi">
            <div className="space-y-2">
              {['claude', 'opencode', 'pi'].map((c) => <CodeBlock key={c} text={`llmpod run ${c} --profile ${profile}`} />)}
            </div>
          </Card>
          <Card title="Export per altri client">
            <Button onClick={showEnv} loading={busy === 'env'}>Mostra gli export</Button>
            {env && (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-amber-300">⚠ Contiene la chiave del profilo: non condividerla.</p>
                <CodeBlock text={Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n')} />
              </div>
            )}
          </Card>
          <Card title="ZCode">
            <p className="mb-3 text-sm text-gray-400">ZCode riscrive la sua configurazione all'uscita: chiudilo prima di continuare.</p>
            <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> ZCode è chiuso</label>
            <Button onClick={zcode} disabled={!closed} loading={busy === 'zcode'}>Configura ZCode</Button>
            {zcodeFile && <p className="mt-3 text-sm text-emerald-300">Configurato: {zcodeFile}. Apri ZCode e scegli il provider "llmpod (Runpod)".</p>}
          </Card>
        </>
      )}
      <ErrorBox error={error} />
    </div>
  );
}
```

- [ ] **Passo 4: `web/src/pages/QuickTest.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Field, Badge, ErrorBox, inputClass } from '../components/ui.jsx';

export default function QuickTest() {
  const [info, setInfo] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api('/api/openwebui'), api('/api/overview')]).then(([i, o]) => { setInfo(i); setProfiles(o.profiles); }).catch(setError);
  }, []);

  async function choose(profile) {
    setError(null);
    try {
      await api('/api/openwebui/profile', { method: 'POST', body: { profile } });
      setInfo((i) => ({ ...i, profile }));
      setMessage(`Profilo impostato: Open WebUI userà ${profile}`);
    } catch (e) { setError(e); }
  }

  if (!info) return <ErrorBox error={error} />;
  return (
    <div className="space-y-4">
      <Card title="Prova veloce con Open WebUI">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Profilo per Open WebUI">
            <select aria-label="Profilo per Open WebUI" className={inputClass} value={info.profile ?? ''} onChange={(e) => choose(e.target.value)}>
              <option value="" disabled>scegli…</option>
              {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </Field>
          <p className="text-sm text-gray-400">Proxy: {info.proxy?.listening ? <Badge tone="green">attivo sulla porta {info.proxy.port}</Badge> : <Badge tone="red">non attivo</Badge>}</p>
          <a className="text-sm text-cyan-300 hover:underline" href={info.url} target="_blank" rel="noreferrer">Apri in una nuova scheda</a>
        </div>
        {message && <p className="mt-3 text-sm text-emerald-300">{message}</p>}
        <p className="mt-3 text-xs text-gray-500">Open WebUI si avvia con Docker (scripts/start) o manualmente; se la pagina resta vuota, non è in esecuzione.</p>
      </Card>
      <iframe title="Open WebUI" src={info.url} className="glass h-[70vh] w-full" />
      <ErrorBox error={error} />
    </div>
  );
}
```

- [ ] **Passo 5: README** — aggiungere una sezione "Interfaccia web" dopo "Consulente IA":

````markdown
## Interfaccia web

```bash
npm run build:web      # una volta (o dopo un aggiornamento)
llmpod ui              # apre il browser su http://127.0.0.1:7860
```

L'interfaccia (installabile come app dal browser) copre ricerca dei modelli, piano con il
consulente, profili, avvio e spegnimento con le stesse conferme di costo della CLI, stato e
costi, configurazione dei client e una prova veloce con Open WebUI. È raggiungibile solo dal tuo
computer e richiede il link con il token stampato da `llmpod ui`.

Il proxy per Open WebUI (porta 8081) inoltra le richieste al Pod del profilo scelto nella scheda
"Prova veloce"; Open WebUI va puntato su `http://127.0.0.1:8081/v1` con la chiave
`LLMPOD_OPENWEBUI_KEY` del file `.env` (con Docker è automatico).
````

- [ ] **Passo 6: verificare** — `npx vitest run test/web` → PASS (tutti); `npm run build:web`; `npm test` verde.

- [ ] **Passo 7: verifica nel browser (controller)** — con una cartella di configurazione temporanea e un profilo finto, avviare `llmpod ui --no-open` e aprire l'URL con Playwright: controllare che le cinque schede si carichino senza errori in console, che la schermata senza token mostri il messaggio di sessione non valida e fare uno screenshot di ogni scheda per la revisione visiva (stile scuro, gradienti, animazioni).

- [ ] **Passo 8: commit e push** — `git add web test/web README.md && git commit -m "feat: pagine Client e Prova veloce, documentazione dell'interfaccia" && git push`
