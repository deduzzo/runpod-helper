import { LlmpodError, Codes } from './errors.js';

// Inattività: intero, 0 = mai (nessuno spegnimento per inattività) oppure 5..1440 minuti. Ore massime: 0,25..168 dall'avvio.
export const IDLE_MINUTES_RANGE = [5, 1440];
export const MAX_HOURS_RANGE = [0.25, 168];
export const DEFAULT_WATCHDOG = { idleMinutes: 30, maxHours: 8 };
// Margine sotto cui non si accorcia la durata massima rispetto all'uptime: il Pod verrebbe eliminato quasi subito.
export const MIN_REMAINING_SECONDS = 300;

const IDLE_TEXT = `0 (mai) oppure un intero tra ${IDLE_MINUTES_RANGE[0]} e ${IDLE_MINUTES_RANGE[1]}`;

function idleError(value, label = 'Inattività (minuti)') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} deve essere un numero`;
  if (!Number.isInteger(value) || (value !== 0 && (value < IDLE_MINUTES_RANGE[0] || value > IDLE_MINUTES_RANGE[1]))) return `${label} deve essere ${IDLE_TEXT}`;
  return null;
}

function hoursError(value, label = 'Ore massime') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} deve essere un numero`;
  if (value < MAX_HOURS_RANGE[0] || value > MAX_HOURS_RANGE[1]) return `${label} deve essere tra ${String(MAX_HOURS_RANGE[0]).replace('.', ',')} e ${MAX_HOURS_RANGE[1]}`;
  return null;
}

// Valida i limiti di spegnimento da cambiare su un Pod avviato. null/assente = invariato; idleMinutes 0 = nessuno spegnimento per inattività.
export function validateWatchdog(input) {
  const none = () => new LlmpodError(Codes.INVALID_INPUT, 'Indica almeno un limite da cambiare (inattività o ore massime)');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw none();
  const { idleMinutes = null, maxHours = null } = input;
  const e = (idleMinutes !== null && idleError(idleMinutes)) || (maxHours !== null && hoursError(maxHours));
  if (e) throw new LlmpodError(Codes.INVALID_INPUT, e);
  if (idleMinutes === null && maxHours === null) throw none();
  return { idleMinutes, maxHours };
}

// Sezione `watchdog` di un profilo o della configurazione, se presente: tipi e intervalli (altrimenti il supervisore nel Pod la rifiuterebbe).
export function assertWatchdogSettings(wd, where) {
  if (wd === undefined || wd === null) return;
  const bad = (typeof wd !== 'object' || Array.isArray(wd)) ? 'deve essere un oggetto { idleMinutes, maxHours }'
    : (wd.idleMinutes !== undefined && idleError(wd.idleMinutes, 'idleMinutes')) || (wd.maxHours !== undefined && hoursError(wd.maxHours, 'maxHours'));
  if (bad) throw new LlmpodError(Codes.INVALID_INPUT, `Sezione watchdog non valida in ${where}: ${bad}`, { hint: 'idleMinutes: 0 (mai) oppure intero tra 5 e 1440; maxHours: tra 0,25 e 168' });
}

// Costo massimo fino alla scadenza per durata massima: ore rimanenti (dall'avvio) × costo orario. null se il costo orario non è noto.
export function maxCostUSD({ hourlyUSD, maxSeconds, uptimeSeconds }) {
  if (!hourlyUSD) return null;
  return Math.max(0, ((maxSeconds - uptimeSeconds) / 3600) * hourlyUSD);
}

export const fmtHours = (seconds) => `${String(Number((seconds / 3600).toFixed(2))).replace('.', ',')} h`;
export const idleText = (idleMinutes) => (idleMinutes === 0 ? 'inattività: mai' : `inattività: ${idleMinutes} min`);

// Il profilo mantiene il Pod acceso più a lungo del predefinito (inattività mai o più ore massime)?
export const exceedsDefaults = (wd) => Boolean(wd) && (wd.idleMinutes === 0 || wd.maxHours > DEFAULT_WATCHDOG.maxHours);
