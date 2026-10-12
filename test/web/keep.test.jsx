// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import Status from '../../web/src/pages/Status.jsx';
import { mockApi } from './helpers.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const sup = { phase: 'ready', idleSeconds: 300, idleLimitSeconds: 1800, uptimeSeconds: 7200, maxSeconds: 28800 };
const pod = (over = {}) => ({ profile: 'qwen3-coder', podId: 'p1', status: 'RUNNING', state: 'running', stateLabel: 'avviato', gpu: { id: 'A100', count: 1 }, hourlyUSD: 1.5, uptimeSeconds: 7200, sessionUSD: 3, orphan: false, supervisor: sup, ...over });
const statusBody = (pods) => ({ pods, balance: { balance: 42.5 }, volume: null });
const posts = (m) => m.mock.calls.filter(([p, i]) => p === '/api/pods/qwen3-coder/watchdog' && i?.method === 'POST').map(([, i]) => JSON.parse(i.body));

async function open(m = {}) {
  const fetchMock = mockApi({ 'GET /api/status': statusBody([pod()]), ...m });
  render(<Status />);
  await screen.findByText('p1');
  fireEvent.click(screen.getByRole('button', { name: 'Prolunga il Pod p1' }));
  const dialog = await screen.findByRole('dialog');
  return { fetchMock, dialog };
}

describe('Stato: Prolunga un Pod avviato', () => {
  it('il pulsante c\'è solo per i Pod avviati di cui si conoscono i limiti', async () => {
    mockApi({ 'GET /api/status': statusBody([
      pod(),
      pod({ profile: 'nuovo', podId: 'p2', status: 'CREATED', state: 'starting', supervisor: null }),
      pod({ profile: 'spento', podId: 'p3', status: 'EXITED', state: 'stopped', supervisor: null, hourlyUSD: null }),
      pod({ profile: 'muto', podId: 'p4', supervisor: null }),
    ]) });
    render(<Status />);
    await screen.findByText('p1');
    expect(screen.getAllByRole('button', { name: /^Prolunga/ })).toHaveLength(1);
  });

  it('la finestra parte dai limiti correnti letti dal supervisore e "Applica" è disattivato finché non cambia nulla', async () => {
    const { dialog } = await open();
    expect(within(dialog).getByLabelText('Inattività (minuti)').value).toBe('30');
    expect(within(dialog).getByLabelText('Ore massime dall\'avvio').value).toBe('8');
    expect(within(dialog).getByLabelText('Mai (non spegnere per inattività)').checked).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Applica' }).disabled).toBe(true);
  });

  it('aumentare le ore massime mostra il costo massimo e il pulsante lo riporta: un solo clic conferma e invia solo ciò che è cambiato', async () => {
    const { fetchMock, dialog } = await open({ 'POST /api/pods/qwen3-coder/watchdog': { podId: 'p1', maxSeconds: 43200 } });
    fireEvent.change(within(dialog).getByLabelText('Ore massime dall\'avvio'), { target: { value: '12' } });
    // restano 12 h - 2 h = 10 h × 1,50 $/h = 15,00 $
    expect(within(dialog).getByText(/Costo massimo stimato fino alla scadenza: 15,00 \$/)).toBeTruthy();
    expect(within(dialog).getByText(/10 h 0 min/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: /Conferma e prolunga.*15,00 \$/ });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(fetchMock)).toEqual([{ idleMinutes: null, maxHours: 12 }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/Limiti aggiornati per qwen3-coder/)).toBeTruthy();
    // lo stato si ricarica per mostrare i nuovi limiti
    await waitFor(() => expect(fetchMock.mock.calls.filter(([p]) => p === '/api/status').length).toBeGreaterThanOrEqual(2));
  });

  it('"Mai" disattiva l\'inattività (0 minuti) e blocca il campo, senza costo né conferma extra', async () => {
    const { fetchMock, dialog } = await open({ 'POST /api/pods/qwen3-coder/watchdog': { podId: 'p1' } });
    fireEvent.click(within(dialog).getByLabelText('Mai (non spegnere per inattività)'));
    expect(within(dialog).getByLabelText('Inattività (minuti)').disabled).toBe(true);
    expect(within(dialog).queryByText(/Costo massimo stimato/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Applica' }));
    await waitFor(() => expect(posts(fetchMock)).toEqual([{ idleMinutes: 0, maxHours: null }]));
  });

  it('accorciare le ore massime non richiede conferma del costo', async () => {
    const { fetchMock, dialog } = await open({ 'POST /api/pods/qwen3-coder/watchdog': { podId: 'p1' } });
    fireEvent.change(within(dialog).getByLabelText('Ore massime dall\'avvio'), { target: { value: '4' } });
    expect(within(dialog).queryByText(/Costo massimo stimato/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Applica' }));
    await waitFor(() => expect(posts(fetchMock)).toEqual([{ idleMinutes: null, maxHours: 4 }]));
  });

  it('valori fuori intervallo: messaggio e pulsante disattivato, nessuna richiesta', async () => {
    const { fetchMock, dialog } = await open();
    fireEvent.change(within(dialog).getByLabelText('Ore massime dall\'avvio'), { target: { value: '500' } });
    expect(within(dialog).getByText(/tra 0,25 e 168/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Applica|Conferma/ }).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Ore massime dall\'avvio'), { target: { value: '8' } });
    fireEvent.change(within(dialog).getByLabelText('Inattività (minuti)'), { target: { value: '2000' } });
    expect(within(dialog).getByText(/tra 0 e 1440/)).toBeTruthy();
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it('un errore (es. supervisore vecchio) resta nella finestra con il suggerimento', async () => {
    const { dialog } = await open({ 'POST /api/pods/qwen3-coder/watchdog': { __status: 400, body: { error: { code: 'INVALID_INPUT', message: 'Il supervisore del Pod p1 è di una versione precedente', hint: 'Serve un Pod avviato con questa versione di llmpod' } } } });
    fireEvent.change(within(dialog).getByLabelText('Ore massime dall\'avvio'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Conferma e prolunga/ }));
    expect(await within(dialog).findByText(/versione precedente/)).toBeTruthy();
    expect(within(dialog).getByText(/Serve un Pod avviato con questa versione/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Annulla chiude senza inviare nulla', async () => {
    const { fetchMock, dialog } = await open();
    fireEvent.change(within(dialog).getByLabelText('Ore massime dall\'avvio'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annulla' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(fetchMock)).toHaveLength(0);
  });
});

describe('Stato: colonna Spegnimento con i limiti correnti', () => {
  it('inattività disattivata e fase senza inattività misurata', async () => {
    mockApi({ 'GET /api/status': statusBody([pod({ supervisor: { ...sup, idleLimitSeconds: 0 } })]) });
    render(<Status />);
    await screen.findByText(/inattività: mai; massimo tra 6 h 0 min/);
    cleanup();
    mockApi({ 'GET /api/status': statusBody([pod({ supervisor: { ...sup, phase: 'loading', idleSeconds: null } })]) });
    render(<Status />);
    await screen.findByText(/loading; massimo tra 6 h 0 min/);
  });
});
