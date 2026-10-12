# Guida a llmpod

Manuale passo per passo di llmpod: dall'installazione al primo modello acceso, dall'uso con i client di coding al
tuning di vLLM e allo spegnimento. Per una panoramica veloce vedi il [README](../README.md).

Gli esempi usano `llmpod <comando>` (dopo `npm link`); in alternativa vale `node src/cli/index.js <comando>` dalla
cartella del progetto, oppure `bin/llmpod <comando>` con Docker. Ogni comando ha il suo `--help`.

## Indice

1. [Installazione e chiavi](#installazione-e-chiavi)
2. [Concetti](#concetti)
3. [Scegliere il modello](#scegliere-il-modello)
4. [Scegliere la GPU](#scegliere-la-gpu)
5. [Avviare il Pod](#avviare-il-pod)
6. [Usare i client](#usare-i-client)
7. [Monitorare e ottimizzare](#monitorare-e-ottimizzare)
8. [Spegnere e costi](#spegnere-e-costi)
9. [Interfaccia web](#interfaccia-web)
10. [Docker](#docker)
11. [Modalità Claude Code managed](#modalità-claude-code-managed)
12. [Consulente IA esterno](#consulente-ia-esterno)
13. [Risoluzione dei problemi](#risoluzione-dei-problemi)
14. [Domande frequenti](#domande-frequenti)
15. [Appendice: aggiornare un set di modelli](#appendice-aggiornare-un-set-di-modelli)

---

## Installazione e chiavi

### Requisiti

- **Node.js ≥ 20** e **Git**;
- un account [Runpod](https://www.runpod.io) con credito;
- un account Hugging Face solo se vuoi usare modelli *gated* (con accesso su richiesta);
- **Docker** facoltativo (Open WebUI o installazione con Docker, vedi [Docker](#docker));
- Python 3 solo per i test del supervisore (`npm test`).

### Installazione

```bash
git clone https://github.com/deduzzo/runpod-helper.git
cd runpod-helper
npm ci                # dipendenze esatte del lockfile; attiva anche l'hook anti-segreti
npm run build:web     # interfaccia web (llmpod ui)
npm link              # comandi globali "llmpod" e "llmpod-mcp"
```

Per aggiornare: `git pull && npm ci && npm run build:web` nella cartella del progetto.

### Configurazione guidata

```bash
llmpod init
```

`init` chiede, nell'ordine:

1. la **chiave API di Runpod** (input nascosto) e la verifica elencando i Pod;
2. il **token Hugging Face**, facoltativo (invio per saltarlo), verificato se lo inserisci;
3. il **datacenter preferito**, da una tabella dei datacenter con network volume ordinata per numero di GPU
   disponibili (oppure `--datacenter <id>`, es. `EU-RO-1`);
4. il **network volume** per i pesi: se nel datacenter ne esiste già uno ti propone di riusarlo, altrimenti ne
   chiede la dimensione (suggerimento: circa il doppio dei pesi dei modelli che userai, 150 GB per un ~30B, 500+
   per un 200B+) e ti mostra il **costo mensile** prima di crearlo (`--volume-size <gb>` per non chiederlo);
5. se vuoi, il [consulente IA esterno](#consulente-ia-esterno).

**Senza volume.** Se rifiuti la creazione del volume, `init` salva comunque la configurazione senza volume e lo
segnala con un avviso ("i pesi saranno scaricati a ogni avvio"). Con `llmpod init --no-volume` configuri il
datacenter senza creare né riusare un volume e senza domande sul costo. Se avevi già configurato un volume nello
stesso datacenter, llmpod smette di usarlo ma **il volume resta su Runpod e continua a costare**: l'avviso lo
ricorda, e puoi eliminarlo dalla console di Runpod. Puoi rilanciare `llmpod init` in qualsiasi momento (anche per
creare il volume più tardi): le chiavi già presenti si possono mantenere.

### Chiave Runpod

Creala su https://www.runpod.io/console/user/settings:

- chiave *Restricted* con **Pods**, **Network Volumes** e **Templates** in *Read/Write*; oppure
- chiave con accesso completo (*All*).

llmpod usa l'API REST di Runpod (Pod, volumi, catalogo GPU e datacenter) e l'API GraphQL per leggere il **credito
residuo**, che `llmpod up` controlla prima di creare un Pod. `init` verifica la chiave solo tramite REST: se poi
`llmpod status` mostra "Credito residuo: non disponibile" o `llmpod up` si ferma sulla lettura del credito, la
chiave *Restricted* non consente la lettura via GraphQL e serve una chiave con accesso completo.

### Token Hugging Face

Facoltativo: serve solo per i modelli *gated*. Basta un token *Read* (https://huggingface.co/settings/tokens) e
devi aver richiesto l'accesso al modello sulla sua pagina.

### Dove stanno chiavi e configurazione

Tutto è nella cartella `~/.config/llmpod/` (cambiabile con `LLMPOD_CONFIG_DIR`):

| File | Contenuto |
|---|---|
| `.env` | chiave Runpod, token Hugging Face, chiave del consulente, chiave vLLM di ogni profilo (`LLMPOD_KEY_<PROFILO>`), chiave del proxy di Open WebUI |
| `config.json` | datacenter preferito, network volume, consulente, limiti di spegnimento predefiniti |
| `profiles/<nome>.json` | i profili salvati |
| `last-plan.json` | l'ultimo piano calcolato (quello che `save` salva) |
| `state.json` | i Pod avviati da questo computer |

Il file `.env` ha permessi `600` (solo il tuo utente può leggerlo): se sono più larghi llmpod si ferma con
`CONFIG_PERMISSIONS`. Le chiavi non vengono mai stampate, tranne con `llmpod env` quando lo chiedi tu.
**Non condividere `.env`, non copiarlo in un repository e non incollarne il contenuto in chat o nelle issue.**

### Configurare senza terminale interattivo

`llmpod init` e `llmpod advisor` fanno domande e chiedono le chiavi con input nascosto. Senza un terminale (script,
CI, il prefisso `!` di Claude Code, un comando lanciato con `</dev/null`) le domande non hanno risposta: llmpod si
ferma con un errore che indica **quale opzione usare al posto della domanda**, invece di annullare in silenzio.

**Le chiavi non si passano mai come argomento** (`--api-key …` viene rifiutata): finirebbero nella cronologia della
shell e nell'elenco dei processi. Si passano dallo **standard input** (la prima riga, spazi esclusi), da una pipe.

Consulente, con tutte le informazioni nelle opzioni (nessuna domanda):

```bash
# macOS: la chiave è negli appunti
pbpaste | llmpod advisor --preset zai-coding-plan --api-key-stdin --accept-zai-notice

# qualsiasi shell: la chiave si digita senza eco e non resta nella cronologia
read -rs K && printf '%s' "$K" | llmpod advisor --preset zai-coding-plan --api-key-stdin --accept-zai-notice; unset K

# da un file leggibile solo da te (chmod 600)
llmpod advisor --preset anthropic --model <modello> --api-key-stdin < ~/chiave-consulente.txt

# endpoint personalizzato
pbpaste | llmpod advisor --preset custom --protocol openai --base-url https://host/v1 --model <modello> --auth bearer --api-key-stdin
```

- `--api-key-stdin` richiede `--preset` e **non fa domande**: modello, URL, protocollo e autenticazione (preset
  `custom`) arrivano da `--model`, `--base-url`, `--protocol` (`anthropic` o `openai`) e `--auth` (`bearer` o
  `x-api-key`).
- Il preset `zai-coding-plan` mostra un avviso sulle condizioni del Coding Plan. Senza terminale va confermato con
  `--accept-zai-notice`, che registra la presa visione (una sola volta); senza il flag llmpod si ferma e lo spiega.
  Leggi l'avviso prima di aggiungere il flag: stampa il testo a ogni esecuzione.
- La chiave non viene mai stampata né inclusa nei messaggi d'errore.

Credenziali di `init`:

```bash
pbpaste | llmpod init --runpod-key-stdin --datacenter EU-RO-1 --no-volume
pbpaste | llmpod init --hf-token-stdin --datacenter EU-RO-1 --no-volume   # richiede la chiave Runpod già salvata
```

- `--runpod-key-stdin` e `--hf-token-stdin` sono **mutuamente esclusivi** perché lo standard input è uno solo. Se ti
  servono entrambi, lancia `init` **due volte** (prima con `--runpod-key-stdin`, poi con `--hf-token-stdin`) oppure
  usa le variabili d'ambiente.
- `--from-env` legge `RUNPOD_API_KEY` e `HF_TOKEN` dall'**ambiente del processo**, ma solo se lo chiedi con questo
  flag (mai di default): `RUNPOD_API_KEY=… HF_TOKEN=… llmpod init --from-env …`. Imposta le variabili in modo che
  non finiscano nella cronologia (per esempio `read -rs RUNPOD_API_KEY; export RUNPOD_API_KEY`).
- Con uno di questi flag le domande sulle credenziali non vengono fatte: una chiave già salvata resta quella,
  a meno che tu non ne fornisca una nuova.
- Anche le altre domande di `init` hanno la loro opzione quando manca il terminale: `--datacenter <id>`,
  `--volume-size <gb>`, `--no-volume`, `--yes` (conferma il costo del volume e riusa un volume esistente).

**Con il prefisso `!` di Claude Code** il comando gira senza terminale: passa la chiave via stdin **da un file o dagli
appunti** (per esempio `! pbpaste | llmpod advisor --preset zai-coding-plan --api-key-stdin --accept-zai-notice`),
**mai scrivendola nel prompt o nel comando**: quello che digiti nella conversazione è visibile al modello e resta
nella cronologia.

---

## Concetti

**Profilo.** Un file JSON (`profiles/<nome>.json`) con tutto ciò che serve per ricreare lo stesso Pod: modello e
revisione, contesto, GPU scelta e alternative compatibili, datacenter e volume, immagine e argomenti di vLLM,
limiti di spegnimento (`watchdog`). Il nome usa lettere minuscole, numeri e trattini (es. `qwen3-coder`). Il Pod
su Runpod si chiama `llmpod-<profilo>`.

**Piano.** Il risultato di `llmpod plan`: stima della memoria, elenco delle GPU che la contengono con prezzo e
disponibilità, argomenti di `vllm serve`, avvisi. `llmpod save <nome>` lo trasforma in profilo.

**Pod.** La macchina GPU su Runpod (Secure Cloud) che esegue l'immagine ufficiale `vllm/vllm-openai` con
versione fissata (mai `latest`). Si paga a ore finché esiste. llmpod **elimina** sempre i Pod, non li ferma mai:
un Pod fermo (stato `EXITED`) continua a costare lo spazio su disco.

**Network volume.** Un disco di rete nel datacenter preferito che conserva i pesi tra un avvio e l'altro: si
paga al mese anche senza Pod, ma evita di riscaricare decine di GB a ogni avvio. Un Pod creato in un altro
datacenter è "senza volume" e scarica i pesi sul proprio disco.

**Supervisore e watchdog.** Nel Pod llmpod inietta uno script Python (supervisore) che avvia vLLM, ne legge le
metriche ogni 60 secondi, conserva i log e risponde su una porta separata (8001). Il **watchdog** del supervisore
**elimina il Pod** dopo N minuti senza richieste (predefinito 30) o comunque dopo un numero massimo di ore
dall'avvio (predefinito 8), anche se il tuo computer è spento. Per farlo usa la chiave che Runpod inietta nel Pod,
verificata: può leggere ed eliminare solo quel Pod. Nessuna tua chiave entra nel Pod.

**Proxy.** Il Pod espone vLLM (porta 8000) e il supervisore tramite il proxy HTTPS di Runpod
(`https://<id-del-pod>-8000.proxy.runpod.net`). Ogni profilo ha una chiave vLLM propria: senza quella le API non
rispondono. Le metriche Prometheus di vLLM (`/metrics`) sono raggiungibili senza chiave, ma contengono solo
contatori, non i contenuti delle richieste. Il proxy di Runpod interrompe le richieste **non in streaming** oltre
i 100 secondi; quelle in streaming (Claude Code, OpenCode, pi) arrivano complete.

Sul tuo computer, `llmpod ui` avvia anche un piccolo proxy locale (porta 8081) che inoltra Open WebUI al Pod
del profilo scelto, così Open WebUI non deve conoscere la chiave del Pod.

**MTP e DSpark (decodifica speculativa).** Alcuni modelli hanno nei pesi un *draft head* che propone più token
alla volta, poi verificati dal modello principale: a parità di qualità si generano più token al secondo. llmpod
riconosce **MTP** (tensori `mtp.*` o strato nextn) e **DSpark** (DeepSeek-V4-Flash-0731 e V4.1) e aggiunge da solo
`--speculative-config` con il metodo giusto; il piano lo mostra nella riga `MTP:` (o `Draft:`), con circa 1 GiB di
VRAM riservata. Per disattivarlo: `llmpod plan … --set speculative-config=false`.

**Contesto e KV cache.** Il contesto (`--max-model-len`) è il numero massimo di token di una richiesta (prompt più
risposta). Per ogni token vLLM tiene in memoria la **KV cache**: la memoria necessaria cresce con contesto ×
richieste in parallelo (`--concurrency` del piano, predefinito 2). La stima del piano è *pesi + KV cache +
margine*. Per le architetture ibride (es. Qwen3.5: attenzione lineare + completa) conta solo gli strati ad
attenzione completa. La KV in **FP8** (`--kv-cache-dtype fp8`) occupa circa la metà: il piano la usa da solo se
in BF16 il modello non entra in nessuna GPU disponibile, e la segnala con un avviso.

---

## Scegliere il modello

### Set consigliati

llmpod propone set di modelli già verificati (`data/model-sets.json`): formato caricabile da vLLM, architettura
supportata, tool parser noto, revisione fissata e contesto consigliato.

```bash
llmpod search --sets                       # elenco dei set
llmpod search --set abliterated            # modelli del set: id breve, variante, formato, pesi, MTP/DSpark, contesto
llmpod search glm --set abliterated        # il testo filtra dentro il set
llmpod plan abliterated/qwen3.8-27b-gptq   # per id breve (stabile): revisione verificata e contesto consigliato
llmpod plan abliterated/1                  # per posizione nell'elenco (comoda, ma cambia se il set viene riordinato)
llmpod plan abliterated/1 --context 65536  # contesto diverso da quello consigliato
```

Il primo set è **`abliterated`**: modelli senza rifiuti (abliterated, heretic, uncensored), molto capaci e adatti
ai client di coding agentici: Qwen3.8-27B (GPTQ e BF16), Qwen3.6-35B-A3B, gpt-oss-120b, MiniMax-M2.7,
Qwen3.8-Flash-Next, DeepSeek-V4-Flash e V4.1-Flash, GLM-5.3-Flash e GLM-5.3.

> ⚠ **Avviso.** Sono modelli con salvaguardie ridotte o rimosse: possono produrre contenuti dannosi o
> inappropriati. Usali in modo responsabile, nel rispetto della legge e delle licenze, e non esporli a utenti non
> consapevoli. llmpod mostra questo avviso anche in `search --set` e nel piano.

Attenzione ai due `--set`: in `llmpod search --set <id>` indica **il set di modelli**; in
`llmpod plan --set chiave=valore` e `llmpod tune --set chiave=valore` imposta **un argomento di vLLM**
(es. `--set kv-cache-dtype=fp8`).

### Ricerca globale su Hugging Face

```bash
llmpod search qwen3 coder                  # modelli text-generation con chat template (esclusi MLX e repository solo GGUF)
llmpod search qwen3 coder --limit 40       # più risultati (predefinito 20)
llmpod search qwen3 coder --all            # include anche i modelli senza chat template, MLX e solo GGUF
llmpod plan Qwen/Qwen3-Coder-30B-A3B-Instruct --context 65536
llmpod plan Qwen/Qwen3-Coder-30B-A3B-Instruct@<revisione>   # revisione precisa (anche un URL di Hugging Face)
```

La colonna MTP segnala le varianti con draft head (quando tag o nome lo dichiarano) e, a parità di modello base,
le mette prima. **Preferisci le varianti con MTP o DSpark**: generano più token al secondo.

### Formati supportati e non

| Formato | Supportato | Note |
|---|---|---|
| safetensors BF16 / FP16 | sì | pesi pieni |
| FP8, AWQ, GPTQ, compressed-tensors | sì | quantizzazioni caricate nativamente da vLLM |
| NVFP4 | sì | il piano avvisa se la GPU scelta non è Blackwell |
| MXFP4 (gpt-oss) | sì | formato nativo di gpt-oss |
| **GGUF** (llama.cpp) | **no** | `plan` rifiuta il repository e indica il modello base, quando la model card lo dichiara |
| **MLX** (Apple Silicon) | **no** | escluso dalla ricerca e rifiutato da `plan` |
| pesi in sottocartelle | no | i file `.safetensors` devono stare nella radice del repository |

Altre opzioni di `plan`: `--concurrency <n>` (richieste in parallelo previste, predefinito 2), `--extra-arg <arg>`
(argomento di vLLM aggiuntivo), `--image <immagine>` (immagine vLLM diversa da quella predefinita),
`--allow-trust-remote-code` (consente `--trust-remote-code`, solo se ti fidi del codice del repository),
`--no-nccl-safe` (sui Pod con più GPU senza NVLink completo non usa la modalità NCCL sicura, sconsigliato: vedi
[Scegliere la GPU](#scegliere-la-gpu)), `--json`.

---

## Scegliere la GPU

`llmpod plan` elenca **tutte** le configurazioni (GPU singola o multi-GPU) in cui il modello entra, dalla più
economica, con VRAM, margine, prezzo orario e disponibilità: nel datacenter del volume e altrove (quelle non
disponibili da nessuna parte sono marcate "non disponibile ora").

- In un terminale interattivo `plan` chiede **"Quale GPU usare?"** (predefinita: la più economica disponibile).
- `--gpu "NVIDIA A100 80GB PCIe"` o `--gpu "NVIDIA A100 80GB PCIe x2"` la imposta senza domanda.
- `--yes` o `--json` non chiedono nulla.

**Più GPU senza NVLink.** Le configurazioni multi-GPU su schede PCIe (RTX/GeForce, RTX PRO 6000 "Server/Workstation
Edition", RTX A-series, L4/L40/L40S, A10/A16/A40, A100/H100 PCIe) comunicano attraverso il bus PCIe; in molte
macchine virtuali il trasporto diretto P2P di NCCL (e l'all-reduce personalizzato di vLLM) fallisce con
`NCCL error: unhandled cuda error` o si blocca. Per queste llmpod avvia il Pod in **modalità NCCL sicura** e il
piano mostra un avviso `NCCL:`:

| Variabile / argomento | Perché |
|---|---|
| `NCCL_P2P_DISABLE=1` (PCIe pure) oppure `NCCL_P2P_LEVEL=NVL` (H100/H200 NVL, NVLink solo a coppie) | niente P2P diretto sul bus PCIe: NCCL passa per la memoria dell'host (un po' più lento, ma stabile) |
| `NCCL_CUMEM_HOST_ENABLE=0` | rimedio indicato da vLLM per `transport/shm.cc … Cuda failure 217` con la memoria condivisa |
| `VLLM_ALLREDUCE_USE_SYMM_MEM=0`, `--disable-custom-all-reduce` | niente all-reduce di vLLM basati su accesso diretto tra GPU |
| `NCCL_DEBUG=WARN` | gli avvisi di NCCL finiscono nei log, così la causa di un errore si vede |

NVLink completo si presume solo per le GPU SXM/HGX (H100/H200/B200/B300, A100 SXM, GB200/GB300), che non ne
hanno bisogno. `NCCL_IB_DISABLE` non si imposta: InfiniBand serve solo tra nodi diversi e un Pod è un nodo solo.
L'argomento `--disable-custom-all-reduce` si aggiunge a ogni avvio secondo la GPU scelta e non si salva nel
profilo. Se vuoi provare senza (ad esempio per misurare la differenza), crea il piano con
`llmpod plan … --no-nccl-safe`: il profilo salvato avrà `ncclSafe: false`. Con un modello grande, a parità di prezzo, **una sola GPU più grande** è
di solito la scelta più semplice e veloce da avviare.

Il profilo salvato conserva tutte le configurazioni compatibili. Al momento dell'avvio `llmpod up` rilegge il
catalogo e ti propone quelle **disponibili ora**, per costo, comprese quelle di altri datacenter, etichettate
**"senza volume, <datacenter>"** (i pesi si scaricano a ogni avvio, quindi l'avvio è più lento). La scelta
predefinita è la GPU del profilo nel datacenter del volume, se disponibile, altrimenti la più economica.

- Se resta una sola opzione la usa direttamente (la conferma del costo mostra quale).
- Se non ce n'è nessuna si ferma con `NO_GPU_AVAILABLE`.
- Dopo la tua scelta usa solo quella, senza ripieghi silenziosi su altre GPU.
- Con `--yes` non c'è domanda: vale la GPU del profilo con le sue alternative; se nel datacenter del volume non
  c'è disponibilità, il ripiego su altri datacenter segue l'impostazione `allowFallbackWithoutVolume` del profilo
  (`ask`, predefinita, `always` o `never`).

Prezzi indicativi (listino Runpod Secure Cloud letto dall'API l'11/10/2026; `plan` e `up` mostrano sempre quelli
correnti):

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

Esempi: Qwen3-Coder-30B-A3B con 64K di contesto entra in una A100 80GB; Qwen3.8-27B GPTQ del set `abliterated`
entra in una GPU da 48 GB, la variante BF16 richiede 80 GB.

---

## Avviare il Pod

### Il percorso completo

```bash
llmpod search --set abliterated
llmpod plan abliterated/qwen3.8-27b-gptq   # scegli la GPU
llmpod save prova                          # profilo "prova" + chiave vLLM del profilo (non mostrata)
llmpod up prova
```

`llmpod up` esegue, nell'ordine:

1. **controlli preliminari**: se il profilo ha già un Pod acceso si ferma (`llmpod down prova` per eliminarlo);
   se ha un **Pod spento** chiede di eliminarlo prima di crearne uno nuovo (predefinito sì; se rifiuti, `up` si
   ferma senza creare nulla); per i modelli *gated* verifica l'accesso; legge il credito;
2. **scelta della GPU** tra quelle disponibili ora (vedi [Scegliere la GPU](#scegliere-la-gpu));
3. **conferma del costo**: costo orario (e per 24 ore), **stima del tempo e del costo dell'avvio** (vedi
   [Stimare i costi](#stimare-i-costi)), la modalità NCCL sicura se il Pod ha più GPU senza NVLink completo e, se il profilo
   esce dai limiti predefiniti, "inattività: mai (o N min), massimo N h → costo massimo X $". Si ferma se il
   credito è inferiore a un'ora di utilizzo;
4. **creazione del Pod**, attesa dell'avvio, **download e caricamento dei pesi** (con `--verbose` vedi i log di
   vLLM in diretta). L'avanzamento distingue le due parti: *"Download dei pesi: 45% (57 di 126 GiB)"* (i byte del
   modello nella cache di Hugging Face; non dice mai 100% finché il download è in corso) e poi *"Caricamento dei
   pesi: 147/206 file, circa 7 min rimanenti"* (la barra di vLLM). Se vLLM non è pronto entro il tempo previsto
   chiede se aspettare altri 15 minuti;
5. **smoke test**: `/v1/models`, una chiamata a strumento su `/v1/messages` (protocollo Anthropic) e una su
   `/v1/chat/completions` (protocollo OpenAI).

Alla fine stampa endpoint, costo orario, tempo di avvio e i comandi per i client. Se la KV cache consente un
contesto molto più grande di quello del profilo, lo suggerisce ("puoi rigenerare il profilo con --context N").

`llmpod up prova --dry-run` mostra la richiesta che verrebbe inviata a Runpod senza creare nulla; `--yes` salta
le conferme.

### Se qualcosa va storto

- **Errore di avvio o smoke test fallito** (`OOM`, `VLLM_ERROR`, `SMOKE_TEST_FAILED`): se hai configurato il
  [consulente](#consulente-ia-esterno), llmpod chiede se consultarlo, ricordandoti che **il Pod continua a
  costare**. Il consulente legge errore, ultime righe dei log e argomenti attuali e propone una correzione; ti
  mostra le modifiche e, solo se confermi, riavvia vLLM sul Pod con i nuovi argomenti (fino a 3 tentativi). Se
  l'avvio riesce, ti chiede se salvare nel profilo gli argomenti corretti.
- **Avvio fallito senza riparazione**: llmpod chiede "Terminare il Pod … per non continuare a pagare?"
  (predefinito sì). Se l'eliminazione non riesce, l'errore lo dice chiaramente: controlla
  https://www.runpod.io/console/pods.
- **Ctrl+C durante `up`**: llmpod chiede se eliminare il Pod appena creato. Se lo lasci acceso, ricordati
  `llmpod down <profilo>`.
- Codici e rimedi più comuni: [Risoluzione dei problemi](#risoluzione-dei-problemi).

---

## Usare i client

```bash
llmpod run claude --profile prova      # Claude Code (anche: llmpod claude --profile prova)
llmpod run opencode --profile prova    # OpenCode
llmpod run pi --profile prova          # pi
llmpod run zcode --profile prova       # ZCode: scrive la configurazione (su macOS apre l'app; --no-open per non aprirla)
```

Senza `--profile` llmpod usa il profilo con l'unico Pod avviato o l'unico profilo esistente; altrimenti chiede di
indicarlo. Il client parte **nella cartella da cui lanci il comando**.

| Client | Protocollo | Cosa fa llmpod |
|---|---|---|
| Claude Code | Anthropic `/v1/messages` | avvia `claude` con `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` e i modelli impostati sul modello del Pod |
| OpenCode | OpenAI Chat Completions | scrive `~/.config/llmpod/clients/opencode.json` (provider `openai-compatible`) e avvia `opencode` |
| pi | OpenAI Chat Completions | aggiunge il provider in `~/.pi/agent/models.json` (chiave letta da variabile d'ambiente) e avvia `pi` |
| ZCode | OpenAI Chat Completions | aggiunge il provider "llmpod (Runpod)" in `~/.zcode/v2/config.json`, **ad app chiusa** |

Le cartelle di pi e ZCode si cambiano con `PI_CODING_AGENT_DIR` e `ZCODE_DIR`.

**Margine di contesto.** A OpenCode, pi e ZCode llmpod dichiara un contesto un po' **più piccolo** di
`--max-model-len`: il 3% in meno, con un margine tra 1.024 e 8.192 token (es. 131.072 → 127.140). La stima dei
token del client può differire di qualche token da quella di vLLM; senza margine una richiesta al limite verrebbe
rifiutata con un errore 400. A Claude Code llmpod passa il numero massimo di token in uscita.

### Altri client: `llmpod env`

```bash
llmpod env --profile prova               # export per sh/zsh
llmpod env --profile prova --format ps1  # PowerShell
llmpod env --profile prova --format json
```

Stampa le variabili per Claude Code (`ANTHROPIC_*`) e per i client OpenAI (`OPENAI_BASE_URL`, `OPENAI_API_KEY`,
`LLMPOD_MODEL`, `LLMPOD_API_KEY`). **L'output contiene la chiave del profilo**: non incollarlo in chat, issue o
file versionati.

### Prova veloce con Open WebUI

- **Con Docker**: Open WebUI parte con `scripts/start` ed è già collegato al Pod attivo tramite il proxy interno;
  `bin/llmpod chat` apre la pagina.
- **Senza Docker**: avvia `llmpod ui` (che avvia anche il proxy su `127.0.0.1:8081`) e un tuo Open WebUI puntato
  su `http://127.0.0.1:8081/v1`, con la chiave `LLMPOD_OPENWEBUI_KEY` che `llmpod ui` genera nel file `.env`. Poi
  `llmpod chat` (o la scheda "Prova veloce" dell'interfaccia) apre Open WebUI. L'indirizzo predefinito è
  `http://127.0.0.1:3000`, cambiabile con `LLMPOD_OPENWEBUI_URL`.

Il Pod a cui Open WebUI parla è quello del profilo scelto nella scheda "Prova veloce".

---

## Monitorare e ottimizzare

### Stato e costi

```bash
llmpod status          # Pod llmpod: avviati, in avvio, spenti, in eliminazione; costi, credito, volume
llmpod status --all    # anche gli altri Pod dell'account Runpod (non creati da llmpod), in sola lettura
llmpod status --json
```

Per ogni Pod: profilo, ID, stato, GPU, costo orario, uptime, costo della sessione e colonna **Spegnimento** con i
limiti correnti letti dal Pod (es. "inattivo da 4 min 10 s su 30 min 0 s; massimo tra 7 h 20 min"). In fondo: credito
residuo e costo mensile del volume. Segnala i **Pod spenti** (costano ancora il disco) e i **Pod "orfani"** (vedi
[Risoluzione dei problemi](#risoluzione-dei-problemi)). A fine lavoro usa `status --all` per vedere davvero tutto.

### Metriche di vLLM

```bash
llmpod metrics prova               # due letture di /metrics a 10 s di distanza
llmpod metrics prova --window 30   # finestra più lunga (1–300 s)
llmpod metrics prova --json
```

| Riga | Come leggerla |
|---|---|
| Generazione / prompt (token/s) | tassi nella finestra; senza richieste in corso sono 0: misura durante l'uso reale |
| Richieste | in corso, in coda, completate: una coda stabilmente > 0 vuol dire concorrenza satura |
| KV cache | uso della KV cache sul totale di token: oltre ~90% con coda o preemption = KV piena |
| MTP / DSpark | percentuale di token proposti accettati, token medi per passo e accettazione per posizione |
| Errori | richieste interrotte, preemption, HTTP 4xx/5xx (5xx nella finestra = problema attuale: guarda i log) |

Leggere `/metrics` non conta come attività: non impedisce lo spegnimento per inattività.

### Log

```bash
llmpod logs prova                  # log di vLLM dal supervisore, chiavi mascherate
llmpod logs prova --follow         # continua a mostrare le nuove righe (Ctrl+C per uscire)
llmpod logs prova --since 120      # solo le righe dopo il cursore 120 (il JSON restituisce il cursore)
```

### Tuning: `llmpod tune`

`tune` cambia gli argomenti di vLLM **sul Pod già avviato** e lo ricarica: il Pod resta (e continua a costare),
vLLM si interrompe per qualche minuto. Parte dagli argomenti attivi sul Pod, solo con vLLM pronto.

```bash
llmpod tune prova --set max-num-seqs=4 --dry-run   # diff e stima di memoria, nessuna modifica
llmpod tune prova --set kv-cache-dtype=fp8         # conferma, ricarica, smoke test
llmpod tune prova --set kv-cache-dtype=fp8 --save  # come sopra e aggiorna il profilo per i prossimi avvii
llmpod tune prova --set speculative-config=false   # valore false = rimuove l'argomento
```

**Esempio: contesto di 256K con KV in FP8.** Qwen3.8-27B GPTQ del set `abliterated` parte con il contesto
consigliato di 128K (131.072 token) su un massimo di 262.144. Per arrivare a 256K dimezzando la memoria della KV:

```bash
llmpod tune prova --set kv-cache-dtype=fp8 --set max-model-len=262144 --dry-run   # entra nella GPU del Pod?
llmpod tune prova --set kv-cache-dtype=fp8 --set max-model-len=262144 --save      # applica e salva nel profilo
llmpod run pi --profile prova     # rilancia i client: ricevono il nuovo contesto (con il margine)
```

La stima dice "servono circa X GiB su Y GiB utilizzabili" per la GPU del Pod: se non entra, `tune` rifiuta la
modifica prima di toccare vLLM. Con `--save` si aggiornano argomenti e contesto del profilo, quindi anche il
contesto dichiarato ai client.

Regole di `tune`:

- non cambia mai revisione, numero di GPU (`tensor-parallel-size`), chiave, host, porta o nome servito;
- vuole i nomi completi dei flag: normalizza `--max_model_len=…` in `--max-model-len …`, ma rifiuta le forme
  brevi (`-tp`), le abbreviazioni, i flag sconosciuti a vLLM v0.30.0 e i duplicati;
- `--max-model-len` va da 1.024 al contesto massimo del modello; `--gpu-memory-utilization` fino a 0,98;
- dopo la ricarica esegue lo smoke test; se fallisce propone di tornare agli argomenti precedenti (con `--yes` ci
  torna da solo) e, se vLLM non riparte, il passo successivo è `llmpod down`.

| Sintomo | Intervento |
|---|---|
| KV cache piena (oltre 90%, coda, preemption) | `--set kv-cache-dtype=fp8`, oppure `max-num-seqs` più basso, oppure `max-model-len` più basso |
| Accettazione MTP/DSpark bassa (es. < 50%) | meno token speculativi in `speculative-config` (es. da 3 a 1 o 2) |
| Accettazione alta su tutte le posizioni | prova più token speculativi e confronta i token/s |
| OOM all'avvio o alla ricarica | `--set gpu-memory-utilization=0.85` o contesto ridotto; altrimenti un nuovo piano con una GPU più grande |
| Contesto insufficiente per i client | `max-model-len` più alto, se entra, con `--save` |
| Chiamate a strumento non riconosciute | `--set tool-call-parser=<nome>` secondo la recipe del modello |

Un cambiamento alla volta, poi `llmpod metrics` per confrontare. Punto di partenza consigliato: le recipe
ufficiali di vLLM (https://docs.vllm.ai/projects/recipes/en/latest/).

### Tenere acceso un Pod: `llmpod keep`

Per un lavoro lungo puoi cambiare i limiti di spegnimento di un Pod **già avviato**, senza riavviarlo:

```bash
llmpod keep prova --max-hours 24          # durata massima: 24 ore dall'avvio del Pod
llmpod keep prova --no-idle               # mai spegnere per inattività (resta il limite di ore)
llmpod keep prova --idle-minutes 120      # spegni dopo 2 ore senza richieste
llmpod keep prova --max-hours 24 --save   # aggiorna anche il profilo, per i prossimi avvii
```

- `--idle-minutes`: intero tra 5 e 1440, oppure **0 = mai** (`--no-idle` equivale a 0). `--max-hours`: da 0,25 a
  168 (anche con la virgola). Gli stessi valori valgono nella sezione `watchdog` dei profili (`idleMinutes`,
  `maxHours`).
- Le ore massime si contano **sempre dall'avvio del Pod**; cambiando l'inattività il conteggio riparte da adesso.
- Il comando mostra i nuovi limiti, quando il Pod si spegnerà e il **costo massimo** fino a quel momento, e chiede
  conferma ogni volta che la spesa possibile aumenta (`--yes` per saltarla). Con `--save`, inattività 0 o più di
  8 ore massime richiedono una conferma esplicita.
- `keep` non accorcia il massimo fino a eliminare il Pod: ore massime inferiori al tempo trascorso più 5 minuti
  vengono rifiutate (per spegnere usa `llmpod down`).
- I Pod avviati con versioni vecchie di llmpod hanno un supervisore senza questa funzione: `keep` lo rileva e ti
  dice di eliminare e riavviare il Pod.
- Nell'interfaccia web è il pulsante **Prolunga** della pagina "Stato e costi".

---

## Spegnere e costi

### Spegnere: `llmpod down`

```bash
llmpod down prova            # chiede conferma ed elimina il Pod (acceso o spento)
llmpod down prova --dry-run  # mostra cosa eliminerebbe
llmpod status --all          # verifica: niente Pod rimasti
```

- `down` **elimina** sempre il Pod, non lo ferma: un Pod fermo (`EXITED`) costa ancora lo spazio su disco. Elimina
  tutti i Pod del profilo, anche quelli spenti. Il network volume con i pesi resta.
- Dopo l'eliminazione, per qualche minuto l'elenco di Runpod può ancora mostrare il Pod come acceso: llmpod lo
  indica come **"in eliminazione"**.
- Se un Pod risulta spento (per esempio fermato dalla console di Runpod), `status` lo segnala con un avviso e
  `down` lo elimina; `up` chiede di eliminarlo prima di crearne uno nuovo.
- Senza `down` il Pod si elimina comunque da solo quando scatta il watchdog (inattività o ore massime).

### Volume

Il network volume costa circa **0,07 $/GB al mese**, anche senza Pod (150 GB ≈ 10,50 $/mese). Se non ti serve
più:

```bash
llmpod destroy-volume --dry-run   # cosa eliminerebbe
llmpod destroy-volume             # conferma + digitazione del nome del volume; i pesi vanno persi
```

`destroy-volume` si rifiuta se esistono ancora Pod llmpod (accesi o spenti): eliminali prima con `llmpod down`.

### Stimare i costi

- **Una sessione**: prezzo orario × ore di uso, più il tempo di avvio (download e caricamento dei pesi) e fino a
  30 minuti di inattività prima dello spegnimento automatico. Esempio: A100 80GB a 1,79 $/h per 3 ore di lavoro
  più 30 minuti ≈ 6,27 $.
- **Il caso peggiore** di un avvio è prezzo orario × ore massime del watchdog: con 8 ore su A100, circa 14,32 $.
  `llmpod up` e `llmpod keep` lo mostrano quando i limiti escono da quelli predefiniti; in modalità managed è il
  "costo massimo" dell'anteprima.
- **L'avvio si paga**: il Pod costa da quando esiste, anche mentre scarica e carica i pesi. Per i modelli grandi
  non è poco: nel collaudo del 12/10/2026 un modello da 126 GiB su 2× RTX PRO 6000 (PCIe) ha impiegato circa
  **20–25 minuti solo per leggere i pesi in GPU** (~7 s per ognuno dei 206 file da ~0,6 GiB), oltre al download.
  La conferma di `llmpod up` (e `up_preview` in modalità managed) mostra la stima: *"avvio stimato ~52 min
  (download ~23, caricamento dei pesi ~25) ≈ 3,12 $ prima che il modello sia pronto"*. La stima è prudente:
  5 minuti fissi; download a ~100 MB/s, saltato se la stessa revisione è già sul volume (llmpod lo annota dopo un
  avvio riuscito con il volume); caricamento a ~2 s/GiB dal disco del Pod, ×4 dal volume di rete, ×1,5 con più GPU.
  Il fattore del volume è un'ipotesi ricavata dal collaudo (lettura a ~90 MB/s, tipica di uno storage di rete).
  `up` attende vLLM almeno 1,5 volte la stima prima di chiedere se aspettare ancora.
- **Fisso**: il volume, al mese.
- `llmpod status` mostra il costo della sessione in corso e il credito residuo.

---

## Interfaccia web

```bash
npm run build:web      # una volta (o dopo un aggiornamento)
llmpod ui              # apre il browser su http://127.0.0.1:7860 con il link che contiene il token
```

L'interfaccia è installabile come app dal browser (PWA) e usa le stesse conferme di costo della CLI.

| Pagina | Cosa contiene |
|---|---|
| **Modelli** | selettore **Ricerca**: "Tutti i modelli (Hugging Face)" o un set consigliato, mostrato come schede (formato, pesi, MTP o DSpark, contesto, parser, licenza, note, link a Hugging Face); **Calcola il piano**; tabella delle GPU selezionabile; **Salva come profilo** |
| **Profili** | profili salvati con **Avvia** e **Spegni**; durante l'avvio le domande (GPU, Pod spento da eliminare, riparazione) compaiono come scelte; senza risposta il job si annulla e non spende nulla |
| **Stato e costi** | Pod avviati, in avvio e spenti con costo, sessione, uptime e colonna Spegnimento; pulsanti **Prolunga** ed **Elimina**; credito e volume |
| **Client** | comandi per collegare i client; gli `export` con la chiave compaiono solo dopo **Mostra gli export** e non vengono memorizzati nel browser |
| **Prova veloce** | Open WebUI incorporato nella pagina, collegato al Pod del profilo scelto (oppure "Apri in una nuova scheda") |

Sicurezza e rete:

- l'interfaccia richiede il link con il token stampato da `llmpod ui` e accetta solo gli host `127.0.0.1` e
  `localhost` (anche `[::1]`): con un `--host` diverso non è utilizzabile da altri computer;
- opzioni: `--port` (predefinita 7860 o `LLMPOD_UI_PORT`), `--host`, `--proxy-port` (8081), `--proxy-host`,
  `--no-proxy`, `--no-open`;
- per gli indirizzi loopback, se apri l'interfaccia su `127.0.0.1` Open WebUI viene aperto su `localhost` (e
  viceversa): il cookie di sessione dell'interfaccia non viene così inviato a Open WebUI. Non aprire Open WebUI
  sullo stesso nome host dell'interfaccia.

---

## Docker

### Avvio e arresto

```bash
scripts/start.sh                 # macOS/Linux (su macOS anche doppio clic su scripts/start.command)
scripts/start.sh --no-openwebui  # senza Open WebUI
scripts/stop.sh                  # ferma i container (anche scripts/stop.command)
```

Su Windows: `scripts\start.bat` e `scripts\stop.bat` (doppio clic o da terminale; usano gli script PowerShell, per
Open WebUI escluso `scripts\start.ps1 -NoOpenWebUI`).

- Al primo avvio parte `llmpod init`, che richiede un **terminale interattivo**: se manca la chiave Runpod e lo
  script non è eseguito da un terminale, si ferma con un messaggio.
- Poi si apre l'interfaccia (`http://127.0.0.1:7860`, con il token nel link stampato; il link cambia a ogni
  avvio e compare anche in `bin/llmpod docker-logs`) e Open WebUI su `http://127.0.0.1:3000`. Al primo avvio Open WebUI
  può impiegare qualche minuto: lo script attende fino a 2 minuti e poi prosegue.
- **Crea subito l'account di Open WebUI**: il primo account diventa amministratore e la registrazione di altri è
  disattivata. Finché non esiste, chiunque raggiunga `127.0.0.1:3000` dal tuo computer potrebbe crearlo per primo.
- **`stop` ferma solo i container locali, non tocca i Pod su Runpod.** Se trova Pod accesi o spenti stampa un
  avviso con l'ID e il comando per eliminarli, ma non elimina nulla da solo.

### Il wrapper `bin/llmpod`

```bash
bin/llmpod status
bin/llmpod run claude          # anche: opencode, pi, zcode (anche: bin/llmpod claude)
bin/llmpod logs <profilo>      # log di vLLM del Pod, come llmpod logs (anche --follow)
bin/llmpod docker-logs         # log del container llmpod (bin/llmpod docker-logs open-webui per Open WebUI)
bin/llmpod chat                # apre Open WebUI sull'host (http://localhost:3000)
```

Il wrapper esegue i comandi nel container e avvia i client **sul tuo computer**, nella cartella da cui lo lanci.
Su Windows è `bin\llmpod` (cioè `bin\llmpod.cmd`, che lancia `llmpod.ps1` con `-ExecutionPolicy Bypass`, senza
cambiare la policy di PowerShell). `bin/llmpod ui` non serve: l'interfaccia la avvia `scripts/start`.

Con il wrapper `logs` è il comando della CLI (log di vLLM dal supervisore del Pod), mentre i log dei container
locali, utili per la diagnosi di `scripts/start`, si leggono con `docker-logs [servizio]` (predefinito `llmpod`).

### Configurazione e piattaforme

- Le chiavi restano in `~/.config/llmpod/.env` sull'host, montata nel container: l'immagine non contiene segreti.
- Variabili utili: `LLMPOD_CONFIG_DIR`, `ZCODE_DIR`, `PI_DIR` (o `PI_CODING_AGENT_DIR`, rispettata se impostata
  sull'host), `LLMPOD_UI_PORT`, `LLMPOD_OPENWEBUI_PORT` (predefinita 3000). Le porte sono pubblicate solo su
  `127.0.0.1`.
- Il container gira con l'UID/GID del tuo utente, così i file creati restano tuoi.
- **Windows**: i file montati appaiono con permessi 0777 e `chmod` non ha effetto; gli script impostano
  `LLMPOD_HOST_OS=windows` e llmpod salta il controllo dei permessi di `.env`, affidandosi ai permessi NTFS del
  profilo utente.
- **Linux con Docker rootless o Docker Desktop for Linux**: gli script lo rilevano e usano l'utente `0:0` nel
  container, che in quei casi corrisponde al tuo utente.
- **Podman o SELinux**: i volumi di `compose.yaml` possono richiedere il suffisso `:z`.
- Il preset `claude-cli` del consulente non è disponibile nel container.
- Prova dell'immagine senza credenziali reali: `sh scripts/docker-smoke.sh`.

---

## Modalità Claude Code managed

In questa modalità è **Claude Code** a fare da operatore di llmpod: lanciato nella cartella del progetto legge
`CLAUDE.md`, le skill e i permessi di `.claude/` e il server MCP di `.mcp.json`, e ti guida in italiano dalla
scelta del modello allo spegnimento.

```bash
llmpod manage                    # avvia "claude" nella cartella di llmpod
llmpod manage --profile prova    # parte dallo stato del profilo "prova"
# oppure
cd runpod-helper && claude
```

Al primo avvio Claude Code chiede di approvare il server MCP `llmpod` del progetto. `manage` controlla che ci
siano `CLAUDE.md`, `.claude/settings.json`, `.claude/skills` e `.mcp.json`.

### Cosa può fare

Strumenti MCP: `model_sets`, `search`, `plan`, `save_profile`, `profiles`, `status`, `up_preview` → `up`,
`job_status`, `job_events`, `job_answer`, `job_cancel`, `metrics`, `logs`, `tune_preview` → `tune`,
`keep_preview` → `keep`, `down`, `client_commands`. Skill: `/llmpod-avvia`, `/llmpod-stato`, `/llmpod-tune`,
`/llmpod-spegni`.

- propone il set consigliato o cerca modelli, calcola il piano e ti **mostra GPU e varianti con prezzo e
  disponibilità** (preferendo MTP/DSpark), poi salva il profilo con la GPU che scegli tu;
- avvia il Pod **in background** e ne segue l'avanzamento, mostrandoti le domande del core prima di rispondere;
- monitora con metriche e log e fa **tuning** partendo dalle recipe ufficiali di vLLM;
- prolunga (`keep`) o **elimina** i Pod (mai fermarli) e alla fine verifica l'elenco completo dei Pod.

### Permessi (`.claude/settings.json`)

- **allow** (senza domande): solo le operazioni di sola lettura (`status`, `metrics`, `logs`, `search`, `plan`,
  `model_sets`, `profiles`, `job_status`, `job_events`, `up_preview`, `tune_preview`, `keep_preview`,
  `client_commands` e i comandi CLI `status`, `metrics`, `logs`, `search`).
- **ask** (sempre conferma, anche se altrove hai consentito di più): gli strumenti `up`, `tune`, `keep`, `down`,
  `save_profile`, `job_answer`, `job_cancel` e i comandi `llmpod up|tune|keep|down|destroy-volume|rotate-key|save|
  init|advisor` e `logs --follow` (anche nella forma `node src/cli/index.js …`). In più gli strumenti che costano
  richiedono `confirm: true`; `up` vuole anche il prezzo orario visto nell'anteprima (se è cambiato si ferma con
  `PRICE_CHANGED`), `tune` gli argomenti attivi visti nell'anteprima.
- **deny**: leggere o modificare `~/.config/llmpod/.env` e i file `.env` del progetto, `cat`/`grep`/`head`/`tail`/
  `less`/`more` sui `.env`, `llmpod env`. `.env.example` resta leggibile. Le chiavi non compaiono mai nelle
  risposte del server MCP: i client si avviano con `llmpod run …`.
- Con una cartella di configurazione diversa (`LLMPOD_CONFIG_DIR`) aggiungi in `.claude/settings.local.json` (non
  versionato) una regola con il percorso assoluto, es. `"deny": ["Read(//percorso/llmpod/.env)",
  "Edit(//percorso/llmpod/.env)"]`.
- Le regole `Read`/`Edit` valgono per gli strumenti di Claude Code e per i comandi di file riconosciuti, non per un
  programma qualsiasi che apra il file da sé. Per un blocco a livello di sistema operativo attiva la **sandbox** di
  Claude Code (`/sandbox`).

**Sicurezza dei job**: se un avvio fallisce il server MCP elimina subito il Pod; mentre un Pod costa, le domande
pendenti scadono dopo 3 minuti con il valore sicuro; `job_cancel` su un `up` non ancora pronto lo annulla ed
elimina il Pod appena creato, su un `tune` riporta vLLM agli argomenti precedenti e lascia il Pod acceso; `down`
è l'unico modo esplicito per eliminare un Pod in uso. Alla chiusura del server un `up` ancora in corso con il Pod
già creato viene annullato e il Pod eliminato.

### Usarla in altri progetti

```bash
claude mcp add llmpod -- node /percorso/runpod-helper/src/mcp/server.js
# oppure, dopo npm link:
claude mcp add llmpod -- llmpod-mcp      # (o: claude mcp add llmpod -- llmpod mcp)
```

In un altro progetto valgono le conferme di Claude Code e i controlli del server (`confirm`, prezzo atteso), ma
**non** le regole di `CLAUDE.md` né i permessi di questo progetto: copia nel `CLAUDE.md` e nel
`.claude/settings.json` dell'altro progetto le regole che ti servono (almeno le `deny` sui `.env` e le `ask` sugli
strumenti che spendono).

---

## Consulente IA esterno

Un LLM esterno, facoltativo, che rivede gli argomenti di vLLM proposti da `llmpod plan` (leggendo la scheda del
modello e la recipe ufficiale di vLLM) e propone correzioni se l'avvio fallisce. Ogni proposta passa una
validazione rigida (solo flag esistenti in vLLM v0.30.0, nessun flag che tocchi chiave, host, porta o revisione) e
si applica solo con la tua conferma.

```bash
llmpod advisor                      # scegli il preset e inserisci la chiave
llmpod advisor --preset anthropic   # preset senza domanda
llmpod advisor --test               # verifica che risponda con una proposta valida
llmpod advisor --disable            # disattiva
llmpod plan <modello> --no-advisor  # un piano senza consulente (--advisor per usarlo anche se disattivato)
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

La chiave del consulente sta in `~/.config/llmpod/.env` e non viene mai mostrata. In modalità Claude Code
managed il consulente è Claude Code stesso e il piano non chiama il consulente esterno.

---

## Risoluzione dei problemi

| Problema | Causa | Cosa fare |
|---|---|---|
| vLLM non parte con un'immagine `…-cu129` | l'immagine `vllm/vllm-openai:v0.30.0-cu129` è rotta (torch per CUDA 13 con torchvision per CUDA 12.9, [vllm#59057](https://github.com/vllm-project/vllm/issues/59057)) | la predefinita ora è `vllm/vllm-openai:v0.30.0` (CUDA 13). I profili salvati prima contengono ancora la vecchia immagine: rigenera piano e profilo (`llmpod plan …` e `llmpod save <stesso nome>`) |
| `SMOKE_TEST_FAILED` / `UNKNOWN_TOOL_PARSER` | le chiamate a strumento non funzionano: di solito tool parser o chat template sbagliati | sul Pod acceso: `llmpod tune <profilo> --set tool-call-parser=<nome> --save`; per i prossimi avvii: `llmpod plan … --set tool-call-parser=<nome>`. Parser disponibili: https://docs.vllm.ai/en/v0.30.0/features/tool_calling/. Se hai il consulente, `up` propone la correzione |
| pi (o OpenCode) supera il contesto: errore 400 di vLLM | la stima dei token del client differisce da quella di vLLM | llmpod dichiara ai client un contesto con margine: rilancia `llmpod run pi` per riscrivere la configurazione (necessario per configurazioni scritte da versioni precedenti o dopo un `tune --save` che cambia il contesto) |
| Pod "orfano" in `status` | il Pod `llmpod-<profilo>` esiste ma non risulta avviato da questo computer (avviato da un altro computer o da un'altra cartella di configurazione, oppure `state.json` perso) | se non lo sta usando nessuno, `llmpod down <profilo>` |
| Pod "in eliminazione" | per qualche minuto dopo l'eliminazione Runpod può mostrarlo ancora come acceso | attendi qualche minuto; se resta, controlla https://www.runpod.io/console/pods |
| Pod spento (`EXITED`) | fermato dalla console o da Runpod: costa ancora il disco | `llmpod down <profilo>` |
| `NO_GPU_AVAILABLE` | nessuna GPU adatta libera tra le opzioni del profilo | riprova più tardi; accetta un datacenter "senza volume"; oppure un nuovo piano con un'altra GPU, un contesto minore o una variante quantizzata |
| `INSUFFICIENT_BALANCE` | credito inferiore a un'ora di utilizzo | ricarica su https://www.runpod.io/console/user/billing |
| "Credito residuo: non disponibile" o `up` fermo sul credito | la chiave *Restricted* non legge il credito via GraphQL | usa una chiave con accesso completo (`llmpod init`) |
| `PRICE_CHANGED` (managed) | il prezzo è cambiato tra anteprima e avvio | rileggi l'anteprima e conferma il nuovo prezzo: nessun Pod è stato creato |
| `GATED_MODEL` / `HF_AUTH` | modello con accesso su richiesta | richiedi l'accesso sulla pagina del modello e imposta il token con `llmpod init` |
| `OOM` | memoria GPU insufficiente | contesto minore, `--set kv-cache-dtype=fp8`, `--set gpu-memory-utilization=0.85` o una GPU più grande |
| `POD_START_TIMEOUT` | download o caricamento più lunghi del previsto | rispondi sì alla domanda per attendere altri 15 minuti; guarda `llmpod logs` |
| `VLLM_ERROR` con `NCCL error: unhandled cuda error` o `NCCL WARN … Cuda failure 217` (spesso con `SymmMemCommunicator: Device capability 12.0 not supported` e `FlashInfer All Reduce is disabled`) | Pod **multi-GPU senza NVLink completo** (RTX/GeForce, RTX PRO 6000 "Server/Workstation Edition", RTX A-series, L4/L40/L40S, A10/A16/A40, A100/H100 PCIe; H100/H200 NVL solo a coppie): il trasporto diretto tra GPU (P2P) di NCCL o l'all-reduce di vLLM fallisce nella macchina virtuale, anche dopo molti minuti di caricamento dei pesi. I due avvisi sono normali su Blackwell e non sono la causa | llmpod avvia questi Pod in **modalità NCCL sicura** (vedi [Scegliere la GPU](#scegliere-la-gpu): `NCCL_P2P_DISABLE=1` o `NCCL_P2P_LEVEL=NVL`, `NCCL_CUMEM_HOST_ENABLE=0`, `VLLM_ALLREDUCE_USE_SYMM_MEM=0`, `NCCL_DEBUG=WARN`, `--disable-custom-all-reduce`) e il piano lo segnala con un avviso `NCCL:`. Il consulente non viene consultato (non può cambiare l'ambiente). Se l'errore compare lo stesso: controlla che il profilo non sia stato creato con `--no-nccl-safe` (campo `ncclSafe: false`), altrimenti rigenera piano e profilo; oppure scegli **una sola GPU più grande** o GPU **SXM con NVLink** (H100/H200/B200). `NCCL_IB_DISABLE` non serve: InfiniBand si usa solo tra nodi diversi |
| vLLM in `error` senza riavvii | durante l'avvio il supervisore riavvia vLLM **una volta sola, e solo per errori di rete o di download** (connessione, timeout, 5xx di Hugging Face) arrivati prima che inizi la lettura dei pesi (`Loading safetensors checkpoint shards`). Non riavvia dopo l'inizio della lettura né per errori non transitori (NCCL, CUDA, OOM, `ValueError`…): un riavvio ricaricherebbe tutti i pesi (anche 20 minuti a pagamento) per ripetere lo stesso errore. La causa è la prima riga d'errore specifica (es. quella del Worker), non i messaggi di EngineCore/APIServer che la ripetono. Un crash **dopo** che vLLM era pronto ha diritto a un riavvio | `up` si ferma subito con la causa (`lastError`/`errorCause` del supervisore, visibili anche in `llmpod metrics`) e propone riparazione (consulente; non per gli errori NCCL, che dipendono dall'ambiente) o eliminazione del Pod. Un Pod in errore da 15 minuti viene eliminato dal supervisore anche con l'inattività disattivata (motivo `error-timeout`) |
| `VLLM_ERROR` "vLLM bloccato (possibile problema NCCL/P2P)" | dopo la lettura dei pesi vLLM non ha scritto nulla nei log per 10 minuti: tipico di una comunicazione NCCL bloccata tra le GPU | il supervisore ferma vLLM e passa in errore invece di far attendere il timeout. Vedi la riga `NCCL error` qui sopra (modalità NCCL sicura, una GPU più grande o GPU SXM) |
| `ZCODE_RUNNING` | ZCode è aperto e sovrascriverebbe la configurazione | chiudi ZCode e ripeti `llmpod run zcode` |
| `CONFIG_PERMISSIONS` | `.env` leggibile da altri utenti | `chmod 600 ~/.config/llmpod/.env` |
| Risposte interrotte dopo circa 100 s | limite del proxy di Runpod per le richieste **non** in streaming | usa client in streaming (Claude Code, OpenCode e pi lo sono) |
| `plan` rifiuta un repository GGUF o un modello MLX | formati non caricabili da vLLM | usa la versione safetensors (o AWQ/GPTQ/FP8) dello stesso modello |

---

## Domande frequenti

**Quanto costa davvero una sessione?** Prezzo orario della GPU per il tempo in cui il Pod esiste, più il volume al
mese. Vedi [Stimare i costi](#stimare-i-costi).

**Se chiudo il portatile il Pod resta acceso?** Sì, finché non scatta il watchdog nel Pod (30 minuti senza
richieste o 8 ore, salvo `keep`), che lo elimina anche a computer spento. Per smettere subito di pagare usa
`llmpod down`.

**Perché llmpod elimina i Pod invece di fermarli?** Perché un Pod fermo continua a costare lo spazio su disco e
va comunque ricreato: il profilo permette di ricrearlo identico, e il volume conserva i pesi.

**Posso usare lo stesso Pod con più client insieme?** Sì: l'endpoint è unico e i client si collegano con la
chiave del profilo. Tieni conto della concorrenza prevista nel piano (`--concurrency`) e guarda coda e KV cache con
`llmpod metrics`.

**Posso cambiare il contesto senza ricreare il Pod?** Sì, con `llmpod tune <profilo> --set max-model-len=<n>`, se
entra nella memoria della GPU; con `--save` vale anche per i prossimi avvii.

**Come cambio la chiave vLLM di un profilo?** `llmpod rotate-key <profilo>`. Un Pod già acceso usa ancora la
vecchia chiave: eliminalo e riavvialo (`llmpod down`, poi `llmpod up`).

**Posso usare un modello GGUF o MLX?** No: vLLM in llmpod richiede pesi safetensors (anche quantizzati AWQ, GPTQ,
FP8, NVFP4).

**Devo avere Docker?** No. Serve solo per Open WebUI o se preferisci l'installazione con Docker.

**Dove trovo i Pod che non ha creato llmpod?** `llmpod status --all` li elenca in sola lettura; llmpod non li tocca.

**La modalità managed può spendere senza chiedermelo?** No: gli strumenti che spendono sono regole `ask` dei
permessi e richiedono anche `confirm: true` con il prezzo visto nell'anteprima.

---

## Appendice: aggiornare un set di modelli

I set stanno in `data/model-sets.json`. Criteri di inclusione (verificati sull'API pubblica di Hugging Face,
senza token):

- solo formati che vLLM v0.30.0 carica nativamente (safetensors BF16, FP8, AWQ, GPTQ, compressed-tensors, NVFP4,
  MXFP4 nativo di gpt-oss) **nella radice** del repository; niente GGUF, MLX, EXL3 o pesi in sottocartelle;
- architettura presente nel registro dei modelli di vLLM v0.30.0 e tool parser noto in `data/parsers.json`;
- a parità di modello, varianti con draft head (MTP o DSpark); per ogni famiglia 1–3 varianti;
- repository non *gated* e pubblicatori diffusi o affidabili.

Per ogni candidato si registrano revisione (sha), `quantization_config`, dimensione dei pesi, presenza MTP,
architettura, contesto massimo, parser e licenza; poi si modifica `data/model-sets.json` (aggiornando
`updatedAt`) e si esegue `npm test`: lo schema è validato al caricamento e i test controllano che parser e
`mtp`/`draft` di ogni modello coincidano con ciò che llmpod rileva (fixture in `test/fixtures/hf/model-sets/`).
Ogni modello ha un id breve stabile (`key`); il campo `revision` fissa la versione verificata.
