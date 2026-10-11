import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

export function createPrompt({ input = process.stdin, output = process.stderr } = {}) {
  async function question(text, { muted = false } = {}) {
    const sink = new Writable({
      write(chunk, enc, cb) {
        if (!sink.muted) output.write(chunk, enc);
        cb();
      },
    });
    const rl = readline.createInterface({ input, output: sink, terminal: Boolean(input.isTTY) });
    try {
      output.write(text);
      sink.muted = muted;
      return (await rl.question('')).trim();
    } finally {
      rl.close();
      if (muted) output.write('\n');
    }
  }
  return {
    async ask(q, defYes = false) {
      const a = (await question(`${q} ${defYes ? '[S/n]' : '[s/N]'} `)).toLowerCase();
      return a ? ['s', 'si', 'sì', 'y', 'yes'].includes(a) : defYes;
    },
    async askText(q, def) {
      return (await question(def ? `${q} [${def}] ` : `${q} `)) || def || '';
    },
    askSecret: (q) => question(`${q} `, { muted: true }),
  };
}
