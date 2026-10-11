// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import Profiles from '../../web/src/pages/Profiles.jsx';
import Status from '../../web/src/pages/Status.jsx';
import { PlanView } from '../../web/src/components/PlanView.jsx';
import { mockApi } from './helpers.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const profile = { name: 'qwen3-coder', model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', gpu: { id: 'A100', count: 1 }, context: 65536, hourlyUSD: 1.79, advisorApplied: true };

describe('Profili', () => {
  it('elenca i profili e avvia un job con domanda', async () => {
    const fetchMock = mockApi({
      'GET /api/overview': { profiles: [profile], jobs: [], config: {}, advisor: {} },
      'POST /api/jobs': { job: { id: 'j1', kind: 'up:qwen3-coder', status: 'running' } },
      'GET /api/jobs/j1': { job: { id: 'j1', status: 'running', question: { id: 'q1', text: 'Avvio a 1,79 $/h. Confermi?', defYes: false } }, events: [{ type: 'phase', message: 'Controlli preliminari' }] },
      'POST /api/jobs/j1/answer': { ok: true },
    });
    render(<Profiles />);
    await screen.findByText('qwen3-coder');
    expect(screen.getByText(/1,79 \$\/h/)).toBeTruthy();
    expect(screen.getByText('consulente')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Avvia qwen3-coder' }));
    await screen.findByText('Avvio a 1,79 $/h. Confermi?');
    expect(screen.getByText(/Controlli preliminari/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sì' }));
    const answer = fetchMock.mock.calls.find(([p]) => p === '/api/jobs/j1/answer');
    expect(JSON.parse(answer[1].body)).toEqual({ questionId: 'q1', answer: true });
    expect(JSON.parse(fetchMock.mock.calls.find(([p, i]) => p === '/api/jobs' && i?.method === 'POST')[1].body)).toEqual({ action: 'up', profile: 'qwen3-coder' });
  });

  it('Spegni invia action down', async () => {
    const fetchMock = mockApi({
      'GET /api/overview': { profiles: [profile], jobs: [], config: {}, advisor: {} },
      'POST /api/jobs': { job: { id: 'j2', kind: 'down:qwen3-coder', status: 'running' } },
      'GET /api/jobs/j2': { job: { id: 'j2', status: 'running', question: null }, events: [] },
    });
    render(<Profiles />);
    await screen.findByText('qwen3-coder');
    fireEvent.click(screen.getByRole('button', { name: 'Spegni qwen3-coder' }));
    await screen.findByText('in corso');
    expect(JSON.parse(fetchMock.mock.calls.find(([p, i]) => p === '/api/jobs' && i?.method === 'POST')[1].body)).toEqual({ action: 'down', profile: 'qwen3-coder' });
  });

  it('mostra al caricamento i job già in corso (non quelli conclusi)', async () => {
    mockApi({
      'GET /api/overview': { profiles: [profile, { ...profile, name: 'altro' }], jobs: [{ id: 'j9', kind: 'up:qwen3-coder', status: 'running' }, { id: 'j8', kind: 'up:altro', status: 'done' }], config: {}, advisor: {} },
      'GET /api/jobs/j9': { job: { id: 'j9', status: 'running', question: null }, events: [{ type: 'phase', message: 'Attesa del Pod' }] },
    });
    render(<Profiles />);
    await screen.findByText(/Attesa del Pod/);
    expect(screen.getAllByText('in corso')).toHaveLength(1);
  });

  it('mostra il messaggio del server se il profilo ha già un job in corso (409)', async () => {
    mockApi({
      'GET /api/overview': { profiles: [profile], jobs: [], config: {}, advisor: {} },
      'POST /api/jobs': { __status: 409, body: { error: { code: 'HTTP', message: 'Per il profilo "qwen3-coder" c\'è già un\'operazione in corso (up)' } } },
    });
    render(<Profiles />);
    await screen.findByText('qwen3-coder');
    fireEvent.click(screen.getByRole('button', { name: 'Avvia qwen3-coder' }));
    await screen.findByText(/c'è già un'operazione in corso/);
    expect(screen.getByRole('button', { name: 'Avvia qwen3-coder' }).disabled).toBe(false);
  });

  it('il dialogo di conferma è montato su document.body, fuori dalla scheda', async () => {
    mockApi({
      'GET /api/overview': { profiles: [profile], jobs: [], config: {}, advisor: {} },
      'POST /api/jobs': { job: { id: 'j1', kind: 'up:qwen3-coder', status: 'running' } },
      'GET /api/jobs/j1': { job: { id: 'j1', status: 'running', question: { id: 'q1', text: 'Confermi?', defYes: false } }, events: [] },
    });
    render(<Profiles />);
    await screen.findByText('qwen3-coder');
    fireEvent.click(screen.getByRole('button', { name: 'Avvia qwen3-coder' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.closest('section')).toBeNull();
  });

  it('un job running del server prevale su una voce precedente terminata', async () => {
    let calls = 0;
    mockApi({
      'GET /api/overview': () => ({ profiles: [profile], jobs: [{ id: calls++ === 0 ? 'j1' : 'j2', kind: 'up:qwen3-coder', status: 'running' }], config: {}, advisor: {} }),
      'GET /api/jobs/j1': { job: { id: 'j1', status: 'running', question: null }, events: [{ seq: 0, type: 'phase', message: 'Primo job' }, { seq: 1, type: 'done', result: {} }] },
      'GET /api/jobs/j2': { job: { id: 'j2', status: 'running', question: null }, events: [{ seq: 0, type: 'phase', message: 'Secondo job' }] },
    });
    render(<Profiles />);
    // j1 termina -> onFinished ricarica la panoramica, che ora indica j2 in corso: prevale sulla voce j1
    await screen.findByText(/Secondo job/);
    expect(screen.queryByText(/Primo job/)).toBeNull();
  });

  it('Avvia/Spegni disabilitati finché il job del profilo è in corso, riabilitati a job concluso', async () => {
    mockApi({
      'GET /api/overview': { profiles: [profile], jobs: [{ id: 'j1', kind: 'up:qwen3-coder', status: 'running' }], config: {}, advisor: {} },
      'GET /api/jobs/j1': { job: { id: 'j1', status: 'running', question: null }, events: [{ seq: 0, type: 'phase', message: 'In avvio' }] },
    });
    render(<Profiles />);
    await screen.findByText(/In avvio/);
    expect(screen.getByRole('button', { name: 'Avvia qwen3-coder' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Spegni qwen3-coder' }).disabled).toBe(true);
  });

  it('job fallito: pulsanti di nuovo attivi', async () => {
    mockApi({
      'GET /api/overview': { profiles: [profile], jobs: [{ id: 'j1', kind: 'up:qwen3-coder', status: 'running' }], config: {}, advisor: {} },
      'GET /api/jobs/j1': { job: { id: 'j1', status: 'failed', question: null, error: { message: 'Nessuna GPU' } }, events: [{ seq: 0, type: 'failed', error: { message: 'Nessuna GPU' } }] },
    });
    render(<Profiles />);
    await screen.findByText('Nessuna GPU');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Avvia qwen3-coder' }).disabled).toBe(false));
  });

  it('doppio clic su Avvia: una sola POST', async () => {
    const m = mockApi({
      'GET /api/overview': { profiles: [profile], jobs: [], config: {}, advisor: {} },
      'POST /api/jobs': { job: { id: 'j1', kind: 'up:qwen3-coder', status: 'running' } },
      'GET /api/jobs/j1': { job: { id: 'j1', status: 'running', question: null }, events: [] },
    });
    render(<Profiles />);
    await screen.findByText('qwen3-coder');
    const btn = screen.getByRole('button', { name: 'Avvia qwen3-coder' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await screen.findByText('in corso');
    expect(m.mock.calls.filter(([p, i]) => p === '/api/jobs' && i?.method === 'POST')).toHaveLength(1);
  });

  it('riaprire un job già concluso non ricarica in loop', async () => {
    const m = mockApi({
      'GET /api/overview': { profiles: [profile], jobs: [{ id: 'j1', kind: 'up:qwen3-coder', status: 'running' }], config: {}, advisor: {} },
      'GET /api/jobs/j1': { job: { id: 'j1', status: 'done', question: null }, events: [{ seq: 0, type: 'phase', message: 'Fatto' }, { seq: 1, type: 'done', result: {} }] },
    });
    render(<Profiles />);
    await screen.findByText('completato');
    await new Promise((r) => setTimeout(r, 150));
    const count = (path) => m.mock.calls.filter(([p]) => p === path).length;
    expect(count('/api/overview')).toBe(2); // caricamento iniziale + un solo ricaricamento da onFinished
    expect(count('/api/jobs/j1')).toBeLessThanOrEqual(2);
  });

  it('errore di caricamento con "Riprova"', async () => {
    let fail = true;
    mockApi({ 'GET /api/overview': () => (fail ? { __status: 500, body: { error: { message: 'Errore interno' } } } : { profiles: [profile], jobs: [], config: {}, advisor: {} }) });
    render(<Profiles />);
    await screen.findByText('Errore interno');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await screen.findByText('qwen3-coder');
  });

  it('Avvia e Spegni hanno etichetta accessibile con il profilo e testo visibile', async () => {
    mockApi({ 'GET /api/overview': { profiles: [profile], jobs: [], config: {}, advisor: {} } });
    render(<Profiles />);
    await screen.findByText('qwen3-coder');
    expect(screen.getByRole('button', { name: 'Avvia qwen3-coder' }).textContent).toBe('Avvia');
    expect(screen.getByRole('button', { name: 'Spegni qwen3-coder' }).textContent).toBe('Spegni');
  });

  it('nessun profilo', async () => {
    mockApi({ 'GET /api/overview': { profiles: [], jobs: [], config: {}, advisor: {} } });
    render(<Profiles />);
    await screen.findByText(/Nessun profilo/);
  });

});

describe('Salvataggio profilo (R28)', () => {
  const plan = {
    model: { id: 'Qwen/X', revision: 'b2cff646eb4bb1d6', license: 'mit', gated: false }, context: 65536, concurrency: 2, kvCacheDtype: null, parsers: { tool: null, reasoning: null },
    estimate: { weightsGiB: 10, kvGiB: 2, perGpuGiB: 12 }, gpu: { id: 'A100', count: 1 }, hourlyUSD: 1.79, candidates: [], alternatives: [], vllm: { image: 'img', args: [] }, warnings: [],
  };
  const setup = (overview) => mockApi({
    'GET /api/overview': overview,
    'POST /api/profiles': { profile: { name: 'qwen3-coder' } },
  });
  const posts = (m) => m.mock.calls.filter(([p, i]) => p === '/api/profiles' && i?.method === 'POST');

  it('chiede conferma se il nome esiste già e salva solo dopo "Sovrascrivi"', async () => {
    const m = setup({ profiles: [{ name: 'qwen3-coder' }], jobs: [] });
    render(<PlanView data={{ plan, advice: null }} onPlanChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('Nome del profilo'), { target: { value: 'qwen3-coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/esiste già/);
    expect(posts(m)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Sovrascrivi' }));
    await screen.findByText(/Profilo salvato/);
    expect(posts(m)).toHaveLength(1);
  });

  it('Annulla non salva; nome nuovo salva senza conferma', async () => {
    const m = setup({ profiles: [{ name: 'qwen3-coder' }], jobs: [] });
    render(<PlanView data={{ plan, advice: null }} onPlanChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('Nome del profilo'), { target: { value: 'qwen3-coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/esiste già/);
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(screen.queryByText(/esiste già/)).toBeNull();
    expect(posts(m)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Nome del profilo'), { target: { value: 'nuovo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/Profilo salvato/);
    expect(posts(m)).toHaveLength(1);
  });
});

describe('Stato e costi', () => {
  const statusBody = {
    pods: [{ profile: 'qwen3-coder', podId: 'p1', status: 'RUNNING', gpu: { id: 'A100', count: 1 }, hourlyUSD: 1.79, uptimeSeconds: 3900, sessionUSD: 1.94, orphan: true, supervisor: { phase: 'ready', idleSeconds: 300, idleLimitSeconds: 1800, uptimeSeconds: 3900, maxSeconds: 28800 } }],
    balance: { balance: 42.5 }, volume: { name: 'llmpod-pesi', size: 150, dataCenterId: 'EU-RO-1', monthlyUSD: 10.5 },
  };

  it('mostra Pod, sessione, spegnimento, credito e volume', async () => {
    mockApi({ 'GET /api/status': statusBody });
    render(<Status />);
    await screen.findByText('p1');
    expect(screen.getByText('orfano')).toBeTruthy();
    expect(screen.getByText('1,94 $')).toBeTruthy();
    expect(screen.getByText(/inattivo da 5 min 0 s su 30 min 0 s/)).toBeTruthy();
    expect(screen.getByText(/42,50 \$/)).toBeTruthy();
    expect(screen.getByText(/10,50 \$ al mese/)).toBeTruthy();
  });

  it('nessun Pod, credito non disponibile, nessun volume; fase se il supervisor non misura l\'inattività', async () => {
    mockApi({ 'GET /api/status': { pods: [], balance: null, volume: null } });
    render(<Status />);
    await screen.findByText('Nessun Pod llmpod attivo.');
    expect(screen.getByText('non disponibile')).toBeTruthy();
    expect(screen.getByText('Nessun volume configurato.')).toBeTruthy();
    cleanup();
    mockApi({ 'GET /api/status': { ...statusBody, pods: [{ ...statusBody.pods[0], orphan: false, supervisor: { phase: 'loading' } }] } });
    render(<Status />);
    await screen.findByText('loading');
    expect(screen.queryByText('orfano')).toBeNull();
  });

  it('si aggiorna con il pulsante e ogni 15 secondi', async () => {
    const m = mockApi({ 'GET /api/status': statusBody });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Status />);
    await screen.findByText('p1');
    expect(m).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));
    await waitFor(() => expect(m).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
    await waitFor(() => expect(m.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('un errore di aggiornamento non cancella gli ultimi dati', async () => {
    let fail = false;
    mockApi({ 'GET /api/status': () => (fail ? { __status: 502, body: { error: { message: 'Runpod non risponde' } } } : statusBody) });
    render(<Status />);
    await screen.findByText('p1');
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));
    await screen.findByText('Runpod non risponde');
    expect(screen.getByText('p1')).toBeTruthy();
  });

  it('th con scope=col e errore con role=alert', async () => {
    let fail = false;
    mockApi({ 'GET /api/status': () => (fail ? { __status: 502, body: { error: { message: 'Runpod non risponde' } } } : statusBody) });
    render(<Status />);
    await screen.findByText('p1');
    for (const th of document.querySelectorAll('th')) expect(th.getAttribute('scope')).toBe('col');
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));
    const msg = await screen.findByText('Runpod non risponde');
    expect(msg.closest('[role="alert"]')).toBeTruthy();
  });

  it('nessuna sovrapposizione: durante una richiesta in corso timer e clic non ne avviano altre', async () => {
    let release;
    const m = mockApi({ 'GET /api/status': () => new Promise((r) => { release = () => r(statusBody); }) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Status />);
    await waitFor(() => expect(m).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(m).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await screen.findByText('p1');
  });

  it('clearInterval allo smontaggio: nessuna richiesta dopo unmount', async () => {
    const m = mockApi({ 'GET /api/status': statusBody });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = render(<Status />);
    await screen.findByText('p1');
    unmount();
    const before = m.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(m.mock.calls.length).toBe(before);
  });

  it('timeout di 20 s: una richiesta appesa non blocca i refresh successivi', async () => {
    let hang = true;
    const m = vi.spyOn(globalThis, 'fetch').mockImplementation((path, init = {}) => {
      if (hang) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      return Promise.resolve(new Response(JSON.stringify(statusBody), { status: 200 }));
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Status />);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_100); });
    await screen.findByText(/troppo tempo/);
    hang = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
    await screen.findByText('p1');
    expect(m.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('polling in pausa con la scheda nascosta; riprende su visibilitychange', async () => {
    const m = mockApi({ 'GET /api/status': statusBody });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Status />);
    await screen.findByText('p1');
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      const before = m.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
      expect(m.mock.calls.length).toBe(before);
      hidden = false;
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => expect(m.mock.calls.length).toBe(before + 1));
    } finally {
      delete document.hidden;
    }
  });
});
