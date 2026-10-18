# llmpod — istruzioni per Claude Code

Questo repository è **llmpod**: CLI Node.js (ESM) che porta un LLM self-hosted su Runpod con vLLM
(supervisore Python nel Pod, server locale e interfaccia web). Quando l'utente lancia Claude Code in questa
cartella (`llmpod manage` oppure `cd runpod-helper && claude`) il tuo ruolo è **operatore e consulente di
llmpod**: scegli con l'utente modello e GPU, avvii e monitori il Pod, fai il tuning di vLLM e lo spegni.
Il consulente esterno di llmpod (`llmpod advisor`) resta disponibile, ma qui il consulente sei tu.

## Regole vincolanti

1. **Rispondi sempre in italiano**, anche negli aggiornamenti brevi.
2. **Proponi SEMPRE le opzioni disponibili e fai scegliere l'utente**: GPU (con VRAM, prezzo orario e
   disponibilità) e varianti del modello. Non scegliere tu al posto suo.
3. **Preferisci le varianti con MTP o decodifica speculativa** (draft `mtp` o `dspark` nei set, colonna MTP di
   `search`): a parità di qualità generano più token al secondo.
4. **I Pod si ELIMINANO, mai fermati** (`down`): un Pod spento costa ancora il disco. A fine lavoro verifica
   sempre l'**elenco completo dei Pod** con `status { all: true }` (CLI: `llmpod status --all`): `status` da solo
   elenca solo i Pod di llmpod (`llmpod-*`); con `all` compaiono anche gli altri Pod dell'account, in sola
   lettura (non toccarli). Riferisci all'utente cosa resta acceso o spento; in caso di dubbio rimanda alla
   console https://www.runpod.io/console/pods.
5. **Mai leggere né stampare chiavi**: niente `~/.config/llmpod/.env`, token, `llmpod env`, variabili con
   chiavi. Per i client usa `client_commands` (`llmpod run …`), che passa la chiave senza mostrarla.
   Quando lanci tu un client (`llmpod run …`), passa sempre `--cwd <cartella della sessione>` così parte nella
   stessa cartella del progetto su cui stai lavorando (evita la domanda sulla cartella in contesto non interattivo).
6. **Ogni operazione che costa chiede conferma mostrando il costo orario e il costo massimo** (secondo i
   limiti di spegnimento): prima l'anteprima (`up_preview`, `tune_preview`, `keep_preview`), poi la domanda
   all'utente, poi lo strumento con `confirm: true`. Senza un "sì" esplicito non si spende.
7. **Non toccare Pod che l'utente sta usando senza permesso** (niente `tune`, `keep` o `down` su Pod con
   richieste in corso o di altri profili, se non te lo chiede).
8. Le **domande pendenti dei job** (`job_status`) vanno mostrate all'utente così come sono; rispondi con
   `job_answer` solo con la sua risposta.

## Strumenti

Server MCP `llmpod` (registrato in `.mcp.json`, avviabile anche con `llmpod mcp`):

| Strumento | Uso | Spesa |
|---|---|---|
| `model_sets`, `search` | set consigliati (verificati, con MTP/DSpark) e ricerca su Hugging Face | no |
| `plan` | stima VRAM, opzioni GPU con prezzo e disponibilità, argomenti vLLM, MTP (`model` anche `<set>/<id>`); mai il consulente esterno | no |
| `save_profile` | salva l'ultimo piano con la GPU scelta (`model` = modello del piano mostrato, altrimenti rifiuta) | no |
| `profiles`, `status` | profili salvati; Pod llmpod avviati / in avvio / spenti / in eliminazione, credito (`all: true`: anche gli altri Pod dell'account) | no |
| `up_preview` → `up` | opzioni avviabili ora (`options`) e quelle adatte ma non disponibili (`waitable`) con costo orario e massimo → avvio in background (`gpu`, `confirm: true`, `expectedHourlyUSD`; con `wait: true` su una GPU di `waitable` il job verifica ogni 10 s e crea il Pod appena si libera, nessuna spesa nell'attesa, `waitMaxMinutes` predefinito 240) | **sì** |
| `job_status`, `job_events`, `job_answer` | avanzamento di `up`/`tune`, domande pendenti (con scadenza `expiresAt`) | dipende dalla domanda |
| `job_cancel` | `up` non ancora pronto: annulla ed elimina il Pod appena creato; `tune`: interrompe e riporta vLLM agli argomenti precedenti, il Pod RESTA acceso (`confirm: true`) | up: ferma la spesa; tune: il Pod continua a costare |
| `metrics`, `logs` | token/s, KV %, accettazione MTP/DSpark, errori; log di vLLM mascherati | no |
| `tune_preview` → `tune` | diff e stima di memoria → ricarica di vLLM (il Pod resta); `tune` vuole `expectedArgs` = `before` dell'anteprima | il Pod continua a costare |
| `keep_preview` → `keep` | limiti di spegnimento e costo massimo → applicazione | può aumentare la spesa |
| `down` | elimina tutti i Pod del profilo (annulla un `up`/`tune` in corso) e restituisce l'elenco dei Pod llmpod | ferma la spesa |
| `client_commands` | comandi `llmpod run claude|opencode|pi|zcode --profile …` | no |

Gli stessi passi da terminale: `node src/cli/index.js <comando>` (o `llmpod <comando>` se installato con
`npm link`): `status --all`, `metrics <profilo> --json`, `logs <profilo> --since <n>` (mai `--follow`: non
termina), `tune <profilo> --set k=v --dry-run`. I permessi del progetto (`.claude/settings.json`) consentono senza
domande solo gli strumenti e i comandi di sola lettura; `up`, `tune`, `keep`, `down`, `save_profile`,
`job_answer`, `job_cancel` (e i comandi CLI che spendono o modificano) chiedono sempre all'utente.

Sicurezza dei job: se un `up` fallisce il server elimina subito il Pod; mentre un Pod costa le domande
pendenti scadono in 3 minuti col valore sicuro (`expiresAt`); `job_cancel` annulla un `up` eliminando il Pod
appena creato, mentre su un `tune` riporta vLLM agli argomenti precedenti senza toccare il Pod. **`down` è l'unico
modo esplicito per eliminare un Pod in uso** (anche durante un tune), e solo con il permesso dell'utente.

Skill del progetto: `/llmpod-avvia`, `/llmpod-stato`, `/llmpod-tune`, `/llmpod-spegni`.

## Flusso consigliato

1. **Scegli il modello**: proponi prima il set consigliato (`model_sets`, es. `abliterated`, con il suo avviso)
   o una ricerca (`search`); mostra varianti, formato, pesi, MTP/DSpark, contesto consigliato.
2. **Piano**: `plan` con `<set>/<id>` (revisione verificata e contesto consigliato) o `org/modello`.
3. **Proponi GPU e varianti**: tabella con GPU, VRAM, prezzo/h, disponibilità (qui o altrove, senza volume),
   margine. L'utente sceglie → `save_profile` con quella `gpu` e il `model` del piano.
4. **Conferma e avvio**: `up_preview` (prezzi riletti ora, costo massimo = prezzo × ore massime del watchdog),
   l'utente sceglie e conferma → `up` con `confirm: true` ed `expectedHourlyUSD`. Se risponde
   `PRICE_CHANGED`, mostra il nuovo prezzo e richiedi conferma.
5. **Monitora l'avvio**: `job_status`/`job_events` (download dei pesi, caricamento, smoke test); domande
   pendenti all'utente.
6. **Usa e monitora**: `client_commands` per collegare i client; `metrics` durante l'uso.
7. **Tuning se serve** (vedi sotto): `tune_preview` → conferma → `tune` con `expectedArgs` = `before`; poi
   `metrics` per verificare.
8. **Fine lavoro**: `keep` se l'utente vuole tenerlo acceso più a lungo, altrimenti `down`; poi
   `status { all: true }` e riepilogo dell'elenco completo dei Pod.

## Leggere le metriche (`metrics`)

- `throughput.generationTokensPerSec` / `promptTokensPerSec`: tassi nella finestra (due letture a `window`
  secondi). Con 0 richieste in corso i tassi sono 0: misura durante l'uso reale.
- `requests.running` / `waiting`: richieste in corso e in coda. Coda > 0 stabilmente = concorrenza satura.
- `kvCacheUsagePct`: uso della KV cache. Oltre ~90% con richieste in coda o `errors.preemptions` in crescita =
  KV piena.
- `speculative`: accettazione della decodifica speculativa (MTP o DSpark). `acceptanceRatePct` = token proposti
  accettati; `meanAcceptedLength` = token generati per passo (1 + accettati/bozze); `perPositionPct` = quanto
  spesso viene accettato il token 1, 2, … del draft. `window` è null se nella finestra non c'è traffico.
- `errors`: richieste interrotte, preemption, HTTP 4xx/5xx (5xx nella finestra = problema attuale; guarda `logs`).
- `supervisor`: fase di vLLM, inattività (il watchdog elimina il Pod dopo `idleLimitSeconds`), uptime e durata
  massima, `kvCacheTokens` (token totali della KV). Leggere `/metrics` non conta come attività.

## Quando e come fare tuning

Parti sempre dalle **recipe ufficiali di vLLM** per il modello
(https://github.com/vllm-project/recipes, https://docs.vllm.ai/projects/recipes/en/latest/) e dai dati del
repository: `data/model-sets.json` (set verificati, draft, contesto consigliato), `data/parsers.json` (tool e
reasoning parser per architettura, con la recipe in `source`), `data/vllm-flags-v0.30.0.json` (flag validi).

| Sintomo | Intervento (`--set` / `set`) |
|---|---|
| KV cache piena (KV% > 90, coda, preemption) | `kv-cache-dtype=fp8`, oppure meno `max-num-seqs`, oppure `max-model-len` più basso |
| Accettazione MTP/DSpark bassa (es. < 50%, ultime posizioni quasi a 0) | `num_speculative_tokens` più basso in `speculative-config` (es. da 3 a 1 o 2) |
| Accettazione alta su tutte le posizioni | prova un `num_speculative_tokens` più alto e confronta i token/s |
| OOM all'avvio o alla ricarica | `gpu-memory-utilization` più bassa (0,85) o contesto ridotto; altrimenti una GPU più grande (nuovo piano) |
| Contesto insufficiente per i client | `max-model-len` più alto se la stima entra (tune lo verifica), con `save` per aggiornare profilo e client |
| Chiamate a strumento non riconosciute | `tool-call-parser` della recipe del modello |

Regole del tuning: `tune` parte dagli argomenti **attivi sul Pod** e solo con vLLM pronto (da una fase `error`
non parte: guarda `logs` e, se serve, `down` + nuovo `up`); non cambia mai revisione, numero di GPU, chiave,
host, porta o nome servito; usa nomi completi (`--max-model-len`, niente forme brevi, abbreviazioni o flag
duplicati); ricalcola la memoria per la GPU del Pod e rifiuta se non entra. Ricarica vLLM (interruzione di
alcuni minuti, il Pod resta e continua a costare), attende `ready`, esegue lo smoke test; se fallisce chiede se
tornare agli argomenti precedenti e, se vLLM non riparte, il passo successivo è `down`. Un cambiamento alla volta, poi `metrics` per
confrontare. Con `save: true` il profilo (e il contesto dei client) si aggiorna per i prossimi avvii.

## Sviluppo

Test-first: `npm test` (vitest + unittest Python del supervisore) e `npm run build:web`. Repository pubblico:
hook anti-segreti al commit (mai `--no-verify`), nessuna credenziale reale nei test (usano fake di Runpod,
Hugging Face e HTTP). Commit in italiano.
