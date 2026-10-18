import { describe, it, expect } from 'vitest';
import { progressOf, waitForReady, isNcclError } from '../../src/core/pod/launcher.js';

const GiB = 1024 ** 3;

describe('progressOf: avanzamento onesto di download e caricamento dei pesi', () => {
  it('download: percentuale e GiB scaricati sul totale', () => {
    expect(progressOf({ phase: 'downloading', downloadedBytes: 63 * GiB, totalBytes: 126 * GiB })).toEqual({ message: 'Download dei pesi: 50% (63 di 126 GiB)', ratio: 0.5 });
  });

  it('download: mai oltre il 99% finché la fase è ancora "downloading"', () => {
    expect(progressOf({ phase: 'downloading', downloadedBytes: 130 * GiB, totalBytes: 126 * GiB }).message).toMatch(/^Download dei pesi: 99%/);
  });

  it('caricamento con la barra di vLLM: file letti e minuti rimanenti', () => {
    const p = progressOf({ phase: 'loading', loadProgress: { done: 147, total: 206, percent: 71, elapsedSeconds: 1026, remainingSeconds: 412 } });
    expect(p).toEqual({ message: 'Caricamento dei pesi: 147/206 file, circa 7 min rimanenti', ratio: 147 / 206 });
  });

  it('caricamento: tempo rimanente ignoto o sotto il minuto', () => {
    expect(progressOf({ phase: 'loading', loadProgress: { done: 0, total: 206, remainingSeconds: null } }).message).toBe('Caricamento dei pesi: 0/206 file');
    expect(progressOf({ phase: 'loading', loadProgress: { done: 205, total: 206, remainingSeconds: 20 } }).message).toBe('Caricamento dei pesi: 205/206 file, meno di un minuto rimanente');
  });

  it('secondo passaggio sugli stessi shard (draft MTP): etichetta dedicata, non un passo indietro', () => {
    expect(progressOf({ phase: 'loading', loadProgress: { done: 85, total: 120, remainingSeconds: 20, pass: 2 } }).message)
      .toBe('Caricamento dei pesi del draft (passaggio 2): 85/120 file, meno di un minuto rimanente');
    expect(progressOf({ phase: 'loading', loadProgress: { done: 85, total: 120, remainingSeconds: 20, pass: 1 } }).message).toMatch(/^Caricamento dei pesi: 85/);
  });

  it('caricamento senza barra (o pesi già letti): messaggio generico senza percentuale', () => {
    expect(progressOf({ phase: 'loading' })).toEqual({ message: 'Caricamento del modello in GPU' });
    expect(progressOf({ phase: 'loading', loadProgress: { done: 206, total: 206, remainingSeconds: 0 } })).toEqual({ message: 'Pesi caricati: inizializzazione di vLLM (KV cache, compilazione, CUDA graph)' });
    expect(progressOf({ phase: 'ready' })).toEqual({ message: 'vLLM pronto' });
  });
});

describe('waitForReady: errore con la causa dal supervisore', () => {
  const sleep = async () => {};

  it('usa errorCause del supervisore e, per un errore NCCL, suggerisce il rimedio multi-GPU', async () => {
    const cause = "RuntimeError: Worker failed with error 'NCCL error: unhandled cuda error (run with NCCL_DEBUG=INFO for details)'";
    const sup = {
      logs: async () => ({ lines: [] }),
      status: async () => ({ phase: 'error', lastError: `vLLM terminato con codice 1 durante il caricamento dei pesi: nessun riavvio automatico — causa: ${cause}`, errorCause: cause, restarts: 0 }),
    };
    const err = await waitForReady({ sup, timeoutMs: 60_000, sleep }).catch((e) => e);
    expect(err.code).toBe('VLLM_ERROR');
    // la causa non si ripete se è già in lastError
    expect(err.message.match(/NCCL error/g)).toHaveLength(1);
    expect(err.hint).toMatch(/NCCL_P2P_DISABLE/);
    expect(err.details.rootCause).toContain(cause);
  });

  it('suggerimento NCCL anche se la riga NCCL è solo nei log (non nella causa); le righe del supervisore non contano', async () => {
    const lines = [
      { n: 1, line: '[llmpod] ambiente NCCL: NCCL_P2P_DISABLE=1' },
      { n: 2, line: "(Worker_TP0 pid=2) transport/shm.cc:590 NCCL WARN Cuda failure 217 'peer access is not supported between these two devices'" },
    ];
    let first = true;
    const sup = { logs: async () => { const r = first ? { lines } : { lines: [] }; first = false; return r; }, status: async () => ({ phase: 'error', lastError: 'vLLM terminato con codice 1', errorCause: 'RuntimeError: Engine core initialization failed. See root cause above.' }) };
    const err = await waitForReady({ sup, timeoutMs: 60_000, sleep }).catch((e) => e);
    expect(err.hint).toMatch(/NCCL/);
    expect(err.details.nccl).toBe(true);

    const only = { logs: async () => ({ lines: [{ n: 1, line: '[llmpod] ambiente NCCL: NCCL_P2P_DISABLE=1' }] }), status: async () => ({ phase: 'error', lastError: 'vLLM terminato con codice 1', errorCause: 'ValueError: x' }) };
    const err2 = await waitForReady({ sup: only, timeoutMs: 60_000, sleep }).catch((e) => e);
    expect(err2.details.nccl).toBe(false);
  });

  it('vLLM fermo dopo i pesi: suggerimento NCCL', async () => {
    const cause = 'vLLM fermo senza log da 30 minuti dopo il caricamento dei pesi (possibile blocco NCCL/P2P o compilazione molto lunga)';
    const sup = { logs: async () => ({ lines: [] }), status: async () => ({ phase: 'error', lastError: cause, errorCause: cause }) };
    const err = await waitForReady({ sup, timeoutMs: 60_000, sleep }).catch((e) => e);
    expect(err.details.nccl).toBe(true);
    expect(err.message.match(/fermo senza log/g)).toHaveLength(1);
  });

  it('righe NCCL WARN generiche (benigne con NCCL_DEBUG=WARN) + OOM: errore OOM, nessun suggerimento NCCL', async () => {
    const lines = [
      { n: 1, line: '(Worker_TP0 pid=2) NCCL WARN NET/Plugin: Failed to open libibverbs.so' },
      { n: 2, line: 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB' },
    ];
    let first = true;
    const sup = { logs: async () => { const r = first ? { lines } : { lines: [] }; first = false; return r; }, status: async () => ({ phase: 'error', lastError: 'vLLM terminato con codice 1' }) };
    const err = await waitForReady({ sup, timeoutMs: 60_000, sleep }).catch((e) => e);
    expect(err.code).toBe('OOM');
    expect(err.details.nccl).toBe(false);
  });

  it('isNcclError: solo errori veri, non gli avvisi NCCL WARN generici', () => {
    expect(isNcclError(['NCCL WARN NET/Plugin: Failed to open libibverbs.so'])).toBe(false);
    expect(isNcclError(["NCCL WARN Cuda failure 217 'peer access is not supported'"])).toBe(true);
    expect(isNcclError(['RuntimeError: NCCL error: unhandled cuda error'])).toBe(true);
    expect(isNcclError(['ncclInternalError: Internal check failed'])).toBe(true);
    expect(isNcclError(['[llmpod] ambiente NCCL: NCCL_P2P_DISABLE=1'])).toBe(false);
  });

  it('errorCause senza righe di log: la causa compare nel messaggio', async () => {
    const sup = { logs: async () => ({ lines: [] }), status: async () => ({ phase: 'error', lastError: 'vLLM terminato con codice 1', errorCause: 'ValueError: argomento non valido' }) };
    const err = await waitForReady({ sup, timeoutMs: 60_000, sleep }).catch((e) => e);
    expect(err.message).toBe('vLLM non è partito: vLLM terminato con codice 1 — causa: ValueError: argomento non valido');
  });
});
