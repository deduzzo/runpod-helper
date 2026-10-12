import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sandbox, SECRETS } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const fakeSpawn = (code = 0, error = null) => vi.fn(() => {
  const child = new EventEmitter();
  setImmediate(() => (error ? child.emit('error', error) : child.emit('exit', code)));
  return child;
});
const mkdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-start-')));

// Sandbox con llmpod già configurato (datacenter + chiave Runpod finta).
function configured(answers = {}) {
  const s = sandbox({ answers });
  s.store.ensureDir();
  s.store.writeConfig({ dataCenterId: 'EU-A' });
  s.store.writeEnv({ RUNPOD_API_KEY: SECRETS.RUNPOD_API_KEY });
  return s;
}
const noSecrets = (spawn) => {
  const [, args, opts] = spawn.mock.calls[0];
  const all = JSON.stringify([args, opts.env]);
  for (const v of Object.values(SECRETS)) expect(all).not.toContain(v);
};

describe('llmpod start', () => {
  it('configurato + --cwd: claude parte nella cartella con i flag gestiti, senza domande né segreti', async () => {
    const s = configured();
    const dir = mkdir();
    const spawn = fakeSpawn(0);
    expect(await s.run(['start', '--cwd', dir], { spawn })).toBe(0);
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(opts.cwd).toBe(dir);
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.llmpod.args).toEqual([path.join(ROOT, 'src/mcp/server.js')]);
    expect(args[args.indexOf('--settings') + 1]).toBe(path.join(ROOT, '.claude/settings.json'));
    expect(args[args.indexOf('--add-dir') + 1]).toBe(ROOT);
    expect(opts.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(opts.shell).toBeUndefined();
    expect(s.prompt.ask).not.toHaveBeenCalled();
    expect(s.prompt.askText).not.toHaveBeenCalled();
    noSecrets(spawn);
  });

  it('--dir è un alias di --cwd e --profile aggiunge il prompt prima dei flag', async () => {
    const s = configured();
    const dir = mkdir();
    const spawn = fakeSpawn(0);
    expect(await s.run(['start', '--dir', dir, '--profile', 'p'], { spawn })).toBe(0);
    const [, args, opts] = spawn.mock.calls[0];
    expect(opts.cwd).toBe(dir);
    expect(args[0]).toMatch(/profilo llmpod "p"/);
    expect(args.findIndex((a) => a.startsWith('--'))).toBe(1);
  });

  it('configurato, interattivo, senza --cwd: chiede la cartella (default = cartella corrente) e avvia lì', async () => {
    const cur = mkdir();
    const chosen = mkdir();
    const s = configured({ interactive: true, text: [chosen] });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start'], { spawn, cwd: () => cur })).toBe(0);
    expect(s.prompt.askText).toHaveBeenCalledTimes(1);
    expect(s.prompt.askText.mock.calls[0][0]).toMatch(/In quale cartella vuoi lavorare\?/);
    expect(s.prompt.askText.mock.calls[0][1]).toBe(cur);
    expect(spawn.mock.calls[0][2].cwd).toBe(chosen);
    noSecrets(spawn);
  });

  it('interattivo: invio accetta la cartella corrente', async () => {
    const cur = mkdir();
    const s = configured({ interactive: true });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start'], { spawn, cwd: () => cur })).toBe(0);
    expect(spawn.mock.calls[0][2].cwd).toBe(cur);
  });

  it('interattivo: cartella inesistente → INVALID_INPUT senza avviare claude', async () => {
    const s = configured({ interactive: true, text: [path.join(mkdir(), 'non-esiste')] });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start'], { spawn, cwd: () => mkdir() })).toBe(1);
    expect(s.err()).toMatch(/INVALID_INPUT/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('interattivo con cwd = cartella del progetto: nessun default, la cartella è obbligatoria', async () => {
    const s = configured({ interactive: true, text: [''] });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start'], { spawn, cwd: () => ROOT })).toBe(1);
    expect(s.prompt.askText.mock.calls[0][1]).toBeUndefined();
    expect(s.err()).toMatch(/INVALID_INPUT/);
    expect(s.err()).toMatch(/--cwd/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('interattivo con cwd = progetto: indicando la cartella del progetto parte come manage (nessun flag)', async () => {
    const s = configured({ interactive: true, text: [ROOT] });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start'], { spawn, cwd: () => ROOT })).toBe(0);
    const [, args, opts] = spawn.mock.calls[0];
    expect(opts.cwd).toBe(ROOT);
    expect(args).toEqual([]);
  });

  it('--yes interattivo: usa la cartella corrente senza chiedere', async () => {
    const cur = mkdir();
    const s = configured({ interactive: true });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start', '--yes'], { spawn, cwd: () => cur })).toBe(0);
    expect(s.prompt.askText).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][2].cwd).toBe(cur);
  });

  it('non interattivo, senza --cwd, cwd ≠ progetto: usa la cartella corrente', async () => {
    const cur = mkdir();
    const s = configured();
    const spawn = fakeSpawn(0);
    expect(await s.run(['start'], { spawn, cwd: () => cur })).toBe(0);
    expect(spawn.mock.calls[0][2].cwd).toBe(cur);
    expect(s.prompt.askText).not.toHaveBeenCalled();
    noSecrets(spawn);
  });

  it('non interattivo, senza --cwd, cwd = progetto: errore con hint --cwd', async () => {
    const s = configured();
    const spawn = fakeSpawn(0);
    expect(await s.run(['start'], { spawn, cwd: () => ROOT })).toBe(1);
    expect(s.err()).toMatch(/INVALID_INPUT/);
    expect(s.err()).toMatch(/--cwd/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('non configurato, interattivo, l\'utente accetta: esegue init e poi avvia claude', async () => {
    const dir = mkdir();
    const s = sandbox({ answers: { interactive: true, ask: [true] } });
    const runInit = vi.fn(async ({ ctx }) => {
      ctx.store.writeConfig({ dataCenterId: 'EU-A' });
      ctx.store.writeEnv({ RUNPOD_API_KEY: SECRETS.RUNPOD_API_KEY });
    });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start', '--cwd', dir], { spawn, runInit })).toBe(0);
    expect(s.prompt.ask.mock.calls[0][0]).toMatch(/Configuro ora llmpod\?/);
    expect(s.err()).toMatch(/non è ancora configurato/);
    expect(runInit).toHaveBeenCalledTimes(1);
    expect(runInit.mock.calls[0][0].opts).toEqual({});
    expect(spawn.mock.calls[0][2].cwd).toBe(dir);
    noSecrets(spawn);
  });

  it('non configurato, init non completato: errore e claude non parte', async () => {
    const s = sandbox({ answers: { interactive: true, ask: [true] } });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start', '--cwd', mkdir()], { spawn, runInit: vi.fn(async () => {}) })).toBe(1);
    expect(s.err()).toMatch(/llmpod init/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('non configurato, interattivo, l\'utente rifiuta: CANCELLED con hint init', async () => {
    const s = sandbox({ answers: { interactive: true, ask: [false] } });
    const runInit = vi.fn();
    const spawn = fakeSpawn(0);
    expect(await s.run(['start', '--cwd', mkdir()], { spawn, runInit })).toBe(130);
    expect(s.err()).toMatch(/CANCELLED/);
    expect(s.err()).toMatch(/llmpod init/);
    expect(runInit).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('non configurato (manca solo la chiave), non interattivo: INVALID_INPUT con hint init e alternative stdin', async () => {
    const s = sandbox();
    s.store.ensureDir();
    s.store.writeConfig({ dataCenterId: 'EU-A' });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start', '--cwd', mkdir()], { spawn })).toBe(1);
    expect(s.err()).toMatch(/INVALID_INPUT/);
    expect(s.err()).toMatch(/non è configurato: esegui prima `llmpod init`/);
    expect(s.err()).toMatch(/--runpod-key-stdin/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('non configurato con --yes, anche in un terminale: INVALID_INPUT', async () => {
    const s = sandbox({ answers: { interactive: true } });
    const spawn = fakeSpawn(0);
    expect(await s.run(['start', '--yes', '--cwd', mkdir()], { spawn })).toBe(1);
    expect(s.err()).toMatch(/non è configurato/);
    expect(s.prompt.ask).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('claude assente → istruzioni di installazione', async () => {
    const s = configured();
    const e = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    expect(await s.run(['start', '--cwd', mkdir()], { spawn: fakeSpawn(0, e) })).toBe(1);
    expect(s.err()).toMatch(/claude\.ai\/install\.sh|@anthropic-ai\/claude-code/);
  });
});

describe('launcher di start-managed', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
  it('.command e .sh: eseguibili, LF, lanciano "start" senza npm link', () => {
    for (const f of ['start-managed.command', 'start-managed.sh']) {
      const txt = read(f);
      expect(txt, f).not.toContain('\r');
      expect(txt.startsWith('#!/bin/sh\n'), f).toBe(true);
      expect(txt, f).toContain('exec node src/cli/index.js start "$@"');
      expect(fs.statSync(path.join(ROOT, 'scripts', f)).mode & 0o111, f).not.toBe(0);
    }
  });
  it('.bat: CRLF e lancia start con il percorso relativo allo script', () => {
    const txt = read('start-managed.bat');
    expect(txt).toContain('\r\n');
    expect(txt.replace(/\r\n/g, '')).not.toContain('\n');
    expect(txt).toContain('node "%~dp0..\\src\\cli\\index.js" start %*');
  });
});
