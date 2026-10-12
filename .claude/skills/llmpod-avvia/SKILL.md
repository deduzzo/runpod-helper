---
name: llmpod-avvia
description: Avvia un LLM su Runpod con llmpod. Propone prima il set di modelli consigliato, calcola il piano, fa scegliere all'utente variante e GPU con prezzo e disponibilità, chiede conferma del costo e avvia il Pod in background seguendone l'avanzamento. Usala quando l'utente vuole avviare, accendere o provare un modello.
---

# Avviare un modello con llmpod

Rispondi in italiano. Nessuna spesa senza un "sì" esplicito dell'utente al costo mostrato.

## Passi

1. **Situazione attuale**: `status` (MCP). Se il profilo voluto ha già un Pod avviato, dillo e chiedi se usarlo
   invece di crearne un altro. Segnala i Pod spenti: costano ancora il disco (proponi di eliminarli).
2. **Profilo esistente?** `profiles`. Se l'utente vuole riusare un profilo salvato, salta al passo 6.
3. **Scelta del modello**: proponi **prima il set consigliato** con `model_sets` (senza argomenti l'elenco dei
   set; poi `model_sets { set: "abliterated" }`). Mostra l'**avviso del set**, e per ogni modello: variante,
   formato, pesi, MTP/DSpark, contesto consigliato. Metti in evidenza le varianti con **MTP o DSpark**.
   Se l'utente cerca altro: `search { query }` (le varianti MTP sono già in cima).
4. **Piano**: `plan { model: "<set>/<id>" }` (usa `planRef` di `model_sets`: revisione verificata e contesto
   consigliato) oppure `plan { model: "org/modello", context }`. Riporta gli avvisi del piano.
5. **Scelta della GPU**: tabella delle `options` utilizzabili (`available` e `fits`): GPU, numero, VRAM, margine,
   **prezzo/h**, disponibilità nel datacenter del volume o altrove (senza volume: pesi scaricati a ogni avvio).
   Fai scegliere all'utente, poi `save_profile { name, model: <model del piano>, gpu: { id, count } }`.
6. **Anteprima dell'avvio**: `up_preview { profile }`. Mostra le opzioni avviabili ORA con **costo orario e
   costo massimo** (`maxCostUSD`, secondo le ore massime del watchdog) e i limiti di spegnimento
   (inattività, ore massime). Chiedi quale GPU e la conferma esplicita del costo.
7. **Avvio**: `up { profile, gpu: { id, count, dataCenterId }, confirm: true, expectedHourlyUSD: <hourlyUSD
   dell'opzione scelta> }`. Se l'errore è `PRICE_CHANGED`, mostra il nuovo prezzo e richiedi conferma.
8. **Avanzamento**: `job_status { jobId }` e `job_events { jobId, since }` ogni 20–30 secondi (fasi: creazione,
   download dei pesi, caricamento, smoke test). Riassumi in breve. Se c'è una **domanda pendente**, mostrala
   all'utente così com'è (con il costo e la scadenza `expiresAt`: con il Pod acceso scade in 3 minuti e vale la
   risposta sicura) e rispondi con `job_answer` solo con la sua risposta. Se l'avvio fallisce il Pod viene
   eliminato da solo; per interrompere: `job_cancel { jobId, confirm: true }` (elimina il Pod).
9. **Pronto**: riporta GPU, costo/h, tempo di avvio, eventuale suggerimento di contesto, e i comandi di
   `client_commands { profile }` (`llmpod run claude|opencode|pi|zcode --profile …`). Mai la chiave.
10. Ricorda i limiti di spegnimento (si allungano con `/llmpod-stato` → keep) e che si spegne con `/llmpod-spegni`.

Da terminale (equivalente): `node src/cli/index.js search --set abliterated`, `plan <set>/<id>`, `save <nome>`,
`up <nome>` (interattivo: lo lancia l'utente, non tu).
