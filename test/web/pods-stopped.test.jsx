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
    { ...base, profile: 'spento', podId: 'p3', status: 'EXITED', state: 'stopped', stateLabel: 'spento', hourlyUSD: null, uptimeSeconds: 0, sessionUSD: null, diskGB: 44 },
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

  it('il Pod spento ha costo orario, uptime e sessione "—" (non 0,00)', async () => {
    mockApi({ 'GET /api/status': statusBody });
    mount();
    await screen.findByText('p3');
    const cells = within(screen.getByText('p3').closest('tr')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells.slice(4, 7)).toEqual(['—', '—', '—']);
    expect(screen.getByText('p3').closest('tr').textContent).not.toContain('0,00 $');
  });

  it('a eliminazione finita il pannello del job sparisce e lo stato si ricarica; se fallisce il pulsante torna attivo', async () => {
    let calls = 0;
    const fetchMock = mockApi({
      'GET /api/status': () => { calls += 1; return calls === 1 ? statusBody : { ...statusBody, pods: statusBody.pods.slice(0, 2) }; },
      'POST /api/jobs': { job: { id: 'j8', kind: 'down:spento', status: 'running' } },
      'GET /api/jobs/j8': { job: { id: 'j8', kind: 'down:spento', status: 'done', question: null, result: {} }, events: [{ seq: 0, type: 'phase', message: 'Terminazione del Pod p3' }, { seq: 1, type: 'done', result: {} }] },
    });
    mount();
    await screen.findByText('p3');
    fireEvent.click(screen.getByRole('button', { name: 'Elimina il Pod spento p3' }));
    await vi.waitFor(() => expect(screen.queryByText('p3')).toBeNull());
    expect(screen.queryByText(/Eliminazione di spento/)).toBeNull();
    expect(fetchMock.mock.calls.filter(([p]) => p === '/api/status').length).toBeGreaterThanOrEqual(2);
  });

  it('se l\'eliminazione fallisce il pannello resta con l\'errore e Elimina è di nuovo attivo', async () => {
    mockApi({
      'GET /api/status': statusBody,
      'POST /api/jobs': { job: { id: 'j9', kind: 'down:spento', status: 'running' } },
      'GET /api/jobs/j9': { job: { id: 'j9', kind: 'down:spento', status: 'failed', question: null, error: { message: 'Runpod non risponde' } }, events: [{ seq: 0, type: 'failed', error: { message: 'Runpod non risponde' } }] },
    });
    mount();
    await screen.findByText('p3');
    fireEvent.click(screen.getByRole('button', { name: 'Elimina il Pod spento p3' }));
    await screen.findByText('Runpod non risponde');
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Elimina il Pod spento p3' }).disabled).toBe(false));
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
