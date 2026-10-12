import { fmtUSD } from '../confirm.js';

// Stima del tempo di avvio di un Pod (fino a vLLM pronto) e del suo costo: il Pod si paga anche mentre scarica e carica.
// Valori prudenti, non misure: servono a far vedere all'utente l'ordine di grandezza prima della conferma.
const GiB = 1024 ** 3;
// Avvio del Pod, immagine di vLLM, KV cache, compilazione e CUDA graph.
export const FIXED_SECONDS = 300;
// Download da Hugging Face (se i pesi sono già sul volume di rete questa parte si salta).
export const DOWNLOAD_BYTES_PER_SECOND = 100e6;
// Lettura dei pesi in GPU: ~0,5 GiB/s con una GPU e un modello fino a 100 GiB.
export const LOAD_SECONDS_PER_GiB = 2;
// Collaudo del 12/10/2026: 126 GiB su 2× RTX PRO 6000 (PCIe), ~7 s per shard da ~0,6 GiB (~11,7 s/GiB). I due fattori
// insieme (2 × 3 × 2 = 12 s/GiB) riproducono quella misura.
export const MULTI_GPU_FACTOR = 3;
export const LARGE_MODEL_GiB = 100;
export const LARGE_MODEL_FACTOR = 2;

export function estimateStartup({ downloadBytes, weightsBytes, count = 1, hourlyUSD = null }) {
  const weightsGiB = (weightsBytes ?? downloadBytes ?? 0) / GiB;
  const downloadSeconds = Math.round((downloadBytes ?? weightsBytes ?? 0) / DOWNLOAD_BYTES_PER_SECOND);
  const factor = (count > 1 ? MULTI_GPU_FACTOR : 1) * (weightsGiB > LARGE_MODEL_GiB ? LARGE_MODEL_FACTOR : 1);
  const loadSeconds = Math.round(weightsGiB * LOAD_SECONDS_PER_GiB * factor);
  const totalSeconds = FIXED_SECONDS + downloadSeconds + loadSeconds;
  const costUSD = Number.isFinite(hourlyUSD) && hourlyUSD > 0 ? Math.round((totalSeconds / 3600) * hourlyUSD * 100) / 100 : null;
  return { totalSeconds, fixedSeconds: FIXED_SECONDS, downloadSeconds, loadSeconds, costUSD };
}

const minutes = (s) => Math.max(1, Math.round(s / 60));

export function startupText(e) {
  const cost = e.costUSD != null ? ` ≈ ${fmtUSD(e.costUSD)} prima che il modello sia pronto` : '';
  return `avvio stimato ~${minutes(e.totalSeconds)} min (download ~${minutes(e.downloadSeconds)}, caricamento dei pesi ~${minutes(e.loadSeconds)})${cost}`;
}
