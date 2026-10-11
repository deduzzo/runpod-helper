import readline from 'node:readline';
import { Writable } from 'node:stream';
import { LlmpodError, Codes } from '../core/errors.js';

// Un'unica interfaccia readline per tutte le domande, con una coda di righe:
// le risposte in pipe non si perdono tra una domanda e l'altra.
// EOF -> risposta nulla (valore predefinito); Ctrl+C -> operazione annullata.
export function createPrompt({ input = process.stdin, output = process.stderr } = {}) {
  const isTty = Boolean(input.isTTY);
  const queue = [];
  let rl = null;
  let ended = false;
  let muted = false;
  let waiter = null;

  const sink = new Writable({
    write(chunk, enc, cb) {
      if (!muted) output.write(chunk, enc);
      cb();
    },
  });

  function settle(fn) {
    const w = waiter;
    waiter = null;
    if (w) fn(w);
  }

  function open() {
    if (rl || ended) return;
    const current = readline.createInterface({ input, output: sink, terminal: isTty });
    rl = current;
    current.on('line', (line) => {
      if (waiter) settle((w) => w.resolve(line));
      else queue.push(line);
    });
    current.on('close', () => {
      if (rl === current) rl = null;
      if (!current.intentionalClose) {
        ended = true;
        settle((w) => w.resolve(null));
      }
    });
    current.on('SIGINT', () => {
      settle((w) => w.reject(new LlmpodError(Codes.CANCELLED, 'Operazione annullata dall\'utente')));
      closeRl(current);
    });
  }

  function closeRl(current = rl) {
    if (!current) return;
    current.intentionalClose = true;
    current.close();
  }

  async function question(text, { secret = false } = {}) {
    output.write(text);
    let answer;
    if (queue.length) {
      answer = queue.shift();
    } else if (ended) {
      answer = null;
    } else {
      open();
      muted = secret;
      try {
        answer = await new Promise((resolve, reject) => { waiter = { resolve, reject }; });
      } finally {
        muted = false;
        // In un terminale l'interfaccia resta in raw mode finché è aperta: la chiudiamo
        // tra una domanda e l'altra, così Ctrl+C torna a funzionare durante i comandi.
        if (isTty) closeRl();
      }
    }
    if (secret) output.write('\n');
    return answer === null ? null : answer.trim();
  }

  return {
    async ask(q, defYes = false) {
      const a = await question(`${q} ${defYes ? '[S/n]' : '[s/N]'} `);
      if (!a) return defYes;
      return ['s', 'si', 'sì', 'y', 'yes'].includes(a.toLowerCase());
    },
    async askText(q, def) {
      return (await question(def ? `${q} [${def}] ` : `${q} `)) || (def ?? '');
    },
    async askSecret(q) {
      return (await question(`${q} `, { secret: true })) ?? '';
    },
    close() {
      closeRl();
    },
  };
}
