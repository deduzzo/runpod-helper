import { describe, it, expect, vi } from 'vitest';

const fake = { down: vi.fn(async () => ({})), timer: null };
vi.mock('../../src/core/ops.js', async (orig) => ({
  ...(await orig()),
  createOps: ({ events }) => ({
    // "up" finto che tiene vivo il loop con un timer, come il polling di un vero avvio.
    up: () => new Promise(() => {
      events.emit('phase', { message: 'Creazione del Pod' });
      events.emit('pod', { podId: 'podX' });
      fake.timer = setInterval(() => {}, 1000);
    }),
    down: (...a) => fake.down(...a),
  }),
}));

const { sandbox } = await import('./helpers.js');
const { apiClient } = await import('../server/helpers.js');

describe('llmpod ui: chiusura con un up in corso', () => {
  it('al segnale termina il Pod in creazione e chiama exit(0)', async () => {
    const s = sandbox();
    const token = 'abcdef0123456789abcdef0123456789';
    s.env.LLMPOD_UI_TOKEN = token;
    const exit = vi.fn();
    const runpod = { listPods: vi.fn(async () => []) };
    const done = s.run(['ui', '--port', '0', '--no-proxy', '--no-open'], { exit, runpod });
    for (let i = 0; i < 100 && !/Interfaccia llmpod/.test(s.out()); i++) await new Promise((r) => setTimeout(r, 10));
    const port = Number(s.out().match(/127\.0\.0\.1:(\d+)/)[1]);
    const api = apiClient({ port, token });
    expect((await api('/api/jobs', { method: 'POST', body: { action: 'up', profile: 'qwen' } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    process.emit('SIGINT');
    expect(await done).toBe(0);
    clearInterval(fake.timer);
    expect(fake.down).toHaveBeenCalledWith('qwen', { yes: true });
    expect(exit).toHaveBeenCalledWith(0);
    expect(s.err()).toContain('podX');
  });
});
