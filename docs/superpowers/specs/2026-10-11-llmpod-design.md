# llmpod — Design

- **Data:** 11 ottobre 2026
- **Stato:** approvato sezione per sezione in brainstorming; da rileggere prima del piano di implementazione
- **Repository:** https://github.com/deduzzo/runpod-helper (pubblico)

## 1. Obiettivo

`llmpod` automatizza il ciclo di vita di un LLM self-hosted su Runpod da usare come backend di
coding agent: scelta del modello da Hugging Face → piano VRAM/GPU → Pod con vLLM pronto →
configurazione del client → distruzione automatica per inattività → ricreazione identica da un
profilo salvato.

### Criteri di successo

1. Da un ID Hugging Face a un endpoint funzionante (smoke test con chiamata a strumento superato)
   con un solo comando dopo `init`, senza modificare a mano argomenti di vLLM per i modelli
   supportati dalla tabella interna.
2. Il Pod si termina da solo dopo N minuti senza richieste o dopo la durata massima, anche a
   portatile spento.
3. Nessun segreto in repository, immagini Docker, log o output; l'unico segreto utente che entra
   nel Pod è `HF_TOKEN` (solo per modelli gated).
4. Ogni operazione che costa denaro mostra il costo orario e chiede conferma (`--yes` per
   saltarla); `--dry-run` su tutto ciò che crea o distrugge risorse.
5. Funziona su macOS, Linux e Windows tramite Docker e script di avvio.

### Fuori scope (v1)

- App desktop nativa; accesso remoto alla web UI (es. dal telefono).
- Avvio automatico al login (launchd/systemd/Task Scheduler).
- Pubblicazione dell'immagine su un registry (si compila in locale).
- Benchmark e tuning automatico delle prestazioni oltre al suggerimento sul contesto.

## 2. Decisioni prese

| Tema | Decisione |
|---|---|
| Client v1 | Claude Code, OpenCode, ZCode, pi; Open WebUI per prove rapide |
| Interfaccia | CLI **e** web UI locale nella v1, sullo stesso core |
| Classi di modelli | Sia 1 GPU (24–32B) sia multi-GPU con tensor parallel, a seconda del profilo |
| API Runpod | REST v2 `https://api.runpod.io/v2` (niente GraphQL salvo il credito residuo, vedi §12) |
| Immagine Pod | `vllm/vllm-openai:<versione fissata>`, **nessuna immagine derivata** |
| Chiave nel Pod | Solo la `RUNPOD_API_KEY` iniettata da Runpod (verificata, §3) |
| Chiave vLLM | Una per profilo, rigenerabile con `rotate-key` |
| Volume/datacenter | Network volume nel DC preferito; ripiego, con consenso, su altri DC senza volume |
| Parametri vLLM | 3 livelli: regole → consulente LLM → verifica/correzione dopo `up` |
| Consulente LLM | IA esterna modulare con preset (Z.ai Coding Plan via endpoint Anthropic, Z.ai a consumo, Anthropic, OpenAI, custom, Pod, `claude -p`); default `zai-coding-plan` con GLM-5.3, scelta dell'utente. User-Agent onesto `llmpod/<versione>`, nessuna imitazione di altri client (§11) |
| Deploy | Docker Compose + script di avvio per piattaforma + wrapper CLI sull'host |

## 3. Verifiche fatte (11 ottobre 2026)

Tre Pod CPU `cpu3c` (0,06 $/h) hanno verificato la `RUNPOD_API_KEY` iniettata nei Pod:

| Operazione | Esito |
|---|---|
| `GET /v2/pods/{self}` | 200 |
| `DELETE /v2/pods/{self}` | funziona (auto-terminazione) |
| `GET`/`DELETE` di un altro Pod (v2) | 404 |
| `GET /v2/pods`, `GET /v2/templates` | 403 |
| Qualsiasi chiamata REST v1 | 403 |
| GraphQL (`myself`, `podTerminate`) | Unauthorized |
| `POST /v2/pods` con corpo vuoto | 422 (validazione prima dell'autorizzazione: non determinato, molto probabilmente negato) |

Cloudflare risponde `403 error code: 1010` allo User-Agent `Python-urllib/*`: ogni client HTTP
usa lo User-Agent `llmpod/<versione>` (nel Pod `llmpod-supervisor/<versione>`).

Altri fatti verificati dalla documentazione:
- `POST /v2/pods` non fa fallback di GPU; la documentazione indica il fallback lato client
  (ordinare i candidati con il catalogo; 422 non ritentare, 400/403 candidato successivo,
  402 fermarsi, 429 attendere `Retry-After`, 5xx ritentare lo stesso candidato). Corpo max 100 KB.
- `GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&count=N&cloud=…` restituisce prezzo per
  GPU, `maxCount`, disponibilità complessiva e per datacenter, versioni CUDA disponibili.
- Proxy HTTPS dei Pod: `https://<podId>-<porta>.proxy.runpod.net`.
- vLLM + Claude Code: `ANTHROPIC_BASE_URL` senza `/v1`; il nome servito non può contenere `/`.
- ZCode: provider in `~/.zcode/v2/config.json` (`kind` `anthropic` o `openai-compatible`), nessuna
  lettura di variabili d'ambiente, file riscritto dall'app all'uscita → modificarlo ad app chiusa.

## 4. Architettura

Node ≥ 20, ESM, un solo pacchetto. Dipendenze di runtime: `commander`. Tutto il resto con API
native (`fetch`, `node:http`, `node:crypto`). Web UI: React + Vite + Tailwind (dipendenze di build).
Test: `vitest` (Node/web), `unittest` (Python, supervisore).

```
src/
  core/                     logica, senza I/O di terminale
    config.js               .env (600), profili, state.json, percorsi (LLMPOD_CONFIG_DIR)
    secrets.js              registro dei valori segreti + mascheramento
    http.js                 fetch con timeout, retry 429/5xx, User-Agent, mascheramento errori
    runpod.js               REST v2: catalogo GPU/CPU, Pod, network volume, template
    hf.js                   API HF: ricerca, model info, albero file, config, README, gated
    planner/
      vram.js               pesi + KV cache + overhead
      gpu-select.js         candidati (GPU, N, DC) per prezzo/disponibilità
      vllm-args.js          livello 1: tabella architettura → argomenti
      advisor/
        advisor.js          livelli 2–3: prompt, schema, flag ammessi, ricalcolo VRAM
        providers/          anthropic.js  openai.js  claude-cli.js  presets.js
    pod/
      launcher.js           creazione con fallback, attesa, timeout
      smoke.js              smoke test /v1/messages e /v1/chat/completions
      supervisor.py         eseguito nel Pod (solo stdlib)
    clients/
      claude-code.js  opencode.js  zcode.js  pi.js  openwebui-proxy.js
    events.js               emettitore di eventi di avanzamento
    errors.js               LlmpodError (codice, messaggio IT, suggerimento)
    confirm.js              confirmCost() unico per CLI e UI, --yes, --dry-run
  cli/                      commander
  server/                   API JSON + SSE (127.0.0.1), proxy interno per Open WebUI
web/                        React/Vite/Tailwind, PWA
data/
  vllm-flags-<versione>.json   flag ammessi per la versione vLLM fissata
  parsers.json                 architettura/pattern → tool-call parser, reasoning parser
scripts/  start|stop .sh .command .ps1 .bat
bin/      llmpod  llmpod.ps1   wrapper host
Dockerfile  compose.yaml  .dockerignore
```

Principi:
- Il core emette eventi (`phase`, `progress`, `log`, `cost`, `warning`); la CLI li stampa, la
  web UI li riceve via SSE.
- `confirmCost({ hourly, description })` è l'unico punto di conferma; con `--dry-run` nessuna
  chiamata che crea o distrugge viene eseguita e si stampa la richiesta (con segreti mascherati).
- La verità sullo stato dei Pod è sempre l'API Runpod; `state.json` serve solo a collegare
  profilo ↔ Pod e a ricordare inizio sessione e costo orario.

### File locali (`LLMPOD_CONFIG_DIR`, default `~/.config/llmpod`, permessi 700)

| File | Contenuto | Permessi |
|---|---|---|
| `.env` | `RUNPOD_API_KEY`, `HF_TOKEN`, `LLMPOD_ADVISOR_*` (endpoint, protocollo, modello, chiave), `LLMPOD_KEY_<PROFILO>` | 600 |
| `config.json` | datacenter preferito, volume (id, DC, dimensione), cloud, versione vLLM di default, consulente abilitato | 600 |
| `profiles/<nome>.json` | profilo (§6) — nessun segreto | 600 |
| `state.json` | Pod attivi per profilo, avvio, costo orario | 600 |

## 5. Comandi

| Comando | Comportamento |
|---|---|
| `init` | Chiede/verifica credenziali (lettura nascosta), datacenter preferito (con disponibilità GPU), crea o riusa il network volume (dimensione proposta dai modelli previsti), configura il consulente |
| `search <query>` | Modelli HF `text-generation` con chat template; mostra nome, parametri, quantizzazione/dtype, licenza, gated, download, ultimo aggiornamento, VRAM stimata; segnala l'assenza di tool-call parser noto |
| `plan <modello[@rev]> [--context 65536] [--concurrency 2] [--set k=v] [--extra-arg …] [--no-advisor]` | Stima VRAM, tabella GPU (scelta + alternative), argomenti vLLM, proposta del consulente come differenza da confermare |
| `save <nome>` | Salva l'ultimo piano come profilo; genera la chiave vLLM del profilo |
| `up <profilo>` | §7 |
| `run <claude\|opencode\|zcode\|pi> [--profile]` | §8; `claude` è anche alias di `run claude` |
| `env [--profile] [--format sh\|ps1\|json]` | Stampa gli export |
| `chat` | Apre la prova veloce con Open WebUI |
| `status` | Pod attivi, uptime, costo della sessione, credito residuo, costo mensile del volume, conto alla rovescia di inattività e durata massima, Pod `llmpod-*` orfani |
| `down [--profile] [--keep-volume]` | Termina il Pod (`DELETE`) e verifica `404`; il volume resta sempre salvo `destroy-volume` |
| `destroy-volume` | Doppia conferma (digitare il nome del volume) |
| `rotate-key [--profile]` | Nuova chiave vLLM; se il Pod è attivo avvisa che va riavviato |
| `ui` | Avvia il server della web UI |

Opzioni globali: `--yes`, `--dry-run`, `--json` (output macchina), `--verbose` (mai segreti).

## 6. Profilo

```json
{
  "name": "qwen3-coder-30b",
  "model": { "id": "Qwen/Qwen3-Coder-30B-A3B-Instruct", "revision": "<sha>" },
  "servedName": "qwen3-coder-30b",
  "vllm": { "image": "vllm/vllm-openai:<versione>", "args": ["--max-model-len", "65536", "..."] },
  "context": 65536,
  "concurrency": 2,
  "gpu": { "id": "NVIDIA A100 80GB PCIe", "count": 1 },
  "alternatives": [{ "id": "NVIDIA H100 80GB HBM3", "count": 1 }],
  "cloud": "SECURE",
  "dataCenterId": "EU-…",
  "volume": { "id": "…", "mountPath": "/workspace" },
  "allowFallbackWithoutVolume": "ask",
  "watchdog": { "idleMinutes": 30, "maxHours": 8 },
  "estimate": { "weightsGB": 61.1, "kvGB": 6.0, "perGpuGB": 69.4, "hourlyUSD": 1.39 },
  "advisor": { "applied": true, "notes": ["…"] }
}
```

Il template Runpod non viene creato: il corpo della creazione Pod è generato dal profilo e un
template aggiungerebbe solo uno stato da sincronizzare.

## 7. Pod, supervisore e watchdog

### Creazione (`POST /v2/pods`)

- `name`: `llmpod-<profilo>`; `image`: dal profilo; `gpu { id, count }`; `cloud`;
  `dataCenterIds: [DC del volume]` (o del candidato in ripiego); `minCudaVersion` compatibile
  con l'immagine vLLM.
- Con volume: `mounts.network: [{ volumeId, path: "/workspace" }]`, `HF_HOME=/workspace/hf`.
  Senza volume: `HF_HOME=/root/.cache/huggingface`, `disk = ceil(pesi × 1,2) + 20` GB.
- `ports: ["8000/http", "8001/http"]`.
- `entrypoint: ["/bin/sh", "-c"]`,
  `cmd: ["echo \"$LLMPOD_SUPERVISOR_B64\" | base64 -d > /tmp/supervisor.py && exec python3 -u /tmp/supervisor.py"]`.
- `env`: `LLMPOD_SUPERVISOR_B64`, `LLMPOD_VLLM_ARGS` (JSON), `LLMPOD_IDLE_MINUTES`,
  `LLMPOD_MAX_HOURS`, `LLMPOD_MODEL_BYTES` (per l'avanzamento del download), `VLLM_API_KEY`
  (chiave del profilo, mai negli argomenti), `HF_TOKEN` solo se il modello è gated.

### Supervisore (Python stdlib)

1. Avvia `vllm serve <modello> <argomenti>` come processo figlio, con stdout/stderr in un buffer
   circolare (ultime 500 righe).
2. Server di stato su `:8001`, autenticato con `Authorization: Bearer <VLLM_API_KEY>`:
   - `GET /status` → `{ phase: downloading|loading|ready|error|terminating, downloadedBytes,
     totalBytes, idleSeconds, idleLimitSeconds, uptimeSeconds, maxSeconds, restarts, lastError,
     kvCacheTokens }`;
   - `GET /logs?since=<n>` → righe di log;
   - `POST /reload` con `{ args: [...] }` → valida che sia un array di stringhe, riavvia solo vLLM.
3. Fase `downloading` misurata dalla crescita di `HF_HOME` rispetto a `LLMPOD_MODEL_BYTES`;
   `loading` dall'avvio del caricamento; `ready` quando `GET /v1/models` locale risponde 200.
4. Watchdog ogni 60 s su `http://127.0.0.1:8000/metrics`: attività se
   `vllm:num_requests_running + vllm:num_requests_waiting > 0` o se `vllm:request_success_total`
   (somma su tutte le etichette) è aumentato. Il conteggio d'inattività parte da `ready` e
   prosegue anche in `error`.
5. Inattività ≥ `LLMPOD_IDLE_MINUTES` oppure uptime ≥ `LLMPOD_MAX_HOURS` → `phase=terminating`,
   `DELETE https://api.runpod.io/v2/pods/$RUNPOD_POD_ID` con la chiave iniettata; se fallisce
   ritenta ogni 60 s registrando l'errore nello stato.
6. Crash di vLLM: fino a 2 riavvii automatici, poi `error`.
7. Legge dai log la capacità della KV cache (riga "GPU KV cache size: N tokens") ed espone
   `kvCacheTokens` per il suggerimento sul contesto.

### Sequenza di `up`

1. Controlli preliminari: profilo valido; credito ≥ costo di 1 h; nessun Pod attivo del profilo;
   accesso HF al modello (gated).
2. Candidati: GPU del profilo nel DC del volume → alternative del profilo nel DC del volume →
   (se `allowFallbackWithoutVolume` lo consente, chiedendo conferma) le stesse GPU in altri DC
   senza volume, ordinate per prezzo.
3. `confirmCost` con il costo orario del primo candidato; creazione con le regole d'errore del
   §3. Se si passa a un candidato più costoso, nuova conferma.
4. Attesa `RUNNING` (timeout 10 min) → avanzamento da `:8001/status` → `ready`
   (timeout stimato da pesi a 50 MB/s + 10 min; alla scadenza: aspettare ancora o terminare).
5. Smoke test: `GET /v1/models`; `POST /v1/messages` con uno strumento `get_weather` e
   `tool_choice` che ne richiede l'uso, verificando un blocco `tool_use`; lo stesso su
   `/v1/chat/completions` verificando `tool_calls`.
6. Output: endpoint, costo orario reale (`cost` del Pod), tempo di avvio, suggerimento sul
   contesto. Aggiorna `state.json` e l'URL in ZCode (se chiuso; altrimenti avviso).
7. Fallimento dopo la creazione o Ctrl+C: proposta di `down` (default sì).

## 8. Client

- **Claude Code:** processo `claude` con `ANTHROPIC_BASE_URL=https://<pod>-8000.proxy.runpod.net`,
  `ANTHROPIC_AUTH_TOKEN=<chiave>`, `ANTHROPIC_MODEL` e `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`
  = nome servito, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
  ≤ 1/4 del contesto. `~/.claude/settings.json` non viene modificato. Se la versione vLLM fissata
  è ≤ 0.17.1 si aggiunge `CLAUDE_CODE_ATTRIBUTION_HEADER=0`.
- **OpenCode:** file di configurazione temporaneo (permessi 600) con provider `llmpod`
  (`@ai-sdk/openai-compatible`, `baseURL …/v1`, chiave da variabile d'ambiente, `limit.context`,
  `limit.output`), passato a `opencode` tramite la variabile d'ambiente prevista da OpenCode.
- **ZCode:** inserisce/aggiorna solo `provider.llmpod` (`kind: openai-compatible`,
  `baseURL …/v1`, `apiKey`, `apiKeyRequired: true`, `models.<nome> .limit`), con backup
  `config.json.llmpod-bak`, scrittura atomica, permessi 600. Gli altri provider restano invariati.
  Dalla CLI host: controllo processo (`pgrep -x ZCode` / `tasklist`) e rifiuto se aperto.
  Dalla web UI: conferma esplicita "ZCode è chiuso".
- **pi** (`earendil-works/pi`): inserisce/aggiorna solo `providers.llmpod` in
  `${PI_CODING_AGENT_DIR:-~/.pi/agent}/models.json` (`baseUrl …/v1`, `api: "openai-completions"`,
  `apiKey: "$LLMPOD_API_KEY"` — interpolazione d'ambiente di pi, la chiave non viene scritta su
  disco —, `models: [{ id, name, contextWindow, maxTokens, reasoning }]`), con backup, scrittura
  atomica e permessi 600; poi avvia `pi --provider llmpod --model <nome servito>` con
  `LLMPOD_API_KEY` nell'ambiente. Gli altri provider restano invariati.
- **Open WebUI:** `OPENAI_API_BASE_URL=http://llmpod:8081/v1` (proxy interno del container
  `llmpod`, solo rete compose, chiave interna fissa) → il proxy inoltra al Pod corrente con la
  chiave del profilo, streaming incluso. `ENABLE_PERSISTENT_CONFIG=false`, `WEBUI_AUTH=false`,
  `ENABLE_OLLAMA_API=false`.

## 9. Web UI

- Server `node:http` sulla porta 7860 del container, pubblicato solo su `127.0.0.1:7860`.
- Token casuale a ogni avvio; lo script apre `http://127.0.0.1:7860/?t=<token>`, il server
  imposta un cookie `HttpOnly`, `SameSite=Strict` e reindirizza togliendo il token dall'URL.
  Ogni richiesta verifica cookie, `Host` (`127.0.0.1:7860`/`localhost:7860`) e `Origin`.
- API JSON che rispecchiano i comandi; `GET /api/events` (SSE) per avanzamento, log, costi.
- Pagine: Modelli, Piano, Profili, Pod, Stato e costi, Client, Prova veloce.
- Stile: dark mode, gradienti neon, glassmorphism, transizioni animate; PWA con manifest e
  service worker che memorizza solo l'interfaccia.
- Le conferme di costo sono una finestra modale con importo orario e totale stimato per 1 h.

## 10. Docker e script

- `Dockerfile` multi-stage: `node:22-slim` build (Vite) → runtime `node:22-slim`, utente non-root,
  solo dipendenze di produzione, `HEALTHCHECK` su `/healthz`. Nessun segreto in `ARG`/`ENV`;
  `.dockerignore` esclude `.env*`, `.git`, `node_modules`.
- `compose.yaml`:
  - `llmpod`: porte `127.0.0.1:7860:7860`; volumi `${LLMPOD_CONFIG_DIR}:/config`,
    `${LLMPOD_CONFIG_DIR}/.env:/config/.env:ro`, `${ZCODE_DIR}:/zcode`, `${PI_DIR}:/pi`.
  - `open-webui`: immagine con versione fissata, `127.0.0.1:3000:8080`, volume `open-webui-data`.
  - Nessun montaggio di `docker.sock`.
- `scripts/start.{sh,command,ps1,bat}`: imposta `LLMPOD_CONFIG_DIR`/`ZCODE_DIR`, verifica Docker,
  al primo avvio esegue `init` interattivo, `docker compose up -d --build`, attende
  l'healthcheck, apre il browser. `stop.*` esegue `docker compose down`.
- `bin/llmpod` e `bin/llmpod.ps1`: `docker compose run --rm -it llmpod <args>`; per
  `run claude|opencode` ottengono `env --format json` dal container e avviano il client
  sull'host; per `run zcode` controllano sull'host che ZCode sia chiuso prima di delegare.

## 11. Parametri vLLM e consulente

### Livello 1 (deterministico)

- VRAM pesi = somma dei file `*.safetensors` della revisione; controllo incrociato con
  `safetensors.parameters`.
- KV per token = `2 × num_hidden_layers × num_key_value_heads × head_dim × byte(kv_dtype)`;
  MLA: `(kv_lora_rank + qk_rope_head_dim) × num_hidden_layers × byte`; architetture con
  finestra scorrevole/ibride gestite nella tabella; sconosciute → stima ad attenzione completa.
- Requisito per GPU: `pesi/TP + KV×contesto×concorrenza/TP + 2 GB ≤ VRAM × 0,90`;
  TP ∈ {1,2,4,8} e divisore di `num_attention_heads`.
- Argomenti fissi: `--served-model-name`, `--max-model-len`, `--tensor-parallel-size`,
  `--gpu-memory-utilization 0.90`, `--revision`, `--port 8000`; `--enable-auto-tool-choice
  --tool-call-parser` e `--reasoning-parser` da `data/parsers.json`; `--kv-cache-dtype fp8`
  solo se necessario per rientrare nella VRAM. Chat template verificato.

### Livello 2 (consulente, prima della creazione)

- Input: README del modello, riassunto config, proposta di livello 1, recipe ufficiale se
  presente (`vllm-project/recipes` via API GitHub).
- Output JSON `{ args, rationale, warnings }`, validato: schema, flag presenti in
  `data/vllm-flags-<versione>.json`, nessun flag che apra accessi (`--host` diverso, `--api-key`,
  `--allowed-local-media-path`, `--trust-remote-code` solo con conferma esplicita), ricalcolo VRAM.
- Mostrato come differenza rispetto al livello 1; applicato solo con conferma.
- **IA esterna modulare** (`src/core/advisor/providers/`): un'interfaccia unica
  `complete({ system, messages, jsonSchema }) → { text, usage }` con due implementazioni di
  protocollo (`anthropic` → `POST {base}/v1/messages`; `openai` → `POST {base}/v1/chat/completions`)
  più il backend `claude-cli` (`claude -p --output-format json`). Preset selezionabili in `init`,
  da CLI (`--advisor <preset>`) e da web UI:

  | Preset | Protocollo | Base URL predefinito | Modello predefinito |
  |---|---|---|---|
  | `zai-coding-plan` (default) | anthropic | endpoint Anthropic di Z.ai usato da Claude Code | GLM-5.3 |
  | `zai` (a consumo) | openai | API Z.ai a consumo | GLM-5.3 |
  | `anthropic` | anthropic | `https://api.anthropic.com` | ultimo Claude Sonnet |
  | `openai` | openai | `https://api.openai.com` | modello scelto dall'utente |
  | `custom` | anthropic o openai | a scelta | a scelta |
  | `pod` (solo livello 3) | openai | Pod corrente | nome servito |
  | `claude-cli` | — | — | — |

  Configurazione in `.env`: `LLMPOD_ADVISOR_PRESET`, e per ogni preset `…_BASE_URL`, `…_MODEL`,
  `…_API_KEY` sovrascrivibili. Le richieste usano lo User-Agent `llmpod/<versione>`: nessun
  header o identità di altri client. Selezionando `zai-coding-plan`, `init` mostra una volta
  l'avviso che le condizioni Z.ai limitano l'uso della quota del piano agli strumenti supportati
  e registra la presa visione in `config.json`.

### Livello 3 (dopo `up`)

- Suggerimento deterministico del contesto massimo da `kvCacheTokens`.
- Su smoke test fallito o `phase=error`: il consulente riceve log ed errore, propone nuovi
  argomenti (stessa validazione), conferma con costo orario, `POST :8001/reload`, nuovo smoke
  test; massimo 3 tentativi. Gli argomenti funzionanti possono essere salvati nel profilo.

## 12. Punti verificati (11 ottobre 2026) e aperti

Verificati con documentazione ufficiale e chiamate in sola lettura:

1. vLLM: `vllm/vllm-openai:v0.30.0-cu129` (rilascio del 22/09/2026, CUDA 12.9, `minCudaVersion
   "12.9"`); parser e 382 flag ammessi della v0.30.0 salvati in `data/`. `VLLM_API_KEY` letta
   dall'ambiente; solo `Authorization: Bearer`; `/v1/messages` attivo senza flag; `/metrics` e
   `/health` non protetti (rischio accettato: solo contatori).
2. Runpod: network volume su `/v2/network-volumes` (corpo `{ name, size, dataCenter }`); nessun
   endpoint v2 per il credito → GraphQL `{ myself { clientBalance currentSpendPerHr } }`;
   prezzo del volume non esposto da API → default `0.07` $/GB/mese dalla documentazione
   (tipo STANDARD), **da confermare con l'utente**, sovrascrivibile in `config.json`.
   Limite di frequenza 180 richieste/minuto. Proxy HTTPS con limite Cloudflare di 100 s: lo
   streaming oltre i 100 s viene verificato dalla prova reale `e2e:cpu`.
3. OpenCode: `OPENCODE_CONFIG` (percorso del file di configurazione).
4. Open WebUI v0.11.4: nessun `X-Frame-Options`/CSP predefinito → incorporabile in iframe.
5. Z.ai: endpoint Anthropic `https://api.z.ai/api/anthropic`, a consumo
   `https://api.z.ai/api/paas/v4`; modello `glm-5.3`.

Ancora aperti:

6. Permesso di creazione Pod della chiave iniettata (non determinato; non cambia il design).
7. Esito dello streaming oltre 100 s attraverso il proxy (prova `e2e:cpu` del piano 1); se
   fallisce, ripiego su porta TCP diretta per i client.

## 13. Errori

`LlmpodError { code, message (IT), hint }`, codici principali: `NO_GPU_AVAILABLE`,
`INSUFFICIENT_BALANCE`, `GATED_MODEL`, `HF_AUTH`, `OOM`, `UNKNOWN_TOOL_PARSER`, `ZCODE_RUNNING`,
`DOCKER_NOT_RUNNING`, `POD_START_TIMEOUT`, `SMOKE_TEST_FAILED`, `CONFIG_PERMISSIONS`.
HTTP: timeout con `AbortSignal`; ritenti solo per 429/5xx. Il README di troubleshooting segue
gli stessi codici (zero GPU, modello gated, OOM, tool calling che non funziona).

## 14. Test

- `vitest`: `fetch` iniettato; fixture JSON reali ripulite (catalogo/Pod Runpod v2; config HF di
  Qwen3-Coder MoE, GLM, DeepSeek MLA, Llama). Copertura: VRAM, scelta GPU, parser, validazione
  del consulente, regole di fallback, adattatori client (merge ZCode), permessi 600, nessun
  segreto in output (test che esegue i comandi con segreti fittizi e cerca i valori nell'output).
- Python `unittest`: finto vLLM (`/metrics`, `/v1/models`) e finta API Runpod su server locali;
  inattività, durata massima, crash/riavvio, ritenti di terminazione, `reload`, autenticazione.
- Server web: token, `Host`/`Origin`, SSE; componente di conferma del costo.
- `npm run e2e:cpu`: prova reale su Pod CPU (0,06 $/h) del supervisore, con conferma esplicita.
- CI GitHub Actions: test Node e Python, `gitleaks`, build Docker. Hook pre-commit `gitleaks`.

## 15. Consegna

- README in italiano: installazione (Docker + script), primo utilizzo end-to-end, costi tipici,
  troubleshooting.
- Licenza: MIT.
