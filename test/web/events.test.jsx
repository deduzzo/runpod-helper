// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { EventsProvider, useJobEvents } from '../../web/src/lib/events.jsx';
import { FakeEventSource } from './helpers.js';

function Probe({ onEvent, onReconnect }) {
  useJobEvents('j1', onEvent, onReconnect);
  return null;
}

beforeEach(() => { vi.useFakeTimers(); FakeEventSource.reset(); vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('EventsProvider', () => {
  it('se il flusso passa a CLOSED riprova con backoff crescente (max 30 s) e azzera al riaprirsi', () => {
    render(<EventsProvider><Probe onEvent={() => {}} /></EventsProvider>);
    expect(FakeEventSource.instances).toHaveLength(1);
    const fail = () => { const es = FakeEventSource.last; es.readyState = 2; es.onerror?.(); };
    fail();
    expect(FakeEventSource.last.closed).toBe(true);
    act(() => { vi.advanceTimersByTime(999); });
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeEventSource.instances).toHaveLength(2);
    fail();
    act(() => { vi.advanceTimersByTime(1999); });
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeEventSource.instances).toHaveLength(3);
    for (let i = 0; i < 10; i++) { fail(); act(() => { vi.advanceTimersByTime(30_000); }); }
    expect(FakeEventSource.instances.length).toBe(13);
    FakeEventSource.last.open(); // connessione riuscita: il backoff riparte da 1 s
    fail();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeEventSource.instances.length).toBe(14);
  });

  it('con readyState CONNECTING (riconnessione automatica del browser) non crea un secondo EventSource', () => {
    render(<EventsProvider><Probe onEvent={() => {}} /></EventsProvider>);
    const es = FakeEventSource.last;
    es.readyState = 0;
    es.onerror?.();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('gli eventi arrivano anche dopo la ricreazione e onReconnect scatta a ogni open; alla chiusura niente timer', () => {
    const onEvent = vi.fn();
    const onReconnect = vi.fn();
    const { unmount } = render(<EventsProvider><Probe onEvent={onEvent} onReconnect={onReconnect} /></EventsProvider>);
    FakeEventSource.last.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    const es = FakeEventSource.last;
    es.readyState = 2; es.onerror?.();
    act(() => { vi.advanceTimersByTime(1000); });
    FakeEventSource.last.open();
    FakeEventSource.last.emit('job', { jobId: 'j1', seq: 0, type: 'phase' });
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(1);
    const last = FakeEventSource.last;
    last.readyState = 2; last.onerror?.();
    unmount();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
