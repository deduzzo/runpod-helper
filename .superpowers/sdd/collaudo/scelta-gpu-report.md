# Report: scelta della GPU e Pod spenti

Branch `feat/scelta-gpu` (da `origin/main` c25a1ed). `npm test` e `npm run build:web` verdi (66 file e 761 test JS, 23 test Python).

## Scelta della GPU
- `plan.options` (src/core/planner/gpu-choice.js, plan.js): tutte le configurazioni che entrano in memoria, per costo, con id, nome, count, VRAM, per GPU, margine, costo, disponibilità nel datacenter preferito (`availableHere`) e globale (`available`, `elsewhere`). Le non disponibili ovunque restano elencate e sono marcate "non disponibile ora". `gpu` resta la più economica disponibile.
- `applyGpuChoice` / `parseGpuSpec` / `findOption`: imposta gpu, costo, `--tensor-parallel-size`, memoria per GPU, riordina le alternative; rifiuta GPU fuori elenco o non disponibili ovunque senza toccare il piano.
- CLI `plan`: `--gpu <id>[x<n>]`; domanda numerata "Quale GPU usare?" dopo la tabella solo se terminale interattivo e senza `--yes`/`--json`/`--gpu`; la scelta va in `last-plan.json`. `io.interactive` e `io.askChoice` nuovi (render.js, prompt.js).
- CLI `up` (ops.up con `askChoice`): rilegge la disponibilità, propone le GPU disponibili ora (VRAM, numero, prezzo, datacenter, disponibilità), predefinita quella del profilo o la più economica; conferma di costo invariata; con `--yes`/`--dry-run`/non interattivo nulla cambia; nessuna scelta = CANCELLED senza spesa. Con una sola opzione non chiede.
- Job web: `choose` in jobs.js (domanda `kind: 'choice'`, opzioni `{id,label}`, `defaultId`; risposta = id o `null` = annulla; scadenza/chiusura = `null`). `POST /api/jobs/:id/answer` valida per tipo (400 se non valida). `QuestionModal` rende i radio con Conferma/Annulla. `POST /api/profiles` accetta `gpu: {id, count}` (applicato a una copia: last-plan e planId non cambiano).
- Web `PlanView`: tabella con radio accessibili da tastiera, badge di disponibilità (HIGH/LOW, "solo altrove (dc)", "non disponibile ora"), comando e costo che seguono la scelta; la GPU viene inviata al salvataggio solo se diversa da quella del piano.

## Pod spenti (aggiunta 6)
- `status` (CLI, `--json`, `/api/status`, pagina Stato e costi): elenca tutti i Pod `llmpod-*` non TERMINATED con `state` (running/starting/stopped/unknown) e `stateLabel` (avviato / in avvio / spento); per gli spenti hourlyUSD 0, `storageUSD` (da `storageCostPerHr`/`storageCost` se Runpod lo fornisce, altrimenti null), avviso "Spento ma costa ancora lo spazio su disco: eliminalo con llmpod down <profilo>". Web: badge verde/ambra/arancio e pulsante "Elimina" (job `down` con conferma, JobPanel inline).
- `down`: elimina (DELETE) tutti i Pod del profilo, anche EXITED, accesi per primi.
- `up`: con un Pod EXITED del profilo propone di eliminarlo prima (con `--yes` lo elimina; con `--dry-run` solo avviso; se rifiutato resta con avviso).
- `destroy-volume`: ora si ferma anche per Pod spenti.
- Audit stop: nessuno stop trovato. Supervisore (`DELETE`), `ops.terminate`, `offerTerminate`, interrupt handler usano sempre DELETE. Aggiunto test statico (test/core/no-stop.test.js) che lo verifica.
- `scripts/stop.sh` e `stop.ps1`: avvisano anche dei Pod spenti ("è spento ma costa ancora lo spazio su disco: eliminalo con bin/llmpod down"); il messaggio per quelli accesi ora dice "eliminalo" invece di "fermalo". Si basano sull'ordine delle chiavi di `status --json` (profile, podId, status, state), coperto da test.
- README aggiornato (tabella comandi, sezione sulla scelta GPU, riga "llmpod elimina sempre i Pod, non li ferma", sezione stop).

## Test aggiunti
test/core/gpu-choice.test.js, plan.test.js (options), ops-pods.test.js (up scelta, saveProfile, status/down/up con Pod spenti), no-stop.test.js, test/server/jobs-choice.test.js, api-choice.test.js, test/cli/cli-gpu-choice.test.js (plan), cli-up-choice.test.js, cli-pods-stopped.test.js, test/scripts/start.test.js (Pod spenti), test/web/gpu-choice.test.jsx (QuestionModal, JobPanel, PlanView), pods-stopped.test.jsx. Test esistenti modificati solo dove cambia il comportamento voluto: testo di Stato senza Pod, messaggi di stop ("eliminalo"), dati di PlanView con `options: []`.

## Dubbi
- `storageCostPerHr` / `storageCost` sono nomi di campo ipotizzati per il costo di storage del Pod Runpod: non verificati senza credenziali; se assenti il costo non compare (resta l'avviso).
- `up` propone solo gpu + alternative salvate nel profilo (max 5), non tutte le opzioni del piano. Dopo la scelta si usa solo quella (nessun ripiego silenzioso su altre GPU); se non è più disponibile fallisce con NO_GPU_AVAILABLE.
- In `up` la domanda non compare con una sola GPU disponibile.
- `test/windows/wrappers.test.ps1` aggiornato ma non eseguibile qui (niente PowerShell).
- Lo `Scheda Profili` mostra ancora solo i profili; i Pod spenti senza profilo locale si eliminano dalla pagina Stato (down per nome profilo).
- Nel worktree `git` con rtk veniva bloccato dalla protezione dei worktree: usato `/usr/bin/git`, sempre sul worktree.
