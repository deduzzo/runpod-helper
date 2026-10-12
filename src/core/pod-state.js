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

export const STOPPED_WARNING = (profile) => `Spento ma costa ancora lo spazio su disco: eliminalo con llmpod down ${profile}`;
