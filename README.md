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
| `llmpod search --sets` / `--set <id>` | Elenca i set di modelli consigliati / mostra solo i modelli di un set (es. `abliterated`; non è il `--set` di `plan`) |
| `llmpod plan <modello>` | Stima VRAM (pesi + KV cache + margine), elenca le GPU adatte e te le fa scegliere (`--gpu <id>[x<n>]` per indicarla), propone gli argomenti di `vllm serve` |
| `llmpod save <nome>` | Salva il piano come profilo riutilizzabile |
| `llmpod up <profilo>` | Ti propone le GPU disponibili ora, crea il Pod, attende vLLM, esegue uno smoke test con chiamata a strumento |
| `llmpod run <client>` | Avvia Claude Code / OpenCode / pi, o configura ZCode, puntandoli al Pod |
| `llmpod env` | Stampa gli `export` per altri client |
| `llmpod chat` | Prova veloce con Open WebUI locale (Docker) collegato al Pod |
| `llmpod status` | Pod avviati, in avvio e spenti, uptime, costo della sessione, credito residuo, costo del volume |
| `llmpod keep <profilo>` | Cambia inattività e ore massime di un Pod già avviato, con il costo massimo fino alla nuova scadenza (vedi "Tenere acceso un Pod") |
| `llmpod down` | Elimina il Pod, acceso o spento (il volume con i pesi resta) |
| `llmpod rotate-key` | Rigenera la chiave API di vLLM del profilo |
| `llmpod destroy-volume` | Elimina il network volume (doppia conferma) |
| `llmpod ui` | Interfaccia web locale (React + Vite + Tailwind, installabile come PWA) |

Ogni operazione che costa denaro mostra il **costo orario stimato e chiede conferma**
(`--yes` per saltarla); tutti i comandi che creano o distruggono risorse supportano `--dry-run`.

**llmpod elimina sempre i Pod, non li ferma**: un Pod spento (stato `EXITED`) continua a costare lo spazio
su disco finché esiste. `llmpod status` e la pagina "Stato e costi" mostrano i Pod avviati, in avvio e spenti
(questi ultimi con un avviso e il pulsante "Elimina"); `llmpod down` elimina anche quelli spenti, e `llmpod up`
chiede di eliminare un Pod spento dello stesso profilo prima di crearne uno nuovo (predefinito sì; con `--yes` lo elimina
senza chiedere). Se rifiuti, o la domanda nell'interfaccia web scade, `up` si ferma e non crea nulla.

## Installazione con Docker (consigliata)

Requisiti: Docker Desktop (macOS, Windows) o Docker Engine con Compose v2 (Linux).

```bash
git clone https://github.com/deduzzo/runpod-helper.git
cd runpod-helper
scripts/start.sh              # macOS/Linux (su macOS anche doppio clic su scripts/start.command)
scripts\start.bat             # Windows (doppio clic o da terminale; usa scripts\start.ps1)
```

Al primo avvio parte la configurazione guidata (`llmpod init`), che richiede un **terminale
interattivo**: se manca la chiave Runpod (o la configurazione, per un `init` interrotto) e lo
script non è eseguito da un terminale, si ferma con un messaggio. Poi si apre l'interfaccia web
(`http://127.0.0.1:7860`, con il token nel link stampato) e Open WebUI è raggiungibile su
`http://127.0.0.1:3000` (ometti con `--no-openwebui`, su Windows `-NoOpenWebUI` con `start.ps1`).
Le porte sono pubblicate solo su `127.0.0.1`. Al primo avvio Open WebUI può impiegare alcuni
minuti a diventare pronto: lo script attende fino a 2 minuti e poi prosegue (se `docker compose`
supporta `--wait`).

Per rientrare nell'interfaccia basta rilanciare lo script di avvio: il link con il token cambia a
ogni avvio e compare anche nei log del container (`bin/llmpod logs`).

**Open WebUI con account.** Il primo account che crei su Open WebUI diventa amministratore; la
registrazione di altri account è disattivata (`ENABLE_SIGNUP=false`; il primo account non ne
dipende, verificato sul codice di Open WebUI v0.11.4). Senza autenticazione una pagina web
malevola (o un attacco di DNS rebinding) potrebbe usare Open WebUI su `localhost` come se fosse
l'utente, quindi l'accesso senza account non è previsto. **Crea l'account subito dopo il primo
avvio**: finché non esiste, chiunque raggiunga `127.0.0.1:3000` dal tuo computer potrebbe crearlo per primo. Le credenziali dell'account restano nel
volume Docker di Open WebUI. La porta si cambia con `LLMPOD_OPENWEBUI_PORT` (predefinita 3000).

Per fermare tutto: `scripts/stop.sh` (o `scripts\stop.bat`); configurazione e dati di Open WebUI
restano. **`stop` ferma i container locali, non tocca i Pod su Runpod**: i Pod si eliminano con
`bin/llmpod down <profilo>` o si eliminano da soli dopo l'inattività. Se alla chiusura risultano Pod
(e c'è la chiave Runpod), lo script stampa un avviso con l'ID del Pod e il comando per eliminarlo:
per un Pod acceso "resta acceso e a pagamento", per uno spento "è spento ma costa ancora lo spazio su
disco". Non elimina nulla da solo.

La CLI dall'host passa dal wrapper `bin/llmpod` (macOS/Linux) o `bin\llmpod` (Windows: è
`bin\llmpod.cmd`, che lancia `llmpod.ps1` con `-ExecutionPolicy Bypass`, così non serve cambiare
la policy di PowerShell). Il wrapper esegue i comandi nel container e avvia i client sul tuo
computer, nella cartella da cui lo lanci (non cambia la cartella corrente):

```bash
bin/llmpod status
bin/llmpod run claude          # anche: opencode, pi, zcode
bin/llmpod logs                # ultimi log del container llmpod (anche: bin/llmpod logs open-webui)
bin/llmpod chat                # apre Open WebUI sull'host (http://localhost:3000)
```

`bin/llmpod ui` non serve nel setup Docker: l'interfaccia la avvia `scripts/start`. Con Docker
Open WebUI parte già con `start` (collegato al Pod attivo tramite il proxy interno, senza chiavi
da copiare); `bin/llmpod chat` apre solo la pagina sull'host (con `localhost`, diverso dal
`127.0.0.1` dell'interfaccia, così il cookie di sessione non viene inviato a Open WebUI).
Dentro Docker i suggerimenti degli errori mostrano `bin/llmpod …`.

Le chiavi restano in `~/.config/llmpod/.env` (permessi 600), montata nel container: l'immagine
non contiene segreti. Cartelle e utente si possono cambiare con `LLMPOD_CONFIG_DIR`, `ZCODE_DIR`,
`PI_DIR` (o `PI_CODING_AGENT_DIR`, rispettata se impostata sull'host), `LLMPOD_UI_PORT` e
`LLMPOD_OPENWEBUI_PORT`. Il container gira con l'UID/GID dell'utente host, così i file creati
restano tuoi.

Note per piattaforma:

- **Windows:** UID/GID sono 1000 e i file montati nel container appaiono con permessi 0777 senza
  che `chmod` abbia effetto: gli script impostano `LLMPOD_HOST_OS=windows` e llmpod salta il
  controllo dei permessi di `.env`. Su Windows la protezione di `.env` è affidata ai permessi NTFS
  del profilo utente.
- **Linux con Docker rootless o Docker Desktop for Linux:** gli script rilevano la modalità
  (`docker info` con `rootless`, oppure contesto `desktop-linux`) e usano l'utente `0:0` nel
  container, che in questi casi corrisponde al tuo utente sull'host.
- **Podman o host con SELinux:** i volumi di `compose.yaml` possono richiedere il suffisso `:z`
  (ad esempio `"${LLMPOD_CONFIG_DIR}:/config:z"`) per essere leggibili dal container.
- **Preset `claude-cli` del consulente:** non è disponibile nel container (non contiene `claude`);
  se già configurato, il consulente segnala l'errore. Usa un altro preset o la CLI senza Docker.

Per provare l'immagine senza credenziali reali: `sh scripts/docker-smoke.sh`.
La CI di GitHub esegue test (Node 20 e 22), build dell'interfaccia, gitleaks, build e prova del
container, validazione di `compose.yaml` e controllo degli script PowerShell (sintassi e prova con
un `docker` finto).

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
llmpod search qwen3 coder                     # modelli con chat template e tool parser noto (esclusi i modelli MLX e i repository solo GGUF, non supportati da vLLM; --all li include)
llmpod plan Qwen/Qwen3-Coder-30B-A3B-Instruct --context 65536
llmpod save qwen3-coder
llmpod up qwen3-coder                         # mostra il costo orario e chiede conferma
llmpod run claude                             # oppure: opencode, pi, zcode
llmpod status
llmpod down                                   # il volume con i pesi resta
```

Scelta della GPU: il piano elenca tutte le configurazioni che entrano in memoria, dalla più economica, con
VRAM, margine, costo e disponibilità (nel datacenter del volume e altrove; quelle non disponibili ovunque
sono marcate "non disponibile ora"). In un terminale interattivo `llmpod plan` chiede "Quale GPU usare?"
(predefinita: la più economica disponibile); `--gpu "NVIDIA A100 80GB PCIe"` o `--gpu "…x2"` la imposta senza
domanda, e `--yes` o `--json` non chiedono nulla. Il profilo salvato conserva tutte le configurazioni compatibili: `llmpod up` rilegge la disponibilità dal catalogo e propone
quelle disponibili ora, per costo, comprese quelle di altri datacenter (etichettate "senza volume, <datacenter>": i pesi vanno
scaricati a ogni avvio). La predefinita è la GPU del profilo nel datacenter del volume, se disponibile, altrimenti la più economica.
Se ne resta una sola la usa direttamente (la conferma del costo mostra quella), se non ce n'è nessuna si ferma con
`NO_GPU_AVAILABLE`. Dopo la scelta usa solo quella, senza ripieghi
silenziosi (con `--yes` vale la GPU del profilo con le sue alternative); i profili vecchi, senza elenco, usano GPU e alternative.
La conferma del costo resta. Nell'interfaccia
web la tabella del piano è selezionabile (la scelta viene salvata nel profilo) e l'avvio dalla scheda Profili
mostra la domanda come scelta tra opzioni; senza risposta il job si annulla e non spende nulla.

Modelli e piano: vLLM carica solo pesi safetensors (anche quantizzati AWQ/GPTQ/FP8); un repository GGUF viene
rifiutato subito con l'indicazione del modello base. Per le architetture ibride (Qwen3.5: attenzione lineare + completa)
la KV cache conta solo gli strati ad attenzione completa, più uno stato costante per sequenza. Se i pesi contengono il
draft head MTP (tensori `mtp.*`; `llmpod search` lo segnala con la colonna MTP quando tag o nome lo dichiarano e mette
prima le varianti MTP a parità di modello base) il piano aggiunge `--speculative-config` con metodo `mtp` e 1 token
speculativo, riserva circa 1 GiB di VRAM e mostra la riga `MTP:`. Per disattivarlo: `llmpod plan … --set speculative-config=false`.

Il Pod si spegne da solo dopo 30 minuti senza richieste o dopo 8 ore in ogni caso
(valori nel profilo, sezione `watchdog`), anche a portatile spento.

### Tenere acceso un Pod

Per un lavoro lungo puoi cambiare i limiti di un Pod **già avviato**, senza riavviarlo:

```bash
llmpod keep <profilo> --max-hours 24          # durata massima: 24 ore dall'avvio del Pod
llmpod keep <profilo> --no-idle               # non spegnere mai per inattività (resta il limite di ore)
llmpod keep <profilo> --idle-minutes 120      # spegni dopo 2 ore senza richieste
llmpod keep <profilo> --max-hours 24 --save   # aggiorna anche il profilo, per i prossimi avvii
```

- `--idle-minutes` accetta un intero tra 5 e 1440, oppure **0 = mai** (nessuno spegnimento per inattività;
  `--no-idle` equivale a 0); `--max-hours` da 0,25 a 168 (anche con la virgola: `0,25`). Gli stessi valori
  valgono per la sezione `watchdog` dei profili (`idleMinutes`, `maxHours`: 0 = mai), che viene validata.
  Le ore massime si contano **sempre dall'avvio del Pod**, non da quando lanci `keep`. Cambiando
  l'inattività il conteggio riparte da adesso.
- Il comando stampa i nuovi limiti, quando il Pod si spegnerà e il **costo massimo** fino a quel momento
  (ore rimanenti × costo orario; se il costo orario non è noto lo dice invece di mostrare 0,00 $). Chiede
  conferma (`--yes` per saltarla) ogni volta che la spesa possibile aumenta: più ore massime, inattività
  disattivata (0) o soglia più alta. Con `--save`, se il profilo avrà inattività 0 o più di 8 ore massime,
  chiede una conferma esplicita; anche `llmpod up` mostra nella conferma "inattività: mai (o N min),
  massimo N h → costo massimo X $" quando il profilo esce dai limiti predefiniti (30 min, 8 h).
  Un Pod tenuto acceso costa finché non lo spegni con `llmpod down` o non scatta un limite.
- `keep` non accorcia il massimo fino a eliminare il Pod in silenzio: se le ore massime sono sotto il
  tempo già trascorso più 5 minuti viene rifiutato (per spegnere il Pod usa `llmpod down`).
- I limiti restano anche se il supervisore nel Pod si riavvia. Senza `--save` valgono solo per questo Pod.
- Nell'interfaccia web, pagina "Stato e costi": il pulsante **Prolunga** di ogni Pod avviato apre una
  finestra con inattività (anche "Mai") e ore massime, e riporta il costo massimo prima della conferma.
  `llmpod status` e la pagina mostrano nella colonna "Spegnimento" i limiti correnti letti dal Pod.
- I Pod avviati con una versione precedente di llmpod hanno un supervisore senza questa funzione: `keep`
  lo rileva e ti dice di eliminare e riavviare il Pod (`llmpod down <profilo>`, poi `llmpod up <profilo>`).

## Set di modelli consigliati

Oltre alla ricerca globale su Hugging Face, llmpod propone **set di modelli già verificati**
(`data/model-sets.json`). Il primo è **`abliterated`**: modelli senza rifiuti (abliterated, heretic,
uncensored), molto capaci e adatti ai client di coding agentici (Claude Code, OpenCode, pi, ZCode):
Qwen3.8-27B (quello in uso, GPTQ e BF16), Qwen3.6-35B-A3B, gpt-oss-120b, MiniMax-M2.7,
Qwen3.8-Flash-Next, DeepSeek-V4-Flash e V4.1-Flash, GLM-5.3-Flash e GLM-5.3 completo.

> ⚠ Sono modelli con salvaguardie ridotte o rimosse: usali in modo responsabile, nel rispetto della legge
> e delle licenze, e non esporli a utenti non consapevoli.

```bash
llmpod search --sets                     # elenco dei set
llmpod search --set abliterated          # modelli del set: id breve, variante, formato, pesi, MTP/DSpark, contesto
llmpod search glm --set abliterated      # il testo filtra dentro il set
llmpod plan abliterated/qwen3.8-27b-gptq # per id breve (stabile): revisione verificata e contesto consigliato
llmpod plan abliterated/1                # per posizione nell'elenco (comoda, ma cambia se il set viene riordinato)
llmpod plan abliterated/1 --context 65536
```

Attenzione ai due `--set`: in `llmpod search --set <id>` indica **il set di modelli**, in `llmpod plan --set
chiave=valore` imposta invece **un argomento di vLLM** (es. `--set kv-cache-dtype=fp8`). `plan <set>/<n>`,
`POST /api/plan` con un riferimento al set e `search --set … --json` riportano anche l'avviso del set.

Nell'interfaccia web, pagina **Modelli**: il selettore **Ricerca** passa da "Tutti i modelli" a un set
consigliato, che compare come schede (formato, pesi, MTP o DSpark, contesto, parser, licenza, note, link alla
pagina Hugging Face); **Calcola il piano** (uno alla volta) precompila il modello alla revisione verificata e il contesto consigliato e calcola il piano con
GPU e prezzo correnti. Prezzi e GPU non sono nel set: dipendono dalla disponibilità e li calcola il piano.

**Criteri di inclusione** (verificati sull'API pubblica di Hugging Face, senza token):

- solo formati che vLLM v0.30.0 carica nativamente: safetensors BF16, FP8, AWQ, GPTQ, compressed-tensors,
  NVFP4 (e l'MXFP4 nativo di gpt-oss) **nella radice** del repository; niente GGUF, MLX, EXL3 o pesi in
  sottocartelle;
- architettura presente nel registro dei modelli di vLLM v0.30.0 e tool parser noto in
  `data/parsers.json` (le regole nuove citano la recipe ufficiale in `source`);
- a parità di modello, varianti con un **draft head** nei pesi e quindi decodifica speculativa: **MTP**
  (tensori `mtp.*` o strato nextn `model.layers.<n>.`/`model.language_model.layers.<n>.` nel weight_map) oppure
  **DSpark** (DeepSeek-V4-Flash-0731 e V4.1: i tensori `mtp.*` sono stadi DSpark, riconosciuti dalle chiavi
  `dspark_*` della config). llmpod sceglie `--speculative-config` di conseguenza: `{"method":"mtp",…}` oppure
  l'argomento DSpark della recipe vLLM del modello; il piano lo mostra nella riga MTP/Draft. Le altre
  raccomandazioni delle recipe (es. `--kv-cache-dtype fp8 --block-size 256` per DeepSeek-V4, `--engram-config`
  su H100 per V4.1) compaiono come avvisi del piano, non come argomenti automatici; per i modelli NVFP4 il piano
  avvisa se la GPU scelta non è Blackwell; per ogni famiglia 1–3 varianti (la più piccola di qualità alta e quella piena);
- repository non gated (metadati verificabili senza token) e pubblicatori diffusi o affidabili.

**Come si aggiorna un set**: per ogni candidato si registrano revisione (sha), `quantization_config` di
`config.json`, dimensione dei pesi (shard elencati nell'indice), presenza MTP, architettura, contesto
massimo, parser, licenza; poi si modifica `data/model-sets.json` (aggiornando `updatedAt`) e si esegue
`npm test`: lo schema è validato al caricamento e un test controlla che i parser di ogni modello siano
quelli che llmpod sceglie per la sua architettura. Ogni modello ha un id breve stabile (`key`) e il campo `draft` (`mtp`, `dspark` o null); le fixture reali in
`test/fixtures/hf/model-sets/` permettono il test di coerenza tra `mtp`/`draft` del set e il rilevamento del
planner. Il campo `revision` fissa la versione verificata: per
passare a una revisione più recente va ricontrollata e aggiornata.

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
| `claude-cli` | Claude Code installato in locale, senza strumenti (non disponibile con Docker) |
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
- **Credenziali** in `~/.config/llmpod/.env` con permessi `600`. Le chiavi (Runpod, Hugging Face,
  consulente, Pod) non vengono mai scritte nei log; fa eccezione il link dell'interfaccia con il
  token di sessione, stampato all'avvio e quindi presente nei log del container: è il modo per
  recuperarlo con `bin/llmpod logs`.

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
