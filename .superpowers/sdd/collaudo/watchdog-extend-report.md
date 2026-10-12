# Report — prolungare un Pod in uso (keep) e rifiniture scelta GPU

Branch: `feat/keep-pod` (da origin/main). Test-first; `npm test` (840 JS + 30 Python) e `npm run build:web` verdi.

## A. Watchdog modificabile su un Pod avviato
1. Supervisore (`src/core/pod/supervisor.py`): `POST /watchdog` con Bearer, corpo `{idleMinutes: 0..1440|null, maxHours: 0.25..168|null}`.
   Validazione con 400 (fuori intervallo, tipo sbagliato, bool, NaN/inf, JSON non valido); aggiornamento sotto lock; persistenza in
   `LLMPOD_STATE_DIR/.llmpod-watchdog-<podId>` (scrittura atomica, riletta all'avvio; file corrotto o fuori intervallo ignorato);
   `GET /status` espone `idleLimitSeconds` e `maxSeconds` correnti. `idleLimit <= 0` disattiva l'inattività (`termination_reason`).
   `maxHours` resta misurato dall'avvio persistito. Cambiando l'inattività il conteggio riparte da adesso (evita lo spegnimento
   immediato riattivandola dopo molto tempo fermo). Errore di scrittura su disco: limiti applicati comunque, `persisted:false`.
2. Core/CLI: `ops.keep` + `llmpod keep [profilo] [--idle-minutes N|--no-idle] [--max-hours N] [--save] [--yes]`. Stampa nuovi limiti,
   scadenza e costo massimo (ore rimanenti × costo orario); conferma solo se le ore massime aumentano. 404 dal supervisore vecchio ->
   errore che spiega "versione precedente" con suggerimento down/up. Profilo aggiornato solo con `--save` e solo dopo successo.
   Validazione condivisa in `src/core/watchdog.js`.
3. Web: pulsante "Prolunga" nella pagina Stato per i Pod avviati con limiti noti; finestra `ExtendModal` (inattività con "Mai",
   ore massime, validazione, costo massimo; il pulsante "Conferma e prolunga (costo massimo X)" e' la conferma del costo).
   Rotta `POST /api/pods/:profile/watchdog` (stesse protezioni CSRF/Content-Type/sessione, 409 con job up/down in corso,
   nome profilo validato; `yes:true` perche' il costo e' confermato in UI, `save` non accettato dal corpo).
4. Colonna "Spegnimento" (CLI e web): mostra i limiti correnti ("inattivo da X su Y; massimo tra Z", "inattività: mai", fase + massimo).
5. README: sezione "Tenere acceso un Pod" e riga nella tabella comandi.

## B. Rifiniture
6. `markFits` ora filtra anche `plan.alternatives` (via quelle con `fits:false`): `up --yes` e `up` non interattivo non ripiegano piu' su GPU dove il modello non entra.
7. `up` in modalita' scelta rispetta `allowFallbackWithoutVolume: "never"` (nessuna opzione di altri datacenter).

## Test aggiunti
`test/supervisor/test_supervisor.py` (+7), `test/core/ops-keep.test.js`, `test/cli/cli-keep.test.js`, `test/server/api-keep.test.js`,
`test/web/keep.test.jsx`, `test/core/plan-flow-fits.test.js` (+2), `test/core/ops-pods.test.js` (+2).

## Dubbi / note
- POST /watchdog con entrambi i valori null/assenti nel supervisore e' un no-op (200); `llmpod keep` e la rotta web lo rifiutano prima (INVALID_INPUT).
- `LLMPOD_IDLE_MINUTES=0` (profilo con `idleMinutes: 0`, es. `keep --no-idle --save`) ora significa inattività disattivata anche all'avvio
  (prima avrebbe spento subito il Pod).
- Mai provato su un Pod reale (vietato): verificato solo con test e fake.
- Un Pod avviato prima di questa versione continua a usare il vecchio supervisore (senza /watchdog) fino al riavvio.

## Correzioni dalla revisione
- Ore massime sotto uptime + 5 min: rifiutate da supervisore (400), `ops.keep` (INVALID_INPUT, "verrebbe eliminato subito... llmpod down") e finestra Prolunga (errore rosso, pulsante disattivato).
- Conferma del costo massimo ogni volta che la spesa possibile aumenta (ore massime, inattività disattivata o aumentata); con `--save`, conferma esplicita se il profilo avra' inattività 0 o maxHours > 8 (le due conferme avvengono prima di toccare il Pod); `up` mostra nella conferma "inattività: mai|N min, massimo N h → costo massimo X $" se il profilo esce dai predefiniti.
- `watchdog` validato in config.js (profili in lettura/scrittura e config.json); README: 0 = mai, intervalli, conferme.
- Minori: OverflowError -> 400; /watchdog 409 se terminating; idleMinutes intero 0 o 5..1440 (CLI, web, supervisore, profili); supervisore vecchio rilevato prima della conferma tramite `features: ['watchdog']` in /status (oltre al 404); costo orario `pod.cost || profile.estimate.hourlyUSD`, mai "0,00" se ignoto (CLI e web); virgola decimale nella CLI; POST /watchdog senza valori -> 400 (rilettura da file per singolo campo).
- Nota: dopo la correzione il caricamento da file del supervisore valida ogni campo da solo.
