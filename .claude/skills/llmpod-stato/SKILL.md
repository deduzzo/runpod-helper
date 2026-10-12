---
name: llmpod-stato
description: Stato di llmpod e monitoraggio dei Pod Runpod. Elenca i Pod avviati, in avvio, spenti e in eliminazione con costi e limiti di spegnimento, legge metriche di vLLM (token/s, KV cache, accettazione MTP/DSpark, errori) e log, e se richiesto allunga i limiti con conferma del costo massimo. Usala per "come sta il Pod", costi, prestazioni o log.
---

# Stato e monitoraggio

Rispondi in italiano. Sola lettura, salvo `keep` (che chiede conferma).

## Passi

1. `status { all: true }`: per ogni gruppo (avviati, in avvio, spenti, in eliminazione) riporta profilo, Pod, GPU, costo/h,
   uptime, costo della sessione e limiti di spegnimento (inattività e ore massime residue). Credito residuo e
   volume. **Pod spenti**: costano ancora il disco → proponi `/llmpod-spegni`. Pod "orfani": segnalali.
   `otherAccountPods`: altri Pod dell'account (non llmpod), solo da elencare: non toccarli.
2. Job in corso (`status.jobs`): `job_status` e, se c'è una domanda pendente, mostrala all'utente.
3. **Prestazioni** di un Pod avviato: `metrics { profile, window: 10 }` (durante l'uso reale, altrimenti i tassi
   sono 0). Riporta:
   - token/s di generazione e di prompt, richieste in corso e in coda;
   - uso della KV cache in % (e token totali della KV);
   - accettazione MTP/DSpark: % dei token proposti, lunghezza media accettata, per posizione (totale e finestra);
   - errori: interrotte, preemption, HTTP 5xx nella finestra.
   Interpreta i numeri con la tabella "Quando e come fare tuning" di CLAUDE.md e, se serve, proponi `/llmpod-tune`.
4. **Log**: `logs { profile, limit: 100 }`; per seguire, ripeti con `since` = `cursor` precedente (mai
   `llmpod logs --follow` dalla shell: non termina). Cerca errori (OOM, traceback, parser) e spiegali.
5. **Tenere acceso più a lungo** (solo se l'utente lo chiede): `keep_preview { profile, maxHours | idleMinutes }`,
   mostra nuova scadenza e **costo massimo**, chiedi conferma, poi `keep { …, confirm: true }`
   (`save: true` solo se vuole lo stesso limite anche nei prossimi avvii).

Da terminale: `node src/cli/index.js status --all`, `metrics <profilo> --json`, `logs <profilo> --since <n>`.
