import fs from 'node:fs';
import path from 'node:path';
import { LlmpodError } from '../errors.js';

export function updateJsonFile(file, mutate, { invalidCode, label }) {
  let raw = null;
  let current = {};
  if (fs.existsSync(file)) {
    raw = fs.readFileSync(file, 'utf8');
    try {
      current = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      throw new LlmpodError(invalidCode, `La configurazione di ${label} (${file}) non è un JSON valido: non la modifico`, { cause: err, hint: 'Correggi il file a mano e riprova' });
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (raw !== null) {
    fs.writeFileSync(`${file}.llmpod-bak`, raw, { mode: 0o600 });
    fs.chmodSync(`${file}.llmpod-bak`, 0o600);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mutate(current), null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
