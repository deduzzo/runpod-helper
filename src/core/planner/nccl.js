// Comunicazione tra GPU (NCCL) nei Pod multi-GPU.
//
// Su GPU PCIe senza NVLink (RTX/GeForce, RTX PRO "Server/Workstation Edition", RTX A-series, L4/L40/L40S, A10/A16/A40,
// A100/H100 PCIe) il trasporto P2P di NCCL può fallire nelle macchine virtuali dei cloud (IOMMU/ACS): vLLM con
// tensor parallel si ferma con "NCCL error: unhandled cuda error", anche dopo molti minuti di caricamento dei pesi
// (collaudo del 12/10/2026: 2× RTX PRO 6000 Blackwell Server Edition, TP=2). Con NCCL_P2P_DISABLE=1 NCCL passa per la
// memoria condivisa dell'host: un po' più lento tra le GPU, ma stabile.
//
// NCCL_IB_DISABLE non si imposta: InfiniBand serve solo tra nodi diversi e un Pod di llmpod è sempre un nodo solo, quindi
// non cambierebbe nulla e nasconderebbe un'altra causa.

// NVLink presunto solo per le GPU SXM/HGX (H100/H200/B200/B300, A100 SXM, GB200/GB300); le varianti PCIe no.
export function hasNvlink(gpuId) {
  const id = String(gpuId ?? '');
  if (/pcie/i.test(id)) return false;
  return /sxm|\bh100\b|\bh200\b|\bb200\b|\bb300\b|\bgb\d00\b/i.test(id);
}

export const needsNcclSafe = (gpuId, count) => Number(count) > 1 && !hasNvlink(gpuId);

export const NCCL_SAFE_ENV = Object.freeze({ NCCL_P2P_DISABLE: '1' });

// Variabili d'ambiente NCCL per il Pod; ncclSafe === false (piano con --no-nccl-safe) le disattiva.
export function ncclEnv({ gpuId, count, ncclSafe = true }) {
  return ncclSafe !== false && needsNcclSafe(gpuId, count) ? { ...NCCL_SAFE_ENV } : {};
}

export const NCCL_WARNING = 'NCCL:';

// Avviso del piano sulla GPU scelta (rigenerato a ogni cambio di GPU, come quello NVFP4).
export function refreshNcclWarning(plan) {
  if (!Array.isArray(plan.warnings)) return plan;
  plan.warnings = plan.warnings.filter((w) => !w.startsWith(NCCL_WARNING));
  const g = plan.gpu;
  if (g && needsNcclSafe(g.id, g.count)) {
    plan.warnings.push(plan.ncclSafe === false
      ? `${NCCL_WARNING} ${g.id} ×${g.count} senza NVLink e protezione NCCL disattivata (--no-nccl-safe): rischio di "NCCL error: unhandled cuda error" durante l'avvio`
      : `${NCCL_WARNING} ${g.id} ×${g.count} senza NVLink (PCIe): il Pod parte con NCCL_P2P_DISABLE=1 per evitare "NCCL error: unhandled cuda error" (comunicazione tra GPU un po' più lenta; disattivabile con llmpod plan … --no-nccl-safe)`);
  }
  return plan;
}
