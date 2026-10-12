import { describe, it, expect, vi } from 'vitest';
import { sandbox, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-PROFILO-FINTA-ABCDEFG';
const profile = {
  name: 'qwen3-coder', servedName: 'qwen3-coder', cloud: 'SECURE', dataCenterId: 'EU-A', context: 65536, concurrency: 2,
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'a'.repeat(40), gated: false, weightsBytes: 61066575656, maxContext: 262144 },
  vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] },
  parsers: { tool: 'qwen3_coder', reasoning: null }, gpu: { id: 'GPU80', count: 1 }, alternatives: [],
  volume: null, allowFallbackWithoutVolume: 'ask', watchdog: { idleMinutes: 30, maxHours: 8 },
};
const RUNNING = { id: 'pod1', name: 'llmpod-qwen3-coder', status: 'RUNNING', cost: 1.5, runtime: { uptime: 7200 } };
const SUP = { phase: 'ready', features: ['watchdog'], idleSeconds: 100, idleLimitSeconds: 1800, uptimeSeconds: 7200, maxSeconds: 28800 };

function setup({ supStatus = SUP, post = null, answers = {}, cost = RUNNING.cost } = {}) {
  const pod = { ...RUNNING, cost };
  const s = sandbox({ answers });
  s.store.writeEnv({ ...SECRETS, LLMPOD_KEY_QWEN3_CODER: KEY });
  s.store.writeConfig({ dataCenterId: 'EU-A' });
  s.store.writeProfile(profile);
  const runpod = {
    listPods: vi.fn(async () => [pod]),
    getPod: vi.fn(async () => pod),
    getBalance: vi.fn(async () => ({ balance: 42.5, spendPerHour: 0 })),
  };
  const http = {
    request: vi.fn(async (m, url, opts) => {
      if (m === 'GET' && url.endsWith('/status')) return { ok: true, status: 200, data: supStatus };
      if (m === 'POST' && url.endsWith('/watchdog')) {
        if (post) return post(opts);
        const b = opts.json;
        return { ok: true, status: 200, data: { ok: true, idleLimitSeconds: b.idleMinutes == null ? SUP.idleLimitSeconds : b.idleMinutes * 60, maxSeconds: b.maxHours == null ? SUP.maxSeconds : b.maxHours * 3600, uptimeSeconds: 7200 } };
      }
      return { ok: false, status: 404, data: null };
    }),
  };
  const posts = () => http.request.mock.calls.filter(([m]) => m === 'POST').map((c) => c[2].json);
  return { ...s, http, posts, go: (argv) => s.run(argv, { runpod, http }) };
}

describe('CLI keep', () => {
  it('prolunga le ore massime: mostra i nuovi limiti, la scadenza e il costo massimo, dopo la conferma', async () => {
    const t = setup();
    expect(await t.go(['keep', 'qwen3-coder', '--max-hours', '12'])).toBe(0);
    expect(t.prompt.ask).toHaveBeenCalledTimes(1);
    expect(t.prompt.ask.mock.calls[0][0]).toMatch(/costo massimo stimato 15,00 \$/);
    expect(t.posts()).toEqual([{ idleMinutes: null, maxHours: 12 }]);
    const out = t.out();
    expect(out).toMatch(/Pod pod1/);
    expect(out).toMatch(/Inattività: 30 min/);
    expect(out).toMatch(/Durata massima: 12 h dall'avvio/);
    expect(out).toMatch(/si spegnerà tra 10 h 0 min/);
    expect(out).toMatch(/Costo massimo fino alla scadenza: 15,00 \$/);
    expect(out).not.toMatch(/Profilo aggiornato/);
  });

  it('--no-idle disattiva l\'inattività (con conferma del costo massimo) e lo dice', async () => {
    const t = setup();
    expect(await t.go(['keep', 'qwen3-coder', '--no-idle'])).toBe(0);
    expect(t.prompt.ask).toHaveBeenCalledTimes(1);
    expect(t.prompt.ask.mock.calls[0][0]).toMatch(/inattività: mai.*costo massimo stimato 9,00 \$/);
    expect(t.posts()).toEqual([{ idleMinutes: 0, maxHours: null }]);
    expect(t.out()).toMatch(/Inattività: nessuno spegnimento/);
  });

  it('--idle-minutes, --yes e --save: aggiorna anche il profilo per i prossimi avvii', async () => {
    const t = setup();
    expect(await t.go(['keep', 'qwen3-coder', '--idle-minutes', '90', '--max-hours', '24', '--yes', '--save'])).toBe(0);
    expect(t.prompt.ask).not.toHaveBeenCalled();
    expect(t.posts()).toEqual([{ idleMinutes: 90, maxHours: 24 }]);
    expect(t.store.readProfile('qwen3-coder').watchdog).toEqual({ idleMinutes: 90, maxHours: 24 });
    expect(t.out()).toMatch(/Profilo qwen3-coder aggiornato per i prossimi avvii/);
  });

  it('senza --save il profilo non cambia', async () => {
    const t = setup();
    await t.go(['keep', 'qwen3-coder', '--max-hours', '12', '--yes']);
    expect(t.store.readProfile('qwen3-coder').watchdog).toEqual({ idleMinutes: 30, maxHours: 8 });
  });

  it('conferma rifiutata: codice 130 e nessuna chiamata al Pod', async () => {
    const t = setup({ answers: { ask: [false] } });
    expect(await t.go(['keep', 'qwen3-coder', '--max-hours', '12'])).toBe(130);
    expect(t.posts()).toEqual([]);
  });

  it('il profilo si può omettere se ce n\'è uno solo', async () => {
    const t = setup();
    expect(await t.go(['keep', '--max-hours', '4'])).toBe(0);
    expect(t.posts()).toEqual([{ idleMinutes: null, maxHours: 4 }]);
  });

  it('accetta la virgola decimale (12,5 ore)', async () => {
    const t = setup();
    expect(await t.go(['keep', 'qwen3-coder', '--max-hours', '12,5', '--yes'])).toBe(0);
    expect(t.posts()).toEqual([{ idleMinutes: null, maxHours: 12.5 }]);
  });

  it('ore massime sotto l\'uptime: errore con l\'indicazione di usare down, nessuna chiamata', async () => {
    const t = setup();
    expect(await t.go(['keep', 'qwen3-coder', '--max-hours', '2'])).toBe(1);
    expect(t.err()).toMatch(/verrebbe eliminato subito/);
    expect(t.err()).toMatch(/llmpod down qwen3-coder/);
    expect(t.posts()).toEqual([]);
  });

  it('costo orario ignoto: non mostra 0,00 $', async () => {
    const t = setup({ cost: null });
    expect(await t.go(['keep', 'qwen3-coder', '--max-hours', '12', '--yes'])).toBe(0);
    expect(t.out()).toMatch(/costo orario non noto/);
    expect(t.out()).not.toContain('0,00');
  });

  it('errori di input: nessuna opzione, valori non numerici o fuori intervallo, --no-idle con --idle-minutes', async () => {
    for (const argv of [['keep', 'qwen3-coder'], ['keep', 'qwen3-coder', '--max-hours', 'tanto'], ['keep', 'qwen3-coder', '--max-hours', '999'], ['keep', 'qwen3-coder', '--idle-minutes', '-5'], ['keep', 'qwen3-coder', '--idle-minutes', '3'], ['keep', 'qwen3-coder', '--idle-minutes', '7,5'], ['keep', 'qwen3-coder', '--no-idle', '--idle-minutes', '10']]) {
      const t = setup();
      expect(await t.go(argv), argv.join(' ')).toBe(1);
      expect(t.err()).toMatch(/INVALID_INPUT/);
      expect(t.posts()).toEqual([]);
    }
  });

  it('supervisore vecchio: spiega che serve un Pod avviato con la nuova versione', async () => {
    const t = setup({ post: async () => ({ ok: false, status: 404, data: { error: 'not found' } }) });
    expect(await t.go(['keep', 'qwen3-coder', '--max-hours', '12', '--yes'])).toBe(1);
    expect(t.err()).toMatch(/versione precedente/);
    expect(t.err()).toMatch(/llmpod down qwen3-coder.*llmpod up qwen3-coder/);
  });
});

describe('CLI status: colonna Spegnimento con i limiti correnti', () => {
  const statusOut = async (supStatus) => {
    const t = setup({ supStatus });
    await t.go(['status']);
    return t.out();
  };

  it('inattivo e durata massima', async () => {
    expect(await statusOut(SUP)).toMatch(/inattivo da 1 min 40 s su 30 min 0 s; massimo tra 6 h 0 min/);
  });

  it('inattività disattivata con keep --no-idle', async () => {
    expect(await statusOut({ ...SUP, idleLimitSeconds: 0, idleSeconds: 500 })).toMatch(/inattività: mai; massimo tra 6 h 0 min/);
  });

  it('durante l\'avvio (senza inattività misurata) mostra la fase e la durata massima', async () => {
    expect(await statusOut({ ...SUP, phase: 'loading', idleSeconds: null })).toMatch(/loading; massimo tra 6 h 0 min/);
  });
});
