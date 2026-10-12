import { LlmpodError, Codes } from './errors.js';

export const IDLE_MINUTES_RANGE = [0, 1440];
export const MAX_HOURS_RANGE = [0.25, 168];

function bounded(value, [low, high], label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new LlmpodError(Codes.INVALID_INPUT, `${label} deve essere un numero`);
  if (value < low || value > high) throw new LlmpodError(Codes.INVALID_INPUT, `${label} deve essere tra ${low} e ${high}`);
  return value;
}

// Valida i limiti di spegnimento da cambiare su un Pod avviato. null/assente = invariato; idleMinutes 0 = nessuno spegnimento per inattività.
export function validateWatchdog(input) {
  const none = () => new LlmpodError(Codes.INVALID_INPUT, 'Indica almeno un limite da cambiare (inattività o ore massime)');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw none();
  const idleMinutes = bounded(input.idleMinutes, IDLE_MINUTES_RANGE, 'Inattività (minuti)');
  const maxHours = bounded(input.maxHours, MAX_HOURS_RANGE, 'Ore massime');
  if (idleMinutes === null && maxHours === null) throw none();
  return { idleMinutes, maxHours };
}

// Costo massimo fino alla scadenza per durata massima: ore rimanenti (dall'avvio) × costo orario.
export function maxCostUSD({ hourlyUSD, maxSeconds, uptimeSeconds }) {
  return Math.max(0, ((maxSeconds - uptimeSeconds) / 3600) * (hourlyUSD ?? 0));
}

export const fmtHours = (seconds) => `${String(Number((seconds / 3600).toFixed(1))).replace('.', ',')} h`;
