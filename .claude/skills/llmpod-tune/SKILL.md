---
name: llmpod-tune
description: Tuning di vLLM su un Pod llmpod avviato. Legge le metriche, consulta le recipe ufficiali di vLLM, propone un cambiamento degli argomenti (KV cache, max-num-seqs, contesto, token speculativi MTP/DSpark, gpu-memory-utilization), ne mostra diff e memoria, chiede conferma e ricarica vLLM senza eliminare il Pod. Usala per migliorare prestazioni, contesto o errori di memoria.
---

# Tuning di vLLM

Rispondi in italiano. La ricarica interrompe il servizio per alcuni minuti; il Pod resta acceso e continua a costare.

## Passi

1. **Permesso**: se il Pod è in uso (richieste in corso in `metrics`, o l'utente ci sta lavorando), chiedi
   prima se si può interrompere.
2. **Misura**: `metrics { profile, window: 15 }` durante un carico tipico; annota token/s, KV %, coda,
   preemption, accettazione MTP/DSpark (totale e per posizione), errori. Se serve, `logs`.
3. **Riferimenti**: recipe ufficiale vLLM del modello (https://github.com/vllm-project/recipes), `data/model-sets.json`
   (draft e contesto consigliato), `data/parsers.json`, `data/vllm-flags-v0.30.0.json` (flag validi).
4. **Proposta** (un cambiamento alla volta), secondo la tabella di CLAUDE.md:
   - KV piena / preemption → `kv-cache-dtype=fp8`, meno `max-num-seqs`, o `max-model-len` più basso;
   - accettazione MTP/DSpark bassa → `speculative-config={"method":"mtp","num_speculative_tokens":1}` (per DSpark
     l'argomento della recipe con meno token); alta su tutte le posizioni → prova un token in più;
   - OOM → `gpu-memory-utilization=0.85` o meno contesto;
   - contesto insufficiente → `max-model-len` più alto (tune verifica che entri).
   Mai revisione, numero di GPU, chiave, host, porta o nome servito.
5. **Anteprima**: `tune_preview { profile, set: ["chiave=valore"] }`. Mostra diff (prima → dopo), stima di
   memoria per GPU (necessaria / utilizzabile), cambio di contesto e flag sconosciuti. Se rifiuta per memoria,
   proponi un'alternativa.
6. **Conferma esplicita** dell'utente ("vLLM verrà ricaricato: interruzione di alcuni minuti; il Pod resta",
   con il costo orario). Chiedi anche se salvare nel profilo (`save`).
7. **Applica**: `tune { profile, set, confirm: true, save }` → `jobId`; segui con `job_status`/`job_events`.
   Se fallisce compare la domanda "Tornare agli argomenti precedenti?": mostrala all'utente e rispondi con
   `job_answer` secondo la sua risposta (di solito sì).
8. **Verifica**: di nuovo `metrics` con lo stesso carico e confronta prima/dopo. Se non migliora, proponi di
   tornare indietro (un altro `tune`).

Da terminale: `node src/cli/index.js tune <profilo> --set k=v --dry-run` (anteprima); senza `--dry-run` lo lancia
l'utente, che conferma nel terminale.
