import { LlmpodError, Codes } from '../core/errors.js';

const MAX_BYTES = 64 * 1024;

// Legge un segreto dalla prima riga dello standard input (spazi, CR e newline rimossi).
// Il valore non compare mai nei messaggi d'errore. Con stdin collegato a un terminale rifiuta:
// la chiave verrebbe digitata in chiaro e il comando resterebbe in attesa.
export async function readSecretFromStdin(stdin, { flag, what }) {
  if (stdin.isTTY) {
    throw new LlmpodError(Codes.INVALID_INPUT, `${flag}: lo standard input è un terminale, non una pipe`, {
      hint: `Passa ${what} in pipe, per esempio: pbpaste | llmpod … ${flag}   oppure   read -rs K && printf '%s' "$K" | llmpod … ${flag}`,
    });
  }
  const text = await new Promise((resolve, reject) => {
    let buf = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.off('end', done);
      stdin.off('close', done);
      stdin.off('error', onError);
      stdin.pause?.();
      resolve(buf);
    };
    const onError = (err) => {
      stdin.off('data', onData);
      reject(new LlmpodError(Codes.INVALID_INPUT, `${flag}: lettura dello standard input non riuscita (${err.code ?? 'errore'})`));
    };
    const onData = (chunk) => {
      buf += String(chunk);
      if (buf.includes('\n') || buf.length > MAX_BYTES) done();
    };
    stdin.setEncoding?.('utf8');
    stdin.on('data', onData);
    stdin.on('end', done);
    stdin.on('close', done);
    stdin.on('error', onError);
  });
  const value = text.split('\n')[0].trim();
  if (!value) {
    throw new LlmpodError(Codes.INVALID_INPUT, `${flag}: lo standard input è vuoto, ${what} non è stata ricevuta`, {
      hint: `Passa ${what} in pipe, per esempio: pbpaste | llmpod … ${flag}`,
    });
  }
  return value;
}

// Le chiavi non si accettano come argomento della riga di comando (finirebbero nella cronologia della shell e
// nell'elenco dei processi). Le opzioni nascoste catturano il tentativo così il valore non viene mai ripetuto
// nei messaggi di errore di commander.
export function secretArgOption(Option, flag, stdinFlag) {
  return new Option(`${flag} <valore>`).hideHelp().argParser(() => {
    throw new LlmpodError(Codes.INVALID_INPUT, `${flag} non è accettata: una chiave nella riga di comando finirebbe nella cronologia della shell`, {
      hint: `Usa ${stdinFlag} e passa la chiave in pipe (vedi la sezione "Configurare senza terminale interattivo" della guida)`,
    });
  });
}
