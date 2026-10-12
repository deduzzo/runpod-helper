import { describe, it, expect, vi } from 'vitest';
import { sandbox, fakeStdin, SECRETS } from './helpers.js';

const KEY = 'CHIAVE-CONSULENTE-FINTA-XYZ';
const runpodFake = () => ({
  listPods: vi.fn(async () => []),
  listDataCenters: vi.fn(async () => [{ id: 'EU-RO-1', region: 'EUROPE', networkVolumeTypes: ['STANDARD'], gpuAvailability: [{ id: 'A', availability: 'HIGH' }] }]),
  listVolumes: vi.fn(async () => []),
  createVolume: vi.fn(),
});
const hfOk = () => ({ request: vi.fn(async () => ({ ok: true, status: 200, data: { name: 'utente' } })) });

describe('advisor --api-key-stdin', () => {
  it('zai-coding-plan con --accept-zai-notice: chiave da stdin, nessuna domanda, nessun segreto in output', async () => {
    const s = sandbox();
    expect(await s.run(['advisor', '--preset', 'zai-coding-plan', '--api-key-stdin', '--accept-zai-notice'], {}, { stdin: fakeStdin(`  ${KEY}  \n`) })).toBe(0);
    expect(s.store.readEnv()).toMatchObject({ LLMPOD_ADVISOR_PRESET: 'zai-coding-plan', LLMPOD_ADVISOR_API_KEY: KEY });
    expect(s.store.readConfig().advisor).toEqual({ enabled: true, zaiNoticeAcknowledged: true });
    expect(s.prompt.ask).not.toHaveBeenCalled();
    expect(s.prompt.askText).not.toHaveBeenCalled();
    expect(s.prompt.askSecret).not.toHaveBeenCalled();
    expect(s.all()).not.toContain(KEY);
  });

  it('--model viene salvato', async () => {
    const s = sandbox();
    expect(await s.run(['advisor', '--preset', 'zai-coding-plan', '--api-key-stdin', '--accept-zai-notice', '--model', 'glm-x'], {}, { stdin: fakeStdin(KEY) })).toBe(0);
    expect(s.store.readEnv().LLMPOD_ADVISOR_MODEL).toBe('glm-x');
  });

  it('senza --accept-zai-notice e senza terminale: errore che spiega il flag, nulla salvato', async () => {
    const s = sandbox();
    expect(await s.run(['advisor', '--preset', 'zai-coding-plan', '--api-key-stdin'], {}, { stdin: fakeStdin(KEY) })).toBe(1);
    expect(s.err()).toMatch(/--accept-zai-notice/);
    expect(s.store.readEnv().LLMPOD_ADVISOR_API_KEY).toBeUndefined();
    expect(s.all()).not.toContain(KEY);
  });

  it('avviso già registrato: il flag non serve', async () => {
    const s = sandbox();
    s.store.writeConfig({ advisor: { enabled: true, zaiNoticeAcknowledged: true } });
    expect(await s.run(['advisor', '--preset', 'zai-coding-plan', '--api-key-stdin'], {}, { stdin: fakeStdin(KEY) })).toBe(0);
    expect(s.store.readEnv().LLMPOD_ADVISOR_API_KEY).toBe(KEY);
  });

  it('custom: --base-url, --protocol, --auth, --model dalle opzioni', async () => {
    const s = sandbox();
    const argv = ['advisor', '--preset', 'custom', '--api-key-stdin', '--protocol', 'openai', '--base-url', 'https://llm.example.com/v1', '--model', 'mio', '--auth', 'x-api-key'];
    expect(await s.run(argv, {}, { stdin: fakeStdin(KEY) })).toBe(0);
    expect(s.store.readEnv()).toMatchObject({ LLMPOD_ADVISOR_PRESET: 'custom', LLMPOD_ADVISOR_PROTOCOL: 'openai', LLMPOD_ADVISOR_BASE_URL: 'https://llm.example.com/v1', LLMPOD_ADVISOR_MODEL: 'mio', LLMPOD_ADVISOR_AUTH: 'x-api-key', LLMPOD_ADVISOR_API_KEY: KEY });
    expect(s.prompt.askText).not.toHaveBeenCalled();
  });

  it('custom senza --base-url: errore che nomina l\'opzione', async () => {
    const s = sandbox();
    expect(await s.run(['advisor', '--preset', 'custom', '--api-key-stdin', '--model', 'm'], {}, { stdin: fakeStdin(KEY) })).toBe(1);
    expect(s.err()).toMatch(/--base-url/);
  });

  it('senza --preset: errore che nomina --preset', async () => {
    const s = sandbox();
    expect(await s.run(['advisor', '--api-key-stdin'], {}, { stdin: fakeStdin(KEY) })).toBe(1);
    expect(s.err()).toMatch(/--preset/);
    expect(s.prompt.askText).not.toHaveBeenCalled();
  });

  it('stdin vuoto o terminale: errore chiaro e nulla salvato', async () => {
    const a = sandbox();
    expect(await a.run(['advisor', '--preset', 'zai-coding-plan', '--api-key-stdin', '--accept-zai-notice'], {}, { stdin: fakeStdin('') })).toBe(1);
    expect(a.err()).toMatch(/vuot/i);
    expect(a.store.readEnv().LLMPOD_ADVISOR_PRESET).toBeUndefined();
    const b = sandbox();
    expect(await b.run(['advisor', '--preset', 'zai-coding-plan', '--api-key-stdin', '--accept-zai-notice'], {}, { stdin: fakeStdin('x', { tty: true }) })).toBe(1);
    expect(b.err()).toMatch(/terminale/);
  });

  it('preset senza chiave (claude-cli) con --api-key-stdin: errore', async () => {
    const s = sandbox();
    expect(await s.run(['advisor', '--preset', 'claude-cli', '--api-key-stdin'], {}, { stdin: fakeStdin(KEY) })).toBe(1);
    expect(s.err()).toMatch(/non usa una chiave/);
  });

  it('la chiave non è accettabile come argomento e non compare nei messaggi', async () => {
    for (const argv of [['--api-key', KEY], [`--api-key=${KEY}`]]) {
      const s = sandbox();
      expect(await s.run(['advisor', '--preset', 'zai-coding-plan', '--accept-zai-notice', ...argv])).toBe(1);
      expect(s.err()).toMatch(/--api-key-stdin/);
      expect(s.all()).not.toContain(KEY);
      expect(s.store.readEnv().LLMPOD_ADVISOR_API_KEY).toBeUndefined();
    }
  });

  it('--accept-zai-notice da solo evita la domanda anche senza --api-key-stdin', async () => {
    const s = sandbox({ answers: { text: ['zai-coding-plan', ''], secret: [KEY] } });
    expect(await s.run(['advisor', '--accept-zai-notice'])).toBe(0);
    expect(s.prompt.ask).not.toHaveBeenCalled();
    expect(s.store.readConfig().advisor.zaiNoticeAcknowledged).toBe(true);
  });
});

describe('init --runpod-key-stdin / --hf-token-stdin / --from-env', () => {
  const base = ['--datacenter', 'EU-RO-1', '--no-volume'];

  it('--runpod-key-stdin: salva la chiave letta da stdin senza domande sulle credenziali', async () => {
    const s = sandbox();
    expect(await s.run(['init', ...base, '--runpod-key-stdin'], { runpod: runpodFake() }, { stdin: fakeStdin(`${SECRETS.RUNPOD_API_KEY}\n`) })).toBe(0);
    expect(s.store.readEnv().RUNPOD_API_KEY).toBe(SECRETS.RUNPOD_API_KEY);
    expect(s.prompt.askSecret).not.toHaveBeenCalled();
    expect(s.all()).not.toContain(SECRETS.RUNPOD_API_KEY);
  });

  it('--runpod-key-stdin sostituisce una chiave già salvata senza chiedere di mantenerla', async () => {
    const s = sandbox();
    s.store.writeEnv({ RUNPOD_API_KEY: 'vecchia-chiave-finta' });
    expect(await s.run(['init', ...base, '--runpod-key-stdin'], { runpod: runpodFake() }, { stdin: fakeStdin(SECRETS.RUNPOD_API_KEY) })).toBe(0);
    expect(s.store.readEnv().RUNPOD_API_KEY).toBe(SECRETS.RUNPOD_API_KEY);
    expect(s.prompt.ask).not.toHaveBeenCalled();
  });

  it('--hf-token-stdin: verifica e salva il token, mantiene la chiave Runpod esistente senza domande', async () => {
    const s = sandbox();
    s.store.writeEnv({ RUNPOD_API_KEY: SECRETS.RUNPOD_API_KEY });
    const http = hfOk();
    expect(await s.run(['init', ...base, '--hf-token-stdin'], { runpod: runpodFake(), http }, { stdin: fakeStdin(SECRETS.HF_TOKEN) })).toBe(0);
    expect(s.store.readEnv()).toEqual(SECRETS);
    expect(http.request.mock.calls[0][2].headers.authorization).toBe(`Bearer ${SECRETS.HF_TOKEN}`);
    expect(s.prompt.ask).not.toHaveBeenCalled();
    expect(s.all()).not.toContain(SECRETS.HF_TOKEN);
  });

  it('--hf-token-stdin senza chiave Runpod configurata: errore che indica come fornirla', async () => {
    const s = sandbox();
    expect(await s.run(['init', ...base, '--hf-token-stdin'], { runpod: runpodFake() }, { stdin: fakeStdin(SECRETS.HF_TOKEN) })).toBe(1);
    expect(s.err()).toMatch(/--runpod-key-stdin/);
    expect(s.err()).toMatch(/--from-env/);
  });

  it('--runpod-key-stdin e --hf-token-stdin sono mutuamente esclusivi', async () => {
    const s = sandbox();
    expect(await s.run(['init', ...base, '--runpod-key-stdin', '--hf-token-stdin'], { runpod: runpodFake() }, { stdin: fakeStdin('x') })).toBe(1);
    expect(s.err()).toMatch(/--runpod-key-stdin.*--hf-token-stdin|--hf-token-stdin.*--runpod-key-stdin/);
    expect(s.store.readEnv().RUNPOD_API_KEY).toBeUndefined();
  });

  it('--from-env legge RUNPOD_API_KEY e HF_TOKEN dall\'ambiente del processo', async () => {
    const s = sandbox();
    s.env.RUNPOD_API_KEY = SECRETS.RUNPOD_API_KEY;
    s.env.HF_TOKEN = SECRETS.HF_TOKEN;
    expect(await s.run(['init', ...base, '--from-env'], { runpod: runpodFake(), http: hfOk() })).toBe(0);
    expect(s.store.readEnv()).toEqual(SECRETS);
    expect(s.prompt.ask).not.toHaveBeenCalled();
    expect(s.prompt.askSecret).not.toHaveBeenCalled();
  });

  it('senza --from-env le variabili d\'ambiente non vengono mai lette', async () => {
    const s = sandbox({ answers: { secret: ['', ''] } });
    s.env.RUNPOD_API_KEY = SECRETS.RUNPOD_API_KEY;
    expect(await s.run(['init', ...base], { runpod: runpodFake() })).toBe(1);
    expect(s.store.readEnv().RUNPOD_API_KEY).toBeUndefined();
  });

  it('--from-env senza variabile: errore che nomina variabile e alternative', async () => {
    const s = sandbox();
    expect(await s.run(['init', ...base, '--from-env'], { runpod: runpodFake() })).toBe(1);
    expect(s.err()).toMatch(/RUNPOD_API_KEY/);
    expect(s.err()).toMatch(/--runpod-key-stdin/);
  });

  it('la chiave non è accettabile come argomento', async () => {
    for (const argv of [['--runpod-key', SECRETS.RUNPOD_API_KEY], [`--hf-token=${SECRETS.HF_TOKEN}`]]) {
      const s = sandbox();
      expect(await s.run(['init', ...base, ...argv], { runpod: runpodFake() })).toBe(1);
      expect(s.err()).toMatch(/stdin/);
      expect(s.all()).not.toContain(SECRETS.RUNPOD_API_KEY);
      expect(s.all()).not.toContain(SECRETS.HF_TOKEN);
    }
  });
});
