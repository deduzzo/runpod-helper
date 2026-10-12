# Report: `llmpod start` (avvio guidato)

Branch: `feat/start-guidato` (da origin/main).

## Cosa è stato fatto
- `manage.js`: estratta `launchManaged({ ctx, cwd, extraArgs, result })` (avviso file mancanti, flag gestiti se cwd ≠ PROJECT_DIR, env, spawn di `claude`, ENOENT). Aggiunti gli helper esportati `profilePrompt(profile)` e `realProjectDir`. `manage` la usa senza cambi di comportamento (test esistenti verdi).
- `init.js`: estratta `runInit({ ctx, opts })`; l'action di `init` la richiama.
- `start.js` (nuovo): configurazione, cartella di lavoro, avvio come da requisiti.
- Launcher `scripts/start-managed.{command,sh,bat}` (LF/eseguibili; il .bat in CRLF).
- README e docs/GUIDA.md aggiornati.
- Test: `test/cli/cli-start.test.js` (18 test + 2 sui launcher).

## Scelta su init
Ho scelto la via "riusa il flusso": `start` chiama `runInit({ ctx, opts: {} })`, cioè la stessa configurazione guidata di `llmpod init` (chiave Runpod, token HF, datacenter, volume) senza stampare comandi da lanciare a mano. Il refactor di init è meccanico (stesso corpo, indentato). Dopo l'init `start` ricontrolla la configurazione e, se incompleta, si ferma con hint `llmpod init`.

## Punti di iniezione per i test
`createContext` espone ora `ctx.overrides` e `ctx.cwd()` (default `process.cwd()`); i test passano `overrides.cwd` e `overrides.runInit` (mock). Nessun `process.chdir` nei test.

## Comportamenti
- Configurato = `dataCenterId` presente e `RUNPOD_API_KEY` presente.
- Non configurato: interattivo e senza `--yes` → spiega, chiede "Configuro ora llmpod? (poi apro Claude Code)"; no → CANCELLED (exit 130) con hint `llmpod init`. Non interattivo o `--yes` → INVALID_INPUT "llmpod non è configurato: esegui prima `llmpod init`" con hint sulle alternative stdin/`--from-env`.
- Cartella: `--cwd`/`--dir`; altrimenti default = cartella corrente se ≠ PROJECT_DIR (realpath). Interattivo: `askText` col default (senza default il campo è obbligatorio; vuoto → INVALID_INPUT con hint `--cwd`); non interattivo o `--yes`: usa il default, oppure errore con hint `--cwd`.
- Il nome profilo è validato prima di qualsiasi domanda.
- Se la cartella scelta è PROJECT_DIR parte come `manage` (nessun flag).

## Verifica
- `npm test` (vitest 1164 test in 91 file + unittest Python 58 test): verde.
- `npm run build:web`: verde.
- Nessuna chiamata a Runpod/claude reali, spawn mockato, nessuna lettura di ~/.config/llmpod; test che verificano l'assenza di segreti in argv/env.

## Dubbi
- `--yes` in `start` vale solo per `start` (non è passato a init, che non viene eseguito con `--yes`).
- Lo script `.sh` non verifica che `node` sia installato (messaggio di errore della shell).
