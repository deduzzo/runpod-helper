// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import App from '../../web/src/App.jsx';
import { mockApi, FakeEventSource } from './helpers.js';

beforeEach(() => { try { localStorage.clear(); } catch { /* ok */ } FakeEventSource.reset(); vi.stubGlobal('EventSource', FakeEventSource); });
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

  describe('banner della domanda in sospeso (Minor 6)', () => {
    const session = { 'GET /api/session': { ok: true, version: '0.1.0' }, 'GET /api/overview': { profiles: [], jobs: [], config: {}, advisor: {} }, 'GET /api/jobs': { jobs: [] } };
    const emit = (e) => act(async () => { FakeEventSource.last.emit('job', e); });
    const mountApp = async () => { mockApi(session); render(<App />); await screen.findByText(/v0\.1\.0/); };

    it('una domanda non seguita da answer/done/failed mostra il banner fuori da Profili; "Vai a Profili" cambia scheda', async () => {
      await mountApp();
      expect(screen.queryByText('Una domanda attende risposta')).toBeNull();
      await emit({ jobId: 'j1', seq: 3, type: 'question', questionId: 'q1', text: 'Terminare il Pod?', defYes: true });
      expect(screen.getByText('Una domanda attende risposta')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Vai a Profili' }));
      expect(await screen.findByRole('heading', { name: 'Profili' })).toBeTruthy();
      expect(screen.queryByText('Una domanda attende risposta')).toBeNull();
    });

    it('nessun banner se la scheda attiva è già Profili', async () => {
      await mountApp();
      fireEvent.click(screen.getByRole('button', { name: 'Profili' }));
      await screen.findByRole('heading', { name: 'Profili' });
      await emit({ jobId: 'j1', seq: 0, type: 'question', questionId: 'q1', text: 'Confermi?', defYes: false });
      expect(screen.queryByText('Una domanda attende risposta')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Client' }));
      expect(await screen.findByText('Una domanda attende risposta')).toBeTruthy();
    });

    it.each([
      ['answer', { type: 'answer', questionId: 'q1', answer: true }],
      ['done', { type: 'done', result: null }],
      ['failed', { type: 'failed', error: { message: 'x' } }],
    ])('il banner sparisce con %s dello stesso job; un answer di un\'altra domanda non lo toglie', async (_n, closing) => {
      await mountApp();
      await emit({ jobId: 'j1', seq: 0, type: 'question', questionId: 'q1', text: 'Confermi?', defYes: false });
      await emit({ jobId: 'j1', seq: 1, type: 'answer', questionId: 'altra', answer: true });
      expect(screen.getByText('Una domanda attende risposta')).toBeTruthy();
      await emit({ jobId: 'j2', seq: 0, type: 'done', result: null });
      expect(screen.getByText('Una domanda attende risposta')).toBeTruthy();
      await emit({ jobId: 'j1', seq: 2, ...closing });
      expect(screen.queryByText('Una domanda attende risposta')).toBeNull();
    });

    it('una domanda già pendente (job in corso al caricamento) viene mostrata subito', async () => {
      mockApi({ ...session, 'GET /api/jobs': { jobs: [{ id: 'j9', kind: 'down:p', status: 'running', question: { id: 'q9', text: 'Terminare?', defYes: true } }] } });
      render(<App />);
      expect(await screen.findByText('Una domanda attende risposta')).toBeTruthy();
    });
  });
});
