// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App from '../../web/src/App.jsx';
import { mockApi, FakeEventSource } from './helpers.js';

beforeEach(() => { FakeEventSource.reset(); vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('App', () => {
  it('senza sessione (401) mostra le istruzioni per llmpod ui', async () => {
    mockApi({ 'GET /api/session': { __status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sessione non valida' } } } });
    render(<App />);
    await screen.findByText(/Sessione non valida: riapri il link stampato da/);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('errore diverso da 401: "Server non raggiungibile"', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    render(<App />);
    await screen.findByText(/Server non raggiungibile/);
    expect(screen.queryByText(/Sessione non valida/)).toBeNull();
  });

  it('con sessione mostra le cinque schede e cambia pagina', async () => {
    mockApi({ 'GET /api/session': { ok: true, version: '0.1.0' }, 'GET /api/overview': { profiles: [], jobs: [], config: {}, advisor: {} } });
    render(<App />);
    await screen.findByText(/v0\.1\.0/);
    for (const label of ['Modelli', 'Profili', 'Stato e costi', 'Client', 'Prova veloce']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Profili' }));
    expect(await screen.findByRole('heading', { name: 'Profili' })).toBeTruthy();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('R19b: funziona anche se localStorage lancia', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('bloccato'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('bloccato'); });
    mockApi({ 'GET /api/session': { ok: true, version: '0.1.0' }, 'GET /api/overview': { profiles: [], jobs: [], config: {}, advisor: {} } });
    render(<App />);
    await screen.findByText(/v0\.1\.0/);
    fireEvent.click(screen.getByRole('button', { name: 'Client' }));
    expect(await screen.findByRole('heading', { name: 'Profilo' })).toBeTruthy();
  });
});
