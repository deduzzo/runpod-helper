---
name: llmpod-spegni
description: Spegne i Pod llmpod su Runpod eliminandoli (mai fermandoli) dopo conferma, poi verifica l'elenco completo dei Pod e riepiloga costi e risorse rimaste. Usala quando l'utente ha finito, vuole smettere di pagare o deve eliminare Pod spenti.
---

# Spegnere (eliminare) i Pod

Rispondi in italiano. **I Pod si eliminano, mai fermati**: un Pod spento costa ancora il disco.

## Passi

1. `status { all: true }`: elenca tutti i Pod llmpod (avviati, in avvio, spenti, in eliminazione) con profilo,
   GPU, costo/h, uptime e costo della sessione, e gli altri Pod dell'account (`otherAccountPods`, da non toccare).
2. Chiedi quali eliminare. **Non toccare Pod che l'utente sta usando** o di altri profili senza il suo permesso;
   se `metrics` mostra richieste in corso, avvisa prima.
3. Per ogni profilo confermato: `down { profile, confirm: true }` (elimina tutti i Pod del profilo, accesi o
   spenti, e annulla un `up`/`tune` in corso; il network volume con i pesi resta).
4. **Verifica finale**: controlla `allPods` della risposta e poi `status { all: true }`. Riporta l'elenco completo dei Pod
   rimasti (devono restare solo quelli che l'utente ha scelto di tenere) e il costo della sessione.
   Se un Pod risulta "in eliminazione", ricontrolla dopo un minuto.
5. Ricorda che il volume costa al mese (vedi `status.volume`) e si elimina solo con `llmpod destroy-volume`,
   che l'utente lancia da sé.

Da terminale: `node src/cli/index.js down <profilo>` (chiede conferma), poi `node src/cli/index.js status --all`.
Per qualunque dubbio sull'account: console https://www.runpod.io/console/pods.
