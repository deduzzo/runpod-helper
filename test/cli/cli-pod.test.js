import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandbox, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-PROFILO-FINTA-ABCDEFG';
const profile = {
  name: 'qwen3-coder', servedName: 'qwen3-coder', cloud: 'SECURE', dataCenterId: 'EU-A', context: 65536, concurrency: 2,
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, gpu: { id: 'GPU80', count: 1 }, alternatives: [],
  volume: { id: 'vol1', mountPath: '/workspace' }, allowFallbackWithoutVolume: 'ask', watchdog: { idleMinutes: 30, maxHours: 8 },
};

function setup(opts = {}) {
  const s = sandbox(opts);
  s.store.writeEnv({ ...SECRETS, LLMPOD_KEY_QWEN3_CODER: KEY });
  s.store.writeConfig({ dataCenterId: 'EU-A', volume: { id: 'vol1', name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-A' } });
  s.store.writeProfile(profile);
  const pods = [];
  const runpod = {
    listPods: vi.fn(async () => pods),
    getPod: vi.fn(async (id) => pods.find((p) => p.id === id) ?? null),
    getBalance: vi.fn(async () => ({ balance: 42.5, spendPerHour: 0 })),
    listGpus: vi.fn(async () => [{ id: 'GPU80', price: { secure: 1.5 }, maxCount: { secure: 8 }, memory: 80, dataCenters: [{ id: 'EU-A', availability: 'HIGH' }] }]),
    createPod: vi.fn(async () => ({ status: 201, data: { id: 'pod1' } })),
    deletePod: vi.fn(async (id) => { pods.splice(pods.findIndex((p) => p.id === id), 1); }),
    deleteVolume: vi.fn(async () => {}),
  };
  const http = { request: vi.fn(async () => ({ ok: false, status: 404, data: null })) };
  const child = () => { const c = new EventEmitter(); setTimeout(() => c.emit('exit', 3), 0); return c; };
  const spawn = vi.fn(child);
  const overrides = { runpod, http, spawn, isZcodeRunning: async () => false };
  const activate = () => {
    pods.push({ id: 'pod1', name: 'llmpod-qwen3-coder', status: 'RUNNING', cost: 1.49, runtime: { uptime: 7200 } });
    s.store.writeState({ pods: { 'qwen3-coder': { podId: 'pod1' } } });
  };
  return { ...s, runpod, spawn, overrides, activate, go: (argv) => s.run(argv, overrides) };
}

describe('CLI: ciclo di vita del Pod', () => {
  it('up --dry-run: nessuna creazione e nessun segreto nell\'output', async () => {
    const t = setup();
    expect(await t.go(['up', 'qwen3-coder', '--dry-run'])).toBe(0);
    expect(t.runpod.createPod).not.toHaveBeenCalled();
    const all = t.all();
    expect(all).toContain('[dry-run]');
    expect(all).toContain('<REDATTO>');
    for (const secret of [KEY, SECRETS.RUNPOD_API_KEY, SECRETS.HF_TOKEN]) expect(all).not.toContain(secret);
  });

  it('un errore che contiene un segreto viene mascherato', async () => {
    const t = setup();
    t.runpod.listPods.mockRejectedValue(new Error(`boom ${SECRETS.RUNPOD_API_KEY}`));
    expect(await t.go(['status'])).toBe(1);
    expect(t.all()).not.toContain(SECRETS.RUNPOD_API_KEY);
    expect(t.all()).toContain('<REDATTO>');
  });

  it('down senza profilo usa l\'unico attivo e termina dopo conferma', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['down', '--yes'])).toBe(0);
    expect(t.runpod.deletePod).toHaveBeenCalledWith('pod1');
    expect(t.out()).toContain('pod1');
  });

  it('status mostra Pod, costo della sessione, credito e volume', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['status'])).toBe(0);
    const out = t.out();
    expect(out).toContain('qwen3-coder');
    expect(out).toContain('1,49 $/h');
    expect(out).toContain('2,98 $');
    expect(out).toContain('42,50 $');
    expect(out).toContain('10,50 $ al mese');
  });

  it('env --format json espone gli export (chiave inclusa: è ciò che l\'utente chiede)', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['env', '--format', 'json'])).toBe(0);
    const env = JSON.parse(t.out());
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://pod1-8000.proxy.runpod.net', ANTHROPIC_AUTH_TOKEN: KEY, OPENAI_BASE_URL: 'https://pod1-8000.proxy.runpod.net/v1', OPENAI_API_KEY: KEY, LLMPOD_MODEL: 'qwen3-coder' });
  });

  it('run claude avvia il client con le variabili e ne restituisce il codice', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['run', 'claude'])).toBe(3);
    const [cmd, args, opts] = t.spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual([]);
    expect(opts.stdio).toBe('inherit');
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://pod1-8000.proxy.runpod.net');
    expect(await t.go(['claude'])).toBe(3);
  });

  it('run --cwd avvia il client nella cartella indicata; senza --cwd e non interattivo usa la cartella corrente', async () => {
    const t = setup();
    t.activate();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-work-')));
    expect(await t.go(['run', 'claude', '--cwd', dir])).toBe(3);
    expect(t.spawn.mock.calls[0][2].cwd).toBe(dir);
    expect(await t.go(['claude', '--cwd', dir])).toBe(3);
    expect(t.spawn.mock.calls[1][2].cwd).toBe(dir);
    expect(await t.go(['run', 'pi', '--cwd', dir])).toBe(3);
    expect(t.spawn.mock.calls[2][2].cwd).toBe(dir);
    expect(await t.go(['run', 'claude'])).toBe(3);
    expect(t.spawn.mock.calls[3][2].cwd).toBe(fs.realpathSync(process.cwd())); // non interattivo: cartella corrente
  });

  describe('cartella di lavoro interattiva', () => {
    const mkdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-work-')));
    const noSecrets = (spawn) => {
      const [, args, opts] = spawn.mock.calls[0];
      const blob = JSON.stringify([args, opts.cwd]);
      expect(blob).not.toContain(KEY);
      expect(blob).not.toContain(SECRETS.RUNPOD_API_KEY);
      expect(Object.keys(opts.env).filter((k) => /^(RUNPOD|HF_)/.test(k))).toEqual([]);
    };

    it('run pi interattivo senza --cwd: la risposta diventa il cwd dello spawn', async () => {
      const cur = mkdir();
      const chosen = mkdir();
      const t = setup({ answers: { interactive: true, text: [chosen] } });
      t.activate();
      expect(await t.run(['run', 'pi'], { ...t.overrides, cwd: () => cur })).toBe(3);
      expect(t.prompt.askText).toHaveBeenCalledTimes(1);
      expect(t.prompt.askText.mock.calls[0][0]).toMatch(/In quale cartella vuoi lavorare con il modello\?/);
      expect(t.prompt.askText.mock.calls[0][1]).toBe(cur);
      expect(t.spawn.mock.calls[0][2].cwd).toBe(chosen);
      noSecrets(t.spawn);
    });

    it('alias claude interattivo: stessa domanda e stesso cwd', async () => {
      const cur = mkdir();
      const chosen = mkdir();
      const t = setup({ answers: { interactive: true, text: [chosen] } });
      t.activate();
      expect(await t.run(['claude'], { ...t.overrides, cwd: () => cur })).toBe(3);
      expect(t.prompt.askText).toHaveBeenCalledTimes(1);
      expect(t.spawn.mock.calls[0][2].cwd).toBe(chosen);
    });

    it('interattivo, risposta vuota (Invio): usa la cartella corrente', async () => {
      const cur = mkdir();
      const t = setup({ answers: { interactive: true } });
      t.activate();
      expect(await t.run(['run', 'pi'], { ...t.overrides, cwd: () => cur })).toBe(3);
      expect(t.spawn.mock.calls[0][2].cwd).toBe(cur);
    });

    it('interattivo con --cwd: nessuna domanda', async () => {
      const dir = mkdir();
      const t = setup({ answers: { interactive: true, text: [mkdir()] } });
      t.activate();
      expect(await t.go(['run', 'pi', '--cwd', dir])).toBe(3);
      expect(t.prompt.askText).not.toHaveBeenCalled();
      expect(t.spawn.mock.calls[0][2].cwd).toBe(dir);
    });

    it('non interattivo senza --cwd: nessuna domanda, cwd = cartella corrente', async () => {
      const cur = mkdir();
      const t = setup();
      t.activate();
      expect(await t.run(['run', 'pi'], { ...t.overrides, cwd: () => cur })).toBe(3);
      expect(t.prompt.askText).not.toHaveBeenCalled();
      expect(t.spawn.mock.calls[0][2].cwd).toBe(cur);
      expect(await t.run(['claude'], { ...t.overrides, cwd: () => cur })).toBe(3);
      expect(t.prompt.askText).not.toHaveBeenCalled();
      expect(t.spawn.mock.calls[1][2].cwd).toBe(cur);
    });

    it('interattivo, cartella inesistente: errore chiaro prima di contattare Runpod e senza avviare il client', async () => {
      const t = setup({ answers: { interactive: true, text: [path.join(mkdir(), 'non-esiste')] } });
      t.activate();
      expect(await t.go(['run', 'pi'])).toBe(1);
      expect(t.err()).toMatch(/non esiste/);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(t.runpod.listPods).not.toHaveBeenCalled();
      expect(t.runpod.getPod).not.toHaveBeenCalled();
    });

    it('zcode: nessuna domanda sulla cartella, anche se interattivo', async () => {
      const t = setup({ answers: { interactive: true } });
      t.activate();
      expect(await t.go(['run', 'zcode', '--no-open'])).toBe(0);
      expect(t.prompt.askText).not.toHaveBeenCalled();
    });
  });

  it('run --cwd inesistente: INVALID_INPUT senza avviare il client; zcode accetta --cwd', async () => {
    const t = setup();
    t.activate();
    const missing = path.join(os.tmpdir(), 'llmpod-non-esiste-xyz');
    expect(await t.go(['run', 'claude', '--cwd', missing])).toBe(1);
    expect(t.err()).toMatch(/non esiste/);
    expect(t.spawn).not.toHaveBeenCalled();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpod-work-'));
    expect(await t.go(['run', 'zcode', '--no-open', '--cwd', dir])).toBe(0);
  });

  it('run pi scrive models.json senza chiave e passa --provider/--model', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['run', 'pi'])).toBe(3);
    const [cmd, args, opts] = t.spawn.mock.calls[0];
    expect(cmd).toBe('pi');
    expect(args).toEqual(['--provider', 'llmpod', '--model', 'qwen3-coder']);
    expect(opts.env.LLMPOD_API_KEY).toBe(KEY);
    expect(fs.readFileSync(path.join(t.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')).not.toContain(KEY);
  });

  it('run zcode configura ZCode se chiuso, rifiuta se aperto', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['run', 'zcode', '--no-open'])).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(t.env.ZCODE_DIR, 'config.json'), 'utf8')).provider.llmpod.options.baseURL).toBe('https://pod1-8000.proxy.runpod.net/v1');
    t.overrides.isZcodeRunning = async () => true;
    expect(await t.run(['run', 'zcode', '--no-open'], t.overrides)).toBe(1);
    expect(t.err()).toContain('ZCODE_RUNNING');
  });

  it('run con client sconosciuto o non installato', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['run', 'boh'])).toBe(1);
    t.spawn.mockImplementation(() => { const c = new EventEmitter(); setTimeout(() => c.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' })), 0); return c; });
    expect(await t.go(['run', 'opencode'])).toBe(1);
    expect(t.err()).toMatch(/opencode.*non trovato/);
  });

  it('rotate-key non mostra la nuova chiave', async () => {
    const t = setup();
    expect(await t.go(['rotate-key', 'qwen3-coder'])).toBe(0);
    const fresh = t.store.readEnv().LLMPOD_KEY_QWEN3_CODER;
    expect(fresh).not.toBe(KEY);
    expect(t.all()).not.toContain(fresh);
  });

  it('destroy-volume richiede il nome digitato', async () => {
    const t = setup({ answers: { ask: [true], text: ['nome-sbagliato'] } });
    expect(await t.go(['destroy-volume'])).toBe(130);
    expect(t.runpod.deleteVolume).not.toHaveBeenCalled();
    const t2 = setup({ answers: { ask: [true], text: ['llmpod-pesi'] } });
    expect(await t2.go(['destroy-volume'])).toBe(0);
    expect(t2.runpod.deleteVolume).toHaveBeenCalledWith('vol1');
    expect(t2.store.readConfig().volume).toBeNull();
  });

  it('destroy-volume rifiuta se un Pod llmpod è attivo', async () => {
    const t = setup();
    t.activate();
    expect(await t.go(['destroy-volume', '--yes'])).toBe(1);
    expect(t.runpod.deleteVolume).not.toHaveBeenCalled();
  });
});
