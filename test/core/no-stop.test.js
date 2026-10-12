import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Un Pod spento (EXITED) continua a costare il disco: llmpod deve sempre eliminare (DELETE), mai fermare (stop).
const SRC = new URL('../../src', import.meta.url).pathname;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe('i Pod si eliminano, non si fermano', () => {
  const files = walk(SRC).filter((f) => /\.(js|py)$/.test(f));

  it('nessuna chiamata di stop/hibernate ai Pod nel codice', () => {
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/pods\/[^'"`\s]*\/(stop|hibernate)|podStop|stopPod|podStopOrHibernate/);
    }
  });

  it('supervisore e client Runpod terminano con DELETE', () => {
    expect(fs.readFileSync(path.join(SRC, 'core/pod/supervisor.py'), 'utf8')).toMatch(/method='DELETE'/);
    expect(fs.readFileSync(path.join(SRC, 'core/runpod.js'), 'utf8')).toMatch(/'DELETE', `\/pods\//);
  });
});
