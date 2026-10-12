// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import Status from '../../web/src/pages/Status.jsx';
import { EventsProvider } from '../../web/src/lib/events.jsx';
import { mockApi, FakeEventSource } from './helpers.js';

beforeEach(() => { FakeEventSource.reset(); vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const base = { gpu: { id: 'A100', count: 1 }, orphan: false, supervisor: null };
const statusBody = {
  pods: [
    { ...base, profile: 'acceso', podId: 'p1', status: 'RUNNING', state: 'running', stateLabel: 'avviato', hourlyUSD: 1.79, uptimeSeconds: 3900, sessionUSD: 1.94, diskGB: 44 },
    { ...base, profile: 'nuovo', podId: 'p2', status: 'CREATED', state: 'starting', stateLabel: 'in avvio', hourlyUSD: 1.79, uptimeSeconds: 10, sessionUSD: 0, diskGB: 20 },
    { ...base, profile: 'spento', podId: 'p3', status: 'EXITED', state: 'stopped', stateLabel: 'spento', hourlyUSD: 0, uptimeSeconds: 0, sessionUSD: 0, diskGB: 44 },
  ],
  balance: { balance: 42.5 }, volume: null,
};
const mount = () => render(<EventsProvider><Status /></EventsProvider>);

describe('Stato e costi: Pod avviati e spenti', () => {
  it('badge diversi per avviato, in avvio e spento', async () => {
    mockApi({ 'GET /api/status': statusBody });
    mount();
    await screen.findByText('p1');
    const badge = (text) => screen.getByText(text, { selector: 'span' });
    expect(badge('avviato').className).toMatch(/emerald/);
    expect(badge('in avvio').className).toMatch(/amber/);
    expect(badge('spento').className).toMatch(/orange/);
    expect(screen.queryByText('RUNNING')).toBeNull();
  });

  it('per il Pod spento: avviso sul costo del disco, costo di storage e pulsante Elimina (solo per gli spenti)', async () => {
    mockApi({ 'GET /api/status': statusBody });
    mount();
    await screen.findByText('p3');
    expect(screen.getByText('Spento: occupa ancora 44 GB di disco e continua a costare — eliminalo con llmpod down spento')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Elimina/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Elimina il Pod spento p3' })).toBeTruthy();
  });

  it('Elimina avvia il job down del profilo; la conferma passa dalla domanda del job', async () => {
    const fetchMock = mockApi({
      'GET /api/status': statusBody,
      'POST /api/jobs': { job: { id: 'j7', kind: 'down:spento', status: 'running' } },
      'GET /api/jobs/j7': { job: { id: 'j7', kind: 'down:spento', status: 'running', question: { id: 'q1', kind: 'confirm', text: 'Eliminare il Pod spento p3 (spento): costa ancora lo spazio su disco?. Confermi?', defYes: false } }, events: [] },
      'POST /api/jobs/j7/answer': { ok: true },
    });
    mount();
    await screen.findByText('p3');
    fireEvent.click(screen.getByRole('button', { name: 'Elimina il Pod spento p3' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Eliminare il Pod spento p3/)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([p, i]) => p === '/api/jobs' && i?.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({ action: 'down', profile: 'spento' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sì' }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([p]) => p === '/api/jobs/j7/answer')).toBe(true));
  });

  it('se il job non parte (es. operazione già in corso) mostra l\'errore', async () => {
    mockApi({
      'GET /api/status': statusBody,
      'POST /api/jobs': { __status: 409, body: { error: { code: 'HTTP', message: 'c\'è già un\'operazione in corso (up)' } } },
    });
    mount();
    await screen.findByText('p3');
    fireEvent.click(screen.getByRole('button', { name: 'Elimina il Pod spento p3' }));
    await screen.findByText(/già un'operazione in corso/);
  });

  it('senza Pod: messaggio che comprende anche i Pod spenti', async () => {
    mockApi({ 'GET /api/status': { pods: [], balance: null, volume: null } });
    mount();
    await screen.findByText('Nessun Pod llmpod (né avviato né spento).');
  });

  it('dati vecchi senza state: lo stato si ricava da status', async () => {
    mockApi({ 'GET /api/status': { pods: [{ ...base, profile: 'x', podId: 'p9', status: 'EXITED', hourlyUSD: 0, uptimeSeconds: 0, sessionUSD: 0 }], balance: null, volume: null } });
    mount();
    await screen.findByText('p9');
    expect(screen.getByText('spento', { selector: 'span' })).toBeTruthy();
  });
});
