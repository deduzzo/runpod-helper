# llmpod — runpod-helper

> **Stato:** v1 completa — CLI, consulente IA, interfaccia web, Docker.

`llmpod` è una CLI (con interfaccia web locale) che automatizza il ciclo di vita di un **LLM
self-hosted su [Runpod](https://www.runpod.io)**, da usare come backend di coding agent come
**Claude Code**, **OpenCode**, **ZCode** e **pi**:

1. scelta del modello da Hugging Face (ricerca o ID diretto);
2. stima della VRAM e scelta automatica della GPU (o multi-GPU) più economica e disponibile;
3. avvio di un Pod con [vLLM](https://docs.vllm.ai) pronto all'uso;
4. configurazione automatica del client scelto;
5. **distruzione automatica del Pod per inattività**, anche a portatile spento;
6. ricreazione identica da un profilo salvato.

## Funzionalità previste (v1)

| Comando | Cosa fa |
|---|---|
| `llmpod init` | Configurazione guidata: credenziali, datacenter preferito, network volume per i pesi |
| `llmpod search <query>` | Cerca su Hugging Face modelli adatti all'uso agentico (chat template, tool calling) |
| `llmpod plan <modello>` | Stima VRAM (pesi + KV cache + margine), sceglie la GPU, propone gli argomenti di `vllm serve` |
| `llmpod save <nome>` | Salva il piano come profilo riutilizzabile |
| `llmpod up <profilo>` | Crea il Pod, attende vLLM, esegue uno smoke test con chiamata a strumento |
| `llmpod run <client>` | Avvia Claude Code / OpenCode / pi, o configura ZCode, puntandoli al Pod |
| `llmpod env` | Stampa gli `export` per altri client |
| `llmpod chat` | Prova veloce con Open WebUI locale (Docker) collegato al Pod |
| `llmpod status` | Pod attivi, uptime, costo della sessione, credito residuo, costo del volume |
| `llmpod down` | Termina il Pod (il volume con i pesi resta) |
| `llmpod rotate-key` | Rigenera la chiave API di vLLM del profilo |
| `llmpod destroy-volume` | Elimina il network volume (doppia conferma) |
| `llmpod ui` | Interfaccia web locale (React + Vite + Tailwind, installabile come PWA) |

Ogni operazione che costa denaro mostra il **costo orario stimato e chiede conferma**
(`--yes` per saltarla); tutti i comandi che creano o distruggono risorse supportano `--dry-run`.

## Installazione con Docker (consigliata)

Requisiti: Docker Desktop (macOS, Windows) o Docker Engine con Compose v2 (Linux).

```bash
git clone https://github.com/deduzzo/runpod-helper.git
cd runpod-helper
scripts/start.sh              # macOS/Linux (su macOS anche doppio clic su scripts/start.command)
scripts\start.bat             # Windows (doppio clic o da terminale; usa scripts\start.ps1)
```

Al primo avvio parte la configurazione guidata (`llmpod init`), che richiede un **terminale
interattivo**: se manca la chiave Runpod e lo script non è eseguito da un terminale, si ferma con
un messaggio. Poi si apre l'interfaccia web (`http://127.0.0.1:7860`, con il token nel link
stampato) e Open WebUI è raggiungibile su `http://127.0.0.1:3000` (ometti con `--no-openwebui`,
su Windows `-NoOpenWebUI` con `start.ps1`). Le porte sono pubblicate solo su `127.0.0.1`.
Per fermare tutto: `scripts/stop.sh` (o `scripts\stop.bat`); configurazione e pesi restano.

La CLI dall'host passa dal wrapper (`bin/llmpod` su macOS/Linux, `bin\llmpod.ps1` su Windows),
che esegue i comandi nel container e avvia i client sul tuo computer:

```bash
bin/llmpod status
bin/llmpod run claude          # anche: opencode, pi, zcode
```

Con Docker Open WebUI parte già con `start` (collegato al Pod attivo tramite il proxy interno,
senza chiavi da copiare); il comando `llmpod chat` serve invece all'installazione senza Docker.

Le chiavi restano in `~/.config/llmpod/.env` (permessi 600), montata nel container: l'immagine
non contiene segreti. Cartelle e utente si possono cambiare con `LLMPOD_CONFIG_DIR`, `ZCODE_DIR`,
`PI_DIR` e `LLMPOD_UI_PORT`. Il container gira con l'UID/GID dell'utente host, così i file creati
restano tuoi (su Windows 1000).

Per provare l'immagine senza credenziali reali: `sh scripts/docker-smoke.sh`.
La CI di GitHub esegue test (Node 20 e 22), build dell'interfaccia, gitleaks, build e prova del
container e controllo di sintassi degli script PowerShell.

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
llmpod search qwen3 coder                     # modelli con chat template e tool parser noto (esclusi i modelli MLX, non supportati da vLLM; --all li include)
llmpod plan Qwen/Qwen3-Coder-30B-A3B-Instruct --context 65536
llmpod save qwen3-coder
llmpod up qwen3-coder                         # mostra il costo orario e chiede conferma
llmpod run claude                             # oppure: opencode, pi, zcode
llmpod status
llmpod down                                   # il volume con i pesi resta
```

Il Pod si spegne da solo dopo 30 minuti senza richieste o dopo 8 ore in ogni caso
(valori nel profilo, sezione `watchdog`), anche a portatile spento.

## Consulente IA (facoltativo)

Un LLM esterno può rivedere gli argomenti di vLLM proposti da `llmpod plan` (leggendo la scheda
del modello e la recipe ufficiale di vLLM) e proporre correzioni se l'avvio fallisce.
Ogni proposta passa una validazione rigida (solo flag esistenti in vLLM v0.30.0, nessun flag che
tocchi chiave, host, porta o revisione) e si applica solo con la tua conferma.

```bash
llmpod advisor            # scegli il preset e inserisci la chiave
llmpod advisor --test     # verifica la connessione
llmpod plan <modello>     # il consulente interviene in automatico (--no-advisor per saltarlo)
```

| Preset | Note |
|---|---|
| `zai-coding-plan` | endpoint Anthropic di Z.ai con GLM-5.3. Le condizioni del Coding Plan limitano l'uso agli strumenti supportati: la responsabilità dell'uso da llmpod è tua |
| `zai` | API Z.ai a consumo |
| `anthropic` | API Anthropic |
| `openai` | API OpenAI (indica il modello) |
| `custom` | qualsiasi endpoint compatibile Anthropic o OpenAI |
| `claude-cli` | Claude Code installato in locale, senza strumenti |
| `pod` | il modello appena avviato sul Pod, solo per le correzioni dopo `up` |

La chiave del consulente sta in `~/.config/llmpod/.env` (permessi 600) e non viene mai mostrata.

## Interfaccia web

```bash
npm run build:web      # una volta (o dopo un aggiornamento)
llmpod ui              # apre il browser su http://127.0.0.1:7860
```

L'interfaccia (installabile come app dal browser) copre ricerca dei modelli, piano con il
consulente, profili, avvio e spegnimento con le stesse conferme di costo della CLI, stato e
costi, configurazione dei client e una prova veloce con Open WebUI. È raggiungibile solo dal tuo
computer e richiede il link con il token stampato da `llmpod ui`. Il controllo dell'intestazione
Host accetta solo `127.0.0.1` e `localhost` (anche `[::1]` se ascolti su IPv6 o su `localhost`):
con `--host` diverso l'interfaccia non è utilizzabile da altri computer. Con `--host localhost`
o IPv6 il proxy resta su `127.0.0.1`, salvo `--proxy-host` o `LLMPOD_PROXY_HOST`.

Il proxy per Open WebUI (porta 8081) inoltra le richieste al Pod del profilo scelto nella scheda
"Prova veloce"; Open WebUI va puntato su `http://127.0.0.1:8081/v1` con la chiave
`LLMPOD_OPENWEBUI_KEY` del file `.env` (con Docker è automatico).

Note sulla scheda "Prova veloce":

- Open WebUI si trova di default su `http://127.0.0.1:3000`; cambialo con `LLMPOD_OPENWEBUI_URL`
  (indirizzo http(s) con nome host semplice: se non è valido, `llmpod ui` non si avvia). Il server
  consente l'incorporamento in pagina solo di quell'indirizzo.
- Per gli indirizzi loopback, se apri l'interfaccia su `127.0.0.1` la finestra e il link usano
  `localhost` per Open WebUI, e viceversa: il cookie di sessione (`llmpod_session`) è legato al
  nome dell'host, non alla porta, e in questo modo il browser non lo invia a Open WebUI. Lo
  scambio vale solo per gli indirizzi loopback; non aprire Open WebUI sullo stesso nome di host
  dell'interfaccia.
- Open WebUI potrebbe rifiutare di essere incorporato in una pagina: in quel caso resta il link
  "Apri in una nuova scheda".
- La scheda "Client" mostra gli `export` (con la chiave del profilo) solo dopo il clic su
  "Mostra gli export": non vengono memorizzati nel browser.

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
| Risposte interrotte dopo ~100 s | Limite del proxy HTTPS di Runpod (Cloudflare) | Verificato l'11/10/2026 con `npm run e2e:cpu`: uno streaming di 150 s attraverso il proxy arriva completo, quindi le risposte in streaming non vengono tagliate. Le richieste *non* in streaming oltre i 100 s invece sì: usa client in streaming (Claude Code, OpenCode e pi lo sono) |

## Sicurezza

- Le credenziali stanno in `~/.config/llmpod/.env` (permessi 600) e non vengono mai stampate.
- Nel Pod non entra nessuna chiave Runpod dell'utente: il watchdog usa la chiave che Runpod
  inietta nel Pod, verificata in grado di agire solo su quel Pod.
- Ogni profilo ha una chiave vLLM propria (`llmpod rotate-key` per cambiarla).
- Le metriche di vLLM (`/metrics`) sono raggiungibili senza chiave tramite il proxy pubblico:
  espongono solo contatori, non i contenuti delle richieste.

## Decisioni di design

- **Node.js ≥ 20, ESM, dipendenze minime** (`commander`, `fetch` nativo). Un modulo `core`
  condiviso da CLI e interfaccia web, che comunicano con il core tramite eventi.
- **Runpod REST API v2** (`https://api.runpod.io/v2`) per Pod, volumi e catalogo GPU con
  disponibilità per datacenter. Il fallback tra GPU è gestito lato client, come indicato dalla
  documentazione Runpod.
- **Immagine ufficiale `vllm/vllm-openai`** con versione fissata nel profilo (mai `latest`).
  Nessuna immagine derivata: l'entrypoint viene sostituito e uno script supervisore viene
  iniettato tramite variabile d'ambiente.
- **Supervisore nel Pod**: avvia vLLM, legge le metriche Prometheus (`/metrics`) ogni 60 s e
  termina il Pod dopo N minuti senza richieste (default 30) o comunque dopo una durata massima
  (default 8 h).
- **Network volume** per i pesi nel datacenter preferito; se lì non ci sono GPU disponibili,
  con il consenso dell'utente si ripiega su un altro datacenter scaricando i pesi sul disco del
  container.
- **Chiave API di vLLM per profilo**, salvata localmente e rigenerabile.
- **Parametri di vLLM su tre livelli**: regole deterministiche (architettura → tool-call parser,
  reasoning parser, dtype, quantizzazione); un consulente LLM che legge la scheda del modello e
  le recipe ufficiali di vLLM, con proposte validate su uno schema e sui flag ammessi; verifica
  dopo l'avvio con correzioni proposte e applicate solo previa conferma.
- **IA esterna modulare** per il consulente: protocolli Anthropic e OpenAI con preset
  (Z.ai GLM, Anthropic, OpenAI, endpoint personalizzato, il modello sul Pod, `claude -p`).
- **Deploy con Docker Compose** (web UI, core e Open WebUI) e script di avvio per macOS,
  Linux e Windows (`scripts/start.*`, `scripts/stop.*`, wrapper `bin/llmpod`).
- **Credenziali** in `~/.config/llmpod/.env` con permessi `600`. Chiavi e token non vengono mai
  scritti nei log.

## Verifiche già fatte

### Chiave API iniettata da Runpod nel Pod (11 ottobre 2026)

Runpod inietta in ogni Pod la variabile `RUNPOD_API_KEY`, descritta solo come *"Pod-scoped API
key"*. Con tre Pod CPU di prova abbiamo verificato cosa permette:

| Operazione con la chiave iniettata | Esito |
|---|---|
| `GET /v2/pods/{proprio id}` | ✅ 200 |
| `DELETE /v2/pods/{proprio id}` (auto-terminazione) | ✅ funziona |
| Leggere o terminare **un altro** Pod (v2) | ❌ 404, non visibile |
| Elencare i Pod, leggere i template (v2) | ❌ 403 |
| Qualsiasi chiamata REST v1 | ❌ 403 |
| GraphQL (saldo, Pod, `podTerminate`) | ❌ Unauthorized |

Conseguenza: il watchdog usa **solo** la chiave iniettata, che può terminare esclusivamente il
proprio Pod; nessuna chiave dell'utente viene mai passata al Pod.

Nota pratica: Cloudflare davanti alle API Runpod risponde `403 error code: 1010` allo
User-Agent predefinito di Python (`Python-urllib/…`); serve uno User-Agent personalizzato.

## Client supportati

| Client | Protocollo | Integrazione |
|---|---|---|
| Claude Code | Anthropic `/v1/messages` | variabili d'ambiente (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, modelli) e avvio di `claude` |
| OpenCode | OpenAI Chat Completions | provider `openai-compatible` e avvio di `opencode` |
| ZCode | OpenAI Chat Completions | provider in `~/.zcode/v2/config.json` (da modificare ad app chiusa) |
| pi | OpenAI Chat Completions | provider in `~/.pi/agent/models.json` con chiave da variabile d'ambiente, avvio di `pi` |
| Open WebUI | OpenAI Chat Completions | container Docker locale per prove rapide |

## Licenza

[MIT](LICENSE)
