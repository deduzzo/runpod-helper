# llmpod — runpod-helper

`llmpod` porta un **LLM self-hosted su [Runpod](https://www.runpod.io)** con [vLLM](https://docs.vllm.ai) e lo
collega ai client di coding: **Claude Code**, **OpenCode**, **pi** e **ZCode** (più **Open WebUI** per le prove
veloci). Si usa in tre modi, con lo stesso core:

- **CLI** `llmpod`, dal terminale;
- **interfaccia web** locale (`llmpod ui`, installabile come PWA), anche con Docker;
- **modalità Claude Code managed** (`llmpod start`, oppure `llmpod manage`): Claude Code fa da operatore di llmpod
  tramite un server MCP, con skill e permessi del progetto. Il modo più semplice è `llmpod start` (dopo `npm link`)
  o il doppio clic su `scripts/start-managed.command` (macOS) / `scripts/start-managed.sh`: configura llmpod se
  serve, chiede la cartella di lavoro e apre Claude Code gestito.

Cosa fa, in sintesi:

1. trova il modello: **set consigliati** già verificati oppure ricerca su Hugging Face;
2. stima la VRAM (pesi + KV cache + margine) e ti propone le GPU adatte con **prezzo e disponibilità**;
3. crea il Pod con l'immagine ufficiale di vLLM, attende il caricamento ed esegue uno **smoke test** con una
   chiamata a strumento;
4. configura e avvia il client che hai scelto;
5. **elimina da solo il Pod** dopo un periodo di inattività o dopo un numero massimo di ore, anche a computer spento;
6. ricrea lo stesso Pod da un profilo salvato.

📖 **Manuale completo, passo per passo: [docs/GUIDA.md](docs/GUIDA.md).**

## Architettura in breve

```
  Il tuo computer                                   Runpod
 ┌───────────────────────────────────┐            ┌──────────────────────────────────────┐
 │ llmpod: CLI · interfaccia web ·   │  API REST  │ Pod GPU (immagine vllm/vllm-openai)  │
 │ server MCP · profili · chiavi     │──────────▶ │  ├─ supervisore Python (porta 8001)  │
 │ (~/.config/llmpod)                │            │  │    watchdog: inattività, ore max  │
 │                                   │   HTTPS    │  └─ vLLM (porta 8000): API Anthropic │
 │ Claude Code · OpenCode · pi ·     │──────────▶ │       e OpenAI, con chiave del       │
 │ ZCode · Open WebUI                │   (proxy   │       profilo                        │
 └───────────────────────────────────┘   Runpod)  │ Network volume con i pesi (facolt.)  │
                                                  └──────────────────────────────────────┘
                                                          ▲ pesi da Hugging Face
```

- Il **supervisore** nel Pod avvia vLLM, legge le metriche e **elimina il Pod** quando scatta un limite, usando
  la chiave che Runpod inietta nel Pod (valida solo per quel Pod): le tue chiavi non lasciano il tuo computer.
- Il **network volume** conserva i pesi tra un avvio e l'altro; senza volume i pesi si scaricano a ogni avvio.
- Dettagli e motivazioni: [Concetti](docs/GUIDA.md#concetti) nella guida e il
  [documento di design](docs/superpowers/specs/2026-10-11-llmpod-design.md).

## Installazione

### Requisiti

- **Node.js ≥ 20** e **Git**;
- un account [Runpod](https://www.runpod.io) con credito; un account Hugging Face solo per i modelli *gated*;
- **Docker** facoltativo: serve per Open WebUI (`llmpod chat`) o per l'installazione con Docker;
- Python 3 solo per eseguire i test del supervisore (`npm test`).

### 1. Clone, dipendenze e comando globale

```bash
git clone https://github.com/deduzzo/runpod-helper.git
cd runpod-helper
npm ci                # dipendenze esatte del lockfile; attiva anche l'hook anti-segreti
npm run build:web     # interfaccia web (llmpod ui)
npm link              # comandi globali "llmpod" e "llmpod-mcp"
```

Senza `npm link` si può usare `node src/cli/index.js <comando>` dalla cartella del progetto.

### 2. Configurazione: `llmpod init`

```bash
llmpod init
```

La configurazione guidata chiede:

- **chiave API di Runpod** (da https://www.runpod.io/console/user/settings): una chiave *Restricted* con **Pods**,
  **Network Volumes** e **Templates** in Read/Write, oppure una chiave con accesso completo (*All*). Il credito
  residuo si legge con l'API GraphQL, che può richiedere la chiave con accesso completo
  ([dettagli](docs/GUIDA.md#chiave-runpod));
- **token Hugging Face** (facoltativo): basta un token *Read*, serve solo per i modelli *gated*;
- **datacenter** preferito e **network volume** per i pesi, con il costo mensile. È facoltativo: se rifiuti la
  creazione (o usi `llmpod init --no-volume`) la configurazione viene salvata senza volume e i pesi si scaricano a
  ogni avvio.

Le chiavi vengono salvate in `~/.config/llmpod/.env` con permessi `600` e non vengono mai stampate: non
condividere quel file.

#### Configurare senza terminale interattivo

Senza un terminale (script, CI, prefisso `!` di Claude Code) le domande di `init` e `advisor` non hanno risposta e
llmpod si ferma indicando l'opzione da usare. Le chiavi si passano dallo **standard input**, mai come argomento
(finirebbero nella cronologia della shell):

```bash
# macOS: chiave negli appunti
pbpaste | llmpod advisor --preset zai-coding-plan --api-key-stdin --accept-zai-notice
# qualsiasi shell: digitata senza eco
read -rs K && printf '%s' "$K" | llmpod advisor --preset zai-coding-plan --api-key-stdin --accept-zai-notice; unset K
# credenziali di init (uno solo per volta: stdin è uno solo; per entrambi lancia init due volte)
pbpaste | llmpod init --runpod-key-stdin --datacenter EU-RO-1 --no-volume
pbpaste | llmpod init --hf-token-stdin --datacenter EU-RO-1 --no-volume
# oppure dall'ambiente, solo se lo chiedi: RUNPOD_API_KEY / HF_TOKEN
llmpod init --from-env --datacenter EU-RO-1 --no-volume
```

`--accept-zai-notice` registra la presa visione dell'avviso del Coding Plan di Z.ai al posto della domanda. Con il
prefisso `!` di Claude Code passa la chiave da un file o dagli appunti, **mai scritta nel prompt**. Dettagli e
opzioni: [guida](docs/GUIDA.md#configurare-senza-terminale-interattivo).

### 3. Client (almeno uno)

| Client | Installazione ufficiale |
|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` (oppure `npm install -g @anthropic-ai/claude-code`) |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` (oppure `npm install -g opencode-ai`) |
| pi | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` |
| ZCode | app desktop di Z.ai, dal sito ufficiale; llmpod ne scrive la configurazione ad app chiusa |

### In alternativa: con Docker

Requisiti: Docker Desktop (macOS, Windows) o Docker Engine con Compose v2 (Linux).

```bash
git clone https://github.com/deduzzo/runpod-helper.git
cd runpod-helper
scripts/start.sh              # macOS/Linux (su macOS anche doppio clic su scripts/start.command)
scripts\start.bat             # Windows
```

Al primo avvio parte `llmpod init` (serve un terminale interattivo), poi si aprono l'interfaccia web
(`http://127.0.0.1:7860`, con il token nel link stampato) e Open WebUI (`http://127.0.0.1:3000`; **crea subito
l'account amministratore**). La CLI si usa con il wrapper `bin/llmpod` (su Windows `bin\llmpod`), per esempio
`bin/llmpod status`, `bin/llmpod run claude` o `bin/llmpod logs <profilo>` (i log dei container sono
`bin/llmpod docker-logs`). Si ferma tutto con `scripts/stop.sh` (o `scripts\stop.bat`), che
**non** elimina i Pod su Runpod. Dettagli, variabili e note per piattaforma: [Docker](docs/GUIDA.md#docker).

### Aggiornamento

```bash
cd runpod-helper
git pull && npm ci && npm run build:web
```

## Modi per avviare

Tre strade, dalla più semplice:

- **Con Claude Code (guidata):** `llmpod start` — configura llmpod se serve, chiede la cartella di lavoro e apre
  Claude Code gestito, che avvia e segue i Pod per te chiedendoti conferma prima di ogni spesa. Senza `npm link`:
  doppio clic su `scripts/start-managed.command` (macOS) o `scripts/start-managed.sh` (Linux), `scripts\start-managed.bat` (Windows).
- **Interfaccia web:** `llmpod ui` apre il pannello locale (installabile come PWA); con Docker, `scripts/start.sh`
  avvia anche Open WebUI per chattare col modello.
- **Dal terminale (CLI):** i comandi dell'avvio rapido qui sotto.

## Avvio rapido

```bash
llmpod search --set abliterated          # modelli del set consigliato (con MTP/DSpark)
llmpod plan abliterated/qwen3.8-27b-gptq # stima VRAM, GPU con prezzo e disponibilità: scegli la GPU
llmpod save prova                        # salva il piano come profilo "prova"
llmpod up prova                          # GPU disponibili ora e costo orario: conferma; poi smoke test
llmpod run claude --profile prova        # oppure: opencode, pi, zcode
llmpod down prova                        # ELIMINA il Pod (il volume con i pesi resta)
llmpod status --all                      # verifica: nessun Pod rimasto acceso o spento
```

Al posto del set puoi cercare su tutto Hugging Face (`llmpod search qwen3 coder`) e pianificare per ID
(`llmpod plan Qwen/Qwen3-Coder-30B-A3B-Instruct --context 65536`). Il percorso completo, con le domande che
llmpod ti fa a ogni passo, è nella [guida](docs/GUIDA.md#avviare-il-pod).

## Comandi

| Comando | Cosa fa |
|---|---|
| `llmpod init` | Configurazione guidata: chiavi, datacenter preferito, network volume (`--datacenter`, `--volume-size`, `--no-volume`, `--dry-run`) |
| `llmpod search [testo]` | Cerca su Hugging Face modelli adatti all'uso agentico; `--sets` elenca i set consigliati, `--set <id>` mostra un set |
| `llmpod plan <modello>` | Stima VRAM, propone le GPU e gli argomenti di vLLM (`--context`, `--gpu`, `--set chiave=valore`, `--no-advisor`) |
| `llmpod save <nome>` | Salva l'ultimo piano come profilo |
| `llmpod up <profilo>` | Crea il Pod, attende vLLM ed esegue lo smoke test (`--dry-run` per vedere la richiesta) |
| `llmpod run <client>` | Avvia `claude`, `opencode` o `pi`, oppure configura `zcode`, sul Pod attivo (`--profile`, `--cwd <cartella>` per lavorare in un'altra cartella; in un terminale interattivo, senza `--cwd`, la cartella viene chiesta con default la corrente) |
| `llmpod claude` | Alias di `llmpod run claude` |
| `llmpod env` | Stampa gli `export` per altri client (**contiene la chiave**; `--format sh\|ps1\|json`) |
| `llmpod chat` | Apre Open WebUI collegato al Pod, per una prova veloce |
| `llmpod status` | Pod avviati, in avvio, spenti e in eliminazione, costi, credito, volume (`--all`: anche gli altri Pod dell'account) |
| `llmpod metrics [profilo]` | Token/s, richieste, KV cache, accettazione MTP/DSpark, errori (`--window`, `--json`) |
| `llmpod logs [profilo]` | Log di vLLM dal supervisore, con le chiavi mascherate (`--follow`, `--since`) |
| `llmpod tune <profilo>` | Cambia gli argomenti di vLLM sul Pod avviato e lo ricarica senza eliminarlo (`--set`, `--dry-run`, `--save`) |
| `llmpod keep [profilo]` | Cambia inattività e ore massime di un Pod avviato (`--idle-minutes`, `--no-idle`, `--max-hours`, `--save`) |
| `llmpod down [profilo]` | Elimina il Pod, acceso o spento (il volume resta) |
| `llmpod rotate-key <profilo>` | Genera una nuova chiave vLLM per il profilo |
| `llmpod destroy-volume` | Elimina il network volume con i pesi (doppia conferma) |
| `llmpod advisor` | Configura il consulente IA esterno (`--preset`, `--test`, `--disable`) |
| `llmpod ui` | Interfaccia web locale e proxy per Open WebUI (`--port`, `--no-open`, `--no-proxy`) |
| `llmpod start` | Avvio guidato della modalità managed: configura llmpod se serve, chiede la cartella di lavoro e apre Claude Code gestito (`--cwd`, `--profile`, `--yes`); senza `npm link`: doppio clic su `scripts/start-managed.command` (macOS) o `scripts/start-managed.sh` |
| `llmpod manage` | Modalità Claude Code managed: avvia Claude Code nella cartella di llmpod o, con `--cwd <cartella>`, nella tua (`--profile`) |
| `llmpod mcp` | Server MCP di llmpod su stdio (equivale a `llmpod-mcp`) |
| `llmpod prepare <client>` | Uso interno del wrapper Docker: prepara il client e stampa lo script per avviarlo sull'host |

Opzioni globali: `--verbose` (log di vLLM durante l'avvio), `--version`, `--help`. Ogni comando ha il suo
`--help`. Ogni operazione che costa mostra il **costo orario** e chiede conferma (`--yes` per saltarla); i comandi
che creano o eliminano risorse accettano `--dry-run`.

## Documentazione

La **[guida](docs/GUIDA.md)** copre, in ordine:
[installazione e chiavi](docs/GUIDA.md#installazione-e-chiavi) ·
[concetti](docs/GUIDA.md#concetti) ·
[scegliere il modello](docs/GUIDA.md#scegliere-il-modello) ·
[scegliere la GPU](docs/GUIDA.md#scegliere-la-gpu) ·
[avviare il Pod](docs/GUIDA.md#avviare-il-pod) ·
[usare i client](docs/GUIDA.md#usare-i-client) ·
[monitorare e ottimizzare](docs/GUIDA.md#monitorare-e-ottimizzare) ·
[spegnere e costi](docs/GUIDA.md#spegnere-e-costi) ·
[interfaccia web](docs/GUIDA.md#interfaccia-web) ·
[Docker](docs/GUIDA.md#docker) ·
[modalità Claude Code managed](docs/GUIDA.md#modalità-claude-code-managed) ·
[consulente IA esterno](docs/GUIDA.md#consulente-ia-esterno) ·
[risoluzione dei problemi](docs/GUIDA.md#risoluzione-dei-problemi) ·
[FAQ](docs/GUIDA.md#domande-frequenti).

Per chi sviluppa: [CLAUDE.md](CLAUDE.md) (regole dell'operatore Claude Code) e la cartella
[docs/superpowers](docs/superpowers) (design e piani di implementazione).

## Costi in breve

- Paghi la GPU **a ore, finché il Pod esiste**: da circa 0,89 $/h (RTX 4090, 24 GB) a oltre 5 $/h (H200), secondo
  il listino che `llmpod plan` e `llmpod up` leggono ogni volta da Runpod.
- Il Pod si elimina da solo dopo **30 minuti senza richieste** o comunque dopo **8 ore** (valori del profilo,
  modificabili con `llmpod keep`).
- **llmpod elimina sempre i Pod, non li ferma**: un Pod spento costa ancora lo spazio su disco. `llmpod status`
  li segnala e `llmpod down` li elimina.
- Il **network volume** costa circa 0,07 $/GB al mese anche senza Pod (150 GB ≈ 10,50 $/mese); si elimina con
  `llmpod destroy-volume`.
- **Anche l'avvio si paga**: per i modelli grandi download e caricamento dei pesi possono durare più di 40 minuti
  (126 GiB su 2 GPU PCIe: ~25 minuti solo di caricamento). `llmpod up` mostra la stima di tempo e costo
  dell'avvio prima della conferma.
- Un errore di vLLM durante il caricamento dei pesi (NCCL, CUDA, memoria) **non** provoca riavvii automatici che
  ricaricherebbero tutto: `up` si ferma subito e propone riparazione o eliminazione; un vLLM fermo dopo i pesi
  (30 minuti senza log e nessuna compilazione in corso) passa in errore, e un Pod in errore da 15 minuti si elimina da solo. Sui Pod con più GPU
  senza NVLink completo llmpod usa la **modalità NCCL sicura** (`NCCL_P2P_DISABLE=1` o `NCCL_P2P_LEVEL=NVL`,
  `--disable-custom-all-reduce`; vedi [NCCL error](docs/GUIDA.md#risoluzione-dei-problemi)).

Tabella dei prezzi e stima di una sessione: [Spegnere e costi](docs/GUIDA.md#spegnere-e-costi).

## Sicurezza in breve

- Le chiavi (Runpod, Hugging Face, consulente, chiavi vLLM dei profili) stanno in `~/.config/llmpod/.env` con
  permessi `600`, non vengono mai stampate nei log e non entrano nell'immagine Docker. L'unico comando che le
  mostra è `llmpod env`, su tua richiesta.
- Nel Pod non entra nessuna tua chiave Runpod: il watchdog usa la chiave che Runpod inietta nel Pod, che può
  agire solo su quel Pod.
- Ogni profilo ha una chiave vLLM propria (`llmpod rotate-key` per cambiarla).
- Interfaccia web e Open WebUI sono raggiungibili solo dal tuo computer (`127.0.0.1`, anche con Docker);
  l'interfaccia richiede il link con il token stampato all'avvio.
- Il repository è pubblico: l'hook di pre-commit e la CI (gitleaks) bloccano i commit con segreti.

## Sviluppo

```bash
npm test              # vitest + unittest Python del supervisore
npm run build:web     # build dell'interfaccia
```

La CI di GitHub esegue i test (Node 20 e 22), la build dell'interfaccia, gitleaks, la build e la prova del
container, la validazione di `compose.yaml` e il controllo degli script PowerShell.

## Licenza

[MIT](LICENSE)
