import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createPrompt } from '../../src/cli/prompt.js';

function setup() {
  const input = new PassThrough();
  const written = [];
  const output = { write: (s) => written.push(String(s)) };
  const prompt = createPrompt({ input, output });
  return { input, prompt, written: () => written.join('') };
}

// Evita che un prompt appeso blocchi la suite: fallisce dopo 2 s.
const within = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('prompt appeso')), 2000))]);

describe('createPrompt', () => {
  it('(a) due risposte bufferizzate in pipe', async () => {
    const { input, prompt } = setup();
    input.write('s\nciao\n');
    expect(await within(prompt.ask('Procedo?', false))).toBe(true);
    expect(await within(prompt.askText('Nome?', 'x'))).toBe('ciao');
    prompt.close();
  });

  it('(b) input terminato: valori predefiniti e nessuna promessa appesa', async () => {
    const { input, prompt } = setup();
    input.end();
    expect(await within(prompt.ask('Q?', true))).toBe(true);
    expect(await within(prompt.ask('Q?', false))).toBe(false);
    expect(await within(prompt.askText('Q?', 'x'))).toBe('x');
    expect(await within(prompt.askText('Q?'))).toBe('');
    expect(await within(prompt.askSecret('Q?'))).toBe('');
  });

  it('EOF mentre una domanda è in attesa la risolve col predefinito', async () => {
    const { input, prompt } = setup();
    const p = prompt.ask('Q?', true);
    setTimeout(() => input.end(), 20);
    expect(await within(p)).toBe(true);
  });

  it('(c) ultima riga senza newline seguita da end', async () => {
    const { input, prompt } = setup();
    input.write('s\nultima');
    input.end();
    expect(await within(prompt.ask('Q?', false))).toBe(true);
    expect(await within(prompt.askText('Q?', 'x'))).toBe('ultima');
    expect(await within(prompt.askText('Q?', 'x'))).toBe('x');
  });

  it('(d) askSecret non scrive sull\'output i caratteri digitati', async () => {
    const { input, prompt, written } = setup();
    input.write('segretissimo\n');
    expect(await within(prompt.askSecret('Chiave:'))).toBe('segretissimo');
    expect(written()).toContain('Chiave:');
    expect(written()).not.toContain('segretissimo');
    prompt.close();
  });
});
