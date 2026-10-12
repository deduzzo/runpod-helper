import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmpodError, Codes } from '../core/errors.js';

// Risolve l'opzione --cwd in un percorso assoluto di una cartella esistente (undefined se non indicata).
// Il percorso va sempre passato a spawn come opzione/argomento (mai in una stringa di shell).
export function resolveCwd(value) {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) throw new LlmpodError(Codes.INVALID_INPUT, 'La cartella indicata con --cwd è vuota', { hint: 'Esempio: --cwd ~/mio-progetto' });
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const abs = path.resolve(expanded);
  let st;
  try { st = fs.statSync(abs); } catch {
    throw new LlmpodError(Codes.INVALID_INPUT, `La cartella di lavoro non esiste: ${abs}`, { hint: 'Indica una cartella esistente, es. --cwd ~/mio-progetto' });
  }
  if (!st.isDirectory()) throw new LlmpodError(Codes.INVALID_INPUT, `Il percorso indicato con --cwd non è una cartella: ${abs}`, { hint: 'Indica la cartella del progetto, non un file' });
  return fs.realpathSync(abs);
}
