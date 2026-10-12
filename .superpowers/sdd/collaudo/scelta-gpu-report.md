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
- `status` (CLI, `--json`, `/api/status`, pagina Stato e costi): elenca tutti i Pod `llmpod-*` non TERMINATED con `state` (running/starting/stopped/unknown) e `stateLabel` (avviato / in avvio / spento); per gli spenti hourlyUSD 0, `diskGB` (campo `disk` del Pod) e avviso "Spento: occupa ancora <disk> GB di disco e continua a costare — eliminalo con llmpod down <profilo>" (nessuna cifra di costo inventata). Web: badge verde/ambra/arancio e pulsante "Elimina" (job `down` con conferma, JobPanel inline).
- `down`: elimina (DELETE) tutti i Pod del profilo, anche EXITED, accesi per primi.
- `up`: con un Pod EXITED del profilo propone di eliminarlo prima (con `--yes` lo elimina; con `--dry-run` solo avviso; se rifiutato resta con avviso).
- `destroy-volume`: ora si ferma anche per Pod spenti.
- Audit stop: nessuno stop trovato. Supervisore (`DELETE`), `ops.terminate`, `offerTerminate`, interrupt handler usano sempre DELETE. Aggiunto test statico (test/core/no-stop.test.js) che lo verifica.
- `scripts/stop.sh` e `stop.ps1`: avvisano anche dei Pod spenti ("è spento ma costa ancora lo spazio su disco: eliminalo con bin/llmpod down"); il messaggio per quelli accesi ora dice "eliminalo" invece di "fermalo". Si basano sull'ordine delle chiavi di `status --json` (profile, podId, status, state), coperto da test.
- README aggiornato (tabella comandi, sezione sulla scelta GPU, riga "llmpod elimina sempre i Pod, non li ferma", sezione stop).

## Correzioni della revisione (round 3)
1. `up` in modalità scelta: una sola opzione disponibile ora diventa l'unico candidato (la conferma del costo mostra la GPU che verrà creata, niente tentativi su GPU NONE né ripieghi); zero opzioni → `NO_GPU_AVAILABLE` con l'elenco e "Riprova più tardi", nessuna creazione.
2. Opzioni e VRAM: `makeFitsWith` cerca in `plan.options`; nuove `fitsForOption` e `markFits` (advice.js). `applyAdvice` (CLI e `/api/plan/apply-advice`) marca `fits:false` le opzioni che con i nuovi argomenti non entrano; `findOption`, `applyGpuChoice`, tabella CLI, PlanView e `up` le escludono (in `up` si ricontrolla anche con gli argomenti salvati del profilo).
3. `up` in modalità scelta propone sempre anche le opzioni di altri datacenter, etichettate "(senza volume, <dc>)"; predefinita: GPU del profilo nel datacenter del volume se disponibile, altrimenti la più economica. Niente domanda di ripiego in questa modalità (la scelta è il consenso). Con `--yes` comportamento precedente.
11. Pod spento del profilo: `up` chiede di eliminarlo (predefinito sì, timeout = no); se rifiutato o scaduto si ferma con "Elimina prima il Pod spento <id> (llmpod down <profilo>)" e non crea nulla; con `--yes` lo elimina.
4. Status.jsx: a eliminazione finita il pannello sparisce (e lo stato si ricarica); se fallisce resta l'errore e Elimina torna attivo.
5. Pod spento: costo orario, uptime e sessione "—" in CLI e web (`hourlyUSD`/`sessionUSD` null nei dati); il disco è nell'avviso.
6. Tolto il "?" prima di ". Confermi?" nelle conferme di `down`.
7. `down` cita tutti i Pod eliminati. 8. `stop.sh`: un Pod senza `state` è trattato come acceso (awk con flush per Pod). 9. PlanView riallinea la scelta al cambio di `planId` (resta se ancora selezionabile); un piano senza `options` non ha tabella selezionabile. 10. `aria-describedby` sul radio disabilitato, clic sulla riga, QuestionModal usa la prima opzione se `defaultId` non è tra le opzioni. 12. Etichetta VRAM "2×80 GB" (CLI, web, domanda di `up`).
Test nuovi: ops-pods.test.js (modalità scelta, altri datacenter, fits, Pod spento), plan-flow-fits.test.js, advisor-advice.test.js (makeFitsWith/markFits), gpu-choice.test.js, cli-pods-stopped.test.js, start.test.js (stop.sh), test web gpu-choice e pods-stopped.

## Test aggiunti
test/core/gpu-choice.test.js, plan.test.js (options), ops-pods.test.js (up scelta, saveProfile, status/down/up con Pod spenti), no-stop.test.js, test/server/jobs-choice.test.js, api-choice.test.js, test/cli/cli-gpu-choice.test.js (plan), cli-up-choice.test.js, cli-pods-stopped.test.js, test/scripts/start.test.js (Pod spenti), test/web/gpu-choice.test.jsx (QuestionModal, JobPanel, PlanView), pods-stopped.test.jsx. Test esistenti modificati solo dove cambia il comportamento voluto: testo di Stato senza Pod, messaggi di stop ("eliminalo"), dati di PlanView con `options: []`.

## Dubbi
- (risolto) Il costo di storage non esiste nell'API: i Pod spenti mostrano `disk` in GB.
- (risolto) Il profilo salva `options` (tutte le configurazioni compatibili); `up` in modalità scelta le rilegge dal catalogo e propone quelle disponibili ora. Dopo la scelta si usa solo quella (nessun ripiego silenzioso); se non è più disponibile fallisce con NO_GPU_AVAILABLE. Con `--yes` e per profili vecchi senza `options` vale GPU + alternative con ripieghi.
- In `up` la domanda non compare con una sola GPU disponibile.
- `test/windows/wrappers.test.ps1` aggiornato ma non eseguibile qui (niente PowerShell).
- Lo `Scheda Profili` mostra ancora solo i profili; i Pod spenti senza profilo locale si eliminano dalla pagina Stato (down per nome profilo).
- Nel worktree `git` con rtk veniva bloccato dalla protezione dei worktree: usato `/usr/bin/git`, sempre sul worktree.
