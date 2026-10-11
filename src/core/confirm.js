import { LlmpodError, Codes } from './errors.js';

export const fmtUSD = (n) => `${Number(n).toFixed(2).replace('.', ',')} $`;

async function confirm({ message, yes, dryRun, ask }) {
  if (dryRun) return { proceed: false, dryRun: true, message };
  if (yes) return { proceed: true, message };
  if (!(await ask(`${message}. Confermi?`, false))) throw new LlmpodError(Codes.CANCELLED, 'Operazione annullata');
  return { proceed: true, message };
}

export function confirmCost({ hourlyUSD, monthlyUSD, description, yes = false, dryRun = false, ask }) {
  const cost = monthlyUSD !== undefined
    ? `${fmtUSD(monthlyUSD)} al mese`
    : `${fmtUSD(hourlyUSD)}/h (${fmtUSD(hourlyUSD * 24)} se acceso 24 ore)`;
  return confirm({ message: `${description} — costo stimato ${cost}`, yes, dryRun, ask });
}

export function confirmAction({ description, yes = false, dryRun = false, ask }) {
  return confirm({ message: description, yes, dryRun, ask });
}
