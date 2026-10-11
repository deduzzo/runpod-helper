# llmpod — Piano 4: Docker, script di avvio per ogni piattaforma, wrapper e CI

> **Per chi esegue con agenti:** SUB-SKILL RICHIESTA: usare superpowers:subagent-driven-development (consigliata) oppure superpowers:executing-plans. I passi usano le caselle (`- [ ]`) per il tracciamento.

**Obiettivo:** avviare llmpod (interfaccia web, core, proxy e Open WebUI) con Docker Compose tramite uno script per macOS, Linux e Windows; usare la CLI dall'host tramite un wrapper che esegue i comandi nel container e avvia i client (Claude Code, OpenCode, pi) sull'host; CI su GitHub con test, gitleaks e build dell'immagine.

**Architettura:** immagine `node:22-slim` multi-stage (compila la web UI, poi solo dipendenze di produzione, utente non-root, `HEALTHCHECK`). `compose.yaml` con il servizio `llmpod` (porta `127.0.0.1:7860`, cartelle montate da host) e il servizio facoltativo `open-webui` (profilo compose `openwebui`, `127.0.0.1:3000`, punta al proxy interno `http://llmpod:8081/v1`). Gli script preparano le variabili (cartelle, UID/GID, chiave interna di Open WebUI, token dell'interfaccia), lanciano `init` al primo avvio, `docker compose up -d`, attendono la salute e aprono il browser. Il wrapper `bin/llmpod` chiama `docker compose run --rm llmpod …`; per i client usa il nuovo comando `llmpod prepare <client>` che scrive i file di configurazione (nelle cartelle montate) e stampa uno script di shell da eseguire sull'host con i percorsi tradotti.

**Tech stack:** Docker / Docker Compose v2, POSIX sh, PowerShell 5+/7, GitHub Actions, gitleaks.

**Spec:** `docs/superpowers/specs/2026-10-11-llmpod-design.md` (§10). Piani 1–3 eseguiti.

## Vincoli globali

- Nessun segreto nell'immagine: `.dockerignore` esclude `.env*`, `.git`, `node_modules`, `dist`, `.superpowers`, `coverage`; nessun segreto in `ARG`/`ENV` del Dockerfile o in `compose.yaml`. Le chiavi arrivano solo dalla cartella di configurazione montata o dalle variabili d'ambiente di processo impostate dagli script (mai scritte in file del progetto).
- Porte pubblicate solo su `127.0.0.1`. Porta host = porta container (default 7860), perché il server verifica l'header `Host`. Il proxy (8081) non è pubblicato: solo rete compose.
- Ruling sulla spec §10: la cartella di configurazione è montata in lettura/scrittura (non `.env` in sola lettura), perché `init`, `rotate-key`, `advisor` e `ui` scrivono `.env`. I permessi 700/600 restano quelli del filesystem dell'host.
- Container eseguito con l'UID/GID dell'utente host (`LLMPOD_UID`/`LLMPOD_GID`, default 1000), così i file creati restano dell'utente.
- Immagini fissate: `node:22-slim` (digest non richiesto), `ghcr.io/open-webui/open-webui:v0.11.4`.
- Messaggi degli script in italiano; gli script non stampano mai chiavi, tranne l'URL con il token dell'interfaccia (necessario per entrare).
- Open WebUI: `ENABLE_PERSISTENT_CONFIG=false`, `WEBUI_AUTH=false`, `ENABLE_OLLAMA_API=false`, `OPENAI_API_BASE_URL=http://llmpod:8081/v1`, `OPENAI_API_KEY=${LLMPOD_OPENWEBUI_KEY}`.

## Focus della revisione

1. **Primo avvio senza configurazione** → gli script creano la cartella (700) e `.env` (600), lanciano `init` interattivo e non avviano i servizi finché manca la chiave Runpod. Test: Attività 3.
2. **ZCode aperto quando si chiede `llmpod run zcode` dal wrapper** → rifiuto sull'host prima di toccare il file. Test: Attività 4.
3. **Percorsi dei file di configurazione dei client** (OpenCode) → tradotti da `/config/...` al percorso dell'host. Test: Attività 1 e 4.
4. **Docker non installato o non in esecuzione** → messaggio chiaro, nessun traceback. Test: Attività 3.
5. **Immagine con segreti o file inutili** → `.dockerignore` e controllo nella CI. Test: Attività 2 e 5.

## Struttura dei file

```
src/core/clients/prepare.js      prepareClient (condivisa da run e prepare)
src/cli/commands/prepare.js      llmpod prepare <client> --format sh|ps1 --host-config-dir --host-pi-dir
src/cli/commands/run.js          (modifica) usa prepareClient
Dockerfile  .dockerignore  compose.yaml
scripts/start.sh  scripts/stop.sh  scripts/start.command  scripts/stop.command
scripts/start.ps1  scripts/stop.ps1  scripts/start.bat  scripts/stop.bat  scripts/lib.sh
bin/llmpod  bin/llmpod.ps1
.github/workflows/ci.yml
test/scripts/*.test.js           (shell con docker/pgrep finti su PATH)
```

---

### Attività 1: `prepareClient` e comando `llmpod prepare`

**File:**
- Crea: `src/core/clients/prepare.js`, `src/cli/commands/prepare.js`
- Modifica: `src/cli/commands/run.js` (usa `prepareClient`), `src/cli/program.js` (registra `prepare`)
- Test: `test/cli/cli-prepare.test.js`

**Interfacce:**
- Produce:
  - `prepareClient(client, ep, { configDir, piDir }) → { command, args, env }` per `claude`, `opencode`, `pi` (lancia `INVALID_INPUT` per altri); scrive i file come oggi (`prepareOpencode` in `configDir/clients`, `preparePi` in `piDir`).
  - `llmpod prepare <client> [--profile] [--format sh|ps1] [--host-config-dir <dir>] [--host-pi-dir <dir>]`: risolve il profilo e l'endpoint, chiama `prepareClient`, traduce nei valori d'ambiente i prefissi `ctx.store.dir` → `--host-config-dir` e `piDir(ctx.env)` → `--host-pi-dir` (se indicati), e stampa con `io.raw` uno script: formato `sh` → righe `export K='v'` (quoting di `formatEnv`) seguite da `exec 'cmd' 'arg1' …`; formato `ps1` → righe `$env:K = 'v'` seguite da `& 'cmd' 'arg1' …; exit $LASTEXITCODE`. Il client `zcode` non è ammesso (`INVALID_INPUT` con hint "usa llmpod run zcode").

- [ ] **Passo 1: test che fallisce**

`test/cli/cli-prepare.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-PREPARE-FINTA-1234567';

function setup() {
  const s = sandbox();
  s.store.writeEnv({ ...SECRETS, LLMPOD_KEY_QWEN3_CODER: KEY });
  s.store.writeProfile({ name: 'qwen3-coder', servedName: 'qwen3-coder', context: 65536, parsers: { tool: 'qwen3_coder', reasoning: null }, model: { id: 'Q/Q' }, gpu: { id: 'G', count: 1 }, vllm: { args: [] } });
  s.store.writeState({ pods: { 'qwen3-coder': { podId: 'pod1' } } });
  const runpod = { getPod: async () => ({ id: 'pod1', name: 'llmpod-qwen3-coder', status: 'RUNNING' }), listPods: async () => [] };
  return { ...s, runpod };
}

describe('llmpod prepare', () => {
  it('sh: export e exec, percorsi tradotti per OpenCode', async () => {
    const t = setup();
    expect(await t.run(['prepare', 'opencode', '--format', 'sh', '--host-config-dir', '/Users/io/.config/llmpod'], { runpod: t.runpod })).toBe(0);
    const out = t.out();
    expect(out).toContain("export OPENCODE_CONFIG='/Users/io/.config/llmpod/clients/opencode.json'");
    expect(out).toContain(`export LLMPOD_API_KEY='${KEY}'`);
    expect(out.trim().split('\n').at(-1)).toBe("exec 'opencode'");
    expect(fs.existsSync(path.join(t.env.LLMPOD_CONFIG_DIR, 'clients', 'opencode.json'))).toBe(true);
  });

  it('ps1 per pi con argomenti', async () => {
    const t = setup();
    expect(await t.run(['prepare', 'pi', '--format', 'ps1', '--host-pi-dir', 'C:\\Users\\io\\.pi\\agent'], { runpod: t.runpod })).toBe(0);
    const lines = t.out().trim().split('\n');
    expect(lines).toContain(`$env:LLMPOD_API_KEY = '${KEY}'`);
    expect(lines.at(-1)).toBe("& 'pi' '--provider' 'llmpod' '--model' 'qwen3-coder'; exit $LASTEXITCODE");
  });

  it('zcode non ammesso', async () => {
    const t = setup();
    expect(await t.run(['prepare', 'zcode'], { runpod: t.runpod })).toBe(1);
    expect(t.err()).toMatch(/llmpod run zcode/);
  });
});
```

- [ ] **Passo 2: verificare che fallisca** — `npx vitest run test/cli/cli-prepare.test.js` → FAIL.

- [ ] **Passo 3: `src/core/clients/prepare.js`**

```js
import { LlmpodError, Codes } from '../errors.js';
import { prepareClaude } from './claude-code.js';
import { prepareOpencode } from './opencode.js';
import { preparePi } from './pi.js';

export function prepareClient(client, ep, { configDir, piDir }) {
  if (client === 'claude') return prepareClaude(ep);
  if (client === 'opencode') return prepareOpencode(ep, { dir: configDir });
  if (client === 'pi') return preparePi(ep, { dir: piDir });
  throw new LlmpodError(Codes.INVALID_INPUT, `Client non gestibile da prepare: ${client}`, { hint: client === 'zcode' ? 'Per ZCode usa: llmpod run zcode' : 'Client: claude, opencode, pi' });
}
```

In `src/cli/commands/run.js` sostituire l'oggetto `{ claude: …, opencode: …, pi: … }[client]()` con `prepareClient(client, ep, { configDir: ctx.store.dir, piDir: piDir(ctx.env) })` e rimuovere gli import non più usati.

- [ ] **Passo 4: `src/cli/commands/prepare.js`**

```js
import { prepareClient } from '../../core/clients/prepare.js';
import { piDir } from '../../core/clients/pi.js';

const sq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
const pq = (v) => `'${String(v).replace(/'/g, "''")}'`;

export function register(program, getCtx) {
  program.command('prepare <client>')
    .description('Prepara un client (claude, opencode, pi) e stampa lo script per avviarlo sull\'host (usato dal wrapper Docker)')
    .option('--profile <nome>', 'profilo')
    .option('--format <formato>', 'sh o ps1', 'sh')
    .option('--host-config-dir <dir>', 'percorso della cartella di configurazione sull\'host')
    .option('--host-pi-dir <dir>', 'percorso della cartella di pi sull\'host')
    .action(async (client, opts) => {
      const ctx = getCtx();
      const ep = await ctx.ops.endpoint(await ctx.ops.resolveProfile(opts.profile));
      const containerPi = piDir(ctx.env);
      const prep = prepareClient(client, ep, { configDir: ctx.store.dir, piDir: containerPi });
      const translate = (v) => {
        let s = String(v);
        if (opts.hostConfigDir && s.startsWith(ctx.store.dir)) s = opts.hostConfigDir + s.slice(ctx.store.dir.length);
        if (opts.hostPiDir && s.startsWith(containerPi)) s = opts.hostPiDir + s.slice(containerPi.length);
        return s;
      };
      const env = Object.entries(prep.env).map(([k, v]) => [k, translate(v)]);
      const lines = opts.format === 'ps1'
        ? [...env.map(([k, v]) => `$env:${k} = ${pq(v)}`), `& ${[prep.command, ...prep.args].map(pq).join(' ')}; exit $LASTEXITCODE`]
        : [...env.map(([k, v]) => `export ${k}=${sq(v)}`), `exec ${[prep.command, ...prep.args].map(sq).join(' ')}`];
      // Output volutamente non mascherato: lo esegue il wrapper sull'host.
      ctx.io.raw(lines.join('\n'));
    });
}
```

In `src/cli/program.js` importare `prepare` e aggiungerlo a `COMMANDS`.

- [ ] **Passo 5: verificare** — `npx vitest run test/cli/cli-prepare.test.js` → PASS (3 test); `npm test` verde (incluse le prove di `run`).

- [ ] **Passo 6: commit e push** — `git add src test && git commit -m "feat: comando prepare per avviare i client sull'host" && git push`

---

### Attività 2: Dockerfile, .dockerignore, compose e prova del container

**File:**
- Crea: `Dockerfile`, `.dockerignore`, `compose.yaml`, `scripts/docker-smoke.sh`
- Modifica: `src/cli/commands/ui.js` (host del proxy da `LLMPOD_PROXY_HOST`, default uguale a `--host`)

**Interfacce:**
- Produce: immagine `llmpod:local` con `ENTRYPOINT ["node","src/cli/index.js"]` e `CMD ["ui","--no-open"]`; variabili nell'immagine: `NODE_ENV=production`, `LLMPOD_IN_DOCKER=1`, `LLMPOD_CONFIG_DIR=/config`, `ZCODE_DIR=/zcode`, `PI_CODING_AGENT_DIR=/pi`, `LLMPOD_UI_HOST=0.0.0.0`, `LLMPOD_PROXY_HOST=0.0.0.0`; `HEALTHCHECK` su `/api/health` con header `Host: 127.0.0.1:${LLMPOD_UI_PORT:-7860}`. `scripts/docker-smoke.sh` costruisce l'immagine, avvia un container con una cartella di configurazione temporanea, verifica salute (200), `Host` estraneo (403), API senza token (401), poi lo rimuove.

- [ ] **Passo 1: `.dockerignore`**

```
.git
.github
.githooks
.superpowers
node_modules
dist
coverage
test
docs
.env
.env.*
*.log
.DS_Store
```

- [ ] **Passo 2: `Dockerfile`**

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:web

FROM node:22-slim
ENV NODE_ENV=production \
    LLMPOD_IN_DOCKER=1 \
    LLMPOD_CONFIG_DIR=/config \
    ZCODE_DIR=/zcode \
    PI_CODING_AGENT_DIR=/pi \
    LLMPOD_UI_HOST=0.0.0.0 \
    LLMPOD_PROXY_HOST=0.0.0.0 \
    LLMPOD_UI_PORT=7860 \
    LLMPOD_PROXY_PORT=8081
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY data ./data
COPY --from=build /app/dist ./dist
RUN mkdir -p /config /zcode /pi && chown node:node /config /zcode /pi
USER node
EXPOSE 7860 8081
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD node -e "const p=process.env.LLMPOD_UI_PORT||7860;fetch('http://127.0.0.1:'+p+'/api/health',{headers:{host:'127.0.0.1:'+p}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "src/cli/index.js"]
CMD ["ui", "--no-open"]
```

- [ ] **Passo 3: `compose.yaml`**

```yaml
name: llmpod

services:
  llmpod:
    build: .
    image: llmpod:local
    user: "${LLMPOD_UID:-1000}:${LLMPOD_GID:-1000}"
    environment:
      LLMPOD_UI_TOKEN: ${LLMPOD_UI_TOKEN:-}
      LLMPOD_UI_PORT: ${LLMPOD_UI_PORT:-7860}
    ports:
      - "127.0.0.1:${LLMPOD_UI_PORT:-7860}:${LLMPOD_UI_PORT:-7860}"
    volumes:
      - "${LLMPOD_CONFIG_DIR:?imposta LLMPOD_CONFIG_DIR (usa scripts/start)}:/config"
      - "${ZCODE_DIR:?imposta ZCODE_DIR (usa scripts/start)}:/zcode"
      - "${PI_DIR:?imposta PI_DIR (usa scripts/start)}:/pi"
    restart: unless-stopped

  open-webui:
    image: ghcr.io/open-webui/open-webui:v0.11.4
    profiles: ["openwebui"]
    depends_on:
      - llmpod
    environment:
      OPENAI_API_BASE_URL: http://llmpod:8081/v1
      OPENAI_API_KEY: ${LLMPOD_OPENWEBUI_KEY:-}
      ENABLE_PERSISTENT_CONFIG: "false"
      WEBUI_AUTH: "false"
      ENABLE_OLLAMA_API: "false"
    ports:
      - "127.0.0.1:3000:8080"
    volumes:
      - open-webui-data:/app/backend/data
    restart: unless-stopped

volumes:
  open-webui-data: {}
```

- [ ] **Passo 4: `ui.js`** — nel comando `ui` sostituire `proxyHost: opts.host` con `proxyHost: process.env.LLMPOD_PROXY_HOST ?? opts.host`.

- [ ] **Passo 5: `scripts/docker-smoke.sh`**

```sh
#!/usr/bin/env sh
# Prova del container: salute, Host estraneo, API senza token. Non usa credenziali reali.
set -eu
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
mkdir -p "$TMP/config" "$TMP/zcode" "$TMP/pi"
chmod 700 "$TMP/config"
NAME="llmpod-smoke-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
docker build -q -t llmpod:local . >/dev/null
docker run -d --name "$NAME" --user "$(id -u):$(id -g)" -p 127.0.0.1:7999:7999 -e LLMPOD_UI_PORT=7999 -e LLMPOD_UI_TOKEN=token-smoke-1234567890 \
  -v "$TMP/config:/config" -v "$TMP/zcode:/zcode" -v "$TMP/pi:/pi" llmpod:local >/dev/null
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: 127.0.0.1:7999' http://127.0.0.1:7999/api/health)" = "200" ]; do
  i=$((i + 1)); [ "$i" -gt 30 ] && { docker logs "$NAME"; echo "✗ il container non risponde" >&2; exit 1; }; sleep 1
done
echo "✓ salute 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' http://127.0.0.1:7999/api/health)" = "403" ] && echo "✓ Host estraneo 403" || { echo "✗ Host estraneo non rifiutato" >&2; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7999/api/session)" = "401" ] && echo "✓ API senza token 401" || { echo "✗ API accessibile senza token" >&2; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Cookie: llmpod_session=token-smoke-1234567890' http://127.0.0.1:7999/api/session)" = "200" ] && echo "✓ API con token 200" || { echo "✗ token non accettato" >&2; exit 1; }
[ -f "$TMP/config/.env" ] && [ "$(stat -c '%a' "$TMP/config/.env" 2>/dev/null || stat -f '%Lp' "$TMP/config/.env")" = "600" ] && echo "✓ .env creato con permessi 600" || { echo "✗ permessi di .env" >&2; exit 1; }
docker run --rm --entrypoint sh llmpod:local -c 'test ! -e /app/.env && test ! -e /app/.git && test ! -e /app/test' && echo "✓ immagine senza .env/.git/test"
```

- [ ] **Passo 6: verificare (richiede Docker)** — `sh -n scripts/docker-smoke.sh`; `docker compose config -q` con `LLMPOD_CONFIG_DIR=/tmp/a ZCODE_DIR=/tmp/b PI_DIR=/tmp/c` impostate (validazione del file); `sh scripts/docker-smoke.sh` → tutte le righe `✓`. `npm test` verde.

- [ ] **Passo 7: commit e push** — `git add Dockerfile .dockerignore compose.yaml scripts/docker-smoke.sh src/cli/commands/ui.js && git commit -m "feat: immagine Docker e compose con Open WebUI" && git push`

---

### Attività 3: Script di avvio e arresto per macOS, Linux e Windows

**File:**
- Crea: `scripts/lib.sh`, `scripts/start.sh`, `scripts/stop.sh`, `scripts/start.command`, `scripts/stop.command`, `scripts/start.ps1`, `scripts/stop.ps1`, `scripts/start.bat`, `scripts/stop.bat`
- Test: `test/scripts/start.test.js`

**Interfacce:**
- Produce:
  - `scripts/lib.sh` (POSIX, incluso con `.`): funzione `llmpod_env` che controlla Docker (`command -v docker` → "Docker non trovato: installa Docker Desktop o Docker Engine"; `docker info` → "Docker non è in esecuzione: avvialo e riprova"; uscita 1), imposta `LLMPOD_CONFIG_DIR` (default `$HOME/.config/llmpod`), `ZCODE_DIR` (`$HOME/.zcode/v2`), `PI_DIR` (`$HOME/.pi/agent`), le crea (config con `chmod 700`), crea `.env` vuoto con `umask 077` se manca, genera `LLMPOD_OPENWEBUI_KEY` se manca (32 byte casuali in base64url) e la esporta leggendola dal file, esporta `LLMPOD_UID`/`LLMPOD_GID`.
  - `start.sh [--no-openwebui]`: `llmpod_env`; `COMPOSE_PROFILES=openwebui` salvo opzione; token casuale `LLMPOD_UI_TOKEN`; `docker compose build llmpod`; se `.env` non contiene `RUNPOD_API_KEY=` esegue `docker compose run --rm -it llmpod init` (interrompe se fallisce); `docker compose up -d`; attende la salute (max 60 s) con lo stesso controllo dell'`HEALTHCHECK` via `docker compose exec -T`; stampa `Interfaccia llmpod: http://127.0.0.1:<porta>/?t=<token>` e la apre (`open` su macOS, `xdg-open` su Linux se presente).
  - `stop.sh`: `llmpod_env` e `docker compose --profile openwebui down` (i volumi restano).
  - `start.command`/`stop.command`: doppio clic su macOS, eseguono gli script `.sh` della stessa cartella.
  - `start.ps1`/`stop.ps1`: stessa logica in PowerShell (cartelle sotto `$env:USERPROFILE`; ACL non modificate; chiave e token con `System.Security.Cryptography.RandomNumberGenerator`; apertura con `Start-Process`).
  - `start.bat`/`stop.bat`: `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*`.

- [ ] **Passo 1: test che fallisce** — `test/scripts/start.test.js` esegue `scripts/start.sh` con un `docker` finto su `PATH`:

```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

function fakeBin({ dockerRunning = true } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-bin-'));
  const log = path.join(bin, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  info) ${dockerRunning ? 'exit 0' : 'exit 1'} ;;
  compose)
    case "$*" in
      *"run --rm -it llmpod init"*) printf 'RUNPOD_API_KEY=rpa_FINTA\\n' >> "$LLMPOD_CONFIG_DIR/.env" ;;
    esac
    exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  for (const t of ['open', 'xdg-open']) fs.writeFileSync(path.join(bin, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { bin, log };
}

function runStart(args, { home, bin, path: pathEnv }) {
  return spawnSync('sh', [path.join(ROOT, 'scripts/start.sh'), ...args], {
    env: { HOME: home, PATH: pathEnv ?? `${bin}:/usr/bin:/bin` }, encoding: 'utf8',
  });
}

describe('scripts/start.sh', () => {
  it('primo avvio: crea cartelle e .env 600, chiave interna, init, up, URL con token', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
    const { bin, log } = fakeBin();
    const r = runStart([], { home, bin });
    expect(r.status).toBe(0);
    const cfg = path.join(home, '.config/llmpod');
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o700);
    const envFile = path.join(cfg, '.env');
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(envFile, 'utf8')).toMatch(/^LLMPOD_OPENWEBUI_KEY=[A-Za-z0-9_-]{40,}$/m);
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain('compose build llmpod');
    expect(calls).toContain('compose run --rm -it llmpod init');
    expect(calls).toContain('compose up -d');
    expect(r.stdout).toMatch(/Interfaccia llmpod: http:\/\/127\.0\.0\.1:7860\/\?t=[A-Za-z0-9]{40,}/);
    expect(r.stdout).not.toMatch(/LLMPOD_OPENWEBUI_KEY|rpa_FINTA/);
    expect(fs.existsSync(path.join(home, '.zcode/v2'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.pi/agent'))).toBe(true);
  });

  it('secondo avvio: niente init se la chiave Runpod c\'è; chiave interna invariata', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
    const { bin, log } = fakeBin();
    runStart([], { home, bin });
    const before = fs.readFileSync(path.join(home, '.config/llmpod/.env'), 'utf8');
    fs.writeFileSync(log, '');
    expect(runStart(['--no-openwebui'], { home, bin }).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('init');
    expect(fs.readFileSync(path.join(home, '.config/llmpod/.env'), 'utf8')).toBe(before);
  });

  it('Docker assente o fermo → messaggio chiaro e uscita 1', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-nobin-'));
    const r1 = runStart([], { home, bin: empty, path: `${empty}:/usr/bin:/bin` });
    expect(r1.status).toBe(1);
    expect(r1.stderr).toMatch(/Docker non trovato/);
    const { bin } = fakeBin({ dockerRunning: false });
    const r2 = runStart([], { home, bin });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toMatch(/Docker non è in esecuzione/);
  });
});
```

Nota: il test presuppone che `/usr/bin` non contenga `docker`; se sulla macchina di sviluppo `docker` è in `/usr/bin`, il primo caso del terzo test va eseguito con `PATH` che non lo include (la CI Linux lo garantisce: in tal caso adattare `path` usando una cartella con soli `sh`, `mkdir`, `chmod`, `grep`, `cut`, `head`, `od`, `tr` simbolici). La chiave e il token sono generati con `od -An -N32 -tx1 /dev/urandom` (sempre presente) e convertiti senza `openssl`.

- [ ] **Passo 2: verificare che fallisca** — `npx vitest run test/scripts/start.test.js` → FAIL.

- [ ] **Passo 3: `scripts/lib.sh`**

```sh
# Funzioni comuni degli script llmpod (POSIX sh). Includere con: . "$(dirname "$0")/lib.sh"

llmpod_random() {
  # $1 = byte; stampa una stringa esadecimale casuale
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

llmpod_env() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker non trovato: installa Docker Desktop o Docker Engine" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker non è in esecuzione: avvialo e riprova" >&2
    exit 1
  fi
  export LLMPOD_CONFIG_DIR="${LLMPOD_CONFIG_DIR:-$HOME/.config/llmpod}"
  export ZCODE_DIR="${ZCODE_DIR:-$HOME/.zcode/v2}"
  export PI_DIR="${PI_DIR:-$HOME/.pi/agent}"
  mkdir -p "$LLMPOD_CONFIG_DIR" "$ZCODE_DIR" "$PI_DIR"
  chmod 700 "$LLMPOD_CONFIG_DIR"
  LLMPOD_ENV_FILE="$LLMPOD_CONFIG_DIR/.env"
  if [ ! -f "$LLMPOD_ENV_FILE" ]; then (umask 077 && : > "$LLMPOD_ENV_FILE"); fi
  if ! grep -q '^LLMPOD_OPENWEBUI_KEY=' "$LLMPOD_ENV_FILE"; then
    (umask 077 && printf 'LLMPOD_OPENWEBUI_KEY=%s\n' "$(llmpod_random 32)" >> "$LLMPOD_ENV_FILE")
  fi
  chmod 600 "$LLMPOD_ENV_FILE"
  LLMPOD_OPENWEBUI_KEY="$(grep '^LLMPOD_OPENWEBUI_KEY=' "$LLMPOD_ENV_FILE" | head -n 1 | cut -d= -f2-)"
  export LLMPOD_OPENWEBUI_KEY
  LLMPOD_UID="$(id -u)"; LLMPOD_GID="$(id -g)"
  export LLMPOD_UID LLMPOD_GID
}
```

Nota: la chiave interna è esadecimale (64 caratteri), quindi il test usa `[A-Za-z0-9_-]{40,}` che la comprende; `ui` accetta qualunque chiave già presente.

- [ ] **Passo 4: `scripts/start.sh`, `scripts/stop.sh`, `.command`**

`scripts/start.sh`:

```sh
#!/usr/bin/env sh
# Avvia llmpod con Docker Compose. Uso: scripts/start.sh [--no-openwebui]
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
. "$SCRIPT_DIR/lib.sh"
llmpod_env

COMPOSE_PROFILES=openwebui
[ "${1:-}" = "--no-openwebui" ] && COMPOSE_PROFILES=""
export COMPOSE_PROFILES
LLMPOD_UI_TOKEN="$(llmpod_random 24)"
export LLMPOD_UI_TOKEN
PORT="${LLMPOD_UI_PORT:-7860}"

docker compose build llmpod
if ! grep -q '^RUNPOD_API_KEY=.' "$LLMPOD_ENV_FILE"; then
  echo "Prima configurazione di llmpod…"
  docker compose run --rm -it llmpod init
fi
docker compose up -d

i=0
until docker compose exec -T llmpod node -e "fetch('http://127.0.0.1:$PORT/api/health',{headers:{host:'127.0.0.1:$PORT'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "llmpod non risponde: controlla con 'docker compose logs llmpod'" >&2; exit 1; fi
  sleep 1
done

URL="http://127.0.0.1:$PORT/?t=$LLMPOD_UI_TOKEN"
echo "Interfaccia llmpod: $URL"
[ -n "$COMPOSE_PROFILES" ] && echo "Open WebUI: http://127.0.0.1:3000"
case "$(uname -s)" in
  Darwin) open "$URL" >/dev/null 2>&1 || true ;;
  *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 || true ;;
esac
```

`scripts/stop.sh`:

```sh
#!/usr/bin/env sh
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
. "$SCRIPT_DIR/lib.sh"
llmpod_env
docker compose --profile openwebui down
echo "llmpod fermato (configurazione e dati di Open WebUI conservati)"
```

`scripts/start.command` e `scripts/stop.command` (eseguibili):

```sh
#!/bin/sh
cd "$(dirname "$0")" && exec sh ./start.sh "$@"
```

(per `stop.command` sostituire `start.sh` con `stop.sh`). Poi `chmod +x scripts/*.sh scripts/*.command`.

- [ ] **Passo 5: PowerShell e .bat**

`scripts/start.ps1`:

```powershell
# Avvia llmpod con Docker Compose su Windows. Uso: scripts\start.ps1 [-NoOpenWebUI]
param([switch]$NoOpenWebUI)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function New-RandomHex([int]$Bytes) {
  $buf = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  -join ($buf | ForEach-Object { $_.ToString('x2') })
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'Docker non trovato: installa Docker Desktop'; exit 1 }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Error 'Docker non è in esecuzione: avvialo e riprova'; exit 1 }

if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
if (-not $env:PI_DIR) { $env:PI_DIR = Join-Path $env:USERPROFILE '.pi\agent' }
foreach ($d in @($env:LLMPOD_CONFIG_DIR, $env:ZCODE_DIR, $env:PI_DIR)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
$envFile = Join-Path $env:LLMPOD_CONFIG_DIR '.env'
if (-not (Test-Path $envFile)) { New-Item -ItemType File -Path $envFile | Out-Null }
$content = Get-Content $envFile -ErrorAction SilentlyContinue
if (-not ($content -match '^LLMPOD_OPENWEBUI_KEY=')) { Add-Content -Path $envFile -Value "LLMPOD_OPENWEBUI_KEY=$(New-RandomHex 32)" }
$env:LLMPOD_OPENWEBUI_KEY = ((Get-Content $envFile | Where-Object { $_ -match '^LLMPOD_OPENWEBUI_KEY=' } | Select-Object -First 1) -split '=', 2)[1]
$env:LLMPOD_UID = '1000'; $env:LLMPOD_GID = '1000'
$env:COMPOSE_PROFILES = if ($NoOpenWebUI) { '' } else { 'openwebui' }
$env:LLMPOD_UI_TOKEN = New-RandomHex 24
$port = if ($env:LLMPOD_UI_PORT) { $env:LLMPOD_UI_PORT } else { '7860' }

docker compose build llmpod
if (-not ((Get-Content $envFile) -match '^RUNPOD_API_KEY=.')) {
  Write-Host 'Prima configurazione di llmpod…'
  docker compose run --rm -it llmpod init
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
docker compose up -d
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  docker compose exec -T llmpod node -e "fetch('http://127.0.0.1:$port/api/health',{headers:{host:'127.0.0.1:$port'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" *> $null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ok) { Write-Error "llmpod non risponde: controlla con 'docker compose logs llmpod'"; exit 1 }
$url = "http://127.0.0.1:$port/?t=$($env:LLMPOD_UI_TOKEN)"
Write-Host "Interfaccia llmpod: $url"
if (-not $NoOpenWebUI) { Write-Host 'Open WebUI: http://127.0.0.1:3000' }
Start-Process $url
```

`scripts/stop.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
if (-not $env:PI_DIR) { $env:PI_DIR = Join-Path $env:USERPROFILE '.pi\agent' }
docker compose --profile openwebui down
Write-Host 'llmpod fermato (configurazione e dati di Open WebUI conservati)'
```

`scripts/start.bat`:

```bat
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
```

`scripts/stop.bat`: uguale con `stop.ps1`.

- [ ] **Passo 6: verificare** — `sh -n scripts/*.sh`; `npx vitest run test/scripts/start.test.js` → PASS (3 test); `npm test` verde. La sintassi PowerShell è verificata nella CI (Attività 5).

- [ ] **Passo 7: commit e push** — `git add scripts test/scripts && git commit -m "feat: script di avvio e arresto per macOS, Linux e Windows" && git push`

---

### Attività 4: Wrapper `bin/llmpod` (sh e PowerShell)

**File:**
- Crea: `bin/llmpod`, `bin/llmpod.ps1`
- Test: `test/scripts/wrapper.test.js`

**Interfacce:**
- Produce:
  - `bin/llmpod <comando> [argomenti]`: include `scripts/lib.sh` e chiama `llmpod_env`; per `run claude|opencode|pi` (e l'alias `claude`) esegue `docker compose run --rm -T llmpod prepare <client> --format sh --host-config-dir "$LLMPOD_CONFIG_DIR" --host-pi-dir "$PI_DIR" [--profile …]`, salva l'output e lo esegue con `eval` (che termina con `exec <client>`); per `run zcode` controlla con `pgrep -x ZCode` (macOS/Linux) e se è in esecuzione esce con 1 e "Chiudi ZCode e riprova: lo riscrive all'uscita" senza chiamare Docker, altrimenti `docker compose run --rm -T llmpod run zcode --no-open …` e su macOS `open -a ZCode`; per tutti gli altri comandi `docker compose run --rm <-it se stdin è un terminale, altrimenti -T> llmpod "$@"`.
  - `bin/llmpod.ps1`: stessa logica (per ZCode `Get-Process ZCode -ErrorAction SilentlyContinue`; per i client `prepare … --format ps1` eseguito con `Invoke-Expression`).

- [ ] **Passo 1: test che fallisce**

`test/scripts/wrapper.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

function setup({ zcodeRunning = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-bin-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "docker $*" >> "${log}"
case "$*" in
  *"prepare claude"*) printf "export ANTHROPIC_BASE_URL='https://p1-8000.proxy.runpod.net'\\nexec 'claude' '--version'\\n" ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "claude $* base=$ANTHROPIC_BASE_URL" >> "${log}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\n${zcodeRunning ? 'echo 123; exit 0' : 'exit 1'}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "open $*" >> "${log}"\n`, { mode: 0o755 });
  const run = (args) => spawnSync('sh', [path.join(ROOT, 'bin/llmpod'), ...args], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', input: '' });
  return { run, log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

describe('bin/llmpod', () => {
  it('comandi normali passano al container senza TTY se stdin non è un terminale', () => {
    const t = setup();
    expect(t.run(['status']).status).toBe(0);
    expect(t.log()).toContain('docker compose run --rm -T llmpod status');
  });

  it('run claude: prepare nel container, avvio sull\'host con le variabili', () => {
    const t = setup();
    expect(t.run(['run', 'claude', '--profile', 'qwen3-coder']).status).toBe(0);
    const log = t.log();
    expect(log).toMatch(/docker compose run --rm -T llmpod prepare claude --format sh --host-config-dir \S+\/\.config\/llmpod --host-pi-dir \S+\/\.pi\/agent --profile qwen3-coder/);
    expect(log).toContain('claude --version base=https://p1-8000.proxy.runpod.net');
  });

  it('run zcode: rifiuta se ZCode è aperto, senza chiamare Docker', () => {
    const t = setup({ zcodeRunning: true });
    const r = t.run(['run', 'zcode']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Chiudi ZCode/);
    expect(t.log()).not.toContain('docker compose run');
    const t2 = setup();
    expect(t2.run(['run', 'zcode']).status).toBe(0);
    expect(t2.log()).toContain('docker compose run --rm -T llmpod run zcode --no-open');
  });
});
```

- [ ] **Passo 2: verificare che fallisca** — `npx vitest run test/scripts/wrapper.test.js` → FAIL.

- [ ] **Passo 3: `bin/llmpod`**

```sh
#!/usr/bin/env sh
# Wrapper della CLI llmpod con Docker: esegue i comandi nel container, avvia i client sull'host.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. "$ROOT/scripts/lib.sh"
llmpod_env

TTY=-T
[ -t 0 ] && [ -t 1 ] && TTY=-it

client=""
if [ "${1:-}" = "claude" ]; then client=claude; shift
elif [ "${1:-}" = "run" ] && [ -n "${2:-}" ]; then client="$2"; shift 2
fi

case "$client" in
  "")
    exec docker compose run --rm "$TTY" llmpod "$@" ;;
  zcode)
    if command -v pgrep >/dev/null 2>&1 && pgrep -x ZCode >/dev/null 2>&1; then
      echo "Chiudi ZCode e riprova: lo riscrive all'uscita e le modifiche andrebbero perse" >&2
      exit 1
    fi
    docker compose run --rm -T llmpod run zcode --no-open "$@"
    [ "$(uname -s)" = "Darwin" ] && open -a ZCode >/dev/null 2>&1 || true ;;
  *)
    SCRIPT="$(docker compose run --rm -T llmpod prepare "$client" --format sh --host-config-dir "$LLMPOD_CONFIG_DIR" --host-pi-dir "$PI_DIR" "$@")"
    eval "$SCRIPT" ;;
esac
```

Poi `chmod +x bin/llmpod`.

- [ ] **Passo 4: `bin/llmpod.ps1`**

```powershell
# Wrapper della CLI llmpod con Docker su Windows.
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
Set-Location $root
if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
if (-not $env:PI_DIR) { $env:PI_DIR = Join-Path $env:USERPROFILE '.pi\agent' }
$env:LLMPOD_UID = '1000'; $env:LLMPOD_GID = '1000'

$client = $null
$rest = @($args)
if ($rest.Count -ge 1 -and $rest[0] -eq 'claude') { $client = 'claude'; $rest = @($rest | Select-Object -Skip 1) }
elseif ($rest.Count -ge 2 -and $rest[0] -eq 'run') { $client = $rest[1]; $rest = @($rest | Select-Object -Skip 2) }

if (-not $client) { docker compose run --rm -it llmpod @args; exit $LASTEXITCODE }
if ($client -eq 'zcode') {
  if (Get-Process ZCode -ErrorAction SilentlyContinue) { Write-Error "Chiudi ZCode e riprova: lo riscrive all'uscita e le modifiche andrebbero perse"; exit 1 }
  docker compose run --rm -T llmpod run zcode --no-open @rest
  exit $LASTEXITCODE
}
$script = docker compose run --rm -T llmpod prepare $client --format ps1 --host-config-dir $env:LLMPOD_CONFIG_DIR --host-pi-dir $env:PI_DIR @rest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Expression ($script -join "`n")
```

- [ ] **Passo 5: verificare** — `sh -n bin/llmpod`; `npx vitest run test/scripts/wrapper.test.js` → PASS (3 test); `npm test` verde.

- [ ] **Passo 6: commit e push** — `git add bin test/scripts && git commit -m "feat: wrapper llmpod per Docker (sh e PowerShell)" && git push`

---

### Attività 5: CI su GitHub e documentazione Docker

**File:**
- Crea: `.github/workflows/ci.yml`
- Modifica: `README.md` (sezione "Installazione con Docker" e stato), `docs/backlog-piano-1.md` (annotare i punti chiusi nei piani 2–4)

**Interfacce:**
- Produce: workflow `CI` su `push` e `pull_request` con i job:
  - `test` (ubuntu-latest, matrice Node 20 e 22, Python 3.12): `npm ci`, `npm test`, `npm run build:web`.
  - `gitleaks` (ubuntu-latest): `actions/checkout@v4` con `fetch-depth: 0`, `gitleaks/gitleaks-action@v2` con `GITHUB_TOKEN`.
  - `docker` (ubuntu-latest): `docker build -t llmpod:ci .` e `sh scripts/docker-smoke.sh`.
  - `powershell` (windows-latest): parsing di `scripts/*.ps1` e `bin/llmpod.ps1` con `[System.Management.Automation.Language.Parser]::ParseFile` (fallisce se ci sono errori di sintassi).

- [ ] **Passo 1: `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: npm ci
      - run: npm test
      - run: npm run build:web

  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sh scripts/docker-smoke.sh

  powershell:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - shell: pwsh
        run: |
          $files = @(Get-ChildItem scripts/*.ps1) + @(Get-Item bin/llmpod.ps1)
          $bad = 0
          foreach ($f in $files) {
            $errors = $null
            [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors) | Out-Null
            if ($errors) { $errors | ForEach-Object { Write-Error "$($f.Name): $($_.Message)" }; $bad++ }
          }
          exit $bad
```

- [ ] **Passo 2: README** — aggiornare lo "Stato" in: `> **Stato:** v1 completa — CLI, consulente IA, interfaccia web, Docker.` e aggiungere, prima di "Installazione (CLI, senza Docker)":

````markdown
## Installazione con Docker (consigliata)

Requisiti: Docker Desktop (macOS, Windows) o Docker Engine con Compose v2 (Linux).

```bash
git clone https://github.com/deduzzo/runpod-helper.git
cd runpod-helper
scripts/start.sh              # macOS/Linux (su macOS anche doppio clic su scripts/start.command)
scripts\start.bat             # Windows
```

Al primo avvio parte la configurazione guidata (`llmpod init`); poi si apre l'interfaccia web
(`http://127.0.0.1:7860`) e Open WebUI (`http://127.0.0.1:3000`, ometti con `--no-openwebui`).
Per fermare tutto: `scripts/stop.sh` (o `stop.bat`). Configurazione e pesi restano.

La CLI dall'host passa dal wrapper, che esegue i comandi nel container e avvia i client sul tuo
computer:

```bash
bin/llmpod status
bin/llmpod run claude          # anche: opencode, pi, zcode
```

Le chiavi restano in `~/.config/llmpod/.env` (permessi 600), montata nel container: l'immagine
non contiene segreti.
````

- [ ] **Passo 3: verificare** — `npm test` verde; validare lo YAML con `node -e "require('node:fs').readFileSync('.github/workflows/ci.yml','utf8')"` e, se disponibile, `actionlint`; dopo il push controllare l'esito su GitHub con `gh run list --limit 1` e `gh run view --log-failed` in caso di errori (correggere finché è verde).

- [ ] **Passo 4: commit e push** — `git add .github README.md docs && git commit -m "ci: test, gitleaks, build Docker e controllo PowerShell; documentazione Docker" && git push`
