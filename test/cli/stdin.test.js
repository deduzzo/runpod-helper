import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { readSecretFromStdin } from '../../src/cli/stdin.js';
import { fakeStdin } from './helpers.js';

const opts = { flag: '--api-key-stdin', what: 'la chiave' };

describe('readSecretFromStdin', () => {
  it('legge la prima riga e rimuove spazi, CR e newline', async () => {
    expect(await readSecretFromStdin(fakeStdin('  SEGRETO-FINTO \r\naltra riga\n'), opts)).toBe('SEGRETO-FINTO');
    expect(await readSecretFromStdin(fakeStdin('SOLO'), opts)).toBe('SOLO');
  });

  it('si ferma alla prima riga anche se il flusso non termina', async () => {
    const s = new PassThrough();
    s.write('CHIAVE\n');
    expect(await readSecretFromStdin(s, opts)).toBe('CHIAVE');
  });

  it('errore chiaro se vuoto', async () => {
    for (const text of ['', '   \n', null]) {
      await expect(readSecretFromStdin(fakeStdin(text), opts)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/vuot/i) });
    }
  });

  it('errore chiaro se stdin è un terminale, con esempio di pipe', async () => {
    const err = await readSecretFromStdin(fakeStdin('x', { tty: true }), opts).catch((e) => e);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/terminale/);
    expect(err.hint).toMatch(/pbpaste|printf|\|/);
  });
});
