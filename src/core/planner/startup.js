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

// Configurazione di caricamento: disco locale o volume di rete, una o più GPU (le misure valgono solo per la stessa).
export const loadKeyOf = ({ withVolume = false, count = 1 }) => `${withVolume ? 'volume' : 'local'}-${count > 1 ? 'multi' : 'single'}`;

// observed (observedStartup): velocità misurate negli avvii precedenti; dove mancano valgono le costanti prudenti.
export function estimateStartup({ downloadBytes, weightsBytes, count = 1, withVolume = false, cached = false, hourlyUSD = null, observed = null }) {
  const weightsGiB = (weightsBytes ?? downloadBytes ?? 0) / GiB;
  const bytesPerSecond = observed?.downloadBytesPerSecond ?? DOWNLOAD_BYTES_PER_SECOND;
  const downloadSeconds = cached ? 0 : Math.round((downloadBytes ?? weightsBytes ?? 0) / bytesPerSecond);
  const factor = (withVolume ? NETWORK_VOLUME_FACTOR : 1) * (count > 1 ? MULTI_GPU_FACTOR : 1);
  const measuredLoad = observed?.loadSecondsPerGiB?.[loadKeyOf({ withVolume, count })] ?? null;
  const loadSeconds = Math.round(weightsGiB * (measuredLoad ?? LOAD_SECONDS_PER_GiB * factor));
  const totalSeconds = FIXED_SECONDS + downloadSeconds + loadSeconds;
  const costUSD = Number.isFinite(hourlyUSD) && hourlyUSD > 0 ? Math.round((totalSeconds / 3600) * hourlyUSD * 100) / 100 : null;
  const measured = (!cached && observed?.downloadBytesPerSecond != null) || measuredLoad != null;
  return { totalSeconds, fixedSeconds: FIXED_SECONDS, downloadSeconds, loadSeconds, cached: Boolean(cached), costUSD, measured };
}

const minutes = (s) => Math.max(1, Math.round(s / 60));

export function startupText(e) {
  const cost = e.costUSD != null ? ` ≈ ${fmtUSD(e.costUSD)} prima che il modello sia pronto` : '';
  const download = e.cached ? 'pesi già sul volume' : `download ~${minutes(e.downloadSeconds)}`;
  const source = e.measured ? '; velocità misurate negli avvii precedenti' : '';
  return `avvio stimato ~${minutes(e.totalSeconds)} min (${download}, caricamento dei pesi ~${minutes(e.loadSeconds)}${source})${cost}`;
}

// Download più brevi di così non si misurano (pesi già presenti, cache): la velocità sarebbe senza senso.
const MIN_DOWNLOAD_MS = 30_000;
const KEEP = 5;

// Misura un avvio dagli stati del supervisore: il download dal primo stato "downloading" al primo stato successivo,
// il caricamento dal tempo della barra di vLLM a fine del primo passaggio (il secondo è il draft MTP).
export function createStartupMeter({ now, downloadBytes, weightsBytes, count = 1, withVolume = false }) {
  let downloadStart = null;
  let downloadMs = null;
  let loadSeconds = null;
  return {
    observe(st) {
      if (st.phase === 'downloading') {
        if (downloadStart == null) downloadStart = now();
      } else if (downloadStart != null && downloadMs == null) {
        downloadMs = now() - downloadStart;
      }
      const lp = st.loadProgress;
      if (lp?.total && lp.done >= lp.total && (lp.pass ?? 1) === 1 && lp.elapsedSeconds > 0 && loadSeconds == null) loadSeconds = lp.elapsedSeconds;
    },
    result() {
      const weightsGiB = (weightsBytes ?? downloadBytes ?? 0) / GiB;
      return {
        downloadBytesPerSecond: downloadMs >= MIN_DOWNLOAD_MS && downloadBytes > 0 ? downloadBytes / (downloadMs / 1000) : null,
        loadKey: loadKeyOf({ withVolume, count }),
        loadSecondsPerGiB: loadSeconds != null && weightsGiB > 0 ? loadSeconds / weightsGiB : null,
      };
    },
  };
}

// Conserva in state.json le ultime misure (KEEP per tipo).
export function rememberStartupStats(state, r) {
  const stats = state.startupStats ?? { download: [], load: {} };
  const keep = (list, v) => [...(list ?? []), v].slice(-KEEP);
  const next = { download: stats.download ?? [], load: { ...(stats.load ?? {}) } };
  if (r.downloadBytesPerSecond > 0) next.download = keep(next.download, r.downloadBytesPerSecond);
  if (r.loadSecondsPerGiB > 0) next.load[r.loadKey] = keep(next.load[r.loadKey], r.loadSecondsPerGiB);
  return { ...state, startupStats: next };
}

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Velocità osservate (mediana delle ultime misure) per estimateStartup; null senza misure.
export function observedStartup(state) {
  const stats = state?.startupStats;
  if (!stats) return null;
  const load = Object.fromEntries(Object.entries(stats.load ?? {}).filter(([, l]) => l.length).map(([k, l]) => [k, median(l)]));
  const download = stats.download?.length ? median(stats.download) : null;
  if (download == null && !Object.keys(load).length) return null;
  return { downloadBytesPerSecond: download, loadSecondsPerGiB: load };
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
