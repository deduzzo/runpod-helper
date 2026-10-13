# Report: `llmpod run <client>` chiede la cartella di lavoro

Stato: completato. Branch `feat/run-cwd-interattivo`.

## Cosa cambia
- `src/cli/commands/run.js`: nuova `chooseCwd` chiamata PRIMA di `ctx.ops.endpoint` (nessuna spesa su percorso errato).
  - zcode: nessuna cartella, nessuna domanda.
  - `--cwd` esplicito: `resolveCwd(opts.cwd)` (nessuna domanda, anche se interattivo).
  - interattivo senza `--cwd`: `io.askText('In quale cartella vuoi lavorare con il modello?', ctx.cwd())`; risposta vuota = cartella corrente; la risposta passa da `resolveCwd` (errore chiaro se non esiste).
  - non interattivo senza `--cwd`: nessuna domanda; si passa ESPLICITAMENTE `cwd = resolveCwd(ctx.cwd())` (cartella corrente, realpath) allo spawn. Scelta: cwd esplicito, così il comportamento è identico nei tre casi e testabile.
- Help di `--cwd` aggiornato per `run` e per l'alias `claude`.
- Documentazione: CLAUDE.md, skill llmpod-avvia, docs/GUIDA.md, README.md.
- Test aggiornato: il vecchio "senza --cwd non imposta cwd" ora verifica la cartella corrente.

## Test (test/cli/cli-pod.test.js, blocco "cartella di lavoro interattiva")
run pi interattivo con risposta; Invio; alias claude; --cwd con terminale interattivo (nessuna domanda); non interattivo (run pi e claude); cartella inesistente (errore, nessuno spawn, Runpod non contattato); zcode senza domanda; nessun segreto in argv/cwd/env.
`npm test`: 91 file / 1171 test JS + 58 Python verdi. `npm run build:web` verde.
