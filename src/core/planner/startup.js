import { fmtUSD } from '../confirm.js';

// Stima del tempo di avvio di un Pod (fino a vLLM pronto) e del suo costo: il Pod si paga anche mentre scarica e carica.
// Valori prudenti, non misure: servono a far vedere all'utente l'ordine di grandezza prima della conferma.
const GiB = 1024 ** 3;
// Avvio del Pod, immagine di vLLM, KV cache, compilazione e CUDA graph.
export const FIXED_SECONDS = 300;
// Download da Hugging Face; si salta se i pesi della stessa revisione sono già sul volume (vedi weightsOnVolume).
export const DOWNLOAD_BYTES_PER_SECOND = 100e6;
// Lettura dei pesi in GPU dal disco locale del Pod: ~0,5 GiB/s. Il tempo cresce in modo lineare con la dimensione.
export const LOAD_SECONDS_PER_GiB = 2;
// Ipotesi (collaudo del 12/10/2026): 126 GiB letti dal volume di rete su 2× RTX PRO 6000 PCIe a ~7 s per shard da ~0,6 GiB
// (~11,4 s/GiB, cioè ~90 MB/s, tipico di uno storage di rete). Il fattore principale è quindi il volume di rete (×4); più GPU
// aggiungono la sincronizzazione tra i processi (×1,5). Insieme: 2 × 4 × 1,5 = 12 s/GiB, vicino alla misura.
export const NETWORK_VOLUME_FACTOR = 4;
export const MULTI_GPU_FACTOR = 1.5;

export function estimateStartup({ downloadBytes, weightsBytes, count = 1, withVolume = false, cached = false, hourlyUSD = null }) {
  const weightsGiB = (weightsBytes ?? downloadBytes ?? 0) / GiB;
  const downloadSeconds = cached ? 0 : Math.round((downloadBytes ?? weightsBytes ?? 0) / DOWNLOAD_BYTES_PER_SECOND);
  const factor = (withVolume ? NETWORK_VOLUME_FACTOR : 1) * (count > 1 ? MULTI_GPU_FACTOR : 1);
  const loadSeconds = Math.round(weightsGiB * LOAD_SECONDS_PER_GiB * factor);
  const totalSeconds = FIXED_SECONDS + downloadSeconds + loadSeconds;
  const costUSD = Number.isFinite(hourlyUSD) && hourlyUSD > 0 ? Math.round((totalSeconds / 3600) * hourlyUSD * 100) / 100 : null;
  return { totalSeconds, fixedSeconds: FIXED_SECONDS, downloadSeconds, loadSeconds, cached: Boolean(cached), costUSD };
}

const minutes = (s) => Math.max(1, Math.round(s / 60));

export function startupText(e) {
  const cost = e.costUSD != null ? ` ≈ ${fmtUSD(e.costUSD)} prima che il modello sia pronto` : '';
  const download = e.cached ? 'pesi già sul volume' : `download ~${minutes(e.downloadSeconds)}`;
  return `avvio stimato ~${minutes(e.totalSeconds)} min (${download}, caricamento dei pesi ~${minutes(e.loadSeconds)})${cost}`;
}

// Pesi del modello (stessa revisione) già scaricati sul volume del profilo: llmpod lo annota in state.json dopo un avvio
// riuscito con il volume. Vale solo per i candidati con il volume.
export function weightsOnVolume(state, profile, candidate) {
  const vol = profile.volume?.id;
  if (!candidate?.withVolume || !vol || !profile.model?.revision) return false;
  return state?.volumeWeights?.[vol]?.[profile.model.id] === profile.model.revision;
}

export function rememberWeightsOnVolume(state, profile) {
  const vol = profile.volume?.id;
  if (!vol) return state;
  state.volumeWeights = { ...(state.volumeWeights ?? {}), [vol]: { ...(state.volumeWeights?.[vol] ?? {}), [profile.model.id]: profile.model.revision } };
  return state;
}
