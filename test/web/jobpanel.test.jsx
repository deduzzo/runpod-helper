// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { JobPanel } from '../../web/src/components/JobPanel.jsx';
import { EventsProvider } from '../../web/src/lib/events.jsx';
import { mockApi, FakeEventSource } from './helpers.js';

const job = (over = {}) => ({ id: 'j1', kind: 'up:p', status: 'running', question: null, result: null, error: null, ...over });
const ev = (seq, type, extra = {}) => ({ jobId: 'j1', seq, type, ...extra });

function mount(props = {}) {
  return render(<EventsProvider><JobPanel jobId="j1" {...props} /></EventsProvider>);
}

beforeEach(() => { FakeEventSource.reset(); vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('JobPanel', () => {
  it('mostra fasi dallo stato iniziale e deduplica gli eventi SSE già visti (seq)', async () => {
    mockApi({ 'GET /api/jobs/j1': { job: job(), events: [ev(0, 'phase', { message: 'Controlli preliminari' }), ev(1, 'phase', { message: 'Creazione del Pod' })] } });
    mount();
    await screen.findByText(/Creazione del Pod/);
    await act(async () => { FakeEventSource.last.emit('job', ev(1, 'phase', { message: 'Creazione del Pod' })); });
    await act(async () => { FakeEventSource.last.emit('job', ev(2, 'phase', { message: 'Attesa dell\'avvio' })); });
    expect(screen.getAllByText(/Creazione del Pod/)).toHaveLength(1);
    expect(screen.getAllByText(/Attesa dell'avvio/)).toHaveLength(1);
  });

  it('ignora gli eventi di altri job', async () => {
    mockApi({ 'GET /api/jobs/j1': { job: job(), events: [] } });
    mount();
    await screen.findByText('in corso');
    await act(async () => { FakeEventSource.last.emit('job', { jobId: 'altro', seq: 0, type: 'phase', message: 'Non mio' }); });
    expect(screen.queryByText(/Non mio/)).toBeNull();
  });

  it('alla riconnessione SSE rifà il fetch con since = ultimo seq + 1 e non duplica', async () => {
    const fetchMock = mockApi({
      'GET /api/jobs/j1': (init, url) => (url.includes('since=2')
        ? { job: job(), events: [ev(2, 'phase', { message: 'Dopo la riconnessione' })] }
        : { job: job(), events: [ev(0, 'phase', { message: 'Inizio' }), ev(1, 'info', { message: 'Info uno' })] }),
    });
    mount();
    await screen.findByText(/Info uno/);
    await act(async () => { FakeEventSource.last.open(); });
    await screen.findByText(/Dopo la riconnessione/);
    const urls = fetchMock.mock.calls.map(([p]) => p);
    expect(urls).toContain('/api/jobs/j1?since=2');
    expect(screen.getAllByText(/Inizio/)).toHaveLength(1);
    expect(screen.getAllByText(/Info uno/)).toHaveLength(1);
  });

  it('un buco nella sequenza SSE provoca la risincronizzazione', async () => {
    const fetchMock = mockApi({
      'GET /api/jobs/j1': (init, url) => (url.includes('since=1')
        ? { job: job(), events: [ev(1, 'phase', { message: 'Perso' }), ev(2, 'phase', { message: 'Tre' })] }
        : { job: job(), events: [ev(0, 'phase', { message: 'Zero' })] }),
    });
    mount();
    await screen.findByText(/Zero/);
    await act(async () => { FakeEventSource.last.emit('job', ev(2, 'phase', { message: 'Tre' })); });
    await screen.findByText(/Perso/);
    expect(screen.getAllByText(/Tre/)).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([p]) => p === '/api/jobs/j1?since=1')).toBe(true);
  });

  it('errore di caricamento: ErrorBox, niente spinner infinito', async () => {
    mockApi({ 'GET /api/jobs/j1': { __status: 404, body: { error: { code: 'HTTP', message: 'Job non trovato' } } } });
    mount();
    await screen.findByText('Job non trovato');
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('mostra advice (motivazione e diff), info e pod', async () => {
    mockApi({ 'GET /api/jobs/j1': { job: job(), events: [
      ev(0, 'pod', { podId: 'pod123' }),
      ev(1, 'info', { message: 'Profilo p aggiornato' }),
      ev(2, 'advice', { rationale: 'Riduci la memoria', changes: { added: ['--enforce-eager'], removed: ['--foo'], changed: [{ flag: '--max-model-len', from: '65536', to: '32768' }] }, rejected: [], warnings: ['Attenzione'] }),
    ] } });
    mount();
    await screen.findByText(/Riduci la memoria/);
    expect(screen.getByText(/pod123/)).toBeTruthy();
    expect(screen.getByText(/Profilo p aggiornato/)).toBeTruthy();
    expect(screen.getByText(/--enforce-eager/)).toBeTruthy();
    expect(screen.getByText(/--foo/)).toBeTruthy();
    expect(screen.getByText(/--max-model-len/)).toBeTruthy();
    expect(screen.getByText(/Attenzione/)).toBeTruthy();
  });

  it('domanda: risposta booleana via POST con content-type JSON; chiusura con evento answer', async () => {
    const fetchMock = mockApi({
      'GET /api/jobs/j1': { job: job({ question: { id: 'q1', text: 'Terminare il Pod?', defYes: true } }), events: [ev(0, 'question', { questionId: 'q1', text: 'Terminare il Pod?', defYes: true })] },
      'POST /api/jobs/j1/answer': { ok: true },
    });
    mount();
    await screen.findByText('Terminare il Pod?');
    fireEvent.click(screen.getByRole('button', { name: 'Sì' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([p, i]) => p === '/api/jobs/j1/answer' && i.method === 'POST')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([p]) => p === '/api/jobs/j1/answer');
    expect(JSON.parse(init.body)).toEqual({ questionId: 'q1', answer: true });
    expect(init.headers['content-type']).toBe('application/json');
    await waitFor(() => expect(screen.queryByText('Terminare il Pod?')).toBeNull());
  });

  it('risposta rifiutata (409): domanda chiusa e messaggio, nessun crash', async () => {
    mockApi({
      'GET /api/jobs/j1': { job: job({ question: { id: 'q1', text: 'Confermi?', defYes: false } }), events: [ev(0, 'question', { questionId: 'q1', text: 'Confermi?', defYes: false })] },
      'POST /api/jobs/j1/answer': { __status: 409, body: { error: { code: 'CONFLICT', message: 'La domanda non è più attiva' } } },
    });
    mount();
    await screen.findByText('Confermi?');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    await screen.findByText('La domanda non è più attiva');
  });

  it('done chiama onFinished una sola volta (anche con evento duplicato); failed mostra ErrorBox', async () => {
    mockApi({ 'GET /api/jobs/j1': { job: job(), events: [ev(0, 'phase', { message: 'Avvio' })] } });
    const onFinished = vi.fn();
    mount({ onFinished });
    await screen.findByText(/Avvio/);
    await act(async () => { FakeEventSource.last.emit('job', ev(1, 'done', { result: { podId: 'p1' } })); });
    await act(async () => { FakeEventSource.last.emit('job', ev(1, 'done', { result: { podId: 'p1' } })); });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith({ podId: 'p1' });
    expect(screen.getByText('completato')).toBeTruthy();
  });

  it('failed mostra messaggio e suggerimento', async () => {
    mockApi({ 'GET /api/jobs/j1': { job: job({ status: 'failed', error: { code: 'X', message: 'Nessuna GPU', hint: 'Riprova' } }), events: [ev(0, 'failed', { error: { code: 'X', message: 'Nessuna GPU', hint: 'Riprova' } })] } });
    mount();
    await screen.findByText('Nessuna GPU');
    expect(screen.getByText('Riprova')).toBeTruthy();
    expect(screen.getByText('non riuscito')).toBeTruthy();
  });

  it('conserva solo gli ultimi 200 log', async () => {
    const events = Array.from({ length: 250 }, (_, i) => ev(i, 'log', { line: `riga-${i}` }));
    mockApi({ 'GET /api/jobs/j1': { job: job(), events } });
    mount();
    fireEvent.click(await screen.findByText(/Mostra i log di vLLM \(200\)/));
    const pre = document.querySelector('pre');
    expect(pre.textContent).toContain('riga-249');
    expect(pre.textContent).not.toContain('riga-49\n');
    expect(pre.textContent.split('\n')).toHaveLength(200);
  });
});
