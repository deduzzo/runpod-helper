# Report — modalità "Claude Code managed" e installazione nel README

Branch `feat/claude-managed` (da `origin/main`, ribasato dopo il merge dei set di modelli). Lavoro test-first;
nessuna credenziale reale, nessuna chiamata a Runpod/Hugging Face (fake in tutti i test).

## Cosa è stato fatto

### 1. Core e CLI (tutti con `--json`)
- `src/core/metrics.js`: lettura di `/metrics` di vLLM (Prometheus): token/s di generazione e prompt, richieste in
  corso/in coda, KV cache % (`kv_cache_usage_perc` o legacy `gpu_cache_usage_perc`), accettazione della decodifica
  speculativa (totale e nella finestra: % accettati, lunghezza media 1 + accettati/bozze, per posizione), errori
  (interrotte, preemption, HTTP 4xx/5xx). Contatori azzerati da una ricarica: mai tassi negativi.
- `llmpod metrics [profilo] --window N`: due letture a distanza di N s (default 10) + `/status` del supervisore.
  Se vLLM non è pronto restituisce lo stato del supervisore con `metrics: null` e il motivo.
- `llmpod logs [profilo] --since N --follow`: log del supervisore, mascherati anche lato client.
- `src/core/tune.js` + `llmpod tune <profilo> --set/--extra-arg --dry-run --yes --save`: parte dagli argomenti attivi
  (GET /status), vieta revision, tensor-parallel-size, served-model-name, api-key, host, port (anche via
  `--extra-arg`, abbreviazioni e `_`), consente max-model-len (validato ≤ contesto massimo del modello),
  valida gpu-memory-utilization e max-num-seqs, riallinea tool-call-parser/enable-auto-tool-choice, ricalcola la
  memoria per la GPU del Pod (`memoryCheck`, KV scalata con contesto e dtype) e rifiuta prima di chiedere se non
  entra. Conferma con "vLLM verrà ricaricato: interruzione di alcuni minuti; il Pod resta" e costo orario; POST
  /reload, `waitReloadStarted` (estratto dalla riparazione e condiviso), `waitForReady` dal cursore dei log,
  smoke test. Se fallisce propone il ritorno agli argomenti precedenti (con `--yes` torna automaticamente).
  `--save`: argomenti nel profilo (syncDerivedFields), `context` se cambia max-model-len, ZCode riconfigurato.
- `llmpod manage [--profile p]`: `claude` nella cartella del progetto (risolta dal pacchetto), nessuna chiave
  nell'ambiente; se manca, istruzioni di installazione. `llmpod mcp`: server MCP su stdio.
- `ops.upPreview` e `ops.up({ gpu, expectedHourlyUSD, costConfirmed })` (nuovo codice `PRICE_CHANGED`);
  `ops.keep({ preview })`; `ops.tune({ confirmed })`.

### 2. Server MCP `llmpod-mcp`
- `src/mcp/server.js` con `@modelcontextprotocol/sdk` **1.30.1** (pubblicata il 23/09/2026, verificato con
  `npm view`) e `zod` **4.6.5** (13/09/2026), versioni esatte. API raccomandata `McpServer.registerTool`: lo schema
  JSON di ogni strumento resta la fonte unica (convertito con `z.fromJSONSchema` per l'SDK; `validateInput` lo
  riapplica). Trasporto stdio; `.mcp.json` (`node src/mcp/server.js`), bin `llmpod-mcp`, `llmpod mcp`.
- 19 strumenti: `model_sets` (collegato direttamente a `src/core/model-sets.js`, con `planRef` `<set>/<key>`),
  `search`, `plan` (anche `<set>/<id>`, contesto consigliato), `save_profile` (gpu obbligatoria), `profiles`,
  `status` (avviati/in avvio/spenti/in eliminazione), `metrics`, `logs`, `up_preview`, `up` (gpu + `confirm: true`
  + `expectedHourlyUSD`, controllo del prezzo prima del job e di nuovo nel core; job in background), `job_status`,
  `job_events` (seq, log esclusi salvo `includeLogs`), `job_answer`, `tune_preview`, `tune` (job; il ritorno
  indietro è una domanda pendente), `keep_preview`, `keep`, `down` (+ elenco completo dei Pod), `client_commands`.
- Job con `src/server/jobs.js` (stesso modulo dell'interfaccia web); un solo job per profilo; domande scadute =
  valore sicuro. Risposte mascherate per valore (tutte le chiavi del `.env` registrate a ogni chiamata).
  Annotazioni `readOnlyHint`/`destructiveHint`.

### 3. Claude Code nel repository
- `CLAUDE.md`: ruolo, 8 regole vincolanti, strumenti, flusso consigliato, lettura delle metriche, tabella di tuning
  con le recipe vLLM e i dati di `data/`.
- Skill `.claude/skills/llmpod-{avvia,stato,tune,spegni}/SKILL.md` (frontmatter in italiano); `/llmpod-avvia`
  propone prima il set consigliato.
- `.claude/settings.json`: allow per i 13 strumenti MCP di sola lettura e per `status|metrics|logs|search|--help`
  della CLI; deny per `.env` (Read/Edit, cat/grep/head/tail/less/more) e `llmpod env`; `enabledMcpjsonServers`.
  `.gitignore`: aggiunto `.claude/settings.local.json` (`.claude/worktrees/` era già ignorato).

### 4. README
- Sezione "Installazione" (requisiti, clone, `npm ci`, build, `npm link`, `llmpod init` con permessi minimi della
  chiave, client con comandi ufficiali, prima prova con `search --set abliterated`, Docker, aggiornamento).
- Sezione "Modalità Claude Code managed" (avvio, cosa fa, permessi, comandi CLI per l'agente, `claude mcp add`).
- Tabella dei comandi aggiornata.

## Test
- `npm test`: vitest **1001 test** verdi (nuovi: `test/core/metrics|tune|ops-live`, `test/cli/cli-managed`,
  `test/mcp/server|project-config`; fixture `test/fixtures/fake-world.js` e `vllm-metrics.js`); Python 31 test OK.
- `npm run build:web` verde. Prova manuale del server su stdio (initialize, tools/list, tools/call) con una
  configurazione vuota nella scratchpad.

## Dubbi e scelte da confermare
- **tensor-parallel-size** è bloccato in `tune` (oltre ai flag richiesti): il numero di GPU del Pod non cambia.
- Flag sconosciuti in `tune`: dopo la revisione sono un errore (chiudono anche le abbreviazioni di argparse).
- La stima di memoria di `tune` scala la KV linearmente con max-model-len rispetto al contesto del profilo; non
  modella `max-num-seqs`. Se manca l'opzione GPU nel profilo usa il catalogo; senza dati non blocca (fits null).
- `job_answer` e `save_profile` non sono in allow (richiedono conferma di Claude Code); `client_commands` sì
  (sola lettura, non nella lista della richiesta).
- Domande pendenti dei job MCP: 30 minuti di norma, 3 minuti mentre un Pod costa (vedi correzioni).
- ZCode: non ho un URL ufficiale verificato da citare nel README (scritto "app desktop di Z.ai, dal sito ufficiale").

## Correzioni della revisione

Tutte test-first; `npm test` 1024 test vitest + 31 Python verdi, `npm run build:web` verde.

1. **Permessi** (`.claude/settings.json`), sintassi verificata sulla documentazione dei permessi di Claude Code
   (ordine deny → ask → allow; `Bash(cmd *)` copre anche il comando senza argomenti e non `cmdx`):
   - `ask` per `mcp__llmpod__{up,tune,keep,down,save_profile,job_answer,job_cancel}` e per
     `llmpod|node src/cli/index.js {up,tune,keep,down,destroy-volume,rotate-key,save,init,advisor} *`;
   - `allow` con lo spazio (`Bash(llmpod logs *)` ecc.);
   - `deny`: niente più `.env.*` (`.env.example` leggibile): `Read/Edit(~/.config/llmpod/.env)`,
     `Read/Edit(**/.env)`, `cat|grep|head|tail *.env` e `*.env *`, `less|more *.env`, `llmpod env *`.
   - Test: un piccolo matcher delle regole in `project-config.test.js` verifica decisioni concrete
     (ask, allow, deny, `.env.example` non bloccato, `llmpod statusx` non consentito).
2. **tune**: `normalizeArgTokens` porta tutto in `--nome-con-trattini` (minuscole, `_` → `-`, `--k=v` in due token)
   prima di applyOverrides, argMap, TUNE_LOCKED e checkValues; anche le chiavi di `--set`. Rifiuta i token con un
   solo trattino (`-tp`), i flag duplicati e i flag sconosciuti (quindi anche le abbreviazioni come
   `--tensor-parallel`, `--max-model`). Test con `--tensor_parallel_size=2`, `--max_model_len=…`,
   `--gpu_memory_utilization=0.99`, `set: ['max_model_len=…']`, `-tp 2`.
3. **Pod acceso dopo un up fallito**:
   - `up` con `autoTerminate` (usato dai job MCP): se l'avvio fallisce il Pod si elimina subito, senza domanda;
   - le domande dei job MCP scadono in 3 minuti col valore sicuro durante `tune` e, in `up`, dopo la creazione del
     Pod (`expiresAt` nella domanda; `ask` dei job accetta `timeoutMs`);
   - `jobs.cancel` / `jobs.wait` e segnale di annullamento; i job MCP usano uno `sleep` annullabile;
   - `down` è consentito durante un `up`/`tune` dello stesso profilo: annulla il job (domanda pendente chiusa col
     valore sicuro), attende che esca (max 60 s) ed elimina il Pod; nuovo strumento `job_cancel` (`confirm: true`,
     in `ask`) con la stessa logica.
4. **Chiusura del server MCP**: SIGINT, SIGTERM, chiusura di stdin o del trasporto → `shutdown`: annulla i job e,
   per gli `up` in corso con Pod già creato, elimina il Pod (tempo massimo 60 s), con log su stderr; poi esce con 0.
   Test sia sulla funzione sia su un processo reale (`test/mcp/stdio.test.js`, SIGTERM e stdin chiuso).

Minori:
- `plan` (in allow) non chiama mai il consulente esterno: parametro `advisor` rimosso dallo strumento.
- `tune` rifiuta di partire se vLLM è in `error` (il ritorno indietro andrebbe su argomenti rotti); se la ricarica
  fallisce l'errore propone `llmpod down` come passo successivo.
- `status --all` (CLI) e `status { all: true }` (MCP): anche gli altri Pod dell'account, in sola lettura;
  CLAUDE.md e skill precisano che `status` da solo elenca solo i Pod `llmpod-*`.
- `tune` via MCP richiede `expectedArgs` (il `before` dell'anteprima) e rifiuta se gli argomenti attivi sono cambiati.
- `save_profile` richiede `model` e rifiuta se `last-plan.json` è di un altro modello (accetta anche `<set>/<id>`).
- `llmpod manage` controlla CLAUDE.md, `.claude/settings.json`, `.claude/skills` e `.mcp.json` nella cartella del
  progetto (avviso; senza CLAUDE.md chiede se partire comunque); `package.json` `files` li include (verificato con
  `npm pack --dry-run`).
- Skill e CLAUDE.md: mai `logs --follow` dall'agente.
- README: permessi della chiave Runpod (REST + GraphQL per il credito: `llmpod init` verifica solo la parte REST;
  se il credito risulta "non disponibile" serve una chiave con accesso completo), nota su `LLMPOD_CONFIG_DIR`
  personalizzata (regola `deny` con percorso assoluto in `settings.local.json`) e sulla sandbox di Claude Code.

**`job_cancel` sui tune** (correzione successiva): annullare un `tune` non elimina più il Pod. Interrompe
l'attesa in corso (interruzione "morbida", separata dall'annullamento del job), chiude con "sì" la domanda di
ritorno se pendente e il job stesso ricarica vLLM con gli argomenti precedenti; anche se l'interruzione arriva
dopo una ricarica riuscita (`isCancelled` in `ops.tune`) si torna indietro. L'esito è nell'evento finale
(`failed` con codice `CANCELLED`: "vLLM è di nuovo attivo con gli argomenti precedenti; il Pod resta acceso",
oppure ritorno non riuscito con suggerimento di chiedere all'utente se fare `down`). Solo `job_cancel` su un `up`
non ancora pronto elimina il Pod; `down` resta l'unico modo esplicito per eliminare un Pod, anche durante un
tune. Nuovo `jobs.settlePending`. Test: tune in attesa annullato (2 ricariche, nessun DELETE), domanda di ritorno
pendente, `down` durante un tune.

Dubbio: non ho potuto verificare quali permessi *Restricted* di Runpod coprano la query GraphQL del credito; il
README lo dice in modo prudente.
