import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli/program.js';
import { createIo } from '../../src/cli/render.js';
import { createWorld, KEY, RUNPOD_KEY, ACTIVE_ARGS } from '../fixtures/fake-world.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function setup(worldOpts = {}, { answers = [] } = {}) {
  const w = createWorld(worldOpts);
  const out = [];
  const err = [];
  const prompt = { isTty: false, ask: vi.fn(async () => (answers.length ? answers.shift() : true)), askText: vi.fn(), askSecret: vi.fn() };
  const io = createIo({ stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, prompt });
  const sleep = vi.fn(async () => {});
  return {
    ...w, prompt, sleep,
    out: () => out.join(''), err: () => err.join(''), all: () => out.join('') + err.join(''),
    go: (argv, overrides = {}) => runCli(argv, { io, env: w.env, overrides: { runpod: w.runpod, http: w.http, sleep, ...overrides } }),
  };
}

describe('llmpod metrics', () => {
  it('--json: token/s, KV, accettazione MTP e stato del supervisore; finestra configurabile', async () => {
    const t = setup();
    expect(await t.go(['metrics', 'p', '--window', '5', '--json'])).toBe(0);
    const r = JSON.parse(t.out());
    expect(r.metrics.throughput.generationTokensPerSec).toBe(200);
    expect(r.metrics.speculative.total.meanAcceptedLength).toBe(2.25);
    expect(r.supervisor.phase).toBe('ready');
    expect(t.sleep).toHaveBeenCalledWith(5000);
    expect(t.all()).not.toContain(KEY);
  });

  it('testo leggibile in italiano', async () => {
    const t = setup();
    expect(await t.go(['metrics', 'p'])).toBe(0);
    expect(t.out()).toMatch(/Generazione: .*token\/s/);
    expect(t.out()).toMatch(/KV cache: 87,5 %|KV cache: 25 %/);
    expect(t.out()).toMatch(/Accettazione MTP/);
  });
});

describe('llmpod logs', () => {
  it('stampa le righe mascherate; --json con cursore', async () => {
    const t = setup();
    expect(await t.go(['logs', 'p'])).toBe(0);
    expect(t.out()).toMatch(/INFO pronto/);
    expect(t.out()).not.toContain(KEY);
    const j = setup();
    expect(await j.go(['logs', 'p', '--since', '2', '--json'])).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject({ cursor: 3, lines: [{ n: 3, line: 'INFO pronto' }] });
  });
});

describe('llmpod tune', () => {
  it('--dry-run mostra il diff e la memoria, senza ricaricare', async () => {
    const t = setup();
    expect(await t.go(['tune', 'p', '--set', 'max-num-seqs=4', '--dry-run'])).toBe(0);
    expect(t.out()).toMatch(/\+ --max-num-seqs 4/);
    expect(t.out()).toMatch(/Memoria per GPU/);
    expect(t.calls('/reload')).toHaveLength(0);
  });

  it('chiede conferma (interruzione) e ricarica; --save aggiorna il profilo', async () => {
    const t = setup();
    expect(await t.go(['tune', 'p', '--set', 'max-model-len=32768', '--save'])).toBe(0);
    expect(t.prompt.ask.mock.calls[0][0]).toMatch(/interruzione di alcuni minuti/);
    expect(t.calls('/reload', 'POST')[0][2].json.args).toEqual(expect.arrayContaining(['--max-model-len', '32768']));
    expect(t.store.readProfile('p').context).toBe(32768);
    expect(t.out()).toMatch(/Profilo p aggiornato/);
  });

  it('senza --set/--extra-arg → errore', async () => {
    const t = setup();
    expect(await t.go(['tune', 'p'])).toBe(1);
    expect(t.err()).toMatch(/Indica almeno/);
  });

  it('flag bloccato → errore senza domande', async () => {
    const t = setup();
    expect(await t.go(['tune', 'p', '--set', 'revision=main'])).toBe(1);
    expect(t.prompt.ask).not.toHaveBeenCalled();
    expect(t.store.readProfile('p').vllm.args).toEqual(ACTIVE_ARGS);
  });
});

describe('llmpod manage', () => {
  const fakeSpawn = (code = 0, error = null) => vi.fn(() => {
    const child = new EventEmitter();
    setImmediate(() => (error ? child.emit('error', error) : child.emit('exit', code)));
    return child;
  });

  it('avvia claude nella cartella del progetto llmpod, senza passargli chiavi', async () => {
    const t = setup();
    const spawn = fakeSpawn(0);
    expect(await t.go(['manage', '--profile', 'p'], { spawn })).toBe(0);
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(opts.cwd).toBe(ROOT);
    expect(args.join(" ")).toMatch(/profilo llmpod "p"/);
    expect(JSON.stringify(opts.env ?? {})).not.toContain(RUNPOD_KEY);
    expect(JSON.stringify(opts.env ?? {})).not.toContain(KEY);
  });

  it('claude assente → istruzioni di installazione', async () => {
    const t = setup();
    const e = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    expect(await t.go(['manage'], { spawn: fakeSpawn(0, e) })).toBe(1);
    expect(t.err()).toMatch(/claude\.ai\/install\.sh|@anthropic-ai\/claude-code/);
  });
});
