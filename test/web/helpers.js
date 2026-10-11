import { vi } from 'vitest';

// Risposta fetch finta: ogni chiamata ne costruisce una nuova (il corpo si legge una volta sola).
const respond = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });

// mockApi({ 'GET /api/jobs/j1': (init, url) => ({ job, events }), 'POST /api/x': { ok: true } })
// Il valore può essere un oggetto (200), { __status, body } oppure una funzione che restituisce uno dei due.
// Percorsi senza voce → 404. Restituisce lo spy di fetch (calls: [path, init]).
export function mockApi(routes = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, init = {}) => {
    const method = init.method ?? 'GET';
    const pathname = String(path).split('?')[0];
    const entry = routes[`${method} ${String(path)}`] ?? routes[`${method} ${pathname}`];
    if (entry === undefined) return respond(404, { error: { code: 'NOT_FOUND', message: 'Percorso API sconosciuto' } });
    const value = typeof entry === 'function' ? await entry(init, String(path)) : entry;
    if (value && typeof value === 'object' && '__status' in value) return respond(value.__status, value.body);
    return respond(200, value);
  });
}

// EventSource finto: i test emettono eventi `job` e simulano la riconnessione.
export class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  close() { this.closed = true; }

  emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) }); }

  open() { this.onopen?.(); }

  static reset() { FakeEventSource.instances = []; }

  static get last() { return FakeEventSource.instances.at(-1); }
}
