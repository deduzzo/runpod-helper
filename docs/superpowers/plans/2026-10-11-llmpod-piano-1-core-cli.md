# llmpod — Piano 1: core, CLI e supervisore

> **Per chi esegue con agenti:** SUB-SKILL RICHIESTA: usare superpowers:subagent-driven-development (consigliata) oppure superpowers:executing-plans per eseguire il piano attività per attività. I passi usano le caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** una CLI `llmpod` funzionante da riga di comando che porta un modello Hugging Face su un Pod Runpod con vLLM, lo verifica, configura Claude Code / OpenCode / ZCode e si spegne da sola per inattività.

**Architettura:** modulo `src/core` senza I/O di terminale (client HTTP con mascheramento dei segreti, client Runpod REST v2, client Hugging Face, planner VRAM/GPU/argomenti vLLM, launcher del Pod, adattatori dei client) + `src/cli` con commander che stampa gli eventi del core. Nel Pod gira `supervisor.py` (solo libreria standard Python) che avvia vLLM, espone lo stato su `:8001` e termina il Pod per inattività con la chiave iniettata da Runpod.

**Tech stack:** Node ≥ 20 (ESM), `commander`, `fetch` nativo, `vitest`; Python 3 stdlib + `unittest` per il supervisore; immagine `vllm/vllm-openai:v0.30.0-cu129`.

**Spec:** `docs/superpowers/specs/2026-10-11-llmpod-design.md` (leggerla prima di iniziare).

**Piani successivi (fuori da questo piano):** 2 — consulente con IA esterna modulare (livelli 2–3); 3 — server, web UI e proxy Open WebUI; 4 — Docker, script per piattaforma, CI. Questo piano lascia i punti di aggancio (`makePlan` restituisce `warnings`/`args` modificabili; `ops` emette eventi; `supervisor` espone `POST /reload`).

## Vincoli globali

- Node `>=20`, `"type": "module"`, dipendenze di runtime: solo `commander`.
- Credenziali in `${LLMPOD_CONFIG_DIR:-~/.config/llmpod}/.env`, file `600`, cartella `700`. Mai stampare, loggare o committare chiavi/token, nemmeno con `--verbose`.
- Ogni operazione che costa denaro mostra il costo orario stimato e chiede conferma (`--yes` per saltarla). `--dry-run` su tutto ciò che crea o distrugge risorse: nessuna chiamata di scrittura, stampa la richiesta con i segreti mascherati.
- API Runpod: REST v2 `https://api.runpod.io/v2` (network volume: `/v2/network-volumes`); credito residuo solo via GraphQL `https://api.runpod.io/graphql` `{ myself { clientBalance currentSpendPerHr } }`.
- Tutte le richieste HTTP con User-Agent `llmpod/<versione>` (nel Pod `llmpod-supervisor/<versione>`): Cloudflare risponde `403 error code: 1010` allo UA di Python.
- Immagine vLLM di default `vllm/vllm-openai:v0.30.0-cu129` con `minCudaVersion: "12.9"`; mai `latest`.
- Nome servito = nome profilo, regex `^[a-z0-9][a-z0-9-]{0,40}$` (Claude Code non accetta `/`).
- Proxy Runpod: `https://<podId>-<porta>.proxy.runpod.net`, limite Cloudflare di 100 s per richiesta: ogni chiamata non in streaming verso il Pod deve avere timeout < 95 s.
- vLLM accetta la chiave solo come `Authorization: Bearer` (quindi Claude Code usa `ANTHROPIC_AUTH_TOKEN`); `/metrics` e `/health` non sono protetti.
- Messaggi utente in italiano; identificatori e codice in inglese.
- Prezzo network volume: non esposto da API; default `0.07` $/GB/mese (documentazione Runpod, tipo STANDARD), sovrascrivibile in `config.json` (`volumePricePerGbMonth`).
- Repository pubblico: hook `.githooks/pre-commit` attivo; commit e push alla fine di ogni attività.

## Focus della revisione

1. **Pod lasciato acceso** dopo un errore o un Ctrl+C durante `up` → l'utente si aspetta la proposta di terminarlo (default sì) e nessun Pod orfano. Test: Attività 13 (`up` con smoke test fallito chiama `deletePod`).
2. **Segreti nell'output** di `--dry-run`, errori HTTP e `--verbose` → l'utente si aspetta `<REDATTO>` ovunque. Test: Attività 2 (`redactObject`), Attività 3 (errore HTTP che riporta l'header), Attività 15 (CLI end-to-end con segreti finti).
3. **Riferimento al modello incollato in forme diverse** (`org/modello`, `org/modello@rev`, URL `https://huggingface.co/org/modello/tree/main`) → l'utente si aspetta che funzionino tutte. Test: Attività 5 (`parseModelRef`).
4. **Configurazione ZCode malformata o con altri provider** → l'utente si aspetta che nulla venga perso: backup, rifiuto se il JSON non è valido, altri provider intatti. Test: Attività 12.
5. **Streaming oltre i 100 s del proxy** (risposte lunghe di Claude Code) → l'utente si aspetta che non si interrompa o, se succede, un messaggio chiaro. Test: Attività 16 (prova reale `e2e:cpu` con endpoint che invia dati per 150 s).

## Struttura dei file

```
package.json  vitest.config.js  .env.example
data/parsers.json                    regole architettura/id → tool e reasoning parser
data/vllm-flags-v0.30.0.json         flag ammessi di `vllm serve`
src/core/errors.js                   LlmpodError + codici
src/core/secrets.js                  registro segreti, redact, redactObject
src/core/config.js                   cartella config, .env, JSON, profili, stato
src/core/http.js                     fetch con timeout/retry/UA/mascheramento
src/core/runpod.js                   client REST v2 + GraphQL saldo
src/core/hf.js                       client Hugging Face + parseModelRef
src/core/events.js                   emettitore eventi
src/core/confirm.js                  confirmCost / confirmAction
src/core/planner/vram.js             pesi, KV cache, stima per GPU
src/core/planner/vllm-args.js        parser, argomenti, validazione flag
src/core/planner/gpu-select.js       candidati GPU per prezzo/disponibilità
src/core/planner/plan.js             orchestrazione del piano
src/core/pod/supervisor.py           eseguito nel Pod
src/core/pod/body.js                 corpo di POST /v2/pods
src/core/pod/launcher.js             creazione con fallback, attese, client del supervisore
src/core/pod/smoke.js                smoke test con chiamata a strumento
src/core/clients/env-format.js       export sh/ps1/json
src/core/clients/claude-code.js      variabili per Claude Code
src/core/clients/opencode.js         config OpenCode
src/core/clients/zcode.js            merge sicuro di ~/.zcode/v2/config.json
src/core/ops.js                      up / down / status / rotate-key
src/cli/index.js                     entry point commander
src/cli/prompt.js                    domande, input nascosto
src/cli/render.js                    stampa eventi e tabelle
src/cli/commands/*.js                init search plan save up down status env run rotate-key destroy-volume
scripts/e2e-cpu.js                   prova reale su Pod CPU
test/fixtures/{runpod,hf}/…          risposte reali ripulite
test/core/*.test.js  test/cli/*.test.js  test/supervisor/test_supervisor.py  test/supervisor/fake_vllm.py
```

---
### Attività 1: Impalcatura del progetto ed errori tipizzati

**File:**
- Crea: `package.json`, `vitest.config.js`, `.env.example`, `src/core/errors.js`
- Crea: `test/fixtures/runpod/*`, `test/fixtures/hf/*`, `data/vllm-flags-v0.30.0.json` (copiati dalle fixture raccolte)
- Test: `test/core/errors.test.js`

**Interfacce:**
- Produce: `class LlmpodError extends Error { code: string; hint?: string; details?: any }`, `Codes` (oggetto congelato con i codici della spec §13 più `NETWORK`, `HTTP`, `RUNPOD_AUTH`, `RUNPOD_API`, `REQUEST_INVALID`, `INVALID_INPUT`, `NOT_FOUND`, `VLLM_ERROR`, `ZCODE_CONFIG_INVALID`, `CANCELLED`).

- [ ] **Passo 1: package.json, vitest e .env.example**

```json
{
  "name": "llmpod",
  "version": "0.1.0",
  "description": "LLM self-hosted su Runpod come backend di coding agent",
  "license": "MIT",
  "type": "module",
  "bin": { "llmpod": "src/cli/index.js" },
  "engines": { "node": ">=20" },
  "files": ["src", "data"],
  "scripts": {
    "test": "npm run test:js && npm run test:py",
    "test:js": "vitest run",
    "test:py": "python3 -m unittest discover -s test/supervisor -v",
    "e2e:cpu": "node scripts/e2e-cpu.js",
    "prepare": "git config core.hooksPath .githooks || true"
  }
}
```

Poi installare le dipendenze (fissano da sole le versioni nel `package.json`):

```bash
npm install commander@12
npm install -D vitest@3
```

`vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.js'], environment: 'node' },
});
```

`.env.example` (solo nomi, mai valori):

```
RUNPOD_API_KEY=
HF_TOKEN=
```

- [ ] **Passo 2: copiare le fixture e verificare che non contengano segreti**

```bash
S=/private/tmp/claude-501/-Users-deduzzo-dev-runpod-helper/9ec2a24a-c9c9-453f-9294-75f84230e944/scratchpad/fixtures
mkdir -p test/fixtures data
cp -R "$S/runpod" "$S/hf" test/fixtures/
cp "$S/vllm/serve-flags-v0.30.0.json" data/vllm-flags-v0.30.0.json
grep -rniE 'rpa_|hf_[A-Za-z0-9]{20}|sk-|@gmail|email|clientBalance' test/fixtures data && echo "CONTROLLARE" || echo "fixture pulite"
```

Atteso: `fixture pulite`. Se compare qualcosa, sostituire il valore con `"REDACTED"` prima di proseguire.

- [ ] **Passo 3: scrivere il test che fallisce**

`test/core/errors.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { LlmpodError, Codes } from '../../src/core/errors.js';

describe('LlmpodError', () => {
  it('conserva codice, messaggio e suggerimento', () => {
    const err = new LlmpodError(Codes.NO_GPU_AVAILABLE, 'Nessuna GPU', { hint: 'Prova un altro datacenter' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LlmpodError');
    expect(err.code).toBe('NO_GPU_AVAILABLE');
    expect(err.hint).toBe('Prova un altro datacenter');
  });

  it('espone tutti i codici della spec', () => {
    for (const c of ['NO_GPU_AVAILABLE', 'INSUFFICIENT_BALANCE', 'GATED_MODEL', 'HF_AUTH', 'OOM',
      'UNKNOWN_TOOL_PARSER', 'ZCODE_RUNNING', 'DOCKER_NOT_RUNNING', 'POD_START_TIMEOUT',
      'SMOKE_TEST_FAILED', 'CONFIG_PERMISSIONS']) {
      expect(Codes[c]).toBe(c);
    }
    expect(Object.isFrozen(Codes)).toBe(true);
  });
});
```

- [ ] **Passo 4: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/errors.test.js`
Atteso: FAIL, `Failed to load url ../../src/core/errors.js`.

- [ ] **Passo 5: implementazione**

`src/core/errors.js`:

```js
const CODE_LIST = [
  'NO_GPU_AVAILABLE', 'INSUFFICIENT_BALANCE', 'GATED_MODEL', 'HF_AUTH', 'OOM',
  'UNKNOWN_TOOL_PARSER', 'ZCODE_RUNNING', 'DOCKER_NOT_RUNNING', 'POD_START_TIMEOUT',
  'SMOKE_TEST_FAILED', 'CONFIG_PERMISSIONS',
  'NETWORK', 'HTTP', 'RUNPOD_AUTH', 'RUNPOD_API', 'REQUEST_INVALID', 'INVALID_INPUT',
  'NOT_FOUND', 'VLLM_ERROR', 'ZCODE_CONFIG_INVALID', 'CANCELLED',
];

export const Codes = Object.freeze(Object.fromEntries(CODE_LIST.map((c) => [c, c])));

export class LlmpodError extends Error {
  constructor(code, message, { hint, cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LlmpodError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}
```

- [ ] **Passo 6: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/errors.test.js`
Atteso: PASS (2 test).

- [ ] **Passo 7: commit e push**

```bash
git add package.json package-lock.json vitest.config.js .env.example src/core/errors.js test/core/errors.test.js test/fixtures data/vllm-flags-v0.30.0.json
git commit -m "feat: impalcatura progetto, errori tipizzati e fixture"
git push
```

---

### Attività 2: Registro dei segreti e mascheramento

**File:**
- Crea: `src/core/secrets.js`
- Test: `test/core/secrets.test.js`

**Interfacce:**
- Produce: `registerSecret(value: string): void` (ignora stringhe < 8 caratteri), `redact(input: any): string` (stringa con ogni segreto registrato sostituito da `<REDATTO>`; oggetti serializzati in JSON), `redactObject(obj: any): any` (copia profonda: valori delle chiavi che corrispondono a `/key|token|secret|password|authorization/i` → `<REDATTO>`, poi `redact` sulle stringhe), `clearSecrets(): void` (solo per i test).

- [ ] **Passo 1: scrivere il test che fallisce**

`test/core/secrets.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { registerSecret, redact, redactObject, clearSecrets } from '../../src/core/secrets.js';

describe('segreti', () => {
  beforeEach(() => clearSecrets());

  it('sostituisce i segreti registrati ovunque compaiano', () => {
    registerSecret('rpa_SEGRETOFINTO1234');
    expect(redact('Bearer rpa_SEGRETOFINTO1234 e ancora rpa_SEGRETOFINTO1234'))
      .toBe('Bearer <REDATTO> e ancora <REDATTO>');
  });

  it('ignora valori troppo corti per non oscurare testo normale', () => {
    registerSecret('abc');
    expect(redact('abc def')).toBe('abc def');
  });

  it('serializza gli oggetti prima di mascherare', () => {
    registerSecret('hf_TOKENFINTO123456');
    expect(redact({ a: 'hf_TOKENFINTO123456' })).toBe('{"a":"<REDATTO>"}');
  });

  it('redactObject maschera per nome di chiave anche segreti non registrati', () => {
    const out = redactObject({
      env: { VLLM_API_KEY: 'x'.repeat(40), HF_TOKEN: 'y', HF_HOME: '/workspace/hf' },
      headers: { Authorization: 'Bearer zzz' },
      list: [{ apiKey: 'k' }],
    });
    expect(out.env.VLLM_API_KEY).toBe('<REDATTO>');
    expect(out.env.HF_TOKEN).toBe('<REDATTO>');
    expect(out.env.HF_HOME).toBe('/workspace/hf');
    expect(out.headers.Authorization).toBe('<REDATTO>');
    expect(out.list[0].apiKey).toBe('<REDATTO>');
  });

  it('redactObject maschera i segreti registrati dentro valori non sensibili', () => {
    registerSecret('SEGRETO-NEL-TESTO-123');
    expect(redactObject({ cmd: ['echo SEGRETO-NEL-TESTO-123'] }).cmd[0]).toBe('echo <REDATTO>');
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/secrets.test.js`
Atteso: FAIL, modulo non trovato.

- [ ] **Passo 3: implementazione**

`src/core/secrets.js`:

```js
const MASK = '<REDATTO>';
const SENSITIVE_KEY = /key|token|secret|password|authorization/i;
const values = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) values.add(value);
}

export function clearSecrets() {
  values.clear();
}

export function redact(input) {
  if (input === undefined || input === null) return String(input);
  let text = typeof input === 'string' ? input : JSON.stringify(input);
  // I segreti più lunghi prima, così un segreto contenuto in un altro non lascia residui.
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    text = text.split(v).join(MASK);
  }
  return text;
}

export function redactObject(obj) {
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [
      k,
      SENSITIVE_KEY.test(k) && typeof v === 'string' ? MASK : redactObject(v),
    ]));
  }
  return typeof obj === 'string' ? redact(obj) : obj;
}
```

- [ ] **Passo 4: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/secrets.test.js`
Atteso: PASS (5 test).

- [ ] **Passo 5: commit e push**

```bash
git add src/core/secrets.js test/core/secrets.test.js
git commit -m "feat: registro dei segreti e mascheramento"
git push
```

---

### Attività 3: Client HTTP con timeout, ritenti e mascheramento

**File:**
- Crea: `src/core/http.js`
- Test: `test/core/http.test.js`

**Interfacce:**
- Consuma: `LlmpodError`, `Codes` (Attività 1); `redact` (Attività 2).
- Produce: `createHttp({ fetch?, userAgent, timeoutMs = 30000, maxRetries = 3, sleep? }) → { request(method, url, { headers?, json?, body?, query?, timeoutMs?, retry? }) → Promise<{ status, ok, headers, data }> }`. `data` è JSON se analizzabile, altrimenti testo. Ritenta 429 (sempre, rispettando `Retry-After` in secondi) ed errori di rete/5xx solo per `GET`, `HEAD`, `DELETE`. `query` accetta valori array (parametro ripetuto). `httpError(res, what) → LlmpodError` con codice `HTTP` e messaggio mascherato `"<what>: HTTP <status> <detail>"`.

- [ ] **Passo 1: scrivere il test che fallisce**

`test/core/http.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttp, httpError } from '../../src/core/http.js';
import { registerSecret, clearSecrets } from '../../src/core/secrets.js';

const res = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('http', () => {
  beforeEach(() => clearSecrets());

  it('invia User-Agent, JSON e query ripetute', async () => {
    const fetch = vi.fn().mockResolvedValue(res(200, { ok: 1 }));
    const http = createHttp({ fetch, userAgent: 'llmpod/0.1.0' });
    const out = await http.request('POST', 'https://x.test/a', { json: { b: 1 }, query: { 'expand[]': ['sha', 'gated'], n: 2 } });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://x.test/a?expand%5B%5D=sha&expand%5B%5D=gated&n=2');
    expect(init.headers['user-agent']).toBe('llmpod/0.1.0');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"b":1}');
    expect(out).toMatchObject({ status: 200, ok: true, data: { ok: 1 } });
  });

  it('ritenta 429 rispettando Retry-After', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(res(429, '', { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    const sleep = vi.fn().mockResolvedValue();
    const http = createHttp({ fetch, userAgent: 'u', sleep });
    const out = await http.request('POST', 'https://x.test/a', { json: {} });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(out.status).toBe(200);
  });

  it('ritenta 5xx solo per metodi idempotenti', async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fetchGet = vi.fn().mockResolvedValueOnce(res(503, '')).mockResolvedValueOnce(res(200, '{}'));
    expect((await createHttp({ fetch: fetchGet, userAgent: 'u', sleep }).request('GET', 'https://x.test')).status).toBe(200);
    const fetchPost = vi.fn().mockResolvedValue(res(503, ''));
    expect((await createHttp({ fetch: fetchPost, userAgent: 'u', sleep }).request('POST', 'https://x.test', { json: {} })).status).toBe(503);
    expect(fetchPost).toHaveBeenCalledTimes(1);
  });

  it('gli errori di rete non contengono segreti', async () => {
    registerSecret('rpa_SEGRETOFINTO1234');
    const fetch = vi.fn().mockRejectedValue(new Error('fallito con rpa_SEGRETOFINTO1234'));
    const http = createHttp({ fetch, userAgent: 'u', sleep: async () => {}, maxRetries: 0 });
    await expect(http.request('GET', 'https://x.test')).rejects.toMatchObject({
      code: 'NETWORK', message: expect.not.stringContaining('rpa_SEGRETOFINTO1234'),
    });
  });

  it('httpError usa il detail del problem+json e maschera', () => {
    registerSecret('rpa_SEGRETOFINTO1234');
    const err = httpError({ status: 400, data: { detail: 'header rpa_SEGRETOFINTO1234 errato' } }, 'Creazione Pod');
    expect(err.code).toBe('HTTP');
    expect(err.message).toBe('Creazione Pod: HTTP 400 header <REDATTO> errato');
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/http.test.js`
Atteso: FAIL, modulo non trovato.

- [ ] **Passo 3: implementazione**

`src/core/http.js`:

```js
import { LlmpodError, Codes } from './errors.js';
import { redact } from './secrets.js';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'DELETE']);
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 8000);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHttp({ fetch = globalThis.fetch, userAgent, timeoutMs = 30000, maxRetries = 3, sleep = defaultSleep } = {}) {
  async function request(method, url, { headers = {}, json, body, query, timeoutMs: t = timeoutMs, retry = true } = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, String(v));
    }
    const h = { 'user-agent': userAgent, accept: 'application/json', ...headers };
    let payload = body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const canRetryServer = retry && IDEMPOTENT.has(method);

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(u, { method, headers: h, body: payload, signal: AbortSignal.timeout(t) });
      } catch (err) {
        if (canRetryServer && attempt < maxRetries) { await sleep(backoff(attempt)); continue; }
        throw new LlmpodError(Codes.NETWORK, redact(`Errore di rete verso ${u.host}: ${err.message}`), { cause: err });
      }
      const retryable = res.status === 429 ? retry : canRetryServer && res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
        continue;
      }
      const text = await res.text();
      let data = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* testo non JSON */ }
      return { status: res.status, ok: res.ok, headers: res.headers, data };
    }
  }
  return { request };
}

export function httpError(res, what) {
  const d = res.data;
  const detail = typeof d === 'string' ? d.slice(0, 300) : d?.detail ?? d?.title ?? d?.error ?? d?.message ?? '';
  return new LlmpodError(Codes.HTTP, redact(`${what}: HTTP ${res.status} ${detail}`.trim()), { details: { status: res.status } });
}
```

- [ ] **Passo 4: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/http.test.js`
Atteso: PASS (5 test).

- [ ] **Passo 5: commit e push**

```bash
git add src/core/http.js test/core/http.test.js
git commit -m "feat: client HTTP con timeout, ritenti e mascheramento"
git push
```

---

### Attività 4: Configurazione locale, .env, profili e stato

**File:**
- Crea: `src/core/config.js`
- Test: `test/core/config.test.js`

**Interfacce:**
- Consuma: `LlmpodError`, `Codes`; `registerSecret`.
- Produce:
  - `configDir(env = process.env): string`
  - `parseEnv(text): Record<string,string>`, `serializeEnv(obj): string`
  - `PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/`, `assertProfileName(name)` (lancia `INVALID_INPUT`)
  - `profileKeyVar(name) → "LLMPOD_KEY_<NOME_MAIUSCOLO_CON_UNDERSCORE>"`
  - `createStore({ dir = configDir(), platform = process.platform })` → `{ dir, ensureDir(), checkPermissions(), readEnv(), writeEnv(patch), readJson(name, fallback), writeJson(name, data), readConfig(), writeConfig(patch), readProfile(name), writeProfile(profile), listProfiles(), readState(), writeState(state) }`.
  - `readEnv()` registra come segreti i valori delle variabili con `KEY|TOKEN|SECRET` nel nome. Tutti i file scritti con permessi `600`, la cartella `700`, scrittura atomica (file temporaneo + `rename`). `checkPermissions()` su POSIX lancia `CONFIG_PERMISSIONS` se `.env` ha bit per gruppo/altri; su `win32` non controlla.
  - Default di `readConfig()`: `{ cloud: 'SECURE', vllmImage: 'vllm/vllm-openai:v0.30.0-cu129', minCudaVersion: '12.9', volumePricePerGbMonth: 0.07, watchdog: { idleMinutes: 30, maxHours: 8 } }` unito al file.

- [ ] **Passo 1: scrivere il test che fallisce**

`test/core/config.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, parseEnv, serializeEnv, configDir, assertProfileName, profileKeyVar } from '../../src/core/config.js';
import { redact, clearSecrets } from '../../src/core/secrets.js';

let dir;
beforeEach(() => {
  clearSecrets();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-'));
  dir = path.join(dir, 'cfg');
});
const mode = (p) => fs.statSync(p).mode & 0o777;

describe('config', () => {
  it('configDir rispetta LLMPOD_CONFIG_DIR', () => {
    expect(configDir({ LLMPOD_CONFIG_DIR: '/x/y' })).toBe('/x/y');
  });

  it('parseEnv / serializeEnv gestiscono commenti, virgolette e uguali nei valori', () => {
    const env = parseEnv('# commento\nA=1\nB="due = 2"\n\nC=x=y\n');
    expect(env).toEqual({ A: '1', B: 'due = 2', C: 'x=y' });
    expect(parseEnv(serializeEnv(env))).toEqual(env);
  });

  it('writeEnv crea cartella 700 e file 600, unisce e registra i segreti', () => {
    const s = createStore({ dir, platform: 'linux' });
    s.writeEnv({ RUNPOD_API_KEY: 'rpa_SEGRETOFINTO1234' });
    s.writeEnv({ HF_TOKEN: 'hf_TOKENFINTO1234567' });
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, '.env'))).toBe(0o600);
    expect(s.readEnv()).toEqual({ RUNPOD_API_KEY: 'rpa_SEGRETOFINTO1234', HF_TOKEN: 'hf_TOKENFINTO1234567' });
    expect(redact('x rpa_SEGRETOFINTO1234')).toBe('x <REDATTO>');
  });

  it('checkPermissions rifiuta un .env leggibile da altri', () => {
    const s = createStore({ dir, platform: 'linux' });
    s.writeEnv({ A: '1' });
    fs.chmodSync(path.join(dir, '.env'), 0o644);
    expect(() => s.checkPermissions()).toThrow(expect.objectContaining({ code: 'CONFIG_PERMISSIONS' }));
  });

  it('profili: nome valido, round-trip, elenco', () => {
    const s = createStore({ dir, platform: 'linux' });
    s.writeProfile({ name: 'qwen3-coder', model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' } });
    expect(s.readProfile('qwen3-coder').model.id).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');
    expect(s.listProfiles()).toEqual(['qwen3-coder']);
    expect(mode(path.join(dir, 'profiles', 'qwen3-coder.json'))).toBe(0o600);
    expect(() => s.readProfile('inesistente')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('assertProfileName e profileKeyVar', () => {
    expect(() => assertProfileName('Org/Model')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => assertProfileName('qwen3-coder-30b')).not.toThrow();
    expect(profileKeyVar('qwen3-coder-30b')).toBe('LLMPOD_KEY_QWEN3_CODER_30B');
  });

  it('readConfig fornisce i default', () => {
    const s = createStore({ dir, platform: 'linux' });
    expect(s.readConfig()).toMatchObject({ cloud: 'SECURE', vllmImage: 'vllm/vllm-openai:v0.30.0-cu129', volumePricePerGbMonth: 0.07, watchdog: { idleMinutes: 30, maxHours: 8 } });
    s.writeConfig({ dataCenterId: 'EU-RO-1' });
    expect(s.readConfig().dataCenterId).toBe('EU-RO-1');
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/config.test.js`
Atteso: FAIL, modulo non trovato.

- [ ] **Passo 3: implementazione**

`src/core/config.js`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmpodError, Codes } from './errors.js';
import { registerSecret } from './secrets.js';

export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SECRET_VAR = /KEY|TOKEN|SECRET/;
const DEFAULT_CONFIG = {
  cloud: 'SECURE',
  vllmImage: 'vllm/vllm-openai:v0.30.0-cu129',
  minCudaVersion: '12.9',
  volumePricePerGbMonth: 0.07,
  watchdog: { idleMinutes: 30, maxHours: 8 },
};

export function configDir(env = process.env) {
  return env.LLMPOD_CONFIG_DIR || path.join(os.homedir(), '.config', 'llmpod');
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

export function serializeEnv(obj) {
  return Object.entries(obj)
    .map(([k, v]) => (/[\s"#=]/.test(v) ? `${k}="${String(v).replace(/"/g, '\\"')}"` : `${k}=${v}`))
    .join('\n') + '\n';
}

export function assertProfileName(name) {
  if (!PROFILE_NAME.test(name ?? '')) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Nome profilo non valido: "${name}"`, {
      hint: 'Usa lettere minuscole, numeri e trattini (max 41 caratteri), es. qwen3-coder-30b',
    });
  }
}

export const profileKeyVar = (name) => `LLMPOD_KEY_${name.toUpperCase().replace(/-/g, '_')}`;

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function createStore({ dir = configDir(), platform = process.platform } = {}) {
  const p = (...parts) => path.join(dir, ...parts);

  function ensureDir() {
    fs.mkdirSync(p('profiles'), { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }

  function checkPermissions() {
    if (platform === 'win32' || !fs.existsSync(p('.env'))) return;
    const m = fs.statSync(p('.env')).mode & 0o777;
    if (m & 0o077) {
      throw new LlmpodError(Codes.CONFIG_PERMISSIONS, `Il file ${p('.env')} è leggibile da altri utenti (permessi ${m.toString(8)})`, {
        hint: `Esegui: chmod 600 "${p('.env')}"`,
      });
    }
  }

  function readEnv() {
    if (!fs.existsSync(p('.env'))) return {};
    const env = parseEnv(fs.readFileSync(p('.env'), 'utf8'));
    for (const [k, v] of Object.entries(env)) if (SECRET_VAR.test(k)) registerSecret(v);
    return env;
  }

  function writeEnv(patch) {
    ensureDir();
    const next = { ...readEnv(), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    writeAtomic(p('.env'), serializeEnv(next));
    readEnv();
  }

  function readJson(name, fallback) {
    const f = p(name);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback;
  }

  function writeJson(name, data) {
    ensureDir();
    writeAtomic(p(name), JSON.stringify(data, null, 2) + '\n');
  }

  const readConfig = () => {
    const c = readJson('config.json', {});
    return { ...DEFAULT_CONFIG, ...c, watchdog: { ...DEFAULT_CONFIG.watchdog, ...c.watchdog } };
  };
  const writeConfig = (patch) => writeJson('config.json', { ...readJson('config.json', {}), ...patch });

  function readProfile(name) {
    assertProfileName(name);
    const prof = readJson(path.join('profiles', `${name}.json`), null);
    if (!prof) throw new LlmpodError(Codes.NOT_FOUND, `Profilo "${name}" non trovato`, { hint: 'Elenca i profili con: llmpod status' });
    return prof;
  }

  function writeProfile(profile) {
    assertProfileName(profile.name);
    writeJson(path.join('profiles', `${profile.name}.json`), profile);
  }

  const listProfiles = () => (fs.existsSync(p('profiles'))
    ? fs.readdirSync(p('profiles')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
    : []);

  return {
    dir, ensureDir, checkPermissions, readEnv, writeEnv, readJson, writeJson, readConfig, writeConfig,
    readProfile, writeProfile, listProfiles,
    readState: () => readJson('state.json', { pods: {} }),
    writeState: (s) => writeJson('state.json', s),
  };
}
```

- [ ] **Passo 4: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/config.test.js`
Atteso: PASS (7 test).

- [ ] **Passo 5: commit e push**

```bash
git add src/core/config.js test/core/config.test.js
git commit -m "feat: configurazione locale, .env 600, profili e stato"
git push
```

---
### Attività 5: Client Hugging Face e riferimenti al modello

**File:**
- Crea: `src/core/hf.js`
- Test: `test/core/hf.test.js`

**Interfacce:**
- Consuma: `createHttp`/`httpError` (Attività 3), `LlmpodError`/`Codes`.
- Produce:
  - `parseModelRef(input: string) → { id: string, revision: string }` — accetta `org/modello`, `org/modello@rev`, `https://huggingface.co/org/modello[/tree/<rev>|/blob/<rev>/…]`, `hf.co/org/modello`; revisione di default `main`; altrimenti `INVALID_INPUT`.
  - `summarizeModel(raw) → { id, downloads, lastModified, gated, license, params, paramsByDtype, dtypes, libraryName, architectures, modelType, hasChatTemplate }` (campi assenti → `null`/`[]`/`false`).
  - `createHf({ http, token? })` → `{ searchModels(query, { limit = 20 }) → summary[], getModel(id) → raw, resolveSha(id, revision) → string, listFiles(id, sha) → tree[], getConfig(id, sha) → object, getReadme(id, sha) → string|null, checkAccess(id, sha) → { ok, status } }`.
  - `getConfig`: 401 → `GATED_MODEL` se il modello è gated, altrimenti `HF_AUTH`; 403 → `GATED_MODEL` con suggerimento del link `https://huggingface.co/<id>` per richiedere l'accesso; 404 → `NOT_FOUND`.

- [ ] **Passo 1: scrivere il test che fallisce**

`test/core/hf.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { parseModelRef, summarizeModel, createHf } from '../../src/core/hf.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const fakeHttp = (routes) => ({
  request: vi.fn(async (method, url) => {
    for (const [re, res] of routes) if (re.test(`${method} ${url}`)) return typeof res === 'function' ? res(url) : res;
    throw new Error(`rotta non prevista: ${method} ${url}`);
  }),
});

describe('parseModelRef', () => {
  it.each([
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'main'],
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct@b2cff64', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'b2cff64'],
    ['https://huggingface.co/zai-org/GLM-4.6', 'zai-org/GLM-4.6', 'main'],
    ['https://huggingface.co/zai-org/GLM-4.6/tree/v1.0', 'zai-org/GLM-4.6', 'v1.0'],
    ['https://huggingface.co/zai-org/GLM-4.6/blob/main/config.json', 'zai-org/GLM-4.6', 'main'],
    ['hf.co/meta-llama/Llama-3.3-70B-Instruct', 'meta-llama/Llama-3.3-70B-Instruct', 'main'],
    ['  org/model  ', 'org/model', 'main'],
  ])('%s', (input, id, revision) => {
    expect(parseModelRef(input)).toEqual({ id, revision });
  });

  it.each(['', 'solo-nome', 'a/b/c d', 'https://example.com/org/model'])('rifiuta %j', (input) => {
    expect(() => parseModelRef(input)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('summarizeModel', () => {
  it('estrae i campi utili dal modello reale', () => {
    const s = summarizeModel(fx('model-qwen3-coder-30b.json'));
    expect(s).toMatchObject({
      id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', gated: false, params: 30532122624, dtypes: ['BF16'],
      architectures: ['Qwen3MoeForCausalLM'], modelType: 'qwen3_moe', hasChatTemplate: true,
    });
    expect(typeof s.license).toBe('string');
  });

  it('tollera campi mancanti (risultati di ricerca senza expand)', () => {
    const s = summarizeModel(fx('search-qwen3-coder.json')[0]);
    expect(s.params).toBeNull();
    expect(s.hasChatTemplate).toBe(false);
  });
});

describe('createHf', () => {
  it('searchModels chiede text-generation ordinati per download con expand', async () => {
    const http = fakeHttp([[/GET https:\/\/huggingface\.co\/api\/models$/, { ok: true, status: 200, data: fx('search-qwen3-coder.json') }]]);
    const hf = createHf({ http });
    const list = await hf.searchModels('qwen3 coder', { limit: 5 });
    const [, , opts] = http.request.mock.calls[0];
    expect(opts.query).toMatchObject({ search: 'qwen3 coder', filter: 'text-generation', sort: 'downloads', direction: -1, limit: 5 });
    expect(opts.query['expand[]']).toEqual(expect.arrayContaining(['safetensors', 'config', 'gated', 'cardData']));
    expect(list.length).toBeGreaterThan(0);
  });

  it('listFiles segue la paginazione Link', async () => {
    const page1 = { ok: true, status: 200, data: [{ type: 'file', path: 'a.safetensors', size: 1 }],
      headers: new Headers({ link: '<https://huggingface.co/api/models/o/m/tree/abc?recursive=true&cursor=X>; rel="next"' }) };
    const page2 = { ok: true, status: 200, data: [{ type: 'file', path: 'b.safetensors', size: 2 }], headers: new Headers() };
    const http = fakeHttp([[/cursor=X/, page2], [/tree\/abc/, page1]]);
    const files = await createHf({ http }).listFiles('o/m', 'abc');
    expect(files.map((f) => f.path)).toEqual(['a.safetensors', 'b.safetensors']);
  });

  it('getConfig traduce 403 in GATED_MODEL con link', async () => {
    const http = fakeHttp([[/resolve/, { ok: false, status: 403, data: 'Access denied', headers: new Headers() }]]);
    await expect(createHf({ http, token: 'hf_x' }).getConfig('meta-llama/Llama-4', 'main'))
      .rejects.toMatchObject({ code: 'GATED_MODEL', hint: expect.stringContaining('https://huggingface.co/meta-llama/Llama-4') });
  });

  it('invia il token solo se presente', async () => {
    const http = fakeHttp([[/resolve/, { ok: true, status: 200, data: { a: 1 }, headers: new Headers() }]]);
    await createHf({ http, token: 'hf_TOKENFINTO123456' }).getConfig('o/m', 'abc');
    expect(http.request.mock.calls[0][2].headers.authorization).toBe('Bearer hf_TOKENFINTO123456');
    const http2 = fakeHttp([[/resolve/, { ok: true, status: 200, data: { a: 1 }, headers: new Headers() }]]);
    await createHf({ http: http2 }).getConfig('o/m', 'abc');
    expect(http2.request.mock.calls[0][2].headers.authorization).toBeUndefined();
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/hf.test.js`
Atteso: FAIL, modulo non trovato.

- [ ] **Passo 3: implementazione**

`src/core/hf.js`:

```js
import { LlmpodError, Codes } from './errors.js';
import { httpError } from './http.js';

const HF = 'https://huggingface.co';
const ID = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const EXPAND = ['downloads', 'lastModified', 'gated', 'safetensors', 'config', 'cardData', 'library_name', 'tags', 'pipeline_tag', 'sha'];

export function parseModelRef(input) {
  let s = String(input ?? '').trim();
  let revision = 'main';
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/\s]+\/[^/\s]+)(?:\/(?:tree|blob|resolve)\/([^/\s]+).*)?\/?$/);
  if (url) {
    s = url[1];
    if (url[2]) revision = url[2];
  } else if (/^[a-z]+:\/\//i.test(s)) {
    s = '';
  } else if (s.includes('@')) {
    [s, revision] = s.split('@');
  }
  if (!ID.test(s) || !revision) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Riferimento al modello non valido: "${input}"`, {
      hint: 'Usa org/modello, org/modello@revisione o l\'URL della pagina Hugging Face',
    });
  }
  return { id: s, revision };
}

export function summarizeModel(m) {
  const licenseTag = (m.tags ?? []).find((t) => t.startsWith('license:'));
  const tok = m.config?.tokenizer_config;
  return {
    id: m.id,
    downloads: m.downloads ?? null,
    lastModified: m.lastModified ?? null,
    gated: m.gated ?? false,
    license: m.cardData?.license ?? (licenseTag ? licenseTag.slice(8) : null),
    params: m.safetensors?.total ?? null,
    paramsByDtype: m.safetensors?.parameters ?? null,
    dtypes: Object.keys(m.safetensors?.parameters ?? {}),
    libraryName: m.library_name ?? null,
    architectures: m.config?.architectures ?? [],
    modelType: m.config?.model_type ?? null,
    hasChatTemplate: Boolean(tok?.chat_template || m.config?.chat_template_jinja),
  };
}

const enc = (id) => id.split('/').map(encodeURIComponent).join('/');
const nextLink = (headers) => headers?.get?.('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;

export function createHf({ http, token } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const get = (url, opts = {}) => http.request('GET', url, { headers, ...opts });

  async function api(url, what, opts) {
    const r = await get(url, opts);
    if (!r.ok) throw httpError(r, what);
    return r;
  }

  async function resolveFile(id, sha, file, what) {
    const r = await get(`${HF}/${enc(id)}/resolve/${encodeURIComponent(sha)}/${file}`, { timeoutMs: 60000 });
    if (r.ok) return r.data;
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) {
      const gatedHint = `Richiedi l'accesso su https://huggingface.co/${id} e imposta HF_TOKEN con "llmpod init"`;
      if (r.status === 403 || token) throw new LlmpodError(Codes.GATED_MODEL, `Accesso negato a ${id}`, { hint: gatedHint });
      throw new LlmpodError(Codes.HF_AUTH, `${what}: serve un token Hugging Face per ${id}`, { hint: gatedHint });
    }
    throw httpError(r, what);
  }

  return {
    async searchModels(query, { limit = 20 } = {}) {
      const r = await api(`${HF}/api/models`, 'Ricerca Hugging Face', {
        query: { search: query, filter: 'text-generation', sort: 'downloads', direction: -1, limit, 'expand[]': EXPAND },
      });
      return r.data.map(summarizeModel);
    },
    async getModel(id) {
      return (await api(`${HF}/api/models/${enc(id)}`, `Modello ${id}`, { query: { 'expand[]': EXPAND } })).data;
    },
    async resolveSha(id, revision) {
      return (await api(`${HF}/api/models/${enc(id)}/revision/${encodeURIComponent(revision)}`, `Revisione ${revision}`)).data.sha;
    },
    async listFiles(id, sha) {
      const files = [];
      let url = `${HF}/api/models/${enc(id)}/tree/${encodeURIComponent(sha)}?recursive=true`;
      while (url) {
        const r = await api(url, `File di ${id}`);
        files.push(...r.data);
        url = nextLink(r.headers);
      }
      return files;
    },
    async getConfig(id, sha) {
      const cfg = await resolveFile(id, sha, 'config.json', `Config di ${id}`);
      if (!cfg) throw new LlmpodError(Codes.NOT_FOUND, `config.json non trovato per ${id}@${sha}`);
      return cfg;
    },
    async getReadme(id, sha) {
      const t = await resolveFile(id, sha, 'README.md', `README di ${id}`);
      return typeof t === 'string' ? t : t ? JSON.stringify(t) : null;
    },
    async checkAccess(id, sha) {
      const r = await http.request('HEAD', `${HF}/${enc(id)}/resolve/${encodeURIComponent(sha)}/config.json`, { headers });
      return { ok: r.ok, status: r.status };
    },
  };
}
```

- [ ] **Passo 4: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/hf.test.js`
Atteso: PASS (17 test).

- [ ] **Passo 5: commit e push**

```bash
git add src/core/hf.js test/core/hf.test.js
git commit -m "feat: client Hugging Face e parsing dei riferimenti al modello"
git push
```

---

### Attività 6: Client Runpod (REST v2 + saldo GraphQL)

**File:**
- Crea: `src/core/runpod.js`
- Test: `test/core/runpod.test.js`

**Interfacce:**
- Consuma: `httpError`, `LlmpodError`/`Codes`.
- Produce: `RUNPOD_API = 'https://api.runpod.io/v2'`, `proxyUrl(podId, port) → "https://<podId>-<port>.proxy.runpod.net"`, `createRunpod({ http, apiKey, base = RUNPOD_API })` →
  - `listGpus({ count = 1, cloud = 'SECURE', minCudaVersion }) → gpu[]`
  - `listDataCenters() → dc[]` (con `include=GPU_AVAILABILITY`)
  - `listPods() → pod[]` (segue `pagination.nextCursor`)
  - `getPod(id) → pod | null` (404 → `null`)
  - `createPod(body) → { status, data }` **grezzo** (lo interpreta il launcher)
  - `deletePod(id) → void` (204 o 404 = ok)
  - `listVolumes() → volume[]`, `createVolume({ name, size, dataCenter }) → volume`, `deleteVolume(id) → void`
  - `getBalance() → { balance: number, spendPerHour: number }` via GraphQL
  - Errori: 401/403 → `RUNPOD_AUTH`; 402 → `INSUFFICIENT_BALANCE`; altri → `RUNPOD_API` (messaggio da `httpError`).

- [ ] **Passo 1: scrivere il test che fallisce**

`test/core/runpod.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { createRunpod, proxyUrl } from '../../src/core/runpod.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/runpod/${p}`, import.meta.url), 'utf8'));
const ok = (data, status = 200) => ({ ok: status < 300, status, data, headers: new Headers() });

function setup(handler) {
  const http = { request: vi.fn(handler) };
  return { http, rp: createRunpod({ http, apiKey: 'rpa_SEGRETOFINTO1234' }) };
}

describe('runpod', () => {
  it('proxyUrl', () => {
    expect(proxyUrl('abc123', 8000)).toBe('https://abc123-8000.proxy.runpod.net');
  });

  it('listGpus passa i filtri di disponibilità e l\'autorizzazione', async () => {
    const { http, rp } = setup(async () => ok(fx('catalog-gpus-count1.json')));
    const gpus = await rp.listGpus({ count: 2, minCudaVersion: '12.9' });
    const [method, url, opts] = http.request.mock.calls[0];
    expect(method).toBe('GET');
    expect(url).toBe('https://api.runpod.io/v2/catalog/gpus');
    expect(opts.query).toEqual({ include: 'AVAILABILITY', product: 'POD', count: 2, cloud: 'SECURE', minCudaVersion: '12.9' });
    expect(opts.headers.authorization).toBe('Bearer rpa_SEGRETOFINTO1234');
    expect(gpus.some((g) => g.id === 'NVIDIA H100 80GB HBM3')).toBe(true);
  });

  it('listPods segue la paginazione', async () => {
    const { rp } = setup(async (m, url, opts) => (opts.query?.cursor
      ? ok({ pagination: { hasNextPage: false, nextCursor: null }, pods: [{ id: 'b' }] })
      : ok({ pagination: { hasNextPage: true, nextCursor: 'C1' }, pods: [{ id: 'a' }] })));
    expect((await rp.listPods()).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('getPod restituisce null su 404', async () => {
    const { rp } = setup(async () => ok(fx('error-404.json'), 404));
    expect(await rp.getPod('xyz')).toBeNull();
  });

  it('deletePod accetta 204 e 404', async () => {
    const { rp } = setup(async () => ok(null, 204));
    await expect(rp.deletePod('a')).resolves.toBeUndefined();
    const { rp: rp2 } = setup(async () => ok(fx('error-404.json'), 404));
    await expect(rp2.deletePod('a')).resolves.toBeUndefined();
  });

  it('volumi su /v2/network-volumes', async () => {
    const { http, rp } = setup(async (m) => (m === 'GET' ? ok(fx('networkvolumes-list.json')) : ok({ id: 'v1', name: 'llmpod-pesi', size: 150, dataCenter: 'EU-RO-1' }, 201)));
    expect(await rp.listVolumes()).toEqual([]);
    const v = await rp.createVolume({ name: 'llmpod-pesi', size: 150, dataCenter: 'EU-RO-1' });
    expect(v.id).toBe('v1');
    const [, url, opts] = http.request.mock.calls[1];
    expect(url).toBe('https://api.runpod.io/v2/network-volumes');
    expect(opts.json).toEqual({ name: 'llmpod-pesi', size: 150, dataCenter: 'EU-RO-1' });
  });

  it('getBalance usa GraphQL', async () => {
    const { http, rp } = setup(async () => ok({ data: { myself: { clientBalance: 49.5, currentSpendPerHr: 0 } } }));
    expect(await rp.getBalance()).toEqual({ balance: 49.5, spendPerHour: 0 });
    expect(http.request.mock.calls[0][1]).toBe('https://api.runpod.io/graphql');
  });

  it('mappa 401/402 su codici specifici', async () => {
    const { rp } = setup(async () => ok({ title: 'Unauthorized', status: 401 }, 401));
    await expect(rp.listPods()).rejects.toMatchObject({ code: 'RUNPOD_AUTH' });
    const { rp: rp2 } = setup(async () => ok({ detail: 'insufficient balance', status: 402 }, 402));
    await expect(rp2.createVolume({ name: 'x', size: 10, dataCenter: 'EU-RO-1' })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/runpod.test.js`
Atteso: FAIL, modulo non trovato.

- [ ] **Passo 3: implementazione**

`src/core/runpod.js`:

```js
import { LlmpodError, Codes } from './errors.js';
import { httpError } from './http.js';

export const RUNPOD_API = 'https://api.runpod.io/v2';
const GRAPHQL = 'https://api.runpod.io/graphql';

export const proxyUrl = (podId, port) => `https://${podId}-${port}.proxy.runpod.net`;

function runpodError(res, what) {
  const base = httpError(res, what);
  if (res.status === 401 || res.status === 403) {
    return new LlmpodError(Codes.RUNPOD_AUTH, base.message, { hint: 'Verifica RUNPOD_API_KEY e i suoi permessi con "llmpod init"' });
  }
  if (res.status === 402) {
    return new LlmpodError(Codes.INSUFFICIENT_BALANCE, base.message, { hint: 'Ricarica il credito su https://www.runpod.io/console/user/billing' });
  }
  return new LlmpodError(Codes.RUNPOD_API, base.message, { details: { status: res.status } });
}

export function createRunpod({ http, apiKey, base = RUNPOD_API }) {
  const headers = { authorization: `Bearer ${apiKey}` };
  const req = (method, path, opts = {}) => http.request(method, `${base}${path}`, { headers, ...opts });
  async function call(method, path, opts, what) {
    const r = await req(method, path, opts);
    if (!r.ok) throw runpodError(r, what);
    return r.data;
  }

  return {
    listGpus: async ({ count = 1, cloud = 'SECURE', minCudaVersion } = {}) =>
      (await call('GET', '/catalog/gpus', { query: { include: 'AVAILABILITY', product: 'POD', count, cloud, minCudaVersion } }, 'Catalogo GPU')).gpus,

    listDataCenters: async () =>
      (await call('GET', '/catalog/datacenters', { query: { include: 'GPU_AVAILABILITY' } }, 'Datacenter')).dataCenters,

    async listPods() {
      const pods = [];
      let cursor;
      do {
        const d = await call('GET', '/pods', { query: cursor ? { cursor } : {} }, 'Elenco Pod');
        pods.push(...d.pods);
        cursor = d.pagination?.hasNextPage ? d.pagination.nextCursor : null;
      } while (cursor);
      return pods;
    },

    async getPod(id) {
      const r = await req('GET', `/pods/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      if (!r.ok) throw runpodError(r, `Pod ${id}`);
      return r.data;
    },

    createPod: async (body) => {
      const r = await req('POST', '/pods', { json: body, timeoutMs: 60000 });
      return { status: r.status, data: r.data };
    },

    async deletePod(id) {
      const r = await req('DELETE', `/pods/${encodeURIComponent(id)}`);
      if (!r.ok && r.status !== 404) throw runpodError(r, `Terminazione Pod ${id}`);
    },

    listVolumes: async () => (await call('GET', '/network-volumes', {}, 'Network volume')).networkVolumes,
    createVolume: ({ name, size, dataCenter }) =>
      call('POST', '/network-volumes', { json: { name, size, dataCenter } }, 'Creazione network volume'),
    async deleteVolume(id) {
      const r = await req('DELETE', `/network-volumes/${encodeURIComponent(id)}`);
      if (!r.ok && r.status !== 404) throw runpodError(r, `Eliminazione volume ${id}`);
    },

    async getBalance() {
      const r = await http.request('POST', GRAPHQL, { headers, json: { query: '{ myself { clientBalance currentSpendPerHr } }' } });
      if (!r.ok || r.data?.errors) throw runpodError(r.ok ? { status: 403, data: { detail: r.data.errors[0]?.message } } : r, 'Credito Runpod');
      const m = r.data.data.myself;
      return { balance: Number(m.clientBalance), spendPerHour: Number(m.currentSpendPerHr ?? 0) };
    },
  };
}
```

- [ ] **Passo 4: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/runpod.test.js`
Atteso: PASS (8 test).

- [ ] **Passo 5: commit e push**

```bash
git add src/core/runpod.js test/core/runpod.test.js
git commit -m "feat: client Runpod REST v2 e saldo GraphQL"
git push
```

---

### Attività 7: Stima della VRAM

**File:**
- Crea: `src/core/planner/vram.js`
- Test: `test/core/vram.test.js`

**Interfacce:**
- Produce:
  - `GiB = 1024 ** 3`
  - `weightsBytes(tree) → number` (somma dei `*.safetensors`, usa `lfs.size` se presente)
  - `kvBytesPerToken(config, kvDtypeBytes = 2) → { bytes, kind: 'mla' | 'full' }` — usa `config.text_config` se presente; MLA se `kv_lora_rank` e `qk_rope_head_dim`; altrimenti attenzione completa (stima prudente anche per architetture a finestra scorrevole/ibride, che quindi risultano sovrastimate, mai sottostimate); `head_dim` assente → `hidden_size / num_attention_heads`.
  - `estimate({ weightsBytes, kvPerToken, context, concurrency, tp, overheadGiB = 2 }) → { weightsGiB, kvGiB, perGpuGiB }`
  - `fits(perGpuGiB, gpuMemGiB, util = 0.9) → boolean`
  - `tpSizes(config) → number[]` (sottoinsieme di `[1, 2, 4, 8]` che divide `num_attention_heads`)
  - `bytesFromSafetensorsParams(parameters) → number | null` — stima dei pesi dal campo `safetensors.parameters` dell'API HF (elementi per dtype × byte del dtype; usata da `search`, dove l'albero dei file non è disponibile)

- [ ] **Passo 1: scrivere il test che fallisce**

`test/core/vram.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { GiB, weightsBytes, kvBytesPerToken, estimate, fits, tpSizes, bytesFromSafetensorsParams } from '../../src/core/planner/vram.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));

describe('vram', () => {
  it('somma i pesi safetensors reali di Qwen3-Coder-30B', () => {
    expect(weightsBytes(fx('tree-qwen3-coder-30b.json'))).toBe(61066575656);
  });

  it('KV per token con GQA (Qwen3-Coder: 2×48×4×128×2)', () => {
    expect(kvBytesPerToken(fx('config-qwen3-coder-30b.json'))).toEqual({ bytes: 98304, kind: 'full' });
  });

  it('KV per token con MLA (DeepSeek-V3: (512+64)×61×2)', () => {
    expect(kvBytesPerToken(fx('config-deepseek-v3.json'))).toEqual({ bytes: 70272, kind: 'mla' });
  });

  it('KV per token GLM-4.6 e Llama-3.3-70B', () => {
    expect(kvBytesPerToken(fx('config-glm.json')).bytes).toBe(376832);
    expect(kvBytesPerToken(fx('config-llama.json')).bytes).toBe(327680);
  });

  it('head_dim mancante e text_config annidato', () => {
    const cfg = { text_config: { num_hidden_layers: 2, num_attention_heads: 8, num_key_value_heads: 2, hidden_size: 1024 } };
    expect(kvBytesPerToken(cfg).bytes).toBe(2 * 2 * 2 * 128 * 2);
  });

  it('stima per GPU: Qwen3-Coder 64K×2 su 1 GPU ≈ 70,9 GiB, entra in 80 GB', () => {
    const e = estimate({ weightsBytes: 61066575656, kvPerToken: 98304, context: 65536, concurrency: 2, tp: 1 });
    expect(e.kvGiB).toBeCloseTo(12, 5);
    expect(e.weightsGiB).toBeCloseTo(56.87, 2);
    expect(e.perGpuGiB).toBeCloseTo(70.87, 2);
    expect(fits(e.perGpuGiB, 80)).toBe(true);
    expect(fits(e.perGpuGiB, 48)).toBe(false);
    const e2 = estimate({ weightsBytes: 61066575656, kvPerToken: 98304, context: 65536, concurrency: 2, tp: 2 });
    expect(e2.perGpuGiB).toBeCloseTo(36.44, 2);
    expect(fits(e2.perGpuGiB, 48)).toBe(true);
  });

  it('bytesFromSafetensorsParams moltiplica per la dimensione del dtype', () => {
    expect(bytesFromSafetensorsParams({ BF16: 10, F8_E4M3: 4, F32: 1 })).toBe(10 * 2 + 4 + 4);
    expect(bytesFromSafetensorsParams({ BF16: 30532122624 })).toBe(61064245248);
    expect(bytesFromSafetensorsParams(undefined)).toBeNull();
  });

  it('tpSizes rispetta il numero di attention heads', () => {
    expect(tpSizes({ num_attention_heads: 32 })).toEqual([1, 2, 4, 8]);
    expect(tpSizes({ num_attention_heads: 12 })).toEqual([1, 2, 4]);
    expect(tpSizes({ num_attention_heads: 40, text_config: undefined })).toEqual([1, 2, 4, 8]);
    expect(tpSizes({ num_attention_heads: 6 })).toEqual([1, 2]);
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/vram.test.js`
Atteso: FAIL, modulo non trovato.

- [ ] **Passo 3: implementazione**

`src/core/planner/vram.js`:

```js
export const GiB = 1024 ** 3;

const textConfig = (config) => config.text_config ?? config;

export function weightsBytes(tree) {
  return tree
    .filter((f) => f.type === 'file' && f.path.endsWith('.safetensors'))
    .reduce((sum, f) => sum + (f.lfs?.size ?? f.size ?? 0), 0);
}

export function kvBytesPerToken(config, kvDtypeBytes = 2) {
  const c = textConfig(config);
  const layers = c.num_hidden_layers;
  if (c.kv_lora_rank && c.qk_rope_head_dim) {
    return { bytes: (c.kv_lora_rank + c.qk_rope_head_dim) * layers * kvDtypeBytes, kind: 'mla' };
  }
  const heads = c.num_attention_heads;
  const kvHeads = c.num_key_value_heads ?? heads;
  const headDim = c.head_dim ?? c.hidden_size / heads;
  // Stima prudente: anche le architetture a finestra scorrevole/ibride sono trattate ad attenzione completa.
  return { bytes: 2 * layers * kvHeads * headDim * kvDtypeBytes, kind: 'full' };
}

export function estimate({ weightsBytes: w, kvPerToken, context, concurrency, tp, overheadGiB = 2 }) {
  const kvBytes = kvPerToken * context * concurrency;
  return {
    weightsGiB: w / GiB,
    kvGiB: kvBytes / GiB,
    perGpuGiB: (w / tp + kvBytes / tp) / GiB + overheadGiB,
  };
}

export const fits = (perGpuGiB, gpuMemGiB, util = 0.9) => perGpuGiB <= gpuMemGiB * util;

export function tpSizes(config) {
  const heads = textConfig(config).num_attention_heads;
  return [1, 2, 4, 8].filter((n) => heads % n === 0);
}

const DTYPE_BYTES = { F64: 8, I64: 8, F32: 4, I32: 4, U32: 4, BF16: 2, F16: 2, I16: 2, U16: 2, F8_E4M3: 1, F8_E5M2: 1, I8: 1, U8: 1, BOOL: 1 };

export function bytesFromSafetensorsParams(parameters) {
  if (!parameters) return null;
  return Object.entries(parameters).reduce((sum, [dtype, count]) => sum + count * (DTYPE_BYTES[dtype] ?? 2), 0);
}
```

- [ ] **Passo 4: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/vram.test.js`
Atteso: PASS (8 test).

- [ ] **Passo 5: commit e push**

```bash
git add src/core/planner/vram.js test/core/vram.test.js
git commit -m "feat: stima VRAM (pesi, KV cache GQA/MLA, tensor parallel)"
git push
```

---

### Attività 8: Parser, argomenti di vLLM e validazione dei flag

**File:**
- Crea: `data/parsers.json`, `src/core/planner/vllm-args.js`
- Test: `test/core/vllm-args.test.js`

**Interfacce:**
- Produce:
  - `detectParsers({ modelId, config }) → { tool: string|null, reasoning: string|null, extraArgs: string[], warnings: string[] }` — regole in ordine, la prima che corrisponde vince; corrispondenza su `modelType` (stringa o array, da `config.model_type`), `architectures` (da `config.architectures`) e `idPattern` (regex case-insensitive sull'id del modello). Nessuna regola → `tool: null` e avviso `UNKNOWN_TOOL_PARSER`.
  - `buildArgs({ context, tp, revision, parsers, gpuUtil = 0.9, kvCacheDtype? }) → string[]` (senza `--served-model-name`, aggiunto al momento dell'`up`).
  - `applyOverrides(args, { set = [], extra = [] }) → string[]` — `set` è `["chiave=valore", …]` → imposta/sostituisce `--chiave valore` (`chiave=true` → flag senza valore; `chiave=false` → rimosso); `extra` è un array di token aggiunti in coda.
  - `loadFlags(version = 'v0.30.0') → Set<string>`; `validateArgs(args, flags, { allowTrustRemoteCode = false }) → { unknown: string[], forbidden: string[] }`. Vietati sempre: `--api-key`, `--host`, `--port`, `--allowed-local-media-path`, `--served-model-name`; `--trust-remote-code` vietato salvo `allowTrustRemoteCode`.
  - `VLLM_VERSION = 'v0.30.0'`.

- [ ] **Passo 1: creare `data/parsers.json`**

```json
{
  "vllmVersion": "v0.30.0",
  "rules": [
    { "modelType": "kimi_k2", "idPattern": "thinking", "tool": "kimi_k2", "reasoning": "kimi_k2" },
    { "modelType": "kimi_k2", "tool": "kimi_k2" },
    { "architectures": ["DeepseekV32ForCausalLM"], "tool": "deepseek_v32", "reasoning": "deepseek_v3" },
    { "modelType": "deepseek_v3", "idPattern": "v3\\.1", "tool": "deepseek_v31", "reasoning": "deepseek_v3",
      "warning": "DeepSeek-V3.1 richiede il chat template per gli strumenti di vLLM (examples/tool_chat_template_deepseekv31.jinja): verificarne la presenza nell'immagine" },
    { "modelType": "deepseek_v3", "tool": "deepseek_v3", "reasoning": "deepseek_v3",
      "warning": "DeepSeek-V3 richiede il chat template per gli strumenti di vLLM (examples/tool_chat_template_deepseekv3.jinja): verificarne la presenza nell'immagine" },
    { "architectures": ["GlmMoeDsaForCausalLM", "Glm5NextForConditionalGeneration", "Glm4MoeLiteForCausalLM"], "tool": "glm47", "reasoning": "glm47" },
    { "architectures": ["Glm4MoeForCausalLM"], "idPattern": "4\\.[7-9]", "tool": "glm47", "reasoning": "glm47" },
    { "architectures": ["Glm4MoeForCausalLM"], "tool": "glm45", "reasoning": "glm45" },
    { "architectures": ["MiniMaxM2ForCausalLM"], "tool": "minimax_m2", "reasoning": "minimax_m2" },
    { "architectures": ["GptOssForCausalLM"], "tool": "openai", "reasoning": "openai_gptoss" },
    { "architectures": ["Qwen3MoeForCausalLM", "Qwen3ForCausalLM"], "idPattern": "coder", "tool": "qwen3_coder" },
    { "architectures": ["Qwen3MoeForCausalLM", "Qwen3ForCausalLM"], "idPattern": "instruct-2507", "tool": "hermes" },
    { "architectures": ["Qwen3MoeForCausalLM", "Qwen3ForCausalLM"], "tool": "hermes", "reasoning": "qwen3" },
    { "architectures": ["Qwen2ForCausalLM"], "tool": "hermes" },
    { "architectures": ["Llama4ForConditionalGeneration"], "tool": "llama4_pythonic",
      "warning": "Llama 4 richiede un chat template per gli strumenti: verificare che quello del modello supporti tool calling" },
    { "architectures": ["LlamaForCausalLM"], "idPattern": "hermes", "tool": "hermes" },
    { "architectures": ["LlamaForCausalLM"], "tool": "llama3_json",
      "warning": "Llama 3.x richiede un chat template per gli strumenti: verificare che quello del modello supporti tool calling" },
    { "modelType": ["mistral", "mistral3"], "idPattern": "magistral", "tool": "mistral", "reasoning": "mistral", "extraArgs": ["--tokenizer-mode", "mistral"] },
    { "modelType": ["mistral", "mistral3"], "tool": "mistral", "extraArgs": ["--tokenizer-mode", "mistral"] },
    { "architectures": ["GraniteMoeHybridForCausalLM"], "tool": "granite4" },
    { "architectures": ["GraniteForCausalLM"], "tool": "granite", "reasoning": "granite" }
  ]
}
```

- [ ] **Passo 2: scrivere il test che fallisce**

`test/core/vllm-args.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { detectParsers, buildArgs, applyOverrides, loadFlags, validateArgs } from '../../src/core/planner/vllm-args.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const cfg = (architectures, model_type) => ({ architectures, model_type });

describe('detectParsers', () => {
  it.each([
    ['Qwen/Qwen3-Coder-30B-A3B-Instruct', fx('config-qwen3-coder-30b.json'), 'qwen3_coder', null],
    ['Qwen/Qwen3-30B-A3B-Thinking-2507', cfg(['Qwen3MoeForCausalLM'], 'qwen3_moe'), 'hermes', 'qwen3'],
    ['Qwen/Qwen3-30B-A3B-Instruct-2507', cfg(['Qwen3MoeForCausalLM'], 'qwen3_moe'), 'hermes', null],
    ['zai-org/GLM-4.6', fx('config-glm.json'), 'glm45', 'glm45'],
    ['zai-org/GLM-4.7', cfg(['Glm4MoeForCausalLM'], 'glm4_moe'), 'glm47', 'glm47'],
    ['zai-org/GLM-5.3', cfg(['GlmMoeDsaForCausalLM'], 'glm_moe_dsa'), 'glm47', 'glm47'],
    ['deepseek-ai/DeepSeek-V3-0324', fx('config-deepseek-v3.json'), 'deepseek_v3', 'deepseek_v3'],
    ['moonshotai/Kimi-K2-Instruct', cfg(['DeepseekV3ForCausalLM'], 'kimi_k2'), 'kimi_k2', null],
    ['moonshotai/Kimi-K2-Thinking', cfg(['DeepseekV3ForCausalLM'], 'kimi_k2'), 'kimi_k2', 'kimi_k2'],
    ['openai/gpt-oss-120b', cfg(['GptOssForCausalLM'], 'gpt_oss'), 'openai', 'openai_gptoss'],
    ['unsloth/Llama-3.3-70B-Instruct', fx('config-llama.json'), 'llama3_json', null],
  ])('%s → %s / %s', (modelId, config, tool, reasoning) => {
    const p = detectParsers({ modelId, config });
    expect(p.tool).toBe(tool);
    expect(p.reasoning).toBe(reasoning);
  });

  it('Kimi-K2 non viene scambiato per DeepSeek (model_type prima di architectures)', () => {
    expect(detectParsers({ modelId: 'x/Kimi', config: cfg(['DeepseekV3ForCausalLM'], 'kimi_k2') }).tool).toBe('kimi_k2');
  });

  it('Mistral aggiunge --tokenizer-mode mistral', () => {
    expect(detectParsers({ modelId: 'mistralai/Devstral-Small-2507', config: cfg(['MistralForCausalLM'], 'mistral') }).extraArgs)
      .toEqual(['--tokenizer-mode', 'mistral']);
    expect(detectParsers({ modelId: 'mistralai/Magistral-Small-2509', config: cfg(['X'], 'mistral3') })).toMatchObject({ tool: 'mistral', reasoning: 'mistral' });
  });

  it('architettura sconosciuta → nessun parser e avviso', () => {
    const p = detectParsers({ modelId: 'x/y', config: cfg(['FooForCausalLM'], 'foo') });
    expect(p.tool).toBeNull();
    expect(p.warnings[0]).toMatch(/UNKNOWN_TOOL_PARSER/);
  });
});

describe('buildArgs e override', () => {
  const parsers = { tool: 'qwen3_coder', reasoning: null, extraArgs: [], warnings: [] };

  it('costruisce gli argomenti di base', () => {
    expect(buildArgs({ context: 65536, tp: 1, revision: 'abc', parsers })).toEqual([
      '--max-model-len', '65536', '--tensor-parallel-size', '1', '--gpu-memory-utilization', '0.9',
      '--revision', 'abc', '--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_coder',
    ]);
  });

  it('aggiunge reasoning parser, kv-cache-dtype ed extraArgs', () => {
    const a = buildArgs({ context: 8192, tp: 2, revision: 'r', parsers: { tool: 'mistral', reasoning: 'mistral', extraArgs: ['--tokenizer-mode', 'mistral'] }, kvCacheDtype: 'fp8' });
    expect(a).toEqual(expect.arrayContaining(['--reasoning-parser', 'mistral', '--kv-cache-dtype', 'fp8', '--tokenizer-mode', 'mistral']));
  });

  it('senza tool parser non abilita auto-tool-choice', () => {
    expect(buildArgs({ context: 1, tp: 1, revision: 'r', parsers: { tool: null } })).not.toContain('--enable-auto-tool-choice');
  });

  it('applyOverrides sostituisce, aggiunge, toglie flag', () => {
    const base = ['--max-model-len', '65536', '--enable-prefix-caching'];
    expect(applyOverrides(base, { set: ['max-model-len=32768', 'enforce-eager=true', 'enable-prefix-caching=false'], extra: ['--seed', '1'] }))
      .toEqual(['--max-model-len', '32768', '--enforce-eager', '--seed', '1']);
  });
});

describe('validateArgs', () => {
  const flags = loadFlags();

  it('il file dei flag v0.30.0 contiene i flag principali', () => {
    for (const f of ['--max-model-len', '--tool-call-parser', '--reasoning-parser', '--kv-cache-dtype', '--tensor-parallel-size']) {
      expect(flags.has(f)).toBe(true);
    }
  });

  it('segnala flag sconosciuti e vietati', () => {
    const r = validateArgs(['--max-model-len', '1', '--inventato', '--api-key', 'x', '--host', '0.0.0.0', '--trust-remote-code'], flags);
    expect(r.unknown).toEqual(['--inventato']);
    expect(r.forbidden).toEqual(['--api-key', '--host', '--trust-remote-code']);
    expect(validateArgs(['--trust-remote-code'], flags, { allowTrustRemoteCode: true }).forbidden).toEqual([]);
  });

  it('accetta la forma --flag=valore', () => {
    expect(validateArgs(['--max-model-len=4096'], flags)).toEqual({ unknown: [], forbidden: [] });
  });
});
```

- [ ] **Passo 3: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/vllm-args.test.js`
Atteso: FAIL, modulo non trovato.

- [ ] **Passo 4: implementazione**

`src/core/planner/vllm-args.js`:

```js
import fs from 'node:fs';

export const VLLM_VERSION = 'v0.30.0';
const dataFile = (name) => new URL(`../../../data/${name}`, import.meta.url);
const RULES = JSON.parse(fs.readFileSync(dataFile('parsers.json'), 'utf8')).rules;
const ALWAYS_FORBIDDEN = ['--api-key', '--host', '--port', '--allowed-local-media-path', '--served-model-name'];

function matches(rule, modelId, config) {
  if (rule.modelType && ![rule.modelType].flat().includes(config.model_type)) return false;
  if (rule.architectures && !(config.architectures ?? []).some((a) => rule.architectures.includes(a))) return false;
  if (rule.idPattern && !new RegExp(rule.idPattern, 'i').test(modelId)) return false;
  return true;
}

export function detectParsers({ modelId, config }) {
  const c = { ...(config.text_config ?? {}), ...config };
  const rule = RULES.find((r) => matches(r, modelId, c));
  if (!rule) {
    return {
      tool: null, reasoning: null, extraArgs: [],
      warnings: [`UNKNOWN_TOOL_PARSER: nessun tool-call parser noto per ${modelId} (${(c.architectures ?? []).join(', ') || c.model_type}); usa --set tool-call-parser=<nome>`],
    };
  }
  return {
    tool: rule.tool ?? null,
    reasoning: rule.reasoning ?? null,
    extraArgs: rule.extraArgs ?? [],
    warnings: rule.warning ? [rule.warning] : [],
  };
}

export function buildArgs({ context, tp, revision, parsers, gpuUtil = 0.9, kvCacheDtype }) {
  const args = [
    '--max-model-len', String(context),
    '--tensor-parallel-size', String(tp),
    '--gpu-memory-utilization', String(gpuUtil),
    '--revision', revision,
  ];
  if (parsers.tool) args.push('--enable-auto-tool-choice', '--tool-call-parser', parsers.tool);
  if (parsers.reasoning) args.push('--reasoning-parser', parsers.reasoning);
  if (kvCacheDtype) args.push('--kv-cache-dtype', kvCacheDtype);
  args.push(...(parsers.extraArgs ?? []));
  return args;
}

function removeFlag(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    if (args[i].startsWith(`${flag}=`)) continue;
    out.push(args[i]);
  }
  return out;
}

export function applyOverrides(args, { set = [], extra = [] } = {}) {
  let out = [...args];
  for (const item of set) {
    const i = item.indexOf('=');
    const key = i < 0 ? item : item.slice(0, i);
    const value = i < 0 ? 'true' : item.slice(i + 1);
    const flag = `--${key.replace(/^--/, '')}`;
    const pos = out.indexOf(flag);
    if (value === 'false') { out = removeFlag(out, flag); continue; }
    if (pos >= 0) {
      const hasValue = out[pos + 1] !== undefined && !out[pos + 1].startsWith('--');
      if (value === 'true') { if (hasValue) out.splice(pos + 1, 1); }
      else if (hasValue) out[pos + 1] = value;
      else out.splice(pos + 1, 0, value);
    } else {
      out.push(flag);
      if (value !== 'true') out.push(value);
    }
  }
  return [...out, ...extra];
}

export function loadFlags(version = VLLM_VERSION) {
  return new Set(JSON.parse(fs.readFileSync(dataFile(`vllm-flags-${version}.json`), 'utf8')));
}

export function validateArgs(args, flags, { allowTrustRemoteCode = false } = {}) {
  const unknown = [];
  const forbidden = [];
  for (const token of args) {
    if (!token.startsWith('--')) continue;
    const flag = token.split('=')[0];
    if (ALWAYS_FORBIDDEN.includes(flag) || (flag === '--trust-remote-code' && !allowTrustRemoteCode)) forbidden.push(flag);
    else if (!flags.has(flag)) unknown.push(flag);
  }
  return { unknown, forbidden };
}
```

- [ ] **Passo 5: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/vllm-args.test.js`
Atteso: PASS (21 test). Se il test "contiene i flag principali" fallisce, aprire `data/vllm-flags-v0.30.0.json` e confrontare con https://docs.vllm.ai/en/v0.30.0/cli/serve/ — il file deve essere un array JSON di stringhe che iniziano con `--`.

- [ ] **Passo 6: commit e push**

```bash
git add data/parsers.json src/core/planner/vllm-args.js test/core/vllm-args.test.js
git commit -m "feat: tool/reasoning parser per famiglia, argomenti vLLM e flag ammessi"
git push
```

---
### Attività 9: Selezione della GPU e piano completo

**File:**
- Crea: `src/core/planner/gpu-select.js`, `src/core/planner/plan.js`
- Test: `test/core/gpu-select.test.js`, `test/core/plan.test.js`

**Interfacce:**
- Consuma: `fits`, `estimate`, `kvBytesPerToken`, `weightsBytes`, `tpSizes` (Attività 7); `detectParsers`, `buildArgs`, `applyOverrides`, `validateArgs` (Attività 8); `parseModelRef`, `summarizeModel` (Attività 5); `runpod.listGpus` (Attività 6).
- Produce:
  - `selectGpus({ catalogs: { [tp]: gpu[] }, dataCenterId, needs: (tp) => perGpuGiB, tpSizes: number[], cloud = 'SECURE', util = 0.9, limit = 4 }) → { choice, alternatives, elsewhere, all }`. Ogni candidato: `{ gpuId, name, count, memoryGiB, hourly, perGpuGiB, headroomGiB, availabilityHere, elsewhere: [{ id, availability }] }`. Scarta GPU senza prezzo nel cloud scelto o con `maxCount[cloud] < count`. Ordina per `hourly` crescente, poi margine decrescente. `choice`/`alternatives` = candidati disponibili nel datacenter; `elsewhere` = candidati non disponibili lì ma disponibili altrove.
  - `makePlan({ hf, runpod, modelRef, context = 65536, concurrency = 2, cloud = 'SECURE', dataCenterId, minCudaVersion, vllmImage, set = [], extra = [], flags, allowTrustRemoteCode = false, onProgress = () => {} }) → Promise<Plan>` dove `Plan = { model: { id, revision, requestedRevision, gated, license, params, weightsBytes, maxContext }, context, concurrency, vllm: { image, args }, parsers: { tool, reasoning }, estimate: { weightsGiB, kvGiB, perGpuGiB }, gpu: { id, count } | null, hourlyUSD: number | null, alternatives: [{ id, count, hourly }], elsewhere: [...candidati], candidates: [...primi 10], dataCenterId, cloud, kvCacheDtype: 'fp8' | null, warnings: string[] }`.
  - Se nessun candidato entra con la KV cache in BF16, `makePlan` riprova con KV cache FP8 (metà dei byte) e lo segnala in `warnings`.
  - `--tensor-parallel-size` negli `args` corrisponde a `gpu.count` della scelta; per le alternative con un numero di GPU diverso lo aggiorna il launcher (Attività 11).

- [ ] **Passo 1: scrivere i test che falliscono**

`test/core/gpu-select.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { selectGpus } from '../../src/core/planner/gpu-select.js';

const gpu = (id, memory, price, dcs, maxCount = 8) => ({
  id, name: id, memory, price: { secure: price, community: 0 }, maxCount: { secure: maxCount, community: 0 },
  dataCenters: dcs.map(([dc, availability]) => ({ id: dc, name: dc, availability })),
});

describe('selectGpus', () => {
  const needs = (tp) => [0, 70.9, 36.4, 19.2, 10.6][Math.log2(tp) + 1];

  it('sceglie il candidato più economico disponibile nel datacenter, anche multi-GPU', () => {
    const catalogs = {
      1: [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU48', 48, 0.6, [['EU-A', 'LOW']])],
      2: [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU48', 48, 0.6, [['EU-A', 'LOW']])],
    };
    const r = selectGpus({ catalogs, dataCenterId: 'EU-A', needs, tpSizes: [1, 2] });
    expect(r.choice).toMatchObject({ gpuId: 'GPU48', count: 2, hourly: 1.2 });
    expect(r.alternatives.map((c) => `${c.gpuId}x${c.count}`)).toEqual(['GPU80x1', 'GPU80x2']);
  });

  it('separa i candidati disponibili solo altrove', () => {
    const catalogs = { 1: [gpu('GPU80', 80, 1.5, [['US-B', 'MEDIUM']])] };
    const r = selectGpus({ catalogs, dataCenterId: 'EU-A', needs, tpSizes: [1] });
    expect(r.choice).toBeNull();
    expect(r.elsewhere[0]).toMatchObject({ gpuId: 'GPU80', elsewhere: [{ id: 'US-B', availability: 'MEDIUM' }] });
  });

  it('scarta GPU non offerte nel cloud o con maxCount insufficiente', () => {
    const catalogs = { 2: [gpu('NOPRICE', 80, 0, [['EU-A', 'HIGH']]), gpu('MAX1', 80, 1, [['EU-A', 'HIGH']], 1)] };
    expect(selectGpus({ catalogs, dataCenterId: 'EU-A', needs, tpSizes: [2] }).all).toEqual([]);
  });

  it('sulle fixture reali: risultati ordinati per prezzo e tutti con VRAM sufficiente', () => {
    const c1 = JSON.parse(fs.readFileSync(new URL('../fixtures/runpod/catalog-gpus-count1.json', import.meta.url))).gpus;
    const c2 = JSON.parse(fs.readFileSync(new URL('../fixtures/runpod/catalog-gpus-count2.json', import.meta.url))).gpus;
    const r = selectGpus({ catalogs: { 1: c1, 2: c2 }, dataCenterId: 'EU-RO-1', needs, tpSizes: [1, 2] });
    const prices = r.all.map((c) => c.hourly);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    for (const c of r.all) expect(c.perGpuGiB).toBeLessThanOrEqual(c.memoryGiB * 0.9);
  });
});
```

`test/core/plan.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { makePlan } from '../../src/core/planner/plan.js';
import { loadFlags } from '../../src/core/planner/vllm-args.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const SHA = 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120';
const gpu = (id, memory, price, dc) => ({
  id, name: id, memory, price: { secure: price, community: 0 }, maxCount: { secure: 8, community: 0 },
  dataCenters: [{ id: dc, name: dc, availability: 'HIGH' }],
});

function fakes(catalog) {
  const hf = {
    getModel: vi.fn().mockResolvedValue(fx('model-qwen3-coder-30b.json')),
    resolveSha: vi.fn().mockResolvedValue(SHA),
    listFiles: vi.fn().mockResolvedValue(fx('tree-qwen3-coder-30b.json')),
    getConfig: vi.fn().mockResolvedValue(fx('config-qwen3-coder-30b.json')),
  };
  const runpod = { listGpus: vi.fn(async ({ count }) => catalog[count] ?? []) };
  return { hf, runpod };
}

const base = { modelRef: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', dataCenterId: 'EU-A', minCudaVersion: '12.9', vllmImage: 'vllm/vllm-openai:v0.30.0-cu129', flags: loadFlags() };

describe('makePlan', () => {
  it('produce un piano completo per Qwen3-Coder-30B su una GPU da 80 GB', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')], 2: [], 4: [], 8: [] });
    const plan = await makePlan({ hf, runpod, ...base });
    expect(plan.model).toMatchObject({ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: SHA, requestedRevision: 'main', weightsBytes: 61066575656 });
    expect(plan.gpu).toEqual({ id: 'GPU80', count: 1 });
    expect(plan.hourlyUSD).toBe(1.5);
    expect(plan.parsers).toEqual({ tool: 'qwen3_coder', reasoning: null });
    expect(plan.vllm.args).toEqual(expect.arrayContaining(['--tensor-parallel-size', '1', '--tool-call-parser', 'qwen3_coder', '--revision', SHA]));
    expect(plan.estimate.perGpuGiB).toBeCloseTo(70.87, 1);
    expect(runpod.listGpus).toHaveBeenCalledWith({ count: 2, cloud: 'SECURE', minCudaVersion: '12.9' });
  });

  it('ripiega su KV cache FP8 se in BF16 non entra', async () => {
    // 72 GB × 0,9 = 64,8 GiB: BF16 (70,9) non entra, FP8 (56,9 + 6 + 2 = 64,9)… nemmeno; con 74 GB × 0,9 = 66,6 sì.
    const { hf, runpod } = fakes({ 1: [gpu('GPU74', 74, 1, 'EU-A')] });
    const plan = await makePlan({ hf, runpod, ...base });
    expect(plan.kvCacheDtype).toBe('fp8');
    expect(plan.vllm.args).toEqual(expect.arrayContaining(['--kv-cache-dtype', 'fp8']));
    expect(plan.warnings.join(' ')).toMatch(/FP8/);
  });

  it('nessuna GPU nel datacenter → gpu null, avviso e alternative altrove', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'US-B')] });
    const plan = await makePlan({ hf, runpod, ...base });
    expect(plan.gpu).toBeNull();
    expect(plan.elsewhere[0].gpuId).toBe('GPU80');
    expect(plan.warnings.join(' ')).toMatch(/NO_GPU_AVAILABLE/);
  });

  it('gli override vietati bloccano il piano, quelli sconosciuti sono avvisi', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
    await expect(makePlan({ hf, runpod, ...base, extra: ['--api-key', 'x'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const plan = await makePlan({ hf, runpod, ...base, extra: ['--flag-inventato'] });
    expect(plan.warnings.join(' ')).toMatch(/--flag-inventato/);
  });

  it('contesto oltre il massimo del modello viene ridotto con avviso', async () => {
    const { hf, runpod } = fakes({ 1: [gpu('GPU80', 80, 1.5, 'EU-A')] });
    const plan = await makePlan({ hf, runpod, ...base, context: 10_000_000 });
    expect(plan.context).toBe(262144);
    expect(plan.warnings.join(' ')).toMatch(/262144/);
  });
});
```

- [ ] **Passo 2: eseguire i test e verificare che falliscano**

Esegui: `npx vitest run test/core/gpu-select.test.js test/core/plan.test.js`
Atteso: FAIL, moduli non trovati.

- [ ] **Passo 3: implementare `gpu-select.js`**

```js
import { fits } from './vram.js';

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function selectGpus({ catalogs, dataCenterId, needs, tpSizes, cloud = 'SECURE', util = 0.9, limit = 4 }) {
  const key = cloud.toLowerCase();
  const all = [];
  for (const count of tpSizes) {
    const need = needs(count);
    for (const g of catalogs[count] ?? []) {
      const price = g.price?.[key];
      if (!price || (g.maxCount?.[key] ?? 0) < count || !g.memory || !fits(need, g.memory, util)) continue;
      const dcs = g.dataCenters ?? [];
      const here = dcs.find((d) => d.id === dataCenterId);
      all.push({
        gpuId: g.id, name: g.name, count, memoryGiB: g.memory,
        hourly: round(price * count), perGpuGiB: round(need, 2), headroomGiB: round(g.memory * util - need, 2),
        availabilityHere: here?.availability ?? 'NONE',
        elsewhere: dcs.filter((d) => d.id !== dataCenterId && d.availability !== 'NONE').map((d) => ({ id: d.id, availability: d.availability })),
      });
    }
  }
  all.sort((a, b) => a.hourly - b.hourly || b.headroomGiB - a.headroomGiB);
  const inDc = all.filter((c) => c.availabilityHere !== 'NONE');
  return {
    choice: inDc[0] ?? null,
    alternatives: inDc.slice(1, 1 + limit),
    elsewhere: all.filter((c) => c.availabilityHere === 'NONE' && c.elsewhere.length).slice(0, limit),
    all,
  };
}
```

- [ ] **Passo 4: implementare `plan.js`**

```js
import { LlmpodError, Codes } from '../errors.js';
import { parseModelRef, summarizeModel } from '../hf.js';
import { weightsBytes, kvBytesPerToken, estimate, tpSizes } from './vram.js';
import { detectParsers, buildArgs, applyOverrides, validateArgs } from './vllm-args.js';
import { selectGpus } from './gpu-select.js';

const SHA_RE = /^[0-9a-f]{40}$/;

export async function makePlan({
  hf, runpod, modelRef, context = 65536, concurrency = 2, cloud = 'SECURE', dataCenterId,
  minCudaVersion, vllmImage, set = [], extra = [], flags, allowTrustRemoteCode = false, onProgress = () => {},
}) {
  const { id, revision } = parseModelRef(modelRef);
  const warnings = [];

  onProgress(`Lettura di ${id} da Hugging Face`);
  const info = await hf.getModel(id);
  const sha = SHA_RE.test(revision) ? revision : await hf.resolveSha(id, revision);
  const [tree, config] = await Promise.all([hf.listFiles(id, sha), hf.getConfig(id, sha)]);
  const summary = summarizeModel(info);

  const wBytes = weightsBytes(tree);
  if (!wBytes) {
    throw new LlmpodError(Codes.INVALID_INPUT, `${id} non contiene file .safetensors`, { hint: 'vLLM su llmpod supporta modelli safetensors (i repository solo GGUF non sono supportati)' });
  }
  const maxCtx = (config.text_config ?? config).max_position_embeddings;
  let ctx = context;
  if (maxCtx && ctx > maxCtx) {
    warnings.push(`Contesto ridotto da ${context} a ${maxCtx}, il massimo dichiarato dal modello`);
    ctx = maxCtx;
  }
  if (!summary.hasChatTemplate) warnings.push('Il modello non dichiara un chat template: le chiamate a strumento potrebbero non funzionare');
  if (summary.gated) warnings.push(`Modello gated (${summary.gated}): serve HF_TOKEN con accesso approvato`);

  const parsers = detectParsers({ modelId: id, config });
  warnings.push(...parsers.warnings);

  const sizes = tpSizes(config);
  onProgress('Lettura del catalogo GPU Runpod');
  const catalogs = {};
  for (const count of sizes) catalogs[count] = await runpod.listGpus({ count, cloud, minCudaVersion });

  const kv = kvBytesPerToken(config);
  const pick = (kvPerToken) => {
    const needs = (tp) => estimate({ weightsBytes: wBytes, kvPerToken, context: ctx, concurrency, tp }).perGpuGiB;
    return { needs, sel: selectGpus({ catalogs, dataCenterId, needs, tpSizes: sizes, cloud }) };
  };
  let kvCacheDtype = null;
  let kvPerToken = kv.bytes;
  let { sel } = pick(kvPerToken);
  if (!sel.choice && !sel.elsewhere.length) {
    const fp8 = pick(kv.bytes / 2);
    if (fp8.sel.all.length) {
      ({ sel } = fp8);
      kvPerToken = kv.bytes / 2;
      kvCacheDtype = 'fp8';
      warnings.push('KV cache in FP8 (--kv-cache-dtype fp8): in BF16 non entra in nessuna GPU disponibile');
    }
  }
  if (!sel.choice) {
    warnings.push(`NO_GPU_AVAILABLE: nessuna GPU adatta disponibile nel datacenter ${dataCenterId}`
      + (sel.elsewhere.length ? ` (disponibile altrove: ${sel.elsewhere.map((c) => `${c.name}×${c.count}`).join(', ')})` : ''));
  }

  const tp = sel.choice?.count ?? 1;
  const args = applyOverrides(buildArgs({ context: ctx, tp, revision: sha, parsers, kvCacheDtype }), { set, extra });
  const { unknown, forbidden } = validateArgs(args, flags, { allowTrustRemoteCode });
  if (forbidden.length) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Argomenti vLLM non consentiti: ${forbidden.join(', ')}`, { hint: 'llmpod gestisce da solo chiave, host, porta e nome servito' });
  }
  if (unknown.length) warnings.push(`Flag non riconosciuti da vLLM ${'v0.30.0'}: ${unknown.join(', ')}`);

  const est = estimate({ weightsBytes: wBytes, kvPerToken, context: ctx, concurrency, tp });
  return {
    model: { id, revision: sha, requestedRevision: revision, gated: summary.gated, license: summary.license, params: summary.params, weightsBytes: wBytes, maxContext: maxCtx ?? null },
    context: ctx,
    concurrency,
    vllm: { image: vllmImage, args },
    parsers: { tool: parsers.tool, reasoning: parsers.reasoning },
    estimate: { weightsGiB: est.weightsGiB, kvGiB: est.kvGiB, perGpuGiB: est.perGpuGiB },
    gpu: sel.choice ? { id: sel.choice.gpuId, count: sel.choice.count } : null,
    hourlyUSD: sel.choice?.hourly ?? null,
    alternatives: sel.alternatives.map((c) => ({ id: c.gpuId, count: c.count, hourly: c.hourly })),
    elsewhere: sel.elsewhere,
    candidates: sel.all.slice(0, 10),
    dataCenterId,
    cloud,
    kvCacheDtype,
    warnings,
  };
}
```

- [ ] **Passo 5: eseguire i test e verificare che passino**

Esegui: `npx vitest run test/core/gpu-select.test.js test/core/plan.test.js`
Atteso: PASS (9 test). Nota sul test FP8: con 74 GB, BF16 richiede 70,87 GiB > 66,6 → non entra; FP8 richiede 56,87 + 6 + 2 = 64,87 ≤ 66,6 → entra.

- [ ] **Passo 6: commit e push**

```bash
git add src/core/planner/gpu-select.js src/core/planner/plan.js test/core/gpu-select.test.js test/core/plan.test.js
git commit -m "feat: selezione GPU per prezzo/disponibilità e piano completo"
git push
```

---

### Attività 10: Supervisore nel Pod (vLLM, stato, watchdog)

**File:**
- Crea: `src/core/pod/supervisor.py`, `test/supervisor/fake_vllm.py`, `test/supervisor/test_supervisor.py`

**Interfacce:**
- Variabili d'ambiente lette (`env_config`):

  | Variabile | Default | Uso |
  |---|---|---|
  | `LLMPOD_MODEL` | — (obbligatoria) | id HF passato a `vllm serve` |
  | `LLMPOD_SERVED_NAME` | — (obbligatoria) | `--served-model-name` |
  | `LLMPOD_VLLM_ARGS` | `[]` | JSON array di argomenti modificabili |
  | `VLLM_API_KEY` | — (obbligatoria) | chiave del profilo; vLLM la legge da sé; protegge anche `:8001` |
  | `LLMPOD_IDLE_MINUTES` / `LLMPOD_MAX_HOURS` | `30` / `8` | watchdog |
  | `LLMPOD_CHECK_SECONDS` | `60` | intervallo dei controlli |
  | `LLMPOD_MODEL_BYTES` | `0` | totale pesi per la percentuale di download |
  | `HF_HOME` | `/root/.cache/huggingface` | misura del download in `$HF_HOME/hub` |
  | `RUNPOD_POD_ID`, `RUNPOD_API_KEY` | iniettate da Runpod | auto-terminazione |
  | `LLMPOD_RUNPOD_API` | `https://api.runpod.io/v2` | sostituibile nei test |
  | `LLMPOD_VLLM_PORT` | `8000` | porta di vLLM |
  | `LLMPOD_VLLM_CMD` | `["vllm","serve"]` | sostituibile nei test/e2e |
  | `LLMPOD_STATUS_PORT` | `8001` | server di stato |
  | `LLMPOD_MAX_RESTARTS` | `2` | riavvii automatici |

- Comando di vLLM: `LLMPOD_VLLM_CMD + [LLMPOD_MODEL, "--served-model-name", NOME, "--host", "0.0.0.0", "--port", PORTA] + args`.
- HTTP su `:8001`, tutte le rotte con `Authorization: Bearer <VLLM_API_KEY>` (confronto a tempo costante): `GET /status` → JSON `{ phase, downloadedBytes, totalBytes, idleSeconds, idleLimitSeconds, uptimeSeconds, maxSeconds, restarts, lastError, kvCacheTokens, terminateReason, args, version }`; `GET /logs?since=N` → `{ lines: [{ n, line }] }`; `POST /reload` `{ args: string[] }` → 202 (vietati `--api-key`, `--host`, `--port`, `--served-model-name`; max 200 argomenti da max 2000 caratteri).
- Fasi: `downloading` (se `LLMPOD_MODEL_BYTES > 0`) → `loading` → `ready` → (`error`) → `terminating`.

- [ ] **Passo 1: scrivere il finto vLLM per i test**

`test/supervisor/fake_vllm.py`:

```python
"""Finto vLLM per i test del supervisore e per la prova e2e su CPU.

Espone /v1/models (protetto da VLLM_API_KEY), /metrics (valori da FAKE_VLLM_STATE)
e /stream (SSE per FAKE_STREAM_SECONDS secondi, per provare il proxy Runpod).
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


PORT = int(arg('--port', '8000'))
HOST = arg('--host', '127.0.0.1')
KEY = os.environ.get('VLLM_API_KEY', '')
STATE_FILE = os.environ.get('FAKE_VLLM_STATE', '')


def state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'running': 0, 'waiting': 0, 'success': 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/metrics':
            s = state()
            text = (
                '# HELP vllm:num_requests_running Requests running\n'
                f'vllm:num_requests_running{{engine="0",model_name="m"}} {s["running"]}\n'
                f'vllm:num_requests_waiting{{engine="0",model_name="m"}} {s["waiting"]}\n'
                f'vllm:request_success_total{{engine="0",finished_reason="stop",model_name="m"}} {s["success"]}\n'
            )
            return self.reply(200, text.encode(), 'text/plain')
        if self.path == '/v1/models':
            if self.headers.get('Authorization') != 'Bearer ' + KEY:
                return self.reply(401, b'{"error":"unauthorized"}')
            return self.reply(200, json.dumps({'data': [{'id': 'm'}]}).encode())
        if self.path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for i in range(int(os.environ.get('FAKE_STREAM_SECONDS', '150')) // 5):
                self.wfile.write(f'data: {i}\n\n'.encode())
                self.wfile.flush()
                time.sleep(5)
            self.wfile.write(b'data: [DONE]\n\n')
            return None
        return self.reply(404, b'{}')


print('GPU KV cache size: 1,000 tokens, Maximum concurrency for 32,768 tokens per request: 0.03x', flush=True)
if os.environ.get('FAKE_VLLM_EXIT_AFTER'):
    threading.Timer(float(os.environ['FAKE_VLLM_EXIT_AFTER']), lambda: os._exit(3)).start()
ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
```

- [ ] **Passo 2: scrivere i test che falliscono**

`test/supervisor/test_supervisor.py`:

```python
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'src', 'core', 'pod'))
import supervisor as sv  # noqa: E402

KEY = 'chiave-di-prova-1234567890'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_until(cond, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return False


class FakeRunpod:
    """Finta API Runpod che registra le DELETE ricevute."""

    def __init__(self):
        self.calls = []
        calls = self.calls

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_DELETE(self):
                calls.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'ua': self.headers.get('User-Agent')})
                self.send_response(204)
                self.end_headers()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/v2'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


class PureFunctions(unittest.TestCase):
    def test_parse_metrics_somma_le_etichette(self):
        text = (
            '# HELP x\n'
            'vllm:num_requests_running{engine="0",model_name="m"} 1.0\n'
            'vllm:num_requests_waiting{engine="0",model_name="m"} 2.0\n'
            'vllm:request_success_total{finished_reason="stop",model_name="m"} 3.0\n'
            'vllm:request_success_total{finished_reason="length",model_name="m"} 2.0\n'
            'altro_valore 9\n'
        )
        self.assertEqual(sv.parse_metrics(text), (3.0, 5.0))

    def test_parse_kv_tokens(self):
        line = 'INFO GPU KV cache size: 1,234,567 tokens, Maximum concurrency for 32,768 tokens per request: 37.68x'
        self.assertEqual(sv.parse_kv_tokens(line), 1234567)
        self.assertIsNone(sv.parse_kv_tokens('nessuna informazione'))

    def test_idle_tracker(self):
        t = sv.IdleTracker(100)
        t.observe(100, 0, 0)
        self.assertEqual(t.idle_seconds(160), 60)
        t.observe(160, 1, 0)  # richiesta in corso
        self.assertEqual(t.idle_seconds(200), 40)
        t.observe(200, 0, 0)
        t.observe(260, 0, 1)  # completata una richiesta tra due controlli
        self.assertEqual(t.idle_seconds(260), 0)

    def test_termination_reason(self):
        self.assertEqual(sv.termination_reason(100, 0, 100, 0, 1800), 'max-duration')
        self.assertEqual(sv.termination_reason(50, 0, 100, 1800, 1800), 'idle')
        self.assertIsNone(sv.termination_reason(50, 0, 100, 10, 1800))
        self.assertIsNone(sv.termination_reason(50, 0, 100, None, 1800))

    def test_valid_reload_args(self):
        self.assertEqual(sv.valid_reload_args({'args': ['--max-model-len', '4096']}), ['--max-model-len', '4096'])
        for bad in [{}, {'args': []}, {'args': 'x'}, {'args': [1]}, {'args': ['--api-key', 'x']},
                    {'args': ['--port=9000']}, {'args': ['x' * 2001]}, {'args': ['a'] * 201}]:
            self.assertIsNone(sv.valid_reload_args(bad), bad)


class SupervisorIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = os.path.join(self.tmp, 'state.json')
        self.set_state(0, 0, 0)
        self.runpod = FakeRunpod()
        self.port = free_port()
        os.environ['FAKE_VLLM_STATE'] = self.state
        os.environ['VLLM_API_KEY'] = KEY
        os.environ.pop('FAKE_VLLM_EXIT_AFTER', None)
        self.cfg = sv.env_config({
            'LLMPOD_MODEL': 'org/modello', 'LLMPOD_SERVED_NAME': 'modello', 'VLLM_API_KEY': KEY,
            'LLMPOD_VLLM_ARGS': '["--max-model-len","4096"]', 'LLMPOD_IDLE_MINUTES': '1', 'LLMPOD_MAX_HOURS': '1',
            'LLMPOD_CHECK_SECONDS': '0.1', 'HF_HOME': self.tmp, 'RUNPOD_POD_ID': 'POD123', 'RUNPOD_API_KEY': 'chiave-iniettata',
            'LLMPOD_RUNPOD_API': self.runpod.url, 'LLMPOD_VLLM_PORT': str(self.port),
            'LLMPOD_VLLM_CMD': json.dumps([sys.executable, os.path.join(HERE, 'fake_vllm.py')]),
            'LLMPOD_STATUS_PORT': str(free_port()), 'LLMPOD_MAX_RESTARTS': '1',
        })
        self.now = [1000.0]
        self.sup = sv.Supervisor(self.cfg, clock=lambda: self.now[0])

    def tearDown(self):
        self.sup.stop_vllm(5)
        self.runpod.close()

    def set_state(self, running, waiting, success):
        with open(self.state, 'w') as f:
            json.dump({'running': running, 'waiting': waiting, 'success': success}, f)

    def test_comando_vllm(self):
        cmd = self.sup.vllm_command()
        self.assertEqual(cmd[-9:], ['org/modello', '--served-model-name', 'modello', '--host', '0.0.0.0',
                                    '--port', str(self.port), '--max-model-len', '4096'])

    def test_pronto_inattivita_e_terminazione(self):
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: self.sup.step() is None and self.sup.phase == 'ready'))
        self.assertTrue(wait_until(lambda: self.sup.kv_tokens == 1000))
        self.set_state(1, 0, 0)
        self.assertIsNone(self.sup.step())
        self.now[0] += 59
        self.set_state(0, 0, 0)
        self.assertIsNone(self.sup.step())   # ultima attività 59 s fa: sotto il limite di 60 s
        self.now[0] += 61
        self.assertEqual(self.sup.step(), 'idle')
        self.assertTrue(self.sup.terminate_pod())
        self.assertEqual(self.runpod.calls, [{'path': '/v2/pods/POD123', 'auth': 'Bearer chiave-iniettata', 'ua': 'llmpod-supervisor/' + sv.VERSION}])

    def test_durata_massima(self):
        self.sup.start_vllm()
        self.now[0] += 3600
        self.assertEqual(self.sup.step(), 'max-duration')

    def test_crash_riavvio_poi_errore(self):
        os.environ['FAKE_VLLM_EXIT_AFTER'] = '0.5'
        self.sup.start_vllm()
        self.assertTrue(wait_until(lambda: (self.sup.step(), self.sup.restarts)[1] == 1))
        self.assertTrue(wait_until(lambda: (self.sup.step(), self.sup.phase)[1] == 'error'))
        self.assertIn('codice 3', self.sup.last_error)
        self.assertIsNotNone(self.sup.tracker)  # l'inattività continua a contare anche in errore

    def test_server_di_stato_autenticato(self):
        server = sv.make_server(self.sup)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{self.cfg["status_port"]}'
        try:
            def req(path, method='GET', body=None, auth=True):
                headers = {'Authorization': 'Bearer ' + KEY} if auth else {}
                data = json.dumps(body).encode() if body is not None else None
                r = urllib.request.Request(base + path, data=data, method=method, headers=headers)
                try:
                    with urllib.request.urlopen(r, timeout=5) as resp:
                        return resp.status, json.loads(resp.read())
                except urllib.error.HTTPError as e:
                    return e.code, None

            self.assertEqual(req('/status', auth=False)[0], 401)
            code, status = req('/status')
            self.assertEqual(code, 200)
            self.assertEqual(status['phase'], 'loading')
            self.assertNotIn(KEY, json.dumps(status))
            self.sup.log('riga uno')
            self.sup.log('riga due')
            code, logs = req('/logs?since=1')
            self.assertEqual([l['line'] for l in logs['lines']], ['riga due'])
            self.assertEqual(req('/reload', 'POST', {'args': ['--api-key', 'x']})[0], 400)
            self.assertEqual(req('/reload', 'POST', {'args': ['--max-model-len', '2048']})[0], 202)
            self.assertTrue(wait_until(lambda: self.sup.args == ['--max-model-len', '2048']))
        finally:
            server.shutdown()


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Passo 3: eseguire i test e verificare che falliscano**

Esegui: `python3 -m unittest discover -s test/supervisor -v`
Atteso: ERROR, `ModuleNotFoundError: No module named 'supervisor'`.

- [ ] **Passo 4: implementare il supervisore**

`src/core/pod/supervisor.py`:

```python
#!/usr/bin/env python3
"""Supervisore llmpod: avvia vLLM, espone lo stato su :8001 e termina il Pod per inattività.

Solo libreria standard. Configurazione tramite variabili d'ambiente (vedi env_config).
Il Pod si termina con la RUNPOD_API_KEY iniettata da Runpod, che può agire solo su questo Pod.
"""
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '0.1.0'
USER_AGENT = 'llmpod-supervisor/' + VERSION
METRIC_LINE = re.compile(r'^([A-Za-z_:][A-Za-z0-9_:]*)(\{.*\})?\s+(\S+)')
KV_LINE = re.compile(r'KV cache size:\s*([\d,]+)\s*tokens')
RELOAD_FORBIDDEN = ('--api-key', '--host', '--port', '--served-model-name')


def parse_metrics(text):
    """Restituisce (richieste in corso + in attesa, richieste completate totali)."""
    sums = {}
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        m = METRIC_LINE.match(line)
        if not m:
            continue
        try:
            value = float(m.group(3))
        except ValueError:
            continue
        sums[m.group(1)] = sums.get(m.group(1), 0.0) + value
    in_flight = sums.get('vllm:num_requests_running', 0.0) + sums.get('vllm:num_requests_waiting', 0.0)
    return in_flight, sums.get('vllm:request_success_total', 0.0)


def parse_kv_tokens(line):
    m = KV_LINE.search(line)
    return int(m.group(1).replace(',', '')) if m else None


class IdleTracker:
    def __init__(self, now):
        self.last_activity = now
        self.last_success = None

    def observe(self, now, in_flight, success_total):
        if in_flight > 0 or (self.last_success is not None and success_total > self.last_success):
            self.last_activity = now
        self.last_success = success_total

    def idle_seconds(self, now):
        return now - self.last_activity


def termination_reason(now, started_at, max_seconds, idle_seconds, idle_limit):
    if now - started_at >= max_seconds:
        return 'max-duration'
    if idle_seconds is not None and idle_seconds >= idle_limit:
        return 'idle'
    return None


def valid_reload_args(payload):
    args = payload.get('args') if isinstance(payload, dict) else None
    if not isinstance(args, list) or not 0 < len(args) <= 200:
        return None
    if not all(isinstance(a, str) and 0 < len(a) <= 2000 for a in args):
        return None
    if any(a.split('=')[0] in RELOAD_FORBIDDEN for a in args):
        return None
    return args


def env_config(env):
    port = int(env.get('LLMPOD_VLLM_PORT', '8000'))
    return {
        'model': env['LLMPOD_MODEL'],
        'served_name': env['LLMPOD_SERVED_NAME'],
        'args': json.loads(env.get('LLMPOD_VLLM_ARGS', '[]')),
        'api_key': env['VLLM_API_KEY'],
        'idle_seconds': float(env.get('LLMPOD_IDLE_MINUTES', '30')) * 60,
        'max_seconds': float(env.get('LLMPOD_MAX_HOURS', '8')) * 3600,
        'check_seconds': float(env.get('LLMPOD_CHECK_SECONDS', '60')),
        'model_bytes': int(env.get('LLMPOD_MODEL_BYTES', '0')),
        'hf_home': env.get('HF_HOME', '/root/.cache/huggingface'),
        'pod_id': env.get('RUNPOD_POD_ID', ''),
        'runpod_key': env.get('RUNPOD_API_KEY', ''),
        'runpod_api': env.get('LLMPOD_RUNPOD_API', 'https://api.runpod.io/v2'),
        'vllm_port': port,
        'vllm_url': f'http://127.0.0.1:{port}',
        'vllm_cmd': json.loads(env['LLMPOD_VLLM_CMD']) if env.get('LLMPOD_VLLM_CMD') else ['vllm', 'serve'],
        'status_port': int(env.get('LLMPOD_STATUS_PORT', '8001')),
        'max_restarts': int(env.get('LLMPOD_MAX_RESTARTS', '2')),
    }


def dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


class Supervisor:
    def __init__(self, cfg, clock=time.time):
        self.cfg = cfg
        self.clock = clock
        self.lock = threading.Lock()
        self.started_at = clock()
        self.logs = deque(maxlen=500)
        self.log_seq = 0
        self.proc = None
        self.args = list(cfg['args'])
        self.phase = 'downloading' if cfg['model_bytes'] > 0 else 'loading'
        self.restarts = 0
        self.last_error = None
        self.kv_tokens = None
        self.downloaded = 0
        self.tracker = None
        self.expected_exit = False
        self.terminate_reason = None

    # --- log ---
    def log(self, line):
        line = line.rstrip('\n')[:2000]
        with self.lock:
            self.log_seq += 1
            self.logs.append((self.log_seq, line))
        kv = parse_kv_tokens(line)
        if kv:
            self.kv_tokens = kv

    def logs_since(self, since):
        with self.lock:
            return [{'n': n, 'line': text} for n, text in self.logs if n > since]

    def _read_output(self, proc):
        for line in proc.stdout:
            self.log(line)

    # --- vLLM ---
    def vllm_command(self):
        c = self.cfg
        return c['vllm_cmd'] + [c['model'], '--served-model-name', c['served_name'],
                                '--host', '0.0.0.0', '--port', str(c['vllm_port'])] + self.args

    def start_vllm(self):
        self.expected_exit = False
        self.proc = subprocess.Popen(self.vllm_command(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, env=dict(os.environ))
        threading.Thread(target=self._read_output, args=(self.proc,), daemon=True).start()
        self.log(f'[llmpod] vLLM avviato (pid {self.proc.pid})')

    def stop_vllm(self, timeout=30):
        if self.proc and self.proc.poll() is None:
            self.expected_exit = True
            self.proc.terminate()
            try:
                self.proc.wait(timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

    def reload(self, args):
        self.log('[llmpod] ricarica di vLLM con nuovi argomenti')
        self.stop_vllm()
        self.args = list(args)
        self.phase = 'loading'
        self.restarts = 0
        self.last_error = None
        self.start_vllm()

    # --- HTTP verso vLLM e Runpod ---
    def _get(self, path, auth=False, timeout=5):
        headers = {'User-Agent': USER_AGENT}
        if auth:
            headers['Authorization'] = 'Bearer ' + self.cfg['api_key']
        req = urllib.request.Request(self.cfg['vllm_url'] + path, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')

    def check_ready(self):
        try:
            return self._get('/v1/models', auth=True)[0] == 200
        except Exception:  # noqa: BLE001 — vLLM non ancora in ascolto
            return False

    def terminate_pod(self):
        c = self.cfg
        if not c['pod_id'] or not c['runpod_key']:
            self.last_error = 'RUNPOD_POD_ID o RUNPOD_API_KEY mancanti: impossibile terminare il Pod'
            return False
        req = urllib.request.Request(f"{c['runpod_api']}/pods/{c['pod_id']}", method='DELETE',
                                     headers={'User-Agent': USER_AGENT, 'Authorization': 'Bearer ' + c['runpod_key']})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status in (200, 202, 204)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return True
            self.last_error = f'terminazione fallita: HTTP {e.code}'
        except Exception as e:  # noqa: BLE001
            self.last_error = f'terminazione fallita: {e}'
        return False

    # --- ciclo di controllo ---
    def step(self):
        """Un controllo: aggiorna fase e inattività, restituisce il motivo di terminazione o None."""
        now = self.clock()
        if (self.phase != 'terminating' and self.proc is not None
                and self.proc.poll() is not None and not self.expected_exit):
            code = self.proc.returncode
            self.log(f'[llmpod] vLLM terminato con codice {code}')
            if self.restarts < self.cfg['max_restarts']:
                self.restarts += 1
                self.phase = 'loading'
                self.start_vllm()
            else:
                self.phase = 'error'
                self.last_error = f'vLLM terminato con codice {code} dopo {self.restarts} riavvii'
                if self.tracker is None:
                    self.tracker = IdleTracker(now)
        if self.phase in ('downloading', 'loading'):
            if self.check_ready():
                self.phase = 'ready'
                self.tracker = IdleTracker(now)
                self.log('[llmpod] vLLM pronto')
            elif self.phase == 'downloading' and self.downloaded >= self.cfg['model_bytes'] * 0.98:
                self.phase = 'loading'
        if self.phase == 'ready':
            try:
                in_flight, success = parse_metrics(self._get('/metrics')[1])
                self.tracker.observe(now, in_flight, success)
            except Exception as e:  # noqa: BLE001
                self.log(f'[llmpod] metriche non disponibili: {e}')
        idle = self.tracker.idle_seconds(now) if self.tracker else None
        return termination_reason(now, self.started_at, self.cfg['max_seconds'], idle, self.cfg['idle_seconds'])

    def status(self):
        now = self.clock()
        return {
            'phase': self.phase, 'downloadedBytes': self.downloaded, 'totalBytes': self.cfg['model_bytes'],
            'idleSeconds': round(self.tracker.idle_seconds(now)) if self.tracker else None,
            'idleLimitSeconds': self.cfg['idle_seconds'], 'uptimeSeconds': round(now - self.started_at),
            'maxSeconds': self.cfg['max_seconds'], 'restarts': self.restarts, 'lastError': self.last_error,
            'kvCacheTokens': self.kv_tokens, 'terminateReason': self.terminate_reason, 'args': self.args,
            'version': VERSION,
        }

    def _measure_download(self):
        while self.phase == 'downloading':
            self.downloaded = dir_size(os.path.join(self.cfg['hf_home'], 'hub'))
            time.sleep(10)

    def run(self):
        self.start_vllm()
        threading.Thread(target=self._measure_download, daemon=True).start()
        while True:
            reason = self.step()
            if reason:
                self.terminate_reason = reason
                self.phase = 'terminating'
                self.log(f'[llmpod] terminazione del Pod: {reason}')
                if self.terminate_pod():
                    self.log('[llmpod] terminazione accettata da Runpod')
                else:
                    self.log(f'[llmpod] {self.last_error}; nuovo tentativo al prossimo controllo')
            time.sleep(self.cfg['check_seconds'])


def make_server(sup):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'llmpod-supervisor'

        def log_message(self, *args):
            pass

        def _authorized(self):
            got = self.headers.get('Authorization', '').encode()
            return hmac.compare_digest(got, ('Bearer ' + sup.cfg['api_key']).encode())

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._authorized():
                return self._send(401, {'error': 'unauthorized'})
            url = urllib.parse.urlparse(self.path)
            if url.path == '/status':
                return self._send(200, sup.status())
            if url.path == '/logs':
                try:
                    since = int(urllib.parse.parse_qs(url.query).get('since', ['0'])[0])
                except ValueError:
                    since = 0
                return self._send(200, {'lines': sup.logs_since(since)})
            return self._send(404, {'error': 'not found'})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {'error': 'unauthorized'})
            if self.path != '/reload':
                return self._send(404, {'error': 'not found'})
            length = min(int(self.headers.get('Content-Length') or 0), 65536)
            try:
                payload = json.loads(self.rfile.read(length) or b'{}')
            except ValueError:
                return self._send(400, {'error': 'JSON non valido'})
            args = valid_reload_args(payload)
            if args is None:
                return self._send(400, {'error': 'args non validi'})
            threading.Thread(target=sup.reload, args=(args,), daemon=True).start()
            return self._send(202, {'ok': True})

    return ThreadingHTTPServer(('0.0.0.0', sup.cfg['status_port']), Handler)


def main():
    sup = Supervisor(env_config(os.environ))
    server = make_server(sup)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def on_sigterm(*_args):
        sup.stop_vllm(10)
        sys.exit(0)

    signal.signal(signal.SIGTERM, on_sigterm)
    sup.run()


if __name__ == '__main__':
    main()
```

- [ ] **Passo 5: eseguire i test e verificare che passino**

Esegui: `python3 -m unittest discover -s test/supervisor -v`
Atteso: OK (10 test). Il test `test_comando_vllm` confronta la coda del comando: il comando completo è `[python, fake_vllm.py, 'org/modello', '--served-model-name', 'modello', '--host', '0.0.0.0', '--port', <porta>, '--max-model-len', '4096']`.

- [ ] **Passo 6: commit e push**

```bash
git add src/core/pod/supervisor.py test/supervisor/fake_vllm.py test/supervisor/test_supervisor.py
git commit -m "feat: supervisore nel Pod con stato, watchdog e auto-terminazione"
git push
```

---
### Attività 11: Eventi, conferme, corpo del Pod, launcher e smoke test

**File:**
- Crea: `src/core/events.js`, `src/core/confirm.js`, `src/core/pod/body.js`, `src/core/pod/launcher.js`, `src/core/pod/smoke.js`
- Test: `test/core/confirm.test.js`, `test/core/body.test.js`, `test/core/launcher.test.js`, `test/core/smoke.test.js`

**Interfacce:**
- Consuma: `proxyUrl` (Attività 6), `applyOverrides` (Attività 8), `LlmpodError`/`Codes`, `redact`.
- Produce:
  - `createEvents() → { emit(type, data), on(fn) → off }`; tipi: `phase {message}`, `progress {message, ratio?}`, `log {line}`, `warning {message}`, `info {message}`, `pod {podId}`.
  - `fmtUSD(n) → "1,39 $"`; `confirmCost({ hourlyUSD?, monthlyUSD?, description, yes, dryRun, ask }) → { proceed, dryRun?, message }` (lancia `CANCELLED` se l'utente rifiuta); `confirmAction({ description, yes, dryRun, ask })` uguale senza costo. `ask(domanda, predefinitoSi = false) → Promise<boolean>`.
  - `START_CMD`, `argsForCount(args, count)`, `buildPodBody({ profile, candidate, apiKey, hfToken, minCudaVersion }) → body` (candidate: `{ id, count, dataCenterId, withVolume, hourly }`).
  - `rankCandidates({ profile, catalogs }) → { inVolumeDc: candidate[], otherDcs: candidate[] }`; `createWithFallback({ runpod, candidates, buildBody, onAttempt?, beforeAttempt?, sleep? }) → { pod, candidate }`; `waitForRunning({ runpod, podId, timeoutMs = 600000, sleep?, now? }) → pod`; `createSupervisorClient({ http, podId, apiKey, baseUrl? }) → { status(), logs(since), reload(args) }`; `waitForReady({ sup, timeoutMs, sleep?, now?, onStatus?, onLog? }) → status`; `readyTimeoutMs(weightsBytes) → number`.
  - `smokeTest({ http, baseUrl, apiKey, model }) → { ok, models: {ok, detail}, messages: {ok, detail}, chat: {ok, detail} }`.

- [ ] **Passo 1: scrivere i test che falliscono**

`test/core/confirm.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { confirmCost, confirmAction, fmtUSD } from '../../src/core/confirm.js';
import { createEvents } from '../../src/core/events.js';

describe('conferme', () => {
  it('fmtUSD usa la virgola decimale', () => {
    expect(fmtUSD(1.389)).toBe('1,39 $');
  });

  it('dry-run non chiede e non procede', async () => {
    const ask = vi.fn();
    const r = await confirmCost({ hourlyUSD: 1.5, description: 'Avvio', dryRun: true, ask });
    expect(r).toMatchObject({ proceed: false, dryRun: true });
    expect(r.message).toContain('1,50 $/h');
    expect(ask).not.toHaveBeenCalled();
  });

  it('--yes procede senza chiedere', async () => {
    const ask = vi.fn();
    expect((await confirmCost({ hourlyUSD: 1, description: 'x', yes: true, ask })).proceed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('mostra il costo mensile e annulla se l\'utente rifiuta', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    await expect(confirmCost({ monthlyUSD: 10.5, description: 'Volume', ask })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(ask.mock.calls[0][0]).toContain('10,50 $ al mese');
  });

  it('confirmAction chiede senza costo', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    expect((await confirmAction({ description: 'Terminare il Pod abc?', ask })).proceed).toBe(true);
  });

  it('events: on/emit/off', () => {
    const ev = createEvents();
    const seen = [];
    const off = ev.on((e) => seen.push(e));
    ev.emit('phase', { message: 'uno' });
    off();
    ev.emit('phase', { message: 'due' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'phase', message: 'uno' });
  });
});
```

`test/core/body.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildPodBody, argsForCount, START_CMD } from '../../src/core/pod/body.js';

const profile = {
  name: 'qwen3-coder', servedName: 'qwen3-coder', cloud: 'SECURE',
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'abc', weightsBytes: 61066575656, gated: false },
  vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  volume: { id: 'vol1' }, watchdog: { idleMinutes: 30, maxHours: 8 },
};

describe('buildPodBody', () => {
  it('con volume: mount, HF_HOME sul volume, disco piccolo, supervisore in base64', () => {
    const b = buildPodBody({ profile, candidate: { id: 'GPU80', count: 1, dataCenterId: 'EU-RO-1', withVolume: true }, apiKey: 'k'.repeat(40), minCudaVersion: '12.9' });
    expect(b).toMatchObject({
      name: 'llmpod-qwen3-coder', image: 'vllm/vllm-openai:v0.30.0-cu129', cloud: 'SECURE',
      gpu: { id: 'GPU80', count: 1, minCudaVersion: '12.9' }, dataCenterIds: ['EU-RO-1'],
      ports: ['8000/http', '8001/http'], entrypoint: ['/bin/sh', '-c'], cmd: [START_CMD], disk: 20,
      mounts: { network: [{ volumeId: 'vol1', path: '/workspace' }] },
    });
    expect(b.env).toMatchObject({ HF_HOME: '/workspace/hf', LLMPOD_MODEL: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', LLMPOD_SERVED_NAME: 'qwen3-coder', LLMPOD_IDLE_MINUTES: '30', LLMPOD_MAX_HOURS: '8', LLMPOD_MODEL_BYTES: '61066575656', VLLM_API_KEY: 'k'.repeat(40) });
    expect(Buffer.from(b.env.LLMPOD_SUPERVISOR_B64, 'base64').toString()).toContain('class Supervisor');
    expect(b.env.HF_TOKEN).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(100_000);
  });

  it('senza volume: disco dimensionato sui pesi, HF_HOME locale, nessun mount', () => {
    const b = buildPodBody({ profile, candidate: { id: 'GPU80', count: 2, dataCenterId: 'US-KS-2', withVolume: false }, apiKey: 'k', minCudaVersion: '12.9' });
    expect(b.mounts).toBeUndefined();
    expect(b.env.HF_HOME).toBe('/root/.cache/huggingface');
    expect(b.disk).toBe(Math.ceil(61.066575656 * 1.2) + 20);
    expect(JSON.parse(b.env.LLMPOD_VLLM_ARGS)).toEqual(['--max-model-len', '65536', '--tensor-parallel-size', '2']);
  });

  it('HF_TOKEN solo per modelli gated', () => {
    const gated = { ...profile, model: { ...profile.model, gated: 'manual' } };
    const b = buildPodBody({ profile: gated, candidate: { id: 'G', count: 1, dataCenterId: 'X', withVolume: true }, apiKey: 'k', hfToken: 'hf_x', minCudaVersion: '12.9' });
    expect(b.env.HF_TOKEN).toBe('hf_x');
  });

  it('argsForCount aggiorna il tensor parallel', () => {
    expect(argsForCount(['--tensor-parallel-size', '1'], 4)).toEqual(['--tensor-parallel-size', '4']);
  });
});
```

`test/core/launcher.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { rankCandidates, createWithFallback, waitForRunning, waitForReady, readyTimeoutMs, createSupervisorClient } from '../../src/core/pod/launcher.js';

const sleep = vi.fn().mockResolvedValue();
const clock = () => { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; };

describe('rankCandidates', () => {
  it('prima il datacenter del volume (scelta + alternative), poi gli altri datacenter', () => {
    const profile = { dataCenterId: 'EU-A', gpu: { id: 'G1', count: 1 }, alternatives: [{ id: 'G2', count: 2 }], volume: { id: 'v' } };
    const g = (id, price, dcs) => ({ id, price: { secure: price }, dataCenters: dcs.map(([d, a]) => ({ id: d, availability: a })) });
    const catalogs = { 1: [g('G1', 1, [['EU-A', 'NONE'], ['US-B', 'HIGH'], ['EU-C', 'LOW']])], 2: [g('G2', 0.5, [['EU-A', 'LOW']])] };
    const r = rankCandidates({ profile, catalogs, cloud: 'SECURE' });
    expect(r.inVolumeDc).toEqual([
      { id: 'G1', count: 1, dataCenterId: 'EU-A', withVolume: true, hourly: 1, availability: 'NONE' },
      { id: 'G2', count: 2, dataCenterId: 'EU-A', withVolume: true, hourly: 1, availability: 'LOW' },
    ]);
    expect(r.otherDcs.map((c) => `${c.id}@${c.dataCenterId}`)).toEqual(['G1@US-B', 'G1@EU-C']);
    expect(r.otherDcs.every((c) => c.withVolume === false)).toBe(true);
  });
});

describe('createWithFallback', () => {
  const cands = [{ id: 'A', count: 1 }, { id: 'B', count: 1 }, { id: 'C', count: 1 }];
  const body = (c) => ({ gpu: c.id });

  it('400 e 403 passano al candidato successivo', async () => {
    const runpod = { createPod: vi.fn()
      .mockResolvedValueOnce({ status: 400, data: { detail: 'no capacity' } })
      .mockResolvedValueOnce({ status: 403, data: {} })
      .mockResolvedValueOnce({ status: 201, data: { id: 'pod1' } }) };
    const r = await createWithFallback({ runpod, candidates: cands, buildBody: body, sleep });
    expect(r).toEqual({ pod: { id: 'pod1' }, candidate: cands[2] });
  });

  it('5xx ritenta lo stesso candidato', async () => {
    const runpod = { createPod: vi.fn().mockResolvedValueOnce({ status: 503, data: {} }).mockResolvedValueOnce({ status: 201, data: { id: 'p' } }) };
    const r = await createWithFallback({ runpod, candidates: cands, buildBody: body, sleep });
    expect(r.candidate.id).toBe('A');
    expect(runpod.createPod).toHaveBeenCalledTimes(2);
  });

  it('402 si ferma subito, 422 è un errore della richiesta', async () => {
    const r402 = { createPod: vi.fn().mockResolvedValue({ status: 402, data: { detail: 'balance' } }) };
    await expect(createWithFallback({ runpod: r402, candidates: cands, buildBody: body, sleep })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(r402.createPod).toHaveBeenCalledTimes(1);
    const r422 = { createPod: vi.fn().mockResolvedValue({ status: 422, data: { detail: 'Request validation failed.', errors: ['$.gpu: x'] } }) };
    await expect(createWithFallback({ runpod: r422, candidates: cands, buildBody: body, sleep })).rejects.toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringContaining('$.gpu: x') });
  });

  it('tutti esauriti → NO_GPU_AVAILABLE con l\'ultimo dettaglio', async () => {
    const runpod = { createPod: vi.fn().mockResolvedValue({ status: 400, data: { detail: 'no instances available' } }) };
    await expect(createWithFallback({ runpod, candidates: cands, buildBody: body, sleep }))
      .rejects.toMatchObject({ code: 'NO_GPU_AVAILABLE', message: expect.stringContaining('no instances available') });
  });

  it('beforeAttempt può fermare il tentativo (es. conferma per un candidato più caro)', async () => {
    const runpod = { createPod: vi.fn().mockResolvedValueOnce({ status: 400, data: {} }) };
    const beforeAttempt = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'CANCELLED' }));
    await expect(createWithFallback({ runpod, candidates: cands, buildBody: body, sleep, beforeAttempt })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('attese', () => {
  it('waitForRunning restituisce il Pod RUNNING', async () => {
    const runpod = { getPod: vi.fn().mockResolvedValueOnce({ status: 'PROVISIONING' }).mockResolvedValueOnce({ id: 'p', status: 'RUNNING' }) };
    expect(await waitForRunning({ runpod, podId: 'p', sleep })).toMatchObject({ status: 'RUNNING' });
  });

  it('waitForRunning: stato ERROR o Pod sparito → errore; timeout → POD_START_TIMEOUT', async () => {
    await expect(waitForRunning({ runpod: { getPod: async () => ({ status: 'ERROR' }) }, podId: 'p', sleep })).rejects.toMatchObject({ code: 'VLLM_ERROR' });
    await expect(waitForRunning({ runpod: { getPod: async () => null }, podId: 'p', sleep })).rejects.toMatchObject({ code: 'VLLM_ERROR' });
    const c = clock();
    const s = async (ms) => c.tick(ms);
    await expect(waitForRunning({ runpod: { getPod: async () => ({ status: 'STARTING' }) }, podId: 'p', sleep: s, now: c.now, timeoutMs: 30000 }))
      .rejects.toMatchObject({ code: 'POD_START_TIMEOUT' });
  });

  it('waitForReady segue le fasi, inoltra i log e riconosce l\'OOM', async () => {
    const statuses = [null, { phase: 'downloading', downloadedBytes: 5, totalBytes: 10 }, { phase: 'ready', kvCacheTokens: 1000 }];
    const sup = { status: vi.fn(async () => statuses.shift()), logs: vi.fn(async () => ({ lines: [{ n: 1, line: 'ciao' }] })) };
    const onLog = vi.fn();
    const st = await waitForReady({ sup, timeoutMs: 60000, sleep, onLog });
    expect(st.phase).toBe('ready');
    expect(onLog).toHaveBeenCalledWith('ciao');
    const supErr = { status: async () => ({ phase: 'error', lastError: 'vLLM terminato con codice 1' }), logs: async () => ({ lines: [{ n: 1, line: 'torch.OutOfMemoryError: CUDA out of memory' }] }) };
    await expect(waitForReady({ sup: supErr, timeoutMs: 60000, sleep })).rejects.toMatchObject({ code: 'OOM' });
  });

  it('readyTimeoutMs: pesi a 50 MB/s + 10 minuti', () => {
    expect(readyTimeoutMs(50e6 * 600)).toBe(600_000 + 600_000);
  });

  it('createSupervisorClient usa la porta 8001 con Bearer e restituisce null se il proxy non è pronto', async () => {
    const http = { request: vi.fn().mockResolvedValueOnce({ ok: false, status: 502, data: '' }).mockResolvedValueOnce({ ok: true, status: 200, data: { phase: 'loading' } }) };
    const sup = createSupervisorClient({ http, podId: 'p1', apiKey: 'k' });
    expect(await sup.status()).toBeNull();
    expect(await sup.status()).toEqual({ phase: 'loading' });
    expect(http.request.mock.calls[0][1]).toBe('https://p1-8001.proxy.runpod.net/status');
    expect(http.request.mock.calls[0][2].headers.authorization).toBe('Bearer k');
  });
});
```

`test/core/smoke.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { smokeTest } from '../../src/core/pod/smoke.js';

const okModels = { ok: true, status: 200, data: { data: [{ id: 'm' }] } };
const okMessages = { ok: true, status: 200, data: { content: [{ type: 'tool_use', name: 'get_weather', input: { city: 'Messina' } }] } };
const okChat = { ok: true, status: 200, data: { choices: [{ message: { tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Messina"}' } }] } }] } };

describe('smokeTest', () => {
  it('tutto ok', async () => {
    const http = { request: vi.fn().mockResolvedValueOnce(okModels).mockResolvedValueOnce(okMessages).mockResolvedValueOnce(okChat) };
    const r = await smokeTest({ http, baseUrl: 'https://p-8000.proxy.runpod.net', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(true);
    const [, url, opts] = http.request.mock.calls[1];
    expect(url).toBe('https://p-8000.proxy.runpod.net/v1/messages');
    expect(opts.json.tools[0].name).toBe('get_weather');
    expect(opts.timeoutMs).toBeLessThan(95_000);
  });

  it('nessuna chiamata a strumento → fallisce con dettaglio', async () => {
    const http = { request: vi.fn().mockResolvedValueOnce(okModels)
      .mockResolvedValueOnce({ ok: true, status: 200, data: { content: [{ type: 'text', text: 'Fa bel tempo' }] } })
      .mockResolvedValueOnce({ ok: false, status: 400, data: { message: '"auto" tool choice requires --enable-auto-tool-choice' } }) };
    const r = await smokeTest({ http, baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.messages).toMatchObject({ ok: false, detail: expect.stringContaining('Fa bel tempo') });
    expect(r.chat.detail).toContain('enable-auto-tool-choice');
  });

  it('un errore di rete diventa un dettaglio, non un\'eccezione', async () => {
    const http = { request: vi.fn().mockRejectedValue(Object.assign(new Error('Errore di rete'), { code: 'NETWORK' })) };
    const r = await smokeTest({ http, baseUrl: 'https://x', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.models.detail).toContain('Errore di rete');
  });
});
```

- [ ] **Passo 2: eseguire i test e verificare che falliscano**

Esegui: `npx vitest run test/core/confirm.test.js test/core/body.test.js test/core/launcher.test.js test/core/smoke.test.js`
Atteso: FAIL, moduli non trovati.

- [ ] **Passo 3: implementare `events.js` e `confirm.js`**

`src/core/events.js`:

```js
import { EventEmitter } from 'node:events';

export function createEvents() {
  const emitter = new EventEmitter();
  return {
    emit: (type, data = {}) => emitter.emit('event', { type, ...data, at: Date.now() }),
    on(fn) {
      emitter.on('event', fn);
      return () => emitter.off('event', fn);
    },
  };
}
```

`src/core/confirm.js`:

```js
import { LlmpodError, Codes } from './errors.js';

export const fmtUSD = (n) => `${Number(n).toFixed(2).replace('.', ',')} $`;

async function confirm({ message, yes, dryRun, ask }) {
  if (dryRun) return { proceed: false, dryRun: true, message };
  if (yes) return { proceed: true, message };
  if (!(await ask(`${message}. Confermi?`, false))) throw new LlmpodError(Codes.CANCELLED, 'Operazione annullata');
  return { proceed: true, message };
}

export function confirmCost({ hourlyUSD, monthlyUSD, description, yes = false, dryRun = false, ask }) {
  const cost = monthlyUSD !== undefined
    ? `${fmtUSD(monthlyUSD)} al mese`
    : `${fmtUSD(hourlyUSD)}/h (${fmtUSD(hourlyUSD * 24)} se acceso 24 ore)`;
  return confirm({ message: `${description} — costo stimato ${cost}`, yes, dryRun, ask });
}

export function confirmAction({ description, yes = false, dryRun = false, ask }) {
  return confirm({ message: description, yes, dryRun, ask });
}
```

- [ ] **Passo 4: implementare `body.js`**

`src/core/pod/body.js`:

```js
import fs from 'node:fs';
import { LlmpodError, Codes } from '../errors.js';
import { applyOverrides } from '../planner/vllm-args.js';

const SUPERVISOR = fs.readFileSync(new URL('./supervisor.py', import.meta.url));
export const START_CMD = 'echo "$LLMPOD_SUPERVISOR_B64" | base64 -d > /tmp/supervisor.py && exec python3 -u /tmp/supervisor.py';
const MAX_BODY_BYTES = 100_000;

export const argsForCount = (args, count) => applyOverrides(args, { set: [`tensor-parallel-size=${count}`] });

export function buildPodBody({ profile, candidate, apiKey, hfToken, minCudaVersion, supervisorSource = SUPERVISOR }) {
  const withVolume = Boolean(candidate.withVolume && profile.volume?.id);
  const env = {
    LLMPOD_SUPERVISOR_B64: Buffer.from(supervisorSource).toString('base64'),
    LLMPOD_MODEL: profile.model.id,
    LLMPOD_SERVED_NAME: profile.servedName,
    LLMPOD_VLLM_ARGS: JSON.stringify(argsForCount(profile.vllm.args, candidate.count)),
    LLMPOD_IDLE_MINUTES: String(profile.watchdog.idleMinutes),
    LLMPOD_MAX_HOURS: String(profile.watchdog.maxHours),
    LLMPOD_MODEL_BYTES: String(profile.model.weightsBytes),
    HF_HOME: withVolume ? '/workspace/hf' : '/root/.cache/huggingface',
    VLLM_API_KEY: apiKey,
  };
  if (profile.model.gated && hfToken) env.HF_TOKEN = hfToken;

  const body = {
    name: `llmpod-${profile.name}`,
    image: profile.vllm.image,
    cloud: profile.cloud,
    gpu: { id: candidate.id, count: candidate.count, minCudaVersion },
    dataCenterIds: [candidate.dataCenterId],
    ports: ['8000/http', '8001/http'],
    entrypoint: ['/bin/sh', '-c'],
    cmd: [START_CMD],
    env,
    disk: withVolume ? 20 : Math.ceil((profile.model.weightsBytes / 1e9) * 1.2) + 20,
  };
  if (withVolume) body.mounts = { network: [{ volumeId: profile.volume.id, path: '/workspace' }] };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
    throw new LlmpodError(Codes.INVALID_INPUT, 'La richiesta di creazione del Pod supera i 100 KB consentiti da Runpod');
  }
  return body;
}
```

- [ ] **Passo 5: implementare `launcher.js`**

`src/core/pod/launcher.js`:

```js
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

export async function createWithFallback({ runpod, candidates, buildBody, onAttempt = () => {}, beforeAttempt = async () => true, sleep = defaultSleep }) {
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
      if (r.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
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
  };
}

export const readyTimeoutMs = (weightsBytes) => Math.round((weightsBytes / 50e6) * 1000) + 600_000;

export async function waitForReady({ sup, timeoutMs, sleep = defaultSleep, now = Date.now, onStatus = () => {}, onLog = () => {} }) {
  const deadline = now() + timeoutMs;
  let since = 0;
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
      if (st.phase === 'ready') return st;
      if (st.phase === 'error' || st.phase === 'terminating') {
        const oom = recent.some((l) => OOM_RE.test(l));
        throw new LlmpodError(oom ? Codes.OOM : Codes.VLLM_ERROR, `vLLM non è partito: ${st.lastError ?? st.terminateReason ?? st.phase}`, {
          hint: oom ? 'Memoria GPU insufficiente: riduci --context, usa --set kv-cache-dtype=fp8 o scegli una GPU più grande' : 'Controlla i log mostrati sopra',
          details: { lastLines: recent.slice(-30) },
        });
      }
    }
    await sleep(5000);
  }
  throw new LlmpodError(Codes.POD_START_TIMEOUT, `vLLM non è pronto dopo ${Math.round(timeoutMs / 60000)} minuti`);
}
```

- [ ] **Passo 6: implementare `smoke.js`**

`src/core/pod/smoke.js`:

```js
const PROMPT = 'Che tempo fa adesso a Messina? Usa lo strumento get_weather.';
const DESCRIPTION = 'Restituisce il meteo attuale di una città';
const SCHEMA = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const TIMEOUT = 90_000; // sotto il limite di 100 s del proxy Runpod

async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, 300);

export async function smokeTest({ http, baseUrl, apiKey, model }) {
  const headers = { authorization: `Bearer ${apiKey}` };

  const models = await attempt(async () => {
    const r = await http.request('GET', `${baseUrl}/v1/models`, { headers, timeoutMs: 30_000 });
    const ok = r.ok && (r.data?.data ?? []).some((m) => m.id === model);
    return { ok, detail: ok ? '' : `HTTP ${r.status} ${short(r.data)}` };
  });

  const messages = await attempt(async () => {
    const r = await http.request('POST', `${baseUrl}/v1/messages`, {
      headers: { ...headers, 'anthropic-version': '2023-06-01' }, timeoutMs: TIMEOUT,
      json: { model, max_tokens: 512, tools: [{ name: 'get_weather', description: DESCRIPTION, input_schema: SCHEMA }], messages: [{ role: 'user', content: PROMPT }] },
    });
    const use = r.ok ? (r.data?.content ?? []).find((b) => b.type === 'tool_use') : null;
    const ok = use?.name === 'get_weather';
    return { ok, detail: ok ? '' : `HTTP ${r.status}: nessuna chiamata a get_weather (${short(r.data)})` };
  });

  const chat = await attempt(async () => {
    const r = await http.request('POST', `${baseUrl}/v1/chat/completions`, {
      headers, timeoutMs: TIMEOUT,
      json: { model, max_tokens: 512, tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'get_weather', description: DESCRIPTION, parameters: SCHEMA } }], messages: [{ role: 'user', content: PROMPT }] },
    });
    const call = r.ok ? r.data?.choices?.[0]?.message?.tool_calls?.[0] : null;
    const ok = call?.function?.name === 'get_weather';
    return { ok, detail: ok ? '' : `HTTP ${r.status}: nessuna chiamata a get_weather (${short(r.data)})` };
  });

  return { ok: models.ok && messages.ok && chat.ok, models, messages, chat };
}
```

- [ ] **Passo 7: eseguire i test e verificare che passino**

Esegui: `npx vitest run test/core/confirm.test.js test/core/body.test.js test/core/launcher.test.js test/core/smoke.test.js`
Atteso: PASS (24 test).

- [ ] **Passo 8: commit e push**

```bash
git add src/core/events.js src/core/confirm.js src/core/pod/body.js src/core/pod/launcher.js src/core/pod/smoke.js test/core/confirm.test.js test/core/body.test.js test/core/launcher.test.js test/core/smoke.test.js
git commit -m "feat: corpo del Pod, creazione con fallback, attese e smoke test"
git push
```

---

### Attività 12: Adattatori dei client (Claude Code, OpenCode, ZCode, pi)

**File:**
- Crea: `src/core/clients/env-format.js`, `src/core/clients/json-file.js`, `src/core/clients/claude-code.js`, `src/core/clients/opencode.js`, `src/core/clients/zcode.js`, `src/core/clients/pi.js`
- Test: `test/core/clients.test.js`

**Interfacce:**
- Consuma: `LlmpodError`/`Codes`.
- Produce (ogni adattatore riceve `endpoint = { baseUrl, apiKey, servedName, context, reasoning }`, dove `baseUrl` è `https://<pod>-8000.proxy.runpod.net` senza `/v1`):
  - `formatEnv(env, 'sh' | 'ps1' | 'json') → string`
  - `maxOutputTokens(context) → min(32000, max(1024, floor(context / 4)))`
  - `updateJsonFile(file, mutate, { invalidCode, label }) → void` — legge il JSON (file assente → `{}`), lancia `invalidCode` se non valido senza toccare il file, fa il backup in `<file>.llmpod-bak` (600), scrive in modo atomico con permessi 600.
  - `claudeEnv(endpoint) → env`
  - `opencodeConfig(endpoint) → object`; `prepareOpencode(endpoint, { dir }) → { command: 'opencode', args: [], env: { OPENCODE_CONFIG, LLMPOD_API_KEY } }` (scrive `<dir>/clients/opencode.json`, senza segreti)
  - `zcodeDir(env = process.env)`; `mergeZcodeConfig(cfg, endpoint)`; `isZcodeRunning({ platform, exec })`; `updateZcode(endpoint, { dir, isRunning }) → file` (lancia `ZCODE_RUNNING` se aperto)
  - `piDir(env = process.env)`; `mergePiModels(cfg, endpoint)`; `preparePi(endpoint, { dir }) → { command: 'pi', args: ['--provider', 'llmpod', '--model', servedName], env: { LLMPOD_API_KEY } }`
  - `prepareClaude(endpoint) → { command: 'claude', args: [], env }`

- [ ] **Passo 1: scrivere il test che fallisce**

`test/core/clients.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatEnv } from '../../src/core/clients/env-format.js';
import { updateJsonFile } from '../../src/core/clients/json-file.js';
import { claudeEnv, maxOutputTokens, prepareClaude } from '../../src/core/clients/claude-code.js';
import { opencodeConfig, prepareOpencode } from '../../src/core/clients/opencode.js';
import { mergeZcodeConfig, updateZcode, isZcodeRunning } from '../../src/core/clients/zcode.js';
import { mergePiModels, preparePi } from '../../src/core/clients/pi.js';

const endpoint = { baseUrl: 'https://p1-8000.proxy.runpod.net', apiKey: 'CHIAVE-FINTA-1234567890', servedName: 'qwen3-coder', context: 65536, reasoning: false };
let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-cl-')); });
const mode = (p) => fs.statSync(p).mode & 0o777;

describe('formatEnv', () => {
  it('sh, ps1 e json con apici', () => {
    const env = { A: "x'y", B: '1' };
    expect(formatEnv(env, 'sh')).toBe("export A='x'\\''y'\nexport B='1'");
    expect(formatEnv(env, 'ps1')).toBe("$env:A = 'x''y'\n$env:B = '1'");
    expect(JSON.parse(formatEnv(env, 'json'))).toEqual(env);
  });
});

describe('Claude Code', () => {
  it('variabili d\'ambiente previste dalla spec', () => {
    expect(claudeEnv(endpoint)).toEqual({
      ANTHROPIC_BASE_URL: 'https://p1-8000.proxy.runpod.net',
      ANTHROPIC_AUTH_TOKEN: 'CHIAVE-FINTA-1234567890',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384',
      API_TIMEOUT_MS: '600000',
    });
    expect(prepareClaude(endpoint).command).toBe('claude');
  });

  it('maxOutputTokens', () => {
    expect(maxOutputTokens(65536)).toBe(16384);
    expect(maxOutputTokens(262144)).toBe(32000);
    expect(maxOutputTokens(2048)).toBe(1024);
  });
});

describe('OpenCode', () => {
  it('config con provider openai-compatible e chiave da variabile', () => {
    const c = opencodeConfig(endpoint);
    expect(c.model).toBe('llmpod/qwen3-coder');
    expect(c.provider.llmpod).toMatchObject({ npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://p1-8000.proxy.runpod.net/v1', apiKey: '{env:LLMPOD_API_KEY}' } });
    expect(c.provider.llmpod.models['qwen3-coder'].limit).toEqual({ context: 65536, output: 16384 });
  });

  it('prepareOpencode scrive un file senza segreti e passa la chiave via env', () => {
    const p = prepareOpencode(endpoint, { dir: tmp });
    expect(p.env.OPENCODE_CONFIG).toBe(path.join(tmp, 'clients', 'opencode.json'));
    expect(p.env.LLMPOD_API_KEY).toBe(endpoint.apiKey);
    expect(fs.readFileSync(p.env.OPENCODE_CONFIG, 'utf8')).not.toContain(endpoint.apiKey);
    expect(mode(p.env.OPENCODE_CONFIG)).toBe(0o600);
  });
});

describe('updateJsonFile', () => {
  it('JSON non valido: errore e file intatto', () => {
    const f = path.join(tmp, 'c.json');
    fs.writeFileSync(f, '{ rotto');
    expect(() => updateJsonFile(f, (c) => c, { invalidCode: 'ZCODE_CONFIG_INVALID', label: 'ZCode' })).toThrow(expect.objectContaining({ code: 'ZCODE_CONFIG_INVALID' }));
    expect(fs.readFileSync(f, 'utf8')).toBe('{ rotto');
  });

  it('backup e permessi 600', () => {
    const f = path.join(tmp, 'c.json');
    fs.writeFileSync(f, '{"a":1}');
    updateJsonFile(f, (c) => ({ ...c, b: 2 }), { invalidCode: 'X', label: 'x' });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ a: 1, b: 2 });
    expect(fs.readFileSync(`${f}.llmpod-bak`, 'utf8')).toBe('{"a":1}');
    expect(mode(f)).toBe(0o600);
    expect(mode(`${f}.llmpod-bak`)).toBe(0o600);
  });
});

describe('ZCode', () => {
  it('merge preserva gli altri provider', () => {
    const existing = { provider: { 'builtin:zai': { kind: 'anthropic', models: { 'GLM-5.3': {} } } } };
    const out = mergeZcodeConfig(existing, endpoint);
    expect(out.provider['builtin:zai']).toEqual(existing.provider['builtin:zai']);
    expect(out.provider.llmpod).toMatchObject({ kind: 'openai-compatible', source: 'custom', options: { baseURL: 'https://p1-8000.proxy.runpod.net/v1', apiKey: endpoint.apiKey, apiKeyRequired: true } });
    expect(out.provider.llmpod.models['qwen3-coder'].limit).toEqual({ context: 65536, output: 16384 });
  });

  it('rifiuta se ZCode è aperto', async () => {
    await expect(updateZcode(endpoint, { dir: tmp, isRunning: async () => true })).rejects.toMatchObject({ code: 'ZCODE_RUNNING' });
  });

  it('scrive config.json quando ZCode è chiuso', async () => {
    const file = await updateZcode(endpoint, { dir: tmp, isRunning: async () => false });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).provider.llmpod.kind).toBe('openai-compatible');
  });

  it('isZcodeRunning: pgrep su macOS/Linux, tasklist su Windows', async () => {
    const execOk = vi.fn().mockResolvedValue({ stdout: '123\n' });
    expect(await isZcodeRunning({ platform: 'darwin', exec: execOk })).toBe(true);
    expect(execOk).toHaveBeenCalledWith('pgrep', ['-x', 'ZCode']);
    const execFail = vi.fn().mockRejectedValue(Object.assign(new Error('exit 1'), { code: 1 }));
    expect(await isZcodeRunning({ platform: 'linux', exec: execFail })).toBe(false);
    const execWin = vi.fn().mockResolvedValue({ stdout: 'INFO: No tasks are running' });
    expect(await isZcodeRunning({ platform: 'win32', exec: execWin })).toBe(false);
  });
});

describe('pi', () => {
  it('merge di models.json con chiave interpolata, mai in chiaro', () => {
    const out = mergePiModels({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }, { ...endpoint, reasoning: true });
    expect(out.providers.ollama).toEqual({ baseUrl: 'http://localhost:11434/v1' });
    expect(out.providers.llmpod).toEqual({
      baseUrl: 'https://p1-8000.proxy.runpod.net/v1', api: 'openai-completions', apiKey: '$LLMPOD_API_KEY',
      models: [{ id: 'qwen3-coder', name: 'qwen3-coder (llmpod)', contextWindow: 65536, maxTokens: 16384, reasoning: true }],
    });
  });

  it('preparePi scrive models.json e prepara il comando', () => {
    const p = preparePi(endpoint, { dir: tmp });
    expect(p).toEqual({ command: 'pi', args: ['--provider', 'llmpod', '--model', 'qwen3-coder'], env: { LLMPOD_API_KEY: endpoint.apiKey } });
    const text = fs.readFileSync(path.join(tmp, 'models.json'), 'utf8');
    expect(text).not.toContain(endpoint.apiKey);
    expect(JSON.parse(text).$schema).toBe('https://pi.dev/schemas/models.schema.json');
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/clients.test.js`
Atteso: FAIL, moduli non trovati.

- [ ] **Passo 3: implementazione**

`src/core/clients/env-format.js`:

```js
export function formatEnv(env, format = 'sh') {
  const entries = Object.entries(env);
  if (format === 'json') return JSON.stringify(env, null, 2);
  if (format === 'ps1') return entries.map(([k, v]) => `$env:${k} = '${String(v).replace(/'/g, "''")}'`).join('\n');
  return entries.map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`).join('\n');
}
```

`src/core/clients/json-file.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { LlmpodError } from '../errors.js';

export function updateJsonFile(file, mutate, { invalidCode, label }) {
  let raw = null;
  let current = {};
  if (fs.existsSync(file)) {
    raw = fs.readFileSync(file, 'utf8');
    try {
      current = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      throw new LlmpodError(invalidCode, `La configurazione di ${label} (${file}) non è un JSON valido: non la modifico`, { cause: err, hint: 'Correggi il file a mano e riprova' });
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (raw !== null) {
    fs.writeFileSync(`${file}.llmpod-bak`, raw, { mode: 0o600 });
    fs.chmodSync(`${file}.llmpod-bak`, 0o600);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mutate(current), null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
```

`src/core/clients/claude-code.js`:

```js
export const maxOutputTokens = (context) => Math.min(32000, Math.max(1024, Math.floor(context / 4)));

export function claudeEnv({ baseUrl, apiKey, servedName, context }) {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: servedName,
    ANTHROPIC_DEFAULT_OPUS_MODEL: servedName,
    ANTHROPIC_DEFAULT_SONNET_MODEL: servedName,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: servedName,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens(context)),
    API_TIMEOUT_MS: '600000',
  };
}

export const prepareClaude = (endpoint) => ({ command: 'claude', args: [], env: claudeEnv(endpoint) });
```

`src/core/clients/opencode.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { maxOutputTokens } from './claude-code.js';

export function opencodeConfig({ baseUrl, servedName, context }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `llmpod/${servedName}`,
    small_model: `llmpod/${servedName}`,
    provider: {
      llmpod: {
        npm: '@ai-sdk/openai-compatible',
        name: 'llmpod (Runpod)',
        options: { baseURL: `${baseUrl}/v1`, apiKey: '{env:LLMPOD_API_KEY}' },
        models: { [servedName]: { name: servedName, limit: { context, output: maxOutputTokens(context) } } },
      },
    },
  };
}

export function prepareOpencode(endpoint, { dir }) {
  const file = path.join(dir, 'clients', 'opencode.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(opencodeConfig(endpoint), null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { command: 'opencode', args: [], env: { OPENCODE_CONFIG: file, LLMPOD_API_KEY: endpoint.apiKey } };
}
```

`src/core/clients/zcode.js`:

```js
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LlmpodError, Codes } from '../errors.js';
import { updateJsonFile } from './json-file.js';
import { maxOutputTokens } from './claude-code.js';

const execFileP = promisify(execFile);

export const zcodeDir = (env = process.env) => env.ZCODE_DIR || path.join(os.homedir(), '.zcode', 'v2');

export function mergeZcodeConfig(cfg, { baseUrl, apiKey, servedName, context }) {
  const out = structuredClone(cfg ?? {});
  out.provider = out.provider ?? {};
  out.provider.llmpod = {
    name: 'llmpod (Runpod)',
    kind: 'openai-compatible',
    source: 'custom',
    options: { apiKey, baseURL: `${baseUrl}/v1`, apiKeyRequired: true },
    models: { [servedName]: { limit: { context, output: maxOutputTokens(context) } } },
  };
  return out;
}

export async function isZcodeRunning({ platform = process.platform, exec = execFileP } = {}) {
  if (platform === 'win32') {
    const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/NH']);
    return /ZCode\.exe/i.test(stdout);
  }
  try {
    await exec('pgrep', ['-x', 'ZCode']);
    return true;
  } catch {
    return false; // pgrep esce con 1 se non trova processi
  }
}

export async function updateZcode(endpoint, { dir = zcodeDir(), isRunning = () => isZcodeRunning() } = {}) {
  if (await isRunning()) {
    throw new LlmpodError(Codes.ZCODE_RUNNING, 'ZCode è aperto: le modifiche alla configurazione andrebbero perse', { hint: 'Chiudi ZCode e riprova' });
  }
  const file = path.join(dir, 'config.json');
  updateJsonFile(file, (c) => mergeZcodeConfig(c, endpoint), { invalidCode: Codes.ZCODE_CONFIG_INVALID, label: 'ZCode' });
  return file;
}
```

`src/core/clients/pi.js`:

```js
import os from 'node:os';
import path from 'node:path';
import { Codes } from '../errors.js';
import { updateJsonFile } from './json-file.js';
import { maxOutputTokens } from './claude-code.js';

export const piDir = (env = process.env) => env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

export function mergePiModels(cfg, { baseUrl, servedName, context, reasoning }) {
  const out = structuredClone(cfg ?? {});
  out.$schema = out.$schema ?? 'https://pi.dev/schemas/models.schema.json';
  out.providers = out.providers ?? {};
  out.providers.llmpod = {
    baseUrl: `${baseUrl}/v1`,
    api: 'openai-completions',
    apiKey: '$LLMPOD_API_KEY',
    models: [{ id: servedName, name: `${servedName} (llmpod)`, contextWindow: context, maxTokens: maxOutputTokens(context), reasoning: Boolean(reasoning) }],
  };
  return out;
}

export function preparePi(endpoint, { dir = piDir() } = {}) {
  updateJsonFile(path.join(dir, 'models.json'), (c) => mergePiModels(c, endpoint), { invalidCode: Codes.INVALID_INPUT, label: 'pi' });
  return { command: 'pi', args: ['--provider', 'llmpod', '--model', endpoint.servedName], env: { LLMPOD_API_KEY: endpoint.apiKey } };
}
```

- [ ] **Passo 4: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/clients.test.js`
Atteso: PASS (13 test).

- [ ] **Passo 5: commit e push**

```bash
git add src/core/clients test/core/clients.test.js
git commit -m "feat: adattatori Claude Code, OpenCode, ZCode e pi"
git push
```

---
### Attività 13: Operazioni (save, up, down, status, endpoint, rotate-key)

**File:**
- Crea: `src/core/ops.js`
- Test: `test/core/ops.test.js`

**Interfacce:**
- Consuma: `createStore`/`profileKeyVar` (Attività 4), `proxyUrl` (6), `confirmCost`/`confirmAction`/`fmtUSD` (11), `buildPodBody` (11), `rankCandidates`/`createWithFallback`/`waitForRunning`/`createSupervisorClient`/`waitForReady`/`readyTimeoutMs` (11), `smokeTest` (11), `updateZcode`/`zcodeDir` (12), `registerSecret`/`redactObject` (2).
- Produce:
  - `generateKey() → string` (32 byte casuali, base64url)
  - `profileFromPlan(plan, { name, volume, watchdog }) → profile` (forma della spec §6; `servedName = name`)
  - `createOps({ store, runpod, hf, http, events, ask, now = Date.now, sleep?, zcode = { dir: zcodeDir(), isRunning } })` →
    - `saveProfile(name) → profile` — legge `last-plan.json`; usa il volume di `config.json` solo se è nello stesso datacenter del piano; genera la chiave del profilo se manca.
    - `up(name, { yes = false, dryRun = false }) → { podId, baseUrl, hourlyUSD, candidate, startupSeconds, kvCacheTokens, contextSuggestion, smoke } | { dryRun: true, message, candidates, body }`
    - `down(name, { yes = false, dryRun = false }) → { podId: string|null, sessionUSD?, dryRun? }`
    - `status() → { pods: [{ profile, podId, status, gpu, hourlyUSD, uptimeSeconds, sessionUSD, orphan, supervisor }], balance, volume }`
    - `endpoint(name) → { baseUrl, apiKey, servedName, context, reasoning, podId }` (lancia `NOT_FOUND` se nessun Pod attivo)
    - `rotateKey(name) → { activePodId: string|null }`
    - `resolveProfile(name?) → string` — se `name` manca: l'unico profilo con Pod nello stato, altrimenti l'unico profilo esistente, altrimenti `INVALID_INPUT` con l'elenco.

- [ ] **Passo 1: scrivere il test che fallisce**

`test/core/ops.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOps, profileFromPlan, generateKey } from '../../src/core/ops.js';
import { createStore } from '../../src/core/config.js';
import { createEvents } from '../../src/core/events.js';
import { clearSecrets } from '../../src/core/secrets.js';

const KEY = 'CHIAVE-PROFILO-FINTA-123456';
const gpu = (id, memory, price, dcs) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: dcs.map(([d, a]) => ({ id: d, availability: a })) });
const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  context: 65536, concurrency: 2, vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 },
  gpu: { id: 'GPU80', count: 1 }, hourlyUSD: 1.5, alternatives: [{ id: 'GPU96', count: 1, hourly: 2.5 }], elsewhere: [], candidates: [],
  dataCenterId: 'EU-A', cloud: 'SECURE', kvCacheDtype: null, warnings: [],
};

function setup({ catalog = { 1: [gpu('GPU80', 80, 1.5, [['EU-A', 'HIGH']]), gpu('GPU96', 96, 2.5, [['EU-A', 'LOW']])] }, createResponses, smokeOk = true, askAnswers = [] } = {}) {
  clearSecrets();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-ops-')), 'cfg');
  const store = createStore({ dir, platform: 'linux' });
  store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-A' } });
  store.writeJson('last-plan.json', plan);
  let deleted = false;
  const runpod = {
    listPods: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 50, spendPerHour: 0 })),
    listGpus: vi.fn(async ({ count }) => catalog[count] ?? []),
    createPod: vi.fn(async () => (createResponses?.shift() ?? { status: 201, data: { id: 'pod1' } })),
    getPod: vi.fn(async () => (deleted ? null : { id: 'pod1', status: 'RUNNING', cost: 1.49 })),
    deletePod: vi.fn(async () => { deleted = true; }),
  };
  const routes = {
    'GET https://pod1-8001.proxy.runpod.net/logs?since=0': { ok: true, status: 200, data: { lines: [] } },
    'GET https://pod1-8001.proxy.runpod.net/status': { ok: true, status: 200, data: { phase: 'ready', kvCacheTokens: 400000 } },
    'GET https://pod1-8000.proxy.runpod.net/v1/models': { ok: true, status: 200, data: { data: [{ id: 'qwen3-coder' }] } },
    'POST https://pod1-8000.proxy.runpod.net/v1/messages': { ok: true, status: 200, data: { content: smokeOk ? [{ type: 'tool_use', name: 'get_weather' }] : [{ type: 'text', text: 'no' }] } },
    'POST https://pod1-8000.proxy.runpod.net/v1/chat/completions': { ok: true, status: 200, data: { choices: [{ message: { tool_calls: [{ function: { name: 'get_weather' } }] } }] } },
  };
  const http = { request: vi.fn(async (m, url) => routes[`${m} ${url}`] ?? { ok: false, status: 404, data: null }) };
  const hf = { checkAccess: vi.fn(async () => ({ ok: true, status: 200 })) };
  const ask = vi.fn(async () => (askAnswers.length ? askAnswers.shift() : true));
  const events = createEvents();
  const seen = [];
  events.on((e) => seen.push(e));
  let t = 0;
  const ops = createOps({ store, runpod, hf, http, events, ask, now: () => (t += 1000), sleep: async () => {}, zcode: { dir: path.join(dir, 'zcode'), isRunning: async () => false } });
  return { ops, store, runpod, http, ask, seen };
}

describe('ops', () => {
  beforeEach(() => clearSecrets());

  it('generateKey produce chiavi lunghe e diverse', () => {
    expect(generateKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateKey()).not.toBe(generateKey());
  });

  it('profileFromPlan', () => {
    const p = profileFromPlan(plan, { name: 'qwen3-coder', volume: { id: 'vol1' }, watchdog: { idleMinutes: 30, maxHours: 8 } });
    expect(p).toMatchObject({ name: 'qwen3-coder', servedName: 'qwen3-coder', gpu: { id: 'GPU80', count: 1 }, alternatives: [{ id: 'GPU96', count: 1 }], volume: { id: 'vol1', mountPath: '/workspace' }, allowFallbackWithoutVolume: 'ask' });
  });

  it('saveProfile salva il profilo e genera la chiave una sola volta', () => {
    const { ops, store } = setup();
    ops.saveProfile('qwen3-coder');
    const k1 = store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    ops.saveProfile('qwen3-coder');
    expect(store.readEnv().LLMPOD_KEY_QWEN3_CODER).toBe(k1);
    expect(store.readProfile('qwen3-coder').volume.id).toBe('vol1');
  });

  it('up completo: crea il Pod, attende, smoke test, suggerisce il contesto', async () => {
    const { ops, store, runpod, seen } = setup();
    ops.saveProfile('qwen3-coder');
    const r = await ops.up('qwen3-coder', { yes: true });
    expect(r).toMatchObject({ podId: 'pod1', baseUrl: 'https://pod1-8000.proxy.runpod.net', hourlyUSD: 1.49, kvCacheTokens: 400000, contextSuggestion: 199680 });
    const body = runpod.createPod.mock.calls[0][0];
    expect(body.dataCenterIds).toEqual(['EU-A']);
    expect(body.mounts.network[0].volumeId).toBe('vol1');
    expect(store.readState().pods['qwen3-coder'].podId).toBe('pod1');
    expect(seen.some((e) => e.type === 'pod' && e.podId === 'pod1')).toBe(true);
  });

  it('up: smoke test fallito → propone di terminare e termina', async () => {
    const { ops, store, runpod, ask } = setup({ smokeOk: false });
    ops.saveProfile('qwen3-coder');
    await expect(ops.up('qwen3-coder', { yes: false })).rejects.toMatchObject({ code: 'SMOKE_TEST_FAILED' });
    expect(ask.mock.calls.at(-1)[0]).toMatch(/Terminare il Pod pod1/);
    expect(runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(store.readState().pods['qwen3-coder']).toBeUndefined();
  });

  it('up --dry-run non crea nulla e maschera i segreti', async () => {
    const { ops, runpod, store } = setup();
    ops.saveProfile('qwen3-coder');
    const r = await ops.up('qwen3-coder', { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(runpod.createPod).not.toHaveBeenCalled();
    const key = store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.body.env.VLLM_API_KEY).toBe('<REDATTO>');
  });

  it('up rifiuta se il profilo ha già un Pod attivo', async () => {
    const { ops, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    runpod.listPods.mockResolvedValue([{ id: 'old', name: 'llmpod-qwen3-coder', status: 'RUNNING' }]);
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('old') });
  });

  it('up: nessuna disponibilità nel DC del volume → con consenso prova altri DC senza volume', async () => {
    const catalog = { 1: [gpu('GPU80', 80, 1.5, [['EU-A', 'NONE'], ['US-B', 'HIGH']]), gpu('GPU96', 96, 2.5, [['EU-A', 'NONE']])] };
    const { ops, runpod } = setup({ catalog, createResponses: [{ status: 400, data: {} }, { status: 400, data: {} }, { status: 201, data: { id: 'pod1' } }], askAnswers: [true, true] });
    ops.saveProfile('qwen3-coder');
    await ops.up('qwen3-coder', {});
    const bodies = runpod.createPod.mock.calls.map((c) => c[0]);
    expect(bodies.map((b) => b.dataCenterIds[0])).toEqual(['EU-A', 'EU-A', 'US-B']);
    expect(bodies[2].mounts).toBeUndefined();
  });

  it('up: credito insufficiente', async () => {
    const { ops, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    runpod.getBalance.mockResolvedValue({ balance: 0.5, spendPerHour: 0 });
    await expect(ops.up('qwen3-coder', { yes: true })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('down termina, verifica e pulisce lo stato; --dry-run non termina', async () => {
    const { ops, store, runpod } = setup();
    ops.saveProfile('qwen3-coder');
    await ops.up('qwen3-coder', { yes: true });
    const dry = await ops.down('qwen3-coder', { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, podId: 'pod1' });
    expect(runpod.deletePod).not.toHaveBeenCalled();
    const r = await ops.down('qwen3-coder', { yes: true });
    expect(r.podId).toBe('pod1');
    expect(runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(store.readState().pods).toEqual({});
  });

  it('status: Pod llmpod, orfani, volume', async () => {
    const { ops, runpod } = setup();
    runpod.listPods.mockResolvedValue([
      { id: 'x1', name: 'llmpod-orfano', status: 'RUNNING', cost: 2, runtime: { uptime: 3600 } },
      { id: 'y', name: 'altro-pod', status: 'RUNNING', cost: 1 },
    ]);
    const s = await ops.status();
    expect(s.pods).toEqual([expect.objectContaining({ profile: 'orfano', podId: 'x1', orphan: true, sessionUSD: 2, uptimeSeconds: 3600 })]);
    expect(s.volume).toMatchObject({ id: 'vol1', monthlyUSD: 10.5 });
    expect(s.balance.balance).toBe(50);
  });

  it('endpoint e rotateKey', async () => {
    const { ops, store } = setup();
    ops.saveProfile('qwen3-coder');
    await expect(ops.endpoint('qwen3-coder')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await ops.up('qwen3-coder', { yes: true });
    const ep = await ops.endpoint('qwen3-coder');
    expect(ep).toMatchObject({ baseUrl: 'https://pod1-8000.proxy.runpod.net', servedName: 'qwen3-coder', context: 65536, reasoning: false, podId: 'pod1' });
    const before = store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    const r = await ops.rotateKey('qwen3-coder');
    expect(r.activePodId).toBe('pod1');
    expect(store.readEnv().LLMPOD_KEY_QWEN3_CODER).not.toBe(before);
  });

  it('resolveProfile', async () => {
    const { ops } = setup();
    await expect(ops.resolveProfile()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    ops.saveProfile('qwen3-coder');
    expect(await ops.resolveProfile()).toBe('qwen3-coder');
    expect(await ops.resolveProfile('qwen3-coder')).toBe('qwen3-coder');
  });

  it('nessun segreto negli eventi emessi durante up', async () => {
    const { ops, store, seen } = setup();
    ops.saveProfile('qwen3-coder');
    await ops.up('qwen3-coder', { yes: true });
    expect(JSON.stringify(seen)).not.toContain(store.readEnv().LLMPOD_KEY_QWEN3_CODER);
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/core/ops.test.js`
Atteso: FAIL, modulo non trovato.

- [ ] **Passo 3: implementazione**

`src/core/ops.js`:

```js
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
      if (!pod || pod.status === 'TERMINATED') break;
      await sleep(5000);
    }
    forget(name);
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
    const { pod, candidate } = await createWithFallback({
      runpod, candidates, buildBody, sleep,
      beforeAttempt: async (c) => {
        if (c.hourly > confirmedHourly) {
          await confirmCost({ hourlyUSD: c.hourly, yes, ask, description: `Il candidato successivo costa di più: ${c.id} ×${c.count} in ${c.dataCenterId}` });
          confirmedHourly = c.hourly;
        }
      },
      onAttempt: (c) => events.emit('phase', { message: `Creazione del Pod: ${c.id} ×${c.count} in ${c.dataCenterId}${c.withVolume ? '' : ' (senza volume)'}` }),
    });
    events.emit('pod', { podId: pod.id });
    const state = store.readState();
    state.pods[name] = { podId: pod.id, startedAt: new Date(startedAt).toISOString(), hourlyUSD: candidate.hourly, dataCenterId: candidate.dataCenterId, withVolume: candidate.withVolume };
    store.writeState(state);

    try {
      events.emit('phase', { message: 'Attesa dell\'avvio del Pod' });
      const runningPod = await waitForRunning({ runpod, podId: pod.id, sleep, now });
      const sup = createSupervisorClient({ http, podId: pod.id, apiKey });
      events.emit('phase', { message: 'Avvio di vLLM (download e caricamento dei pesi)' });
      const st = await waitForReady({
        sup, sleep, now, timeoutMs: readyTimeoutMs(profile.model.weightsBytes),
        onStatus: (s) => events.emit('progress', progressOf(s)),
        onLog: (line) => events.emit('log', { line }),
      });
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
      if (yes || await ask(`Terminare il Pod ${pod.id} per non continuare a pagare?`, true)) await terminate(name, pod.id);
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
```

- [ ] **Passo 4: eseguire il test e verificare che passi**

Esegui: `npx vitest run test/core/ops.test.js`
Atteso: PASS (14 test). Nota sul test "nessuna disponibilità": i due candidati del datacenter del volume vengono comunque tentati (il catalogo può essere in ritardo), poi `US-B` senza volume; le risposte di `ask` sono: consenso al ripiego, conferma del costo, conferma del candidato più caro (GPU96, risposta predefinita `true` del finto `ask`).

- [ ] **Passo 5: eseguire tutta la suite JS**

Esegui: `npx vitest run`
Atteso: tutti i test PASS.

- [ ] **Passo 6: commit e push**

```bash
git add src/core/ops.js test/core/ops.test.js
git commit -m "feat: operazioni save/up/down/status/endpoint/rotate-key"
git push
```

---
### Attività 14: CLI — infrastruttura, init, search, plan, save

**File:**
- Crea: `src/cli/index.js`, `src/cli/program.js`, `src/cli/context.js`, `src/cli/prompt.js`, `src/cli/render.js`
- Crea: `src/cli/commands/init.js`, `src/cli/commands/search.js`, `src/cli/commands/plan.js`, `src/cli/commands/save.js`
- Test: `test/cli/helpers.js`, `test/cli/cli-plan.test.js`

**Interfacce:**
- Consuma: tutto il core (Attività 1–13).
- Produce:
  - `VERSION` (da `package.json`, in `src/cli/context.js`)
  - `createPrompt({ input, output }) → { ask(q, defYes), askText(q, def), askSecret(q) }` (input nascosto per i segreti)
  - `createIo({ stdout, stderr, prompt }) → { out(t), raw(t), err(t), ask, askText, askSecret }` — `out`/`err` passano da `redact`; `raw` no (usato solo da `env` e da `--json` quando l'utente chiede esplicitamente gli export).
  - `attachRenderer(events, io, { verbose }) → off` (eventi su stderr), `table(rows, columns)`, `fmtGiB(n)`, `fmtDuration(s)`
  - `createContext({ env, io, overrides }) → ctx` con `{ env, io, store, http, events, platform, spawn, isZcodeRunning, runpod (lazy), hf (lazy), ops (lazy) }`; `overrides` sostituisce `runpod`, `hf`, `http`, `spawn`, `isZcodeRunning` nei test.
  - `runCli(argv, { io?, env?, overrides? }) → Promise<number>` (codice d'uscita: 0 ok, 1 errore, 130 annullato). Gli errori `LlmpodError` sono stampati come `Errore [CODICE]: messaggio` + `Suggerimento: …`.
  - Ogni comando: `export function register(program, getCtx, result)`; `result.code` può impostare il codice d'uscita.

- [ ] **Passo 1: scrivere gli helper di test e i test che falliscono**

`test/cli/helpers.js`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { createIo } from '../../src/cli/render.js';
import { createStore } from '../../src/core/config.js';
import { clearSecrets } from '../../src/core/secrets.js';

export const SECRETS = { RUNPOD_API_KEY: 'rpa_SEGRETO_RUNPOD_FINTO_123', HF_TOKEN: 'hf_SEGRETO_HF_FINTO_1234567' };

export function sandbox({ answers = {} } = {}) {
  clearSecrets();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-cli-'));
  const env = { LLMPOD_CONFIG_DIR: path.join(root, 'cfg'), ZCODE_DIR: path.join(root, 'zcode'), PI_CODING_AGENT_DIR: path.join(root, 'pi') };
  const store = createStore({ dir: env.LLMPOD_CONFIG_DIR, platform: 'linux' });
  const outBuf = [];
  const errBuf = [];
  const prompt = {
    ask: vi.fn(async () => (answers.ask?.length ? answers.ask.shift() : true)),
    askText: vi.fn(async (q, def) => (answers.text?.length ? answers.text.shift() : def)),
    askSecret: vi.fn(async () => (answers.secret?.length ? answers.secret.shift() : '')),
  };
  const io = createIo({ stdout: { write: (s) => outBuf.push(s) }, stderr: { write: (s) => errBuf.push(s) }, prompt });
  return {
    root, env, store, io, prompt,
    out: () => outBuf.join(''),
    err: () => errBuf.join(''),
    all: () => outBuf.join('') + errBuf.join(''),
    run: (argv, overrides = {}) => runCli(argv, { io, env, overrides }),
  };
}
```

`test/cli/cli-plan.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, SECRETS } from './helpers.js';
import { VERSION } from '../../src/cli/context.js';

const fx = (p) => JSON.parse(fs.readFileSync(new URL(`../fixtures/hf/${p}`, import.meta.url), 'utf8'));
const gpu = (id, memory, price, dc) => ({ id, name: id, memory, price: { secure: price }, maxCount: { secure: 8 }, dataCenters: [{ id: dc, availability: 'HIGH' }] });
const hfFake = () => ({
  getModel: vi.fn(async () => fx('model-qwen3-coder-30b.json')),
  resolveSha: vi.fn(async () => 'b2cff646eb4bb1d68355c01b18ae02e7cf42d120'),
  listFiles: vi.fn(async () => fx('tree-qwen3-coder-30b.json')),
  getConfig: vi.fn(async () => fx('config-qwen3-coder-30b.json')),
  searchModels: vi.fn(async () => [
    { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', params: 30.5e9, paramsByDtype: { BF16: 30.5e9 }, dtypes: ['BF16'], license: 'apache-2.0', gated: false, downloads: 1000, lastModified: '2025-07-31T00:00:00.000Z', architectures: ['Qwen3MoeForCausalLM'], modelType: 'qwen3_moe', hasChatTemplate: true },
    { id: 'strano/Modello', params: 7e9, paramsByDtype: { BF16: 7e9 }, dtypes: ['BF16'], license: null, gated: 'manual', downloads: 5, lastModified: null, architectures: ['FooForCausalLM'], modelType: 'foo', hasChatTemplate: true },
    { id: 'base/SenzaTemplate', params: 1e9, paramsByDtype: null, dtypes: [], license: null, gated: false, downloads: 1, lastModified: null, architectures: [], modelType: null, hasChatTemplate: false },
  ]),
});
const runpodFake = () => ({
  listGpus: vi.fn(async ({ count }) => (count === 1 ? [gpu('NVIDIA A100 80GB PCIe', 80, 1.79, 'EU-RO-1')] : [])),
  listPods: vi.fn(async () => []),
  listDataCenters: vi.fn(async () => [
    { id: 'EU-RO-1', region: 'EUROPE', networkVolumeTypes: ['STANDARD'], gpuAvailability: [{ id: 'A', availability: 'HIGH' }] },
    { id: 'AP-IN-1', region: 'ASIA', networkVolumeTypes: [], gpuAvailability: [] },
  ]),
  listVolumes: vi.fn(async () => []),
  createVolume: vi.fn(async ({ name, size, dataCenter }) => ({ id: 'vol1', name, size, dataCenter })),
});

describe('CLI: infrastruttura', () => {
  it('--version', async () => {
    const s = sandbox();
    expect(await s.run(['--version'])).toBe(0);
    expect(s.out()).toContain(VERSION);
  });

  it('comando sconosciuto → codice 1', async () => {
    const s = sandbox();
    expect(await s.run(['boh'])).toBe(1);
  });
});

describe('CLI: init', () => {
  it('salva credenziali (600), datacenter e crea il volume', async () => {
    const s = sandbox({ answers: { secret: [SECRETS.RUNPOD_API_KEY, SECRETS.HF_TOKEN], text: ['EU-RO-1', '150'], ask: [true] } });
    const runpod = runpodFake();
    const http = { request: vi.fn(async () => ({ ok: true, status: 200, data: { name: 'utente' } })) };
    expect(await s.run(['init'], { runpod, http })).toBe(0);
    expect(s.store.readEnv()).toEqual(SECRETS);
    expect(fs.statSync(path.join(s.env.LLMPOD_CONFIG_DIR, '.env')).mode & 0o777).toBe(0o600);
    expect(runpod.createVolume).toHaveBeenCalledWith({ name: 'llmpod-pesi', size: 150, dataCenter: 'EU-RO-1' });
    expect(s.store.readConfig()).toMatchObject({ dataCenterId: 'EU-RO-1', volume: { id: 'vol1', size: 150, dataCenterId: 'EU-RO-1' } });
    expect(s.all()).not.toContain(SECRETS.RUNPOD_API_KEY);
    expect(s.prompt.ask.mock.calls[0][0]).toContain('10,50 $ al mese');
  });

  it('init --dry-run non crea il volume', async () => {
    const s = sandbox({ answers: { secret: [SECRETS.RUNPOD_API_KEY, ''], text: ['EU-RO-1', '200'] } });
    const runpod = runpodFake();
    expect(await s.run(['init', '--dry-run'], { runpod })).toBe(0);
    expect(runpod.createVolume).not.toHaveBeenCalled();
  });
});

describe('CLI: search, plan, save', () => {
  it('search mostra parser e nasconde i modelli senza chat template', async () => {
    const s = sandbox();
    expect(await s.run(['search', 'qwen', 'coder'], { hf: hfFake() })).toBe(0);
    const out = s.out();
    expect(out).toContain('Qwen/Qwen3-Coder-30B-A3B-Instruct');
    expect(out).toContain('qwen3_coder');
    expect(out).toMatch(/strano\/Modello.*nessuno/);
    expect(out).not.toContain('base/SenzaTemplate');
    const s2 = sandbox();
    await s2.run(['search', 'x', '--all'], { hf: hfFake() });
    expect(s2.out()).toContain('base/SenzaTemplate');
  });

  it('plan richiede init', async () => {
    const s = sandbox();
    expect(await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'], { hf: hfFake(), runpod: runpodFake() })).toBe(1);
    expect(s.err()).toMatch(/Errore \[INVALID_INPUT\].*datacenter/i);
  });

  it('plan stampa il piano e lo salva; save crea il profilo senza mostrare la chiave', async () => {
    const s = sandbox();
    s.store.writeEnv(SECRETS);
    s.store.writeConfig({ dataCenterId: 'EU-RO-1', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-RO-1' } });
    expect(await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'], { hf: hfFake(), runpod: runpodFake() })).toBe(0);
    const out = s.out();
    expect(out).toContain('qwen3_coder');
    expect(out).toContain('NVIDIA A100 80GB PCIe');
    expect(out).toContain('1,79 $/h');
    expect(out).toContain('llmpod save');
    expect(s.store.readJson('last-plan.json').gpu).toEqual({ id: 'NVIDIA A100 80GB PCIe', count: 1 });

    expect(await s.run(['save', 'qwen3-coder'])).toBe(0);
    const key = s.store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    expect(key).toBeTruthy();
    expect(s.all()).not.toContain(key);
    expect(s.store.readProfile('qwen3-coder').servedName).toBe('qwen3-coder');
  });

  it('plan --json produce JSON valido su stdout', async () => {
    const s = sandbox();
    s.store.writeConfig({ dataCenterId: 'EU-RO-1' });
    expect(await s.run(['plan', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', '--json', '--context', '32768'], { hf: hfFake(), runpod: runpodFake() })).toBe(0);
    expect(JSON.parse(s.out()).context).toBe(32768);
  });
});
```

- [ ] **Passo 2: eseguire i test e verificare che falliscano**

Esegui: `npx vitest run test/cli/cli-plan.test.js`
Atteso: FAIL, moduli non trovati.

- [ ] **Passo 3: implementare prompt, render e context**

`src/cli/prompt.js`:

```js
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

export function createPrompt({ input = process.stdin, output = process.stderr } = {}) {
  async function question(text, { muted = false } = {}) {
    const sink = new Writable({
      write(chunk, enc, cb) {
        if (!sink.muted) output.write(chunk, enc);
        cb();
      },
    });
    const rl = readline.createInterface({ input, output: sink, terminal: Boolean(input.isTTY) });
    try {
      output.write(text);
      sink.muted = muted;
      return (await rl.question('')).trim();
    } finally {
      rl.close();
      if (muted) output.write('\n');
    }
  }
  return {
    async ask(q, defYes = false) {
      const a = (await question(`${q} ${defYes ? '[S/n]' : '[s/N]'} `)).toLowerCase();
      return a ? ['s', 'si', 'sì', 'y', 'yes'].includes(a) : defYes;
    },
    async askText(q, def) {
      return (await question(def ? `${q} [${def}] ` : `${q} `)) || def || '';
    },
    askSecret: (q) => question(`${q} `, { muted: true }),
  };
}
```

`src/cli/render.js`:

```js
import { redact } from '../core/secrets.js';

export function createIo({ stdout = process.stdout, stderr = process.stderr, prompt }) {
  return {
    out: (t) => stdout.write(`${redact(t)}\n`),
    raw: (t) => stdout.write(`${t}\n`),
    err: (t) => stderr.write(`${redact(t)}\n`),
    ask: prompt.ask,
    askText: prompt.askText,
    askSecret: prompt.askSecret,
  };
}

export function attachRenderer(events, io, { verbose = false } = {}) {
  let lastProgress = '';
  return events.on((e) => {
    if (e.type === 'phase') io.err(`▸ ${e.message}`);
    else if (e.type === 'progress' && e.message !== lastProgress) { lastProgress = e.message; io.err(`  … ${e.message}`); }
    else if (e.type === 'log' && verbose) io.err(`  │ ${e.line}`);
    else if (e.type === 'warning') io.err(`⚠ ${e.message}`);
    else if (e.type === 'info') io.err(`ℹ ${e.message}`);
    else if (e.type === 'pod') io.err(`  Pod creato: ${e.podId}`);
  });
}

export function table(rows, columns) {
  const cells = rows.map((r) => columns.map((c) => String(c.value ? c.value(r) : r[c.key] ?? '')));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i].length)));
  const line = (vals) => vals.map((v, i) => (columns[i].align === 'right' ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(columns.map((c) => c.label)), line(widths.map((w) => '─'.repeat(w))), ...cells.map(line)].join('\n');
}

export const fmtGiB = (n) => `${Number(n).toFixed(1).replace('.', ',')} GiB`;

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`;
}
```

`src/cli/context.js`:

```js
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { LlmpodError, Codes } from '../core/errors.js';
import { createStore, configDir } from '../core/config.js';
import { createHttp } from '../core/http.js';
import { createRunpod } from '../core/runpod.js';
import { createHf } from '../core/hf.js';
import { createEvents } from '../core/events.js';
import { createOps } from '../core/ops.js';
import { zcodeDir, isZcodeRunning } from '../core/clients/zcode.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export function createContext({ env = process.env, io, overrides = {}, platform = process.platform }) {
  const store = createStore({ dir: configDir(env), platform });
  store.checkPermissions();
  const http = overrides.http ?? createHttp({ userAgent: `llmpod/${VERSION}` });
  const events = createEvents();
  const cache = {};
  const ctx = {
    env, io, store, http, events, platform,
    spawn: overrides.spawn ?? spawn,
    isZcodeRunning: overrides.isZcodeRunning ?? (() => isZcodeRunning({ platform })),
    get runpod() {
      if (overrides.runpod) return overrides.runpod;
      const apiKey = store.readEnv().RUNPOD_API_KEY;
      if (!apiKey) throw new LlmpodError(Codes.RUNPOD_AUTH, 'RUNPOD_API_KEY non configurata', { hint: 'Esegui: llmpod init' });
      return (cache.runpod ??= createRunpod({ http, apiKey }));
    },
    get hf() {
      return overrides.hf ?? (cache.hf ??= createHf({ http, token: store.readEnv().HF_TOKEN }));
    },
    get ops() {
      return (cache.ops ??= createOps({ store, runpod: ctx.runpod, hf: ctx.hf, http, events, ask: io.ask, zcode: { dir: zcodeDir(env), isRunning: ctx.isZcodeRunning } }));
    },
  };
  return ctx;
}
```

- [ ] **Passo 4: implementare program.js e index.js**

`src/cli/program.js`:

```js
import { Command, CommanderError } from 'commander';
import { LlmpodError, Codes } from '../core/errors.js';
import { redact } from '../core/secrets.js';
import { createContext, VERSION } from './context.js';
import { createIo } from './render.js';
import { createPrompt } from './prompt.js';
import * as init from './commands/init.js';
import * as search from './commands/search.js';
import * as plan from './commands/plan.js';
import * as save from './commands/save.js';

// Le attività successive aggiungono qui i loro comandi.
export const COMMANDS = [init, search, plan, save];

export async function runCli(argv, { io, env = process.env, overrides = {} } = {}) {
  io ??= createIo({ prompt: createPrompt() });
  const result = { code: 0 };
  const program = new Command('llmpod')
    .description('LLM self-hosted su Runpod come backend di coding agent')
    .version(VERSION)
    .option('--verbose', 'mostra i log di vLLM durante l\'avvio')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.raw(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });
  let ctx;
  const getCtx = () => (ctx ??= createContext({ env, io, overrides }));
  for (const cmd of COMMANDS) cmd.register(program, getCtx, result);

  try {
    await program.parseAsync(argv, { from: 'user' });
    return result.code;
  } catch (err) {
    if (err instanceof CommanderError) {
      return ['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(err.code) ? 0 : (err.exitCode || 1);
    }
    if (err instanceof LlmpodError) {
      io.err(`Errore [${err.code}]: ${err.message}`);
      if (err.hint) io.err(`  Suggerimento: ${err.hint}`);
      for (const line of err.details?.lastLines ?? []) io.err(`  │ ${line}`);
      return err.code === Codes.CANCELLED ? 130 : 1;
    }
    io.err(`Errore inatteso: ${redact(program.opts().verbose ? err.stack : err.message)}`);
    return 1;
  }
}
```

`src/cli/index.js`:

```js
#!/usr/bin/env node
import { runCli } from './program.js';

process.exitCode = await runCli(process.argv.slice(2));
```

Poi: `chmod +x src/cli/index.js`.

- [ ] **Passo 5: implementare i comandi init, search, plan, save**

`src/cli/commands/init.js`:

```js
import { LlmpodError, Codes } from '../../core/errors.js';
import { confirmCost } from '../../core/confirm.js';
import { table } from '../render.js';

async function verifyHfToken(http, token) {
  const r = await http.request('GET', 'https://huggingface.co/api/whoami-v2', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new LlmpodError(Codes.HF_AUTH, `Token Hugging Face non valido (HTTP ${r.status})`, { hint: 'Crea un token "Read" su https://huggingface.co/settings/tokens' });
}

export function register(program, getCtx) {
  program.command('init')
    .description('Configurazione guidata: credenziali, datacenter preferito, network volume per i pesi')
    .option('--datacenter <id>', 'datacenter preferito (es. EU-RO-1)')
    .option('--volume-size <gb>', 'dimensione del network volume in GB', (v) => Number.parseInt(v, 10))
    .option('--yes', 'non chiedere conferme')
    .option('--dry-run', 'non creare il volume')
    .action(async (opts) => {
      const ctx = getCtx();
      const { io, store } = ctx;
      store.ensureDir();

      if (!store.readEnv().RUNPOD_API_KEY || !(await io.ask('Chiave Runpod già configurata. Mantenerla?', true))) {
        const key = await io.askSecret('Chiave API Runpod (input nascosto):');
        if (!key) throw new LlmpodError(Codes.INVALID_INPUT, 'La chiave Runpod è obbligatoria', { hint: 'Creala su https://www.runpod.io/console/user/settings (permessi Restricted: Pods, Network Volumes e Templates in Read/Write)' });
        store.writeEnv({ RUNPOD_API_KEY: key });
      }
      await ctx.runpod.listPods();
      io.out('✓ Chiave Runpod valida');

      if (!store.readEnv().HF_TOKEN || !(await io.ask('Token Hugging Face già configurato. Mantenerlo?', true))) {
        const token = await io.askSecret('Token Hugging Face (facoltativo, serve per i modelli gated; invio per saltare):');
        if (token) {
          await verifyHfToken(ctx.http, token);
          store.writeEnv({ HF_TOKEN: token });
          io.out('✓ Token Hugging Face valido');
        }
      }

      const dcs = await ctx.runpod.listDataCenters();
      const usable = dcs
        .filter((d) => (d.networkVolumeTypes ?? []).length > 0)
        .map((d) => ({ id: d.id, region: d.region, gpus: (d.gpuAvailability ?? []).filter((g) => g.availability !== 'NONE').length }))
        .sort((a, b) => b.gpus - a.gpus);
      io.out(table(usable.slice(0, 15), [
        { key: 'id', label: 'Datacenter' }, { key: 'region', label: 'Regione' }, { key: 'gpus', label: 'GPU disponibili', align: 'right' },
      ]));
      const cfg = store.readConfig();
      const suggested = cfg.dataCenterId ?? usable.find((d) => d.region === 'EUROPE')?.id ?? usable[0]?.id;
      const dc = opts.datacenter ?? await io.askText('Datacenter preferito (il volume dei pesi sarà creato lì):', suggested);
      if (!usable.some((d) => d.id === dc)) throw new LlmpodError(Codes.INVALID_INPUT, `Datacenter "${dc}" non valido o senza network volume`);

      const existing = (await ctx.runpod.listVolumes()).filter((v) => v.dataCenter === dc);
      let volume = null;
      if (existing.length && (opts.yes || await io.ask(`Riutilizzare il volume ${existing[0].name} (${existing[0].size} GB)?`, true))) {
        volume = existing[0];
      } else {
        const size = opts.volumeSize ?? Number.parseInt(await io.askText('Dimensione del volume in GB (circa 2× i pesi dei modelli: 150 per ~30B, 500+ per 200B+):', '150'), 10);
        if (!Number.isInteger(size) || size < 10 || size > 4096) throw new LlmpodError(Codes.INVALID_INPUT, 'La dimensione deve essere tra 10 e 4096 GB');
        const conf = await confirmCost({ monthlyUSD: size * cfg.volumePricePerGbMonth, description: `Creazione del network volume llmpod-pesi da ${size} GB in ${dc}`, yes: opts.yes, dryRun: opts.dryRun, ask: io.ask });
        if (conf.dryRun) io.out(`[dry-run] ${conf.message}`);
        else volume = await ctx.runpod.createVolume({ name: 'llmpod-pesi', size, dataCenter: dc });
      }
      store.writeConfig({ dataCenterId: dc, ...(volume ? { volume: { id: volume.id, name: volume.name, size: volume.size, dataCenterId: dc } } : {}) });
      io.out(`✓ Configurazione salvata in ${store.dir}`);
    });
}
```

`src/cli/commands/search.js`:

```js
import { detectParsers } from '../../core/planner/vllm-args.js';
import { bytesFromSafetensorsParams, GiB } from '../../core/planner/vram.js';
import { table, fmtGiB } from '../render.js';

export function register(program, getCtx) {
  program.command('search <query...>')
    .description('Cerca su Hugging Face modelli text-generation adatti all\'uso agentico')
    .option('--limit <n>', 'numero di risultati', (v) => Number.parseInt(v, 10), 20)
    .option('--all', 'includi i modelli senza chat template')
    .option('--json', 'output JSON')
    .action(async (query, opts) => {
      const ctx = getCtx();
      const models = (await ctx.hf.searchModels(query.join(' '), { limit: opts.limit })).filter((m) => opts.all || m.hasChatTemplate);
      const rows = models.map((m) => {
        const known = m.architectures.length || m.modelType;
        const p = known ? detectParsers({ modelId: m.id, config: { architectures: m.architectures, model_type: m.modelType } }) : { tool: null };
        const bytes = bytesFromSafetensorsParams(m.paramsByDtype);
        return { ...m, parser: p.tool ?? '⚠ nessuno', weights: bytes ? fmtGiB(bytes / GiB) : '?' };
      });
      if (opts.json) return ctx.io.raw(JSON.stringify(rows, null, 2));
      ctx.io.out(table(rows, [
        { key: 'id', label: 'Modello' },
        { label: 'Parametri', align: 'right', value: (r) => (r.params ? `${(r.params / 1e9).toFixed(1)} B` : '?') },
        { label: 'Dtype', value: (r) => r.dtypes.join('+') || '?' },
        { label: 'Licenza', value: (r) => r.license ?? '?' },
        { label: 'Gated', value: (r) => (r.gated ? 'sì' : 'no') },
        { label: 'Download', align: 'right', value: (r) => r.downloads ?? '?' },
        { label: 'Aggiornato', value: (r) => (r.lastModified ? r.lastModified.slice(0, 10) : '?') },
        { key: 'weights', label: 'Pesi', align: 'right' },
        { key: 'parser', label: 'Tool parser' },
      ]));
      ctx.io.out('\nLa VRAM necessaria comprende anche la KV cache: calcolala con "llmpod plan <modello>".');
    });
}
```

`src/cli/commands/plan.js`:

```js
import { LlmpodError, Codes } from '../../core/errors.js';
import { makePlan } from '../../core/planner/plan.js';
import { loadFlags } from '../../core/planner/vllm-args.js';
import { fmtUSD } from '../../core/confirm.js';
import { table, fmtGiB, attachRenderer } from '../render.js';

const toInt = (v) => Number.parseInt(v, 10);
const collect = (v, acc) => [...acc, v];

export function register(program, getCtx) {
  program.command('plan <modello>')
    .description('Stima VRAM, sceglie la GPU e gli argomenti di vllm serve (org/modello, org/modello@rev o URL)')
    .option('--context <n>', 'lunghezza massima del contesto', toInt, 65536)
    .option('--concurrency <n>', 'richieste in parallelo previste', toInt, 2)
    .option('--set <chiave=valore>', 'imposta un argomento di vLLM (ripetibile)', collect, [])
    .option('--extra-arg <arg>', 'aggiunge un argomento di vLLM (ripetibile)', collect, [])
    .option('--image <immagine>', 'immagine vLLM (default da config.json)')
    .option('--allow-trust-remote-code', 'consente --trust-remote-code')
    .option('--json', 'output JSON')
    .action(async (modelRef, opts) => {
      const ctx = getCtx();
      const cfg = ctx.store.readConfig();
      if (!cfg.dataCenterId) throw new LlmpodError(Codes.INVALID_INPUT, 'Nessun datacenter configurato', { hint: 'Esegui: llmpod init' });
      const off = attachRenderer(ctx.events, ctx.io);
      let plan;
      try {
        plan = await makePlan({
          hf: ctx.hf, runpod: ctx.runpod, modelRef, context: opts.context, concurrency: opts.concurrency,
          cloud: cfg.cloud, dataCenterId: cfg.dataCenterId, minCudaVersion: cfg.minCudaVersion,
          vllmImage: opts.image ?? cfg.vllmImage, set: opts.set, extra: opts.extraArg, flags: loadFlags(),
          allowTrustRemoteCode: Boolean(opts.allowTrustRemoteCode),
          onProgress: (message) => ctx.events.emit('phase', { message }),
        });
      } finally {
        off();
      }
      ctx.store.writeJson('last-plan.json', plan);
      if (opts.json) return ctx.io.raw(JSON.stringify(plan, null, 2));

      const { io } = ctx;
      const m = plan.model;
      io.out(`Modello:   ${m.id} @ ${m.revision.slice(0, 12)} (${m.requestedRevision})  licenza: ${m.license ?? '?'}  gated: ${m.gated ? 'sì' : 'no'}`);
      io.out(`Memoria:   pesi ${fmtGiB(plan.estimate.weightsGiB)} · KV cache ${fmtGiB(plan.estimate.kvGiB)} (${plan.context} token × ${plan.concurrency}) · per GPU ${fmtGiB(plan.estimate.perGpuGiB)}${plan.kvCacheDtype ? ' · KV FP8' : ''}`);
      io.out(`Parser:    strumenti ${plan.parsers.tool ?? 'nessuno'} · ragionamento ${plan.parsers.reasoning ?? 'nessuno'}`);
      io.out('');
      io.out(table(plan.candidates, [
        { key: 'name', label: 'GPU' },
        { key: 'count', label: 'N', align: 'right' },
        { label: 'VRAM', align: 'right', value: (c) => `${c.memoryGiB} GB` },
        { label: 'Per GPU', align: 'right', value: (c) => fmtGiB(c.perGpuGiB) },
        { label: 'Margine', align: 'right', value: (c) => fmtGiB(c.headroomGiB) },
        { label: 'Costo', align: 'right', value: (c) => `${fmtUSD(c.hourly)}/h` },
        { label: `In ${plan.dataCenterId}`, value: (c) => c.availabilityHere },
      ]));
      io.out('');
      if (plan.gpu) io.out(`Scelta:    ${plan.gpu.id} ×${plan.gpu.count} a ${fmtUSD(plan.hourlyUSD)}/h`);
      if (plan.alternatives.length) io.out(`Alternative: ${plan.alternatives.map((a) => `${a.id} ×${a.count} (${fmtUSD(a.hourly)}/h)`).join(', ')}`);
      io.out(`vLLM:      ${plan.vllm.image}`);
      io.out(`           vllm serve ${m.id} --served-model-name <profilo> ${plan.vllm.args.join(' ')}`);
      for (const w of plan.warnings) io.out(`⚠ ${w}`);
      io.out('\nSalva il piano come profilo con: llmpod save <nome>');
    });
}
```

`src/cli/commands/save.js`:

```js
export function register(program, getCtx) {
  program.command('save <nome>')
    .description('Salva l\'ultimo piano come profilo riutilizzabile')
    .action(async (name) => {
      const ctx = getCtx();
      const profile = ctx.ops.saveProfile(name);
      ctx.io.out(`✓ Profilo "${name}" salvato in ${ctx.store.dir}/profiles/${name}.json`);
      ctx.io.out('  Chiave vLLM del profilo salvata nel file .env (non viene mostrata).');
      if (!profile.volume) ctx.io.out('⚠ Nessun network volume nello stesso datacenter: i pesi saranno scaricati a ogni avvio.');
      ctx.io.out(`Avvia con: llmpod up ${name}`);
    });
}
```

- [ ] **Passo 6: eseguire i test e verificare che passino**

Esegui: `npx vitest run test/cli/cli-plan.test.js`
Atteso: PASS (8 test).

- [ ] **Passo 7: prova manuale in sola lettura**

```bash
node src/cli/index.js --help
node src/cli/index.js search qwen3 coder --limit 5
```

Atteso: l'elenco dei comandi; poi una tabella di modelli reali da Hugging Face con la colonna "Tool parser" (nessuna credenziale necessaria).

- [ ] **Passo 8: commit e push**

```bash
git add src/cli test/cli
git commit -m "feat: CLI con init, search, plan e save"
git push
```

---
### Attività 15: CLI — up, down, status, env, run, rotate-key, destroy-volume

**File:**
- Crea: `src/cli/commands/up.js`, `src/cli/commands/down.js`, `src/cli/commands/status.js`, `src/cli/commands/env.js`, `src/cli/commands/run.js`, `src/cli/commands/rotate-key.js`, `src/cli/commands/destroy-volume.js`
- Modifica: `src/cli/program.js` (import e array `COMMANDS`)
- Test: `test/cli/cli-pod.test.js`

**Interfacce:**
- Consuma: `ctx.ops` (Attività 13), adattatori dei client (12), `formatEnv` (12), `attachRenderer`/`table`/`fmtDuration` (14), `confirmAction`/`fmtUSD` (11).
- Produce: i comandi `up <profilo>`, `down [profilo]`, `status`, `env`, `run <client>`, `claude` (alias di `run claude`), `rotate-key <profilo>`, `destroy-volume`. `run` restituisce come codice d'uscita quello del client.

- [ ] **Passo 1: scrivere il test che fallisce**

`test/cli/cli-pod.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-PROFILO-FINTA-ABCDEFG';
const profile = {
  name: 'qwen3-coder', servedName: 'qwen3-coder', cloud: 'SECURE', dataCenterId: 'EU-A', context: 65536, concurrency: 2,
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, gpu: { id: 'GPU80', count: 1 }, alternatives: [],
  volume: { id: 'vol1', mountPath: '/workspace' }, allowFallbackWithoutVolume: 'ask', watchdog: { idleMinutes: 30, maxHours: 8 },
};

function setup(opts = {}) {
  const s = sandbox(opts);
  s.store.writeEnv({ ...SECRETS, LLMPOD_KEY_QWEN3_CODER: KEY });
  s.store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-A' } });
  s.store.writeProfile(profile);
  const pods = [];
  const runpod = {
    listPods: vi.fn(async () => pods),
    getPod: vi.fn(async (id) => pods.find((p) => p.id === id) ?? null),
    getBalance: vi.fn(async () => ({ balance: 42.5, spendPerHour: 0 })),
    listGpus: vi.fn(async () => [{ id: 'GPU80', price: { secure: 1.5 }, maxCount: { secure: 8 }, memory: 80, dataCenters: [{ id: 'EU-A', availability: 'HIGH' }] }]),
    createPod: vi.fn(async () => ({ status: 201, data: { id: 'pod1' } })),
    deletePod: vi.fn(async (id) => { pods.splice(pods.findIndex((p) => p.id === id), 1); }),
    deleteVolume: vi.fn(async () => {}),
  };
  const http = { request: vi.fn(async () => ({ ok: false, status: 404, data: null })) };
  const child = () => { const c = new EventEmitter(); setTimeout(() => c.emit('exit', 3), 0); return c; };
  const spawn = vi.fn(child);
  const overrides = { runpod, http, spawn, isZcodeRunning: async () => false };
  const activate = () => {
    pods.push({ id: 'pod1', name: 'llmpod-qwen3-coder', status: 'RUNNING', cost: 1.49, runtime: { uptime: 7200 } });
    s.store.writeState({ pods: { 'qwen3-coder': { podId: 'pod1' } } });
  };
  return { ...s, runpod, spawn, overrides, activate, go: (argv) => s.run(argv, overrides) };
}

describe('CLI: ciclo di vita del Pod', () => {
  it('up --dry-run: nessuna creazione e nessun segreto nell\'output', async () => {
    const t = setup();
    expect(await t.go(['up', 'qwen3-coder', '--dry-run'])).toBe(0);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
    const all = t.all();
    expect(all).toContain('[dry-run]');
    expect(all).toContain('<REDATTO>');
    for (const secret of [KEY, SECRETS.RUNPOD_API_KEY, SECRETS.HF_TOKEN]) expect(all).not.toContain(secret);
  });

  it('un errore che contiene un segreto viene mascherato', async () => {
    const t = setup();
    t.runpod.listPods.mockRejectedValue(new Error(`boom ${SECRETS.RUNPOD_API_KEY}`));
    expect(await t.go(['status'])).toBe(1);
    expect(t.all()).not.toContain(SECRETS.RUNPOD_API_KEY);
    expect(t.all()).toContain('<REDATTO>');
  });

  it('down senza profilo usa l\'unico attivo e termina dopo conferma', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['down', '--yes'])).toBe(0);
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(t.out()).toContain('pod1');
  });

  it('status mostra Pod, costo della sessione, credito e volume', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['status'])).toBe(0);
    const out = t.out();
    expect(out).toContain('qwen3-coder');
    expect(out).toContain('1,49 $/h');
    expect(out).toContain('2,98 $');
    expect(out).toContain('42,50 $');
    expect(out).toContain('10,50 $ al mese');
  });

  it('env --format json espone gli export (chiave inclusa: è ciò che l\'utente chiede)', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['env', '--format', 'json'])).toBe(0);
    const env = JSON.parse(t.out());
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://pod1-8000.proxy.runpod.net', ANTHROPIC_AUTH_TOKEN: KEY, OPENAI_BASE_URL: 'https://pod1-8000.proxy.runpod.net/v1', OPENAI_API_KEY: KEY, LLMPOD_MODEL: 'qwen3-coder' });
  });

  it('run claude avvia il client con le variabili e ne restituisce il codice', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['run', 'claude'])).toBe(3);
    const [cmd, args, opts] = t.spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual([]);
    expect(opts.stdio).toBe('inherit');
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://pod1-8000.proxy.runpod.net');
    expect(await t.go(['claude'])).toBe(3);
  });

  it('run pi scrive models.json senza chiave e passa --provider/--model', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['run', 'pi'])).toBe(3);
    const [cmd, args, opts] = t.spawn.mock.calls[0];
    expect(cmd).toBe('pi');
    expect(args).toEqual(['--provider', 'llmpod', '--model', 'qwen3-coder']);
    expect(opts.env.LLMPOD_API_KEY).toBe(KEY);
    expect(fs.readFileSync(path.join(t.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')).not.toContain(KEY);
  });

  it('run zcode configura ZCode se chiuso, rifiuta se aperto', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['run', 'zcode', '--no-open'])).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(t.env.ZCODE_DIR, 'config.json'), 'utf8')).provider.llmpod.options.baseURL).toBe('https://pod1-8000.proxy.runpod.net/v1');
    t.overrides.isZcodeRunning = async () => true;
    expect(await t.run(['run', 'zcode', '--no-open'], t.overrides)).toBe(1);
    expect(t.err()).toContain('ZCODE_RUNNING');
  });

  it('run con client sconosciuto o non installato', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['run', 'boh'])).toBe(1);
    t.spawn.mockImplementation(() => { const c = new EventEmitter(); setTimeout(() => c.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' })), 0); return c; });
    expect(await t.go(['run', 'opencode'])).toBe(1);
    expect(t.err()).toMatch(/opencode.*non trovato/);
  });

  it('rotate-key non mostra la nuova chiave', async () => {
    const t = setup();
    expect(await t.go(['rotate-key', 'qwen3-coder'])).toBe(0);
    const fresh = t.store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    expect(fresh).not.toBe(KEY);
    expect(t.all()).not.toContain(fresh);
  });

  it('destroy-volume richiede il nome digitato', async () => {
    const t = setup({ answers: { ask: [true], text: ['nome-sbagliato'] } });
    expect(await t.go(['destroy-volume'])).toBe(130);
    expect(t.runpod.deleteVolume).not.toHaveBeenCalled();
    const t2 = setup({ answers: { ask: [true], text: ['llmpod-pesi'] } });
    expect(await t2.go(['destroy-volume'])).toBe(0);
    expect(t2.runpod.deleteVolume).toHaveBeenCalledWith('vol1');
    expect(t2.store.readConfig().volume).toBeNull();
  });

  it('destroy-volume rifiuta se un Pod llmpod è attivo', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['destroy-volume', '--yes'])).toBe(1);
    expect(t.runpod.deleteVolume).not.toHaveBeenCalled();
  });
});
```

- [ ] **Passo 2: eseguire il test e verificare che fallisca**

Esegui: `npx vitest run test/cli/cli-pod.test.js`
Atteso: FAIL (comandi sconosciuti: codice 1 dove il test si aspetta 0).

- [ ] **Passo 3: implementare i comandi**

`src/cli/commands/up.js`:

```js
import { attachRenderer } from '../render.js';
import { fmtUSD } from '../../core/confirm.js';

export function register(program, getCtx) {
  program.command('up <profilo>')
    .description('Crea il Pod, attende vLLM ed esegue lo smoke test')
    .option('--yes', 'non chiedere conferme')
    .option('--dry-run', 'mostra la richiesta senza creare nulla')
    .action(async (name, opts) => {
      const ctx = getCtx();
      const { io } = ctx;
      const off = attachRenderer(ctx.events, io, { verbose: program.opts().verbose });
      let podId = null;
      const offPod = ctx.events.on((e) => { if (e.type === 'pod') podId = e.podId; });
      const onSigint = async () => {
        process.off('SIGINT', onSigint);
        if (podId && await io.ask(`\nInterrotto. Terminare il Pod ${podId} per non continuare a pagare?`, true)) await ctx.ops.down(name, { yes: true });
        process.exit(130);
      };
      process.on('SIGINT', onSigint);
      try {
        const r = await ctx.ops.up(name, { yes: opts.yes, dryRun: opts.dryRun });
        if (r.dryRun) {
          io.out(`[dry-run] ${r.message}`);
          io.out(`Candidati: ${r.candidates.map((c) => `${c.id} ×${c.count} @ ${c.dataCenterId}${c.withVolume ? '' : ' (senza volume)'}`).join(', ')}`);
          io.out(JSON.stringify(r.body, null, 2));
          return;
        }
        io.out(`✓ ${name} pronto in ${r.startupSeconds} s`);
        io.out(`  Endpoint:  ${r.baseUrl}  (OpenAI: ${r.baseUrl}/v1)`);
        io.out(`  Costo:     ${fmtUSD(r.hourlyUSD)}/h su ${r.candidate.id} ×${r.candidate.count} (${r.candidate.dataCenterId})`);
        io.out('  Smoke test: /v1/models ✓  /v1/messages con strumento ✓  /v1/chat/completions con strumento ✓');
        if (r.contextSuggestion) io.out(`  La KV cache consente fino a ${r.contextSuggestion} token per richiesta: puoi rigenerare il profilo con --context ${r.contextSuggestion}`);
        io.out(`Usa: llmpod run claude | opencode | pi | zcode   ·   Spegni: llmpod down ${name}`);
      } finally {
        process.off('SIGINT', onSigint);
        offPod();
        off();
      }
    });
}
```

`src/cli/commands/down.js`:

```js
import { attachRenderer } from '../render.js';
import { fmtUSD } from '../../core/confirm.js';

export function register(program, getCtx) {
  program.command('down [profilo]')
    .description('Termina il Pod (il network volume con i pesi resta)')
    .option('--yes', 'non chiedere conferme')
    .option('--dry-run', 'non terminare, mostra soltanto')
    .option('--keep-volume', 'mantiene il volume (comportamento predefinito; per eliminarlo usa destroy-volume)')
    .action(async (name, opts) => {
      const ctx = getCtx();
      const profile = await ctx.ops.resolveProfile(name);
      const off = attachRenderer(ctx.events, ctx.io);
      try {
        const r = await ctx.ops.down(profile, { yes: opts.yes, dryRun: opts.dryRun });
        if (!r.podId) ctx.io.out(`Nessun Pod attivo per ${profile}`);
        else if (r.dryRun) ctx.io.out(`[dry-run] verrebbe terminato il Pod ${r.podId}`);
        else ctx.io.out(`✓ Pod ${r.podId} terminato (costo della sessione circa ${fmtUSD(r.sessionUSD)})`);
      } finally {
        off();
      }
    });
}
```

`src/cli/commands/status.js`:

```js
import { fmtUSD } from '../../core/confirm.js';
import { table, fmtDuration } from '../render.js';

export function register(program, getCtx) {
  program.command('status')
    .description('Pod attivi, costi, credito residuo, volume')
    .option('--json', 'output JSON')
    .action(async (opts) => {
      const ctx = getCtx();
      const s = await ctx.ops.status();
      if (opts.json) return ctx.io.raw(JSON.stringify(s, null, 2));
      const { io } = ctx;
      if (!s.pods.length) io.out('Nessun Pod llmpod attivo.');
      else {
        io.out(table(s.pods, [
          { label: 'Profilo', value: (p) => `${p.profile}${p.orphan ? ' (orfano)' : ''}` },
          { key: 'podId', label: 'Pod' },
          { key: 'status', label: 'Stato' },
          { label: 'GPU', value: (p) => (p.gpu ? `${p.gpu.id} ×${p.gpu.count}` : '?') },
          { label: 'Costo', align: 'right', value: (p) => `${fmtUSD(p.hourlyUSD)}/h` },
          { label: 'Uptime', align: 'right', value: (p) => fmtDuration(p.uptimeSeconds) },
          { label: 'Sessione', align: 'right', value: (p) => fmtUSD(p.sessionUSD) },
          { label: 'Spegnimento', value: (p) => (p.supervisor?.idleSeconds != null
            ? `inattivo da ${fmtDuration(p.supervisor.idleSeconds)} su ${fmtDuration(p.supervisor.idleLimitSeconds)}; massimo tra ${fmtDuration(p.supervisor.maxSeconds - p.supervisor.uptimeSeconds)}`
            : p.supervisor?.phase ?? '—') },
        ]));
        if (s.pods.some((p) => p.orphan)) io.out('⚠ Pod "orfani": non risultano avviati da questo computer. Terminali con: llmpod down <profilo>');
      }
      io.out(`Credito residuo: ${s.balance ? fmtUSD(s.balance.balance) : 'non disponibile'}`);
      if (s.volume) io.out(`Volume: ${s.volume.name} (${s.volume.size} GB, ${s.volume.dataCenterId}) — ${fmtUSD(s.volume.monthlyUSD)} al mese`);
    });
}
```

`src/cli/commands/env.js`:

```js
import { formatEnv } from '../../core/clients/env-format.js';
import { claudeEnv } from '../../core/clients/claude-code.js';

export function register(program, getCtx) {
  program.command('env')
    .description('Stampa gli export per collegare altri client al Pod (contiene la chiave del profilo)')
    .option('--profile <nome>', 'profilo')
    .option('--format <formato>', 'sh, ps1 o json', 'sh')
    .action(async (opts) => {
      const ctx = getCtx();
      const ep = await ctx.ops.endpoint(await ctx.ops.resolveProfile(opts.profile));
      const env = {
        ...claudeEnv(ep),
        OPENAI_BASE_URL: `${ep.baseUrl}/v1`,
        OPENAI_API_KEY: ep.apiKey,
        LLMPOD_MODEL: ep.servedName,
        LLMPOD_API_KEY: ep.apiKey,
      };
      // Uscita volutamente non mascherata: l'utente chiede esplicitamente gli export con la chiave.
      ctx.io.raw(formatEnv(env, opts.format));
    });
}
```

`src/cli/commands/run.js`:

```js
import { LlmpodError, Codes } from '../../core/errors.js';
import { prepareClaude } from '../../core/clients/claude-code.js';
import { prepareOpencode } from '../../core/clients/opencode.js';
import { preparePi, piDir } from '../../core/clients/pi.js';
import { updateZcode, zcodeDir } from '../../core/clients/zcode.js';

const INSTALL = {
  claude: 'Installa Claude Code: npm install -g @anthropic-ai/claude-code',
  opencode: 'Installa OpenCode: https://opencode.ai/docs',
  pi: 'Installa pi: npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
};

async function runClient(client, opts, getCtx, result) {
  const ctx = getCtx();
  if (!['claude', 'opencode', 'pi', 'zcode'].includes(client)) {
    throw new LlmpodError(Codes.INVALID_INPUT, `Client sconosciuto: ${client}`, { hint: 'Client supportati: claude, opencode, pi, zcode' });
  }
  const ep = await ctx.ops.endpoint(await ctx.ops.resolveProfile(opts.profile));

  if (client === 'zcode') {
    const file = await updateZcode(ep, { dir: zcodeDir(ctx.env), isRunning: ctx.isZcodeRunning });
    ctx.io.out(`✓ ZCode configurato (${file}): scegli il modello "${ep.servedName}" del provider "llmpod (Runpod)".`);
    if (opts.open !== false && ctx.platform === 'darwin') ctx.spawn('open', ['-a', 'ZCode'], { stdio: 'ignore', detached: true }).unref?.();
    return;
  }

  const prep = {
    claude: () => prepareClaude(ep),
    opencode: () => prepareOpencode(ep, { dir: ctx.store.dir }),
    pi: () => preparePi(ep, { dir: piDir(ctx.env) }),
  }[client]();
  const child = ctx.spawn(prep.command, prep.args, { stdio: 'inherit', env: { ...process.env, ...prep.env } });
  result.code = await new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err.code === 'ENOENT'
      ? new LlmpodError(Codes.INVALID_INPUT, `Comando "${prep.command}" non trovato`, { hint: INSTALL[client] })
      : err));
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

export function register(program, getCtx, result) {
  program.command('run <client>')
    .description('Avvia o configura un client sul Pod attivo: claude, opencode, pi, zcode')
    .option('--profile <nome>', 'profilo')
    .option('--no-open', 'ZCode: non aprire l\'app dopo la configurazione')
    .action((client, opts) => runClient(client, opts, getCtx, result));

  program.command('claude')
    .description('Alias di "run claude"')
    .option('--profile <nome>', 'profilo')
    .action((opts) => runClient('claude', opts, getCtx, result));
}
```

`src/cli/commands/rotate-key.js`:

```js
export function register(program, getCtx) {
  program.command('rotate-key <profilo>')
    .description('Genera una nuova chiave vLLM per il profilo')
    .action(async (name) => {
      const ctx = getCtx();
      const r = await ctx.ops.rotateKey(name);
      ctx.io.out(`✓ Nuova chiave per ${name} salvata nel file .env (non viene mostrata).`);
      if (r.activePodId) ctx.io.out(`⚠ Il Pod ${r.activePodId} usa ancora la chiave precedente: riavvialo con "llmpod down ${name}" e "llmpod up ${name}".`);
    });
}
```

`src/cli/commands/destroy-volume.js`:

```js
import { LlmpodError, Codes } from '../../core/errors.js';
import { confirmAction } from '../../core/confirm.js';

export function register(program, getCtx) {
  program.command('destroy-volume')
    .description('Elimina il network volume con i pesi (doppia conferma)')
    .option('--yes', 'salta entrambe le conferme')
    .option('--dry-run', 'non eliminare, mostra soltanto')
    .action(async (opts) => {
      const ctx = getCtx();
      const { io, store } = ctx;
      const volume = store.readConfig().volume;
      if (!volume) throw new LlmpodError(Codes.NOT_FOUND, 'Nessun network volume configurato');
      const active = (await ctx.runpod.listPods()).filter((p) => p.name?.startsWith('llmpod-') && !['TERMINATED', 'EXITED'].includes(p.status));
      if (active.length) throw new LlmpodError(Codes.INVALID_INPUT, `Ci sono Pod llmpod attivi (${active.map((p) => p.id).join(', ')})`, { hint: 'Terminali prima con: llmpod down' });
      const conf = await confirmAction({ description: `Eliminare DEFINITIVAMENTE il volume ${volume.name} (${volume.size} GB, ${volume.dataCenterId})? I pesi scaricati andranno persi`, yes: opts.yes, dryRun: opts.dryRun, ask: io.ask });
      if (conf.dryRun) return io.out(`[dry-run] ${conf.message}`);
      if (!opts.yes && (await io.askText('Per confermare digita il nome del volume:', '')) !== volume.name) {
        throw new LlmpodError(Codes.CANCELLED, 'Nome non corrispondente: volume NON eliminato');
      }
      await ctx.runpod.deleteVolume(volume.id);
      store.writeConfig({ volume: null });
      io.out(`✓ Volume ${volume.name} eliminato`);
    });
}
```

- [ ] **Passo 4: registrare i comandi in `program.js`**

Sostituire il blocco di import dei comandi e l'array `COMMANDS` con:

```js
import * as init from './commands/init.js';
import * as search from './commands/search.js';
import * as plan from './commands/plan.js';
import * as save from './commands/save.js';
import * as up from './commands/up.js';
import * as down from './commands/down.js';
import * as status from './commands/status.js';
import * as env from './commands/env.js';
import * as run from './commands/run.js';
import * as rotateKey from './commands/rotate-key.js';
import * as destroyVolume from './commands/destroy-volume.js';

export const COMMANDS = [init, search, plan, save, up, down, status, env, run, rotateKey, destroyVolume];
```

- [ ] **Passo 5: eseguire i test e verificare che passino**

Esegui: `npx vitest run test/cli/cli-pod.test.js`
Atteso: PASS (12 test).

- [ ] **Passo 6: eseguire tutta la suite**

Esegui: `npm test`
Atteso: tutti i test JS e Python PASS.

- [ ] **Passo 7: commit e push**

```bash
git add src/cli test/cli
git commit -m "feat: CLI up/down/status/env/run/rotate-key/destroy-volume"
git push
```

---
### Attività 16: Prova reale su CPU (supervisore, proxy, streaming oltre 100 s) e README

**File:**
- Crea: `scripts/e2e-cpu.js`
- Modifica: `README.md`

**Interfacce:**
- Consuma: `createStore`, `createHttp`, `createRunpod`/`proxyUrl`, `createSupervisorClient`, `createPrompt`, `registerSecret`/`redact`, `test/supervisor/fake_vllm.py`, `src/core/pod/supervisor.py`.
- Produce: `npm run e2e:cpu [-- --yes]` → stampa l'esito di 5 controlli ed esce con 0 solo se passano tutti; termina sempre il Pod di prova.

- [ ] **Passo 1: scrivere lo script**

`scripts/e2e-cpu.js`:

```js
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
```

- [ ] **Passo 2: verificare la sintassi senza eseguire chiamate**

Esegui: `node --check scripts/e2e-cpu.js && echo ok`
Atteso: `ok`.

- [ ] **Passo 3: eseguire la prova reale (costa circa 0,01 $: chiedere conferma all'utente prima)**

Esegui: `npm run e2e:cpu`
Atteso: 5 controlli `✓`, "Nessun Pod di prova rimasto attivo". Se lo streaming si interrompe intorno ai 100 s: annotare l'esito; il piano 3/4 dovrà prevedere il ripiego TCP per i client in streaming (non bloccante per questo piano, ma va segnalato all'utente).

- [ ] **Passo 4: aggiornare il README**

Sostituire in `README.md` il paragrafo iniziale "Stato: in progettazione…" con:

```markdown
> **Stato:** CLI v1 funzionante (piano 1). In arrivo: consulente con IA esterna (piano 2),
> interfaccia web (piano 3), Docker e script di avvio per ogni piattaforma (piano 4).
```

Aggiungere dopo la sezione "Funzionalità previste (v1)" le sezioni seguenti, compilando la riga dello streaming con l'esito reale del Passo 3:

````markdown
## Installazione (CLI, senza Docker)

Requisiti: Node.js ≥ 20, git. Python serve solo per i test del supervisore.

```bash
git clone https://github.com/deduzzo/runpod-helper.git
cd runpod-helper
npm install          # attiva anche l'hook anti-segreti
npm link             # rende disponibile il comando "llmpod"
```

## Primo utilizzo end-to-end

```bash
llmpod init                                   # chiave Runpod, token HF, datacenter, network volume
llmpod search qwen3 coder                     # modelli con chat template e tool parser noto
llmpod plan Qwen/Qwen3-Coder-30B-A3B-Instruct --context 65536
llmpod save qwen3-coder
llmpod up qwen3-coder                         # mostra il costo orario e chiede conferma
llmpod run claude                             # oppure: opencode, pi, zcode
llmpod status
llmpod down                                   # il volume con i pesi resta
```

Il Pod si spegne da solo dopo 30 minuti senza richieste o dopo 8 ore in ogni caso
(valori nel profilo, sezione `watchdog`), anche a portatile spento.

## Costi tipici

Prezzi di listino Runpod Secure Cloud letti dall'API il 11/10/2026 (possono cambiare;
`llmpod plan` mostra sempre quelli correnti):

| GPU | VRAM | $/h |
|---|---|---|
| RTX 4090 | 24 GB | 0,89 |
| RTX 6000 Ada | 48 GB | 0,99 |
| L40S | 48 GB | 1,09 |
| A100 80GB (PCIe/SXM) | 80 GB | 1,79 |
| RTX PRO 6000 Blackwell | 96 GB | 2,49 |
| H100 PCIe | 80 GB | 2,89 |
| H100 SXM | 80 GB | 3,99 |
| H200 | 141 GB | 5,29 |

Esempio: Qwen3-Coder-30B-A3B con 64K di contesto entra in una A100 80GB (circa 1,79 $/h).
Network volume: 0,07 $/GB al mese (150 GB = 10,50 $/mese), pagato anche a Pod spento.

## Risoluzione dei problemi

| Errore | Causa | Cosa fare |
|---|---|---|
| `NO_GPU_AVAILABLE` | Nessuna GPU adatta libera nel datacenter del volume | Riprova più tardi; `llmpod plan` mostra dove c'è disponibilità; `up` può ripiegare su altri datacenter senza volume |
| `GATED_MODEL` / `HF_AUTH` | Modello con accesso su richiesta | Richiedi l'accesso sulla pagina del modello e imposta `HF_TOKEN` con `llmpod init` (basta un token Read) |
| `OOM` | Memoria GPU insufficiente | Riduci `--context`, usa `--set kv-cache-dtype=fp8` o una GPU più grande (`llmpod plan`) |
| `SMOKE_TEST_FAILED` / `UNKNOWN_TOOL_PARSER` | Le chiamate a strumento non funzionano | Verifica il parser con `llmpod plan … --set tool-call-parser=<nome>`; elenco: https://docs.vllm.ai/en/v0.30.0/features/tool_calling/ |
| `ZCODE_RUNNING` | ZCode è aperto e sovrascriverebbe la configurazione | Chiudi ZCode e ripeti `llmpod run zcode` |
| `CONFIG_PERMISSIONS` | `.env` leggibile da altri utenti | `chmod 600 ~/.config/llmpod/.env` |
| Risposte interrotte dopo ~100 s | Limite del proxy HTTPS di Runpod (Cloudflare) | Esito della prova reale: _compilare con il risultato del controllo streaming_ |

## Sicurezza

- Le credenziali stanno in `~/.config/llmpod/.env` (permessi 600) e non vengono mai stampate.
- Nel Pod non entra nessuna chiave Runpod dell'utente: il watchdog usa la chiave che Runpod
  inietta nel Pod, verificata in grado di agire solo su quel Pod.
- Ogni profilo ha una chiave vLLM propria (`llmpod rotate-key` per cambiarla).
- Le metriche di vLLM (`/metrics`) sono raggiungibili senza chiave tramite il proxy pubblico:
  espongono solo contatori, non i contenuti delle richieste.
````

- [ ] **Passo 5: commit e push**

```bash
git add scripts/e2e-cpu.js README.md
git commit -m "feat: prova reale su CPU e README con installazione, costi e risoluzione problemi"
git push
```
