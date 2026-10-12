// Comunicazione tra GPU (NCCL) nei Pod multi-GPU: "modalità NCCL sicura".
//
// Su GPU PCIe senza NVLink (RTX/GeForce, RTX PRO "Server/Workstation Edition", RTX A-series, L4/L40/L40S, A10/A16/A40,
// A100/H100 PCIe) il trasporto P2P di NCCL e l'all-reduce personalizzato di vLLM possono fallire nelle macchine virtuali dei
// cloud (IOMMU/ACS): vLLM con tensor parallel si ferma con "NCCL error: unhandled cuda error" o resta bloccato, anche dopo
// molti minuti di caricamento dei pesi (collaudo del 12/10/2026: 2× RTX PRO 6000 Blackwell Server Edition, TP=2).
//
// Modalità sicura (solo con più GPU senza NVLink completo, salvo --no-nccl-safe):
// - NCCL_P2P_DISABLE=1 (PCIe pure): NCCL passa per la memoria condivisa dell'host, un po' più lento ma stabile;
//   NCCL_P2P_LEVEL=NVL (NVLink parziale, H100/H200 NVL con bridge a coppie): P2P solo dove c'è NVLink;
// - NCCL_CUMEM_HOST_ENABLE=0: rimedio documentato da vLLM per "transport/shm.cc … Cuda failure 217" con la memoria condivisa;
// - VLLM_ALLREDUCE_USE_SYMM_MEM=0 e --disable-custom-all-reduce: niente all-reduce di vLLM basati su accesso P2P diretto
//   (su Blackwell vLLM già avvisa "SymmMemCommunicator: Device capability 12.0 not supported");
// - NCCL_DEBUG=WARN: gli avvisi di NCCL finiscono nei log, così la causa di un errore è visibile.
//
// NCCL_IB_DISABLE non si imposta: InfiniBand serve solo tra nodi diversi e un Pod di llmpod è sempre un nodo solo, quindi
// non cambierebbe nulla e nasconderebbe un'altra causa.

// 'full': NVLink tra tutte le GPU (SXM/HGX: H100/H200/B200/B300, A100 SXM, GB200/GB300); 'partial': NVL (schede PCIe
// con bridge NVLink a coppie); 'none': PCIe pura (anche le varianti PCIe di A100/H100 e le GPU sconosciute).
export function nvlinkClass(gpuId) {
  const id = String(gpuId ?? '');
  if (/pcie/i.test(id)) return 'none';
  if (/\bnvl\b/i.test(id)) return 'partial';
  return /sxm|\bh100\b|\bh200\b|\bb200\b|\bb300\b|\bgb\d00\b/i.test(id) ? 'full' : 'none';
}

export const hasNvlink = (gpuId) => nvlinkClass(gpuId) !== 'none';

export const needsNcclSafe = (gpuId, count) => Number(count) > 1 && nvlinkClass(gpuId) !== 'full';

const COMMON_ENV = { VLLM_ALLREDUCE_USE_SYMM_MEM: '0', NCCL_CUMEM_HOST_ENABLE: '0', NCCL_DEBUG: 'WARN' };
export const NCCL_SAFE_ARGS = Object.freeze(['--disable-custom-all-reduce']);

// Variabili d'ambiente della modalità sicura per il Pod; ncclSafe === false (piano con --no-nccl-safe) le disattiva.
export function ncclEnv({ gpuId, count, ncclSafe = true }) {
  if (ncclSafe === false || !needsNcclSafe(gpuId, count)) return {};
  const p2p = nvlinkClass(gpuId) === 'partial' ? { NCCL_P2P_LEVEL: 'NVL' } : { NCCL_P2P_DISABLE: '1' };
  return { ...p2p, ...COMMON_ENV };
}

// Argomenti di vLLM con quelli della modalità sicura (senza duplicati).
export function ncclArgs(args, { gpuId, count, ncclSafe = true }) {
  if (ncclSafe === false || !needsNcclSafe(gpuId, count)) return [...args];
  return [...args, ...NCCL_SAFE_ARGS.filter((a) => !args.includes(a))];
}

export const NCCL_WARNING = 'NCCL:';

// Avviso del piano sulla GPU scelta (rigenerato a ogni cambio di GPU, come quello NVFP4).
export function refreshNcclWarning(plan) {
  if (!Array.isArray(plan.warnings)) return plan;
  plan.warnings = plan.warnings.filter((w) => !w.startsWith(NCCL_WARNING));
  const g = plan.gpu;
  if (g && needsNcclSafe(g.id, g.count)) {
    const what = nvlinkClass(g.id) === 'partial' ? 'NVLink solo a coppie (NVL)' : 'senza NVLink (PCIe)';
    const env = Object.entries(ncclEnv({ gpuId: g.id, count: g.count })).map(([k, v]) => `${k}=${v}`).join(', ');
    plan.warnings.push(plan.ncclSafe === false
      ? `${NCCL_WARNING} ${g.id} ×${g.count} ${what} e modalità NCCL sicura disattivata (--no-nccl-safe): rischio di "NCCL error: unhandled cuda error" o di blocco durante l'avvio`
      : `${NCCL_WARNING} ${g.id} ×${g.count} ${what}: il Pod parte in modalità NCCL sicura (${env}, --disable-custom-all-reduce) per evitare "NCCL error: unhandled cuda error"; comunicazione tra GPU un po' più lenta, disattivabile con llmpod plan … --no-nccl-safe`);
  }
  return plan;
}
