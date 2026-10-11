# Backlog dopo il piano 1

Elementi minori emersi nelle revisioni del piano 1 e rimandati (nessuno blocca l'uso). Da valutare nei piani successivi.

## Da fare prima o durante il piano 2

- Supervisore: timeout di caricamento (oggi un vLLM che non diventa mai pronto viene fermato solo dalla durata massima, 8 h).
- Prompt sovrapposti (domanda di interruzione durante un'altra domanda di `up`).
- Conferma in `up` quando il profilo non ha un tool parser noto.
- Abbreviazioni di 2 caratteri dei flag vietati (es. `--ho`) solo segnalate, non bloccate.

## Elenco completo dei minori rimandati

- **Attività 1:** errors.test non copre cause/details; `cause ? {cause}` scarta cause falsy; report con conteggi imprecisi; chat_template troncato nella fixture model-qwen3-coder-30b
- **Attività 2:** redact può lanciare con input funzione/circolare (JSON.stringify undefined) — da indurire, è nel percorso --verbose/--dry-run; segreti con caratteri escapati in JSON non mascherati; chiave sensibile con valore non stringa non mascherata; nessun test per l'ordine longest-first
- **Attività 3:** res.text() fuori dal try (errori di lettura corpo non mascherati/non ritentati); corpo delle risposte ritentate non consumato; Retry-After non limitato; httpError con detail oggetto → [object Object]; header case-sensitive duplicabili; copertura test parziale (DELETE, retry:false, timeout, maxRetries)
- **Attività 3:** la causa sostituita perde name (TimeoutError) e codice di rete annidato (ECONNREFUSED) — includerli in modo mascherato nel messaggio
- **Attività 4:** .env round-trip con backslash/newline lossy; readJson lancia SyntaxError grezzo su JSON corrotto (serve errore tipizzato); SECRET_VAR case-sensitive; tmp con segreti non rimosso se rename fallisce; ensureDir fa chmod 700 su cartella esistente
- **Attività 5:** a/b@c@d accetta @c; URL con ?query rifiutato; paginazione listFiles senza limite; getReadme su README JSON non byte-identico; test mancanti per resolveSha/getReadme/checkAccess
- **Attività 6:** getBalance mappa ogni errori GraphQL 200 a RUNPOD_AUTH con "HTTP 403" inventato; r.data.data.myself senza guardia (TypeError su HTML/ null); GRAPHQL non sovrascrivibile da base; .gpus/.dataCenters/.networkVolumes senza ?? []; copertura parziale (listDataCenters, deleteVolume, createPod)
- **Attività 7:** estimate divide la KV per TP anche quando tp > num_key_value_heads (vLLM replica le KV head) e per MLA (latente non shardato) → possibile sottostima, contraria al principio "mai sottostimare"; headDim NaN se mancano campi; dtype sconosciuto → 2 byte
- **Attività 8:** validateArgs non normalizza "_" → "--api_key"/"--host" con underscore risultano "unknown" (solo avviso in plan.js) invece che vietati — rilevante per il consulente LLM del piano 2; applyOverrides non sostituisce forme --flag=valore; key=false non usa --no-flag per i booleani attivi di default; loadFlags non in cache
- **Attività 9:** avviso con versione vLLM fissa 'v0.30.0' anche con immagine diversa; FP8 ritentato solo se BF16 non ha né choice né elsewhere (meglio: ritentare se manca choice); listGpus sequenziale; dataCenterId non validato; commento errato nel test FP8; test fixture potenzialmente vacuo; NO_GPU_AVAILABLE dentro testo libero
- **Attività 10:** ResourceWarning nei test (stdout Popen, server_close); possibile vLLM orfano nel test reload; messaggio di crash ripetuto in error; 404 contato come terminazione riuscita; RUNPOD_API_KEY passato all'ambiente di vLLM (rimuoverlo); kill solo del padre su reload (usare killpg); Content-Length non validato; run() e retry DELETE non testati; nessun timeout in loading
- **Attività 10:** prefissi di 2 caratteri (--ho) non rifiutati; start persistito "inf" disattiva il limite; check_ready fuori lock; reloading bloccato se il thread non parte; idle watchdog inattivo se vLLM non diventa mai pronto (solo max-duration)
- **Attività 11:** ritento 5xx di POST /pods può creare un Pod duplicato a pagamento (controllare listPods per nome prima di ritentare); errors non-array → TypeError; RANK sconosciuto → NaN nel sort; log non mascherati nel launcher; log letti prima dello stato (OOM mancato); confirmCost senza importo → "NaN $"; test mancanti (5xx esauriti, 401, corpo troppo grande, COMMUNITY)
- **Attività 12:** backup .llmpod-bak sovrascritto a ogni esecuzione (si perde la config originale dell'utente: scriverlo solo se assente); radice JSON non oggetto accettata; tasklist senza try/catch e pgrep assente = "non in esecuzione" (fail-open); tmp non rimosso su errore; test senza pulizia tmp e copertura limitata
- **Attività 13:** rifiuto del candidato più caro interrompe tutto l'up; saldo verificato solo sul primo candidato; costo sessione in down senza fallback su startedAt; Pod EXITED invisibili; voci obsolete in state.json; down --dry-run scrive lo stato; copertura test dei percorsi di conferma/rifiuto
- **Attività 13:** errore di findExisting sostituisce l'errore POST; stato del Pod "vagante" registra first.hourly invece del candidato reale; waitForRunning senza opzione "aspetta ancora"
- **Attività 14:** `llmpod` senza comando esce 0; --verbose non passato da plan; init può creare un secondo volume llmpod-pesi se si rifiuta il riuso; test mancanti per Suggerimento/130
- **Attività 14:** newline mancante dopo Ctrl+C su askSecret
- **Attività 15:** down/resolveProfile si fida di state.pods anche se obsoleto (orfani di altri profili non segnalati); destroy-volume lascia riferimenti al volume nei profili; filtro Pod attivi esclude EXITED; run: exit code su segnale e SIGINT durante il client; env con apiKey undefined e --format sconosciuto; status --json via io.raw
- **Attività 15:** Ctrl+C durante la POST con Pod non ancora visibile in listPods → nessun avviso; listener SIGINT attivo per tutta la gestione
- **Attività 16:** errori di rete nei controlli singoli accorpati in un solo fallimento; risposta non-201 che crea comunque il Pod non ripulita prima del finally
- **Attività 16:** RUNNING_STATES con nome invertito; codice d'uscita 1 invece di 130 dopo segnale; creatPod che lancia dopo aver creato il Pod non ripulito; refuso "potrebbe essere ancora attivi"
