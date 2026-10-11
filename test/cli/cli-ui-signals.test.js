import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startUi = vi.fn();
vi.mock('../../src/server/start.js', async (orig) => ({ ...(await orig()), startUi: (...a) => startUi(...a) }));

const { sandbox } = await import('./helpers.js');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
let release;
let shutdown;
let baseline;

beforeEach(() => {
  startUi.mockReset();
  shutdown = vi.fn(() => new Promise((r) => { release = r; }));
  startUi.mockImplementation(async (_ctx, o) => ({ url: `http://127.0.0.1:${o.port}/?t=${o.token}`, port: o.port, proxyPort: o.proxy ? o.proxyPort : null, shutdown, close: vi.fn() }));
  baseline = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
});
afterEach(() => { process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM'); });

const waitStarted = async (s) => { for (let i = 0; i < 100 && !/Interfaccia llmpod/.test(s.out()); i++) await tick(); };

describe('llmpod ui: segnali e chiusura', () => {
  it('due segnali in rapida successione: shutdown una sola volta, exit solo a spegnimento finito', async () => {
    const s = sandbox();
    const exit = vi.fn();
    const done = s.run(['ui', '--port', '7001', '--no-open'], { exit });
    await waitStarted(s);
    process.emit('SIGINT');
    process.emit('SIGTERM');
    process.emit('SIGINT');
    await tick();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(s.err()).toContain('Terminazione in corso, attendere…');
    release();
    expect(await done).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(process.listenerCount('SIGINT')).toBe(baseline.int);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.term);
  });

  it('variabili di porta vuote = assenti (valori predefiniti)', async () => {
    const s = sandbox();
    Object.assign(s.env, { LLMPOD_UI_PORT: '', LLMPOD_PROXY_PORT: '', LLMPOD_UI_HOST: '', LLMPOD_PROXY_HOST: '' });
    const done = s.run(['ui', '--no-open'], { exit: vi.fn() });
    await waitStarted(s);
    expect(startUi.mock.calls[0][1]).toMatchObject({ host: '127.0.0.1', port: 7860, proxyHost: '127.0.0.1', proxyPort: 8081 });
    process.emit('SIGINT'); release(); await done;
  });

  it('--host e LLMPOD_PROXY_HOST sono usati per l\'ascolto', async () => {
    const s = sandbox();
    s.env.LLMPOD_PROXY_HOST = '127.0.0.2';
    const done = s.run(['ui', '--host', 'localhost', '--port', '7002', '--proxy-port', '7003', '--no-open'], { exit: vi.fn() });
    await waitStarted(s);
    expect(startUi.mock.calls[0][1]).toMatchObject({ host: 'localhost', port: 7002, proxyHost: '127.0.0.2', proxyPort: 7003 });
    process.emit('SIGTERM'); release(); await done;
    const s2 = sandbox();
    const done2 = s2.run(['ui', '--host', '127.0.0.1', '--no-open'], { exit: vi.fn() });
    await waitStarted(s2);
    expect(startUi.mock.calls[1][1]).toMatchObject({ host: '127.0.0.1', proxyHost: '127.0.0.1' });
    process.emit('SIGTERM'); release(); await done2;
  });

  it('host non loopback: avviso; in Docker l\'avviso indica di pubblicare la porta solo su 127.0.0.1', async () => {
    const s = sandbox();
    const done = s.run(['ui', '--host', '0.0.0.0', '--port', '7004', '--no-open'], { exit: vi.fn() });
    await waitStarted(s);
    expect(s.err()).toContain('⚠ Ascolto su 0.0.0.0');
    expect(s.err()).not.toContain('Docker');
    process.emit('SIGINT'); release(); await done;

    const d = sandbox();
    d.env.LLMPOD_IN_DOCKER = '1';
    d.env.LLMPOD_UI_HOST = '0.0.0.0';
    const done2 = d.run(['ui', '--port', '7005'], { exit: vi.fn() });
    await waitStarted(d);
    expect(d.err()).toMatch(/Docker.*127\.0\.0\.1:7005/);
    process.emit('SIGINT'); release(); await done2;

    const l = sandbox();
    const done3 = l.run(['ui', '--no-open'], { exit: vi.fn() });
    await waitStarted(l);
    expect(l.err()).not.toContain('Ascolto su');
    process.emit('SIGINT'); release(); await done3;
  });
});
