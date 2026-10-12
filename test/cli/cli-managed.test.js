import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli/program.js';
import { createIo } from '../../src/cli/render.js';
import fs from 'node:fs';
import os from 'node:os';
import { createWorld, KEY, RUNPOD_KEY, ACTIVE_ARGS } from '../fixtures/fake-world.js';
import { missingProjectFiles, PROJECT_FILES } from '../../src/cli/commands/manage.js';

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

describe('llmpod status --all', () => {
  it('elenca anche gli altri Pod dell\'account, solo con --all', async () => {
    const pods = [
      { id: 'pod1', name: 'llmpod-p', status: 'RUNNING', cost: 1.5, gpu: { id: 'GPU80', count: 1 } },
      { id: 'x1', name: 'mio-notebook', status: 'RUNNING', cost: 0.4, gpu: { id: 'GPU24', count: 1 } },
    ];
    const t = setup({ pods });
    expect(await t.go(['status'])).toBe(0);
    expect(t.out()).not.toMatch(/mio-notebook/);
    const a = setup({ pods });
    expect(await a.go(['status', '--all'])).toBe(0);
    expect(a.out()).toMatch(/Altri Pod dell'account[\s\S]*mio-notebook[\s\S]*0,40 \$\/h/);
    const j = setup({ pods });
    expect(await j.go(['status', '--all', '--json'])).toBe(0);
    expect(JSON.parse(j.out()).otherPods).toEqual([expect.objectContaining({ podId: 'x1' })]);
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

  it('senza --cwd: cwd = cartella del progetto e nessun flag di configurazione aggiuntivo', async () => {
    const t = setup();
    const spawn = fakeSpawn(0);
    expect(await t.go(['manage'], { spawn })).toBe(0);
    const [, args, opts] = spawn.mock.calls[0];
    expect(opts.cwd).toBe(ROOT);
    expect(args).toEqual([]);
    expect(opts.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBeUndefined();
  });

  describe('--cwd', () => {
    const mkdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-work-')));

    it('avvia claude nella cartella indicata con --mcp-config (JSON inline, server.js assoluto), --settings e --add-dir', async () => {
      const t = setup();
      const dir = mkdir();
      const spawn = fakeSpawn(0);
      expect(await t.go(['manage', '--cwd', dir], { spawn })).toBe(0);
      const [cmd, args, opts] = spawn.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(opts.cwd).toBe(dir);
      const i = args.indexOf('--mcp-config');
      expect(i).toBeGreaterThanOrEqual(0);
      const mcp = JSON.parse(args[i + 1]);
      expect(mcp.mcpServers.llmpod.command).toBe('node');
      expect(mcp.mcpServers.llmpod.args).toEqual([path.join(ROOT, 'src/mcp/server.js')]);
      expect(path.isAbsolute(mcp.mcpServers.llmpod.args[0])).toBe(true);
      expect(mcp.mcpServers.llmpod.env).toEqual({ LLMPOD_CONFIG_DIR: t.env.LLMPOD_CONFIG_DIR, ZCODE_DIR: t.env.ZCODE_DIR, PI_CODING_AGENT_DIR: t.env.PI_CODING_AGENT_DIR });
      expect(args[args.indexOf('--settings') + 1]).toBe(path.join(ROOT, '.claude/settings.json'));
      expect(args[args.indexOf('--add-dir') + 1]).toBe(ROOT);
      expect(args).not.toContain('--strict-mcp-config');
      expect(opts.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
      expect(t.err()).toContain(dir);
    });

    it('nessun segreto nei flag né nell\'ambiente; --dir è un alias; il prompt del profilo precede i flag (--add-dir accetta più valori)', async () => {
      const t = setup();
      const dir = mkdir();
      const spawn = fakeSpawn(0);
      expect(await t.go(['manage', '--dir', dir, '--profile', 'p'], { spawn })).toBe(0);
      const [, args, opts] = spawn.mock.calls[0];
      expect(opts.cwd).toBe(dir);
      expect(args[0]).toMatch(/profilo llmpod "p"/);
      expect(args.findIndex((a) => a.startsWith('--'))).toBe(1);
      const all = JSON.stringify([args, opts.env]);
      expect(all).not.toContain(RUNPOD_KEY);
      expect(all).not.toContain(KEY);
    });

    it('un percorso con spazi e caratteri di shell resta un solo valore (nessuna shell)', async () => {
      const t = setup();
      const dir = path.join(mkdir(), 'mio progetto; $(rm -rf x)');
      fs.mkdirSync(dir);
      const spawn = fakeSpawn(0);
      expect(await t.go(['manage', '--cwd', dir], { spawn })).toBe(0);
      expect(spawn.mock.calls[0][2].cwd).toBe(dir);
      expect(spawn.mock.calls[0][2].shell).toBeUndefined();
    });

    it('percorso relativo risolto in assoluto', async () => {
      const t = setup();
      const dir = mkdir();
      const spawn = fakeSpawn(0);
      expect(await t.go(['manage', '--cwd', path.relative(process.cwd(), dir)], { spawn })).toBe(0);
      expect(spawn.mock.calls[0][2].cwd).toBe(dir);
    });

    it('cartella inesistente o file: INVALID_INPUT con hint, senza avviare claude', async () => {
      const t = setup();
      const spawn = fakeSpawn(0);
      const missing = path.join(mkdir(), 'non-esiste');
      expect(await t.go(['manage', '--cwd', missing], { spawn })).toBe(1);
      expect(t.err()).toMatch(/INVALID_INPUT/);
      expect(t.err()).toMatch(/non esiste/);
      const file = path.join(mkdir(), 'f.txt');
      fs.writeFileSync(file, 'x');
      expect(await t.go(['manage', '--cwd', file], { spawn })).toBe(1);
      expect(t.err()).toMatch(/non è una cartella/);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('--cwd uguale alla cartella del progetto: comportamento senza --cwd', async () => {
      const t = setup();
      const spawn = fakeSpawn(0);
      expect(await t.go(['manage', '--cwd', ROOT], { spawn })).toBe(0);
      const [, args, opts] = spawn.mock.calls[0];
      expect(opts.cwd).toBe(ROOT);
      expect(args).toEqual([]);
    });
  });

  it('la cartella del progetto contiene CLAUDE.md, permessi, skill e .mcp.json; il pacchetto npm li include', () => {
    expect(missingProjectFiles()).toEqual([]);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-manage-'));
    expect(missingProjectFiles(empty)).toEqual(PROJECT_FILES);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const f of PROJECT_FILES) expect(pkg.files, f).toContain(f);
  });

  it('claude assente → istruzioni di installazione', async () => {
    const t = setup();
    const e = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    expect(await t.go(['manage'], { spawn: fakeSpawn(0, e) })).toBe(1);
    expect(t.err()).toMatch(/claude\.ai\/install\.sh|@anthropic-ai\/claude-code/);
  });
});
