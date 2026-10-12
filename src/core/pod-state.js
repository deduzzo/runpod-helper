// Stato di un Pod llmpod come lo mostrano CLI e interfaccia: avviato, in avvio o spento.
// Un Pod spento (EXITED) NON è gratis: continua a costare lo spazio su disco finché non viene eliminato.
export const STOPPED_STATUSES = ['EXITED', 'STOPPED'];
const STARTING_STATUSES = ['CREATED', 'STARTING', 'RESTARTING', 'PENDING', 'INITIALIZING', 'PROVISIONING'];

export function podState(status) {
  if (status === 'RUNNING') return { state: 'running', label: 'avviato' };
  if (STOPPED_STATUSES.includes(status)) return { state: 'stopped', label: 'spento' };
  if (STARTING_STATUSES.includes(status)) return { state: 'starting', label: 'in avvio' };
  return { state: 'unknown', label: String(status ?? '?').toLowerCase() };
}

// diskGB: campo `disk` del Pod (GB). Nessuna cifra di costo: Runpod non la fornisce per i Pod spenti.
export const STOPPED_WARNING = (profile, diskGB = null) => `Spento: occupa ancora ${diskGB != null ? `${diskGB} GB di disco` : 'disco'} e continua a costare — eliminalo con llmpod down ${profile}`;
