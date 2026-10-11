import { describe, it, expect, vi } from 'vitest';
import { createInterruptHandler } from '../../src/cli/commands/up.js';
import { LlmpodError, Codes } from '../../src/core/errors.js';

function make({ podId = 'pod1', ask = async () => true, down = async () => ({}), pods = [] } = {}) {
  const err = [];
  const io = { ask: vi.fn(ask), err: (t) => err.push(t) };
  const ops = { down: vi.fn(down) };
  const runpod = { listPods: vi.fn(async () => pods) };
  const exit = vi.fn();
  const handler = createInterruptHandler({ ops, runpod, io, name: 'qwen', getPodId: () => podId, exit });
  return { handler, io, ops, runpod, exit, err: () => err.join('\n') };
}

describe('interruzione di up (Ctrl+C)', () => {
  it('podId noto, risposta sì: termina il Pod ed esce con 130', async () => {
    const t = make();
    await t.handler();
    expect(t.ops.down).toHaveBeenCalledWith('qwen', { yes: true });
    expect(t.exit).toHaveBeenCalledWith(130);
  });

  it('risposta no: non termina e avvisa', async () => {
    const t = make({ ask: async () => false });
    await t.handler();
    expect(t.ops.down).not.toHaveBeenCalled();
    expect(t.err()).toContain('lasciato acceso');
    expect(t.exit).toHaveBeenCalledWith(130);
  });

  it('ask che rifiuta con CANCELLED: termina comunque', async () => {
    const t = make({ ask: async () => { throw new LlmpodError(Codes.CANCELLED, 'annullato'); } });
    await t.handler();
    expect(t.ops.down).toHaveBeenCalledWith('qwen', { yes: true });
    expect(t.exit).toHaveBeenCalledWith(130);
  });

  it('ops.down che lancia: avviso con link alla console, nessuna eccezione', async () => {
    const t = make({ down: async () => { throw new LlmpodError(Codes.RUNPOD_API, 'non terminato'); } });
    await expect(t.handler()).resolves.toBeUndefined();
    expect(t.err()).toContain('https://www.runpod.io/console/pods');
    expect(t.exit).toHaveBeenCalledWith(130);
  });

  it('podId nullo: cerca il Pod llmpod-<nome> attivo con listPods', async () => {
    const t = make({ podId: null, pods: [{ id: 'old', name: 'llmpod-qwen', status: 'TERMINATED' }, { id: 'pod9', name: 'llmpod-qwen', status: 'RUNNING' }] });
    await t.handler();
    expect(t.io.ask.mock.calls[0][0]).toContain('pod9');
    expect(t.ops.down).toHaveBeenCalledWith('qwen', { yes: true });
    expect(t.exit).toHaveBeenCalledWith(130);
  });

  it('seconda invocazione durante la prima: nessuna seconda terminazione', async () => {
    let release;
    const t = make({ down: () => new Promise((r) => { release = r; }) });
    const first = t.handler();
    await vi.waitFor(() => expect(t.ops.down).toHaveBeenCalledTimes(1));
    await t.handler();
    expect(t.err()).toContain('Terminazione in corso');
    expect(t.ops.down).toHaveBeenCalledTimes(1);
    expect(t.exit).not.toHaveBeenCalled();
    release({});
    await first;
    expect(t.exit).toHaveBeenCalledTimes(1);
  });
});
