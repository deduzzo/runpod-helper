// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Clients from '../../web/src/pages/Clients.jsx';
import QuickTest from '../../web/src/pages/QuickTest.jsx';
import { embedUrl } from '../../web/src/lib/openwebui.js';
import { mockApi } from './helpers.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const overview = { profiles: [{ name: 'qwen3-coder' }], jobs: [], config: { openwebuiProfile: null }, advisor: {} };
const body = (fetchMock, p) => JSON.parse(fetchMock.mock.calls.find(([path]) => path === p)[1].body);

describe('Client', () => {
  it('comandi, export su richiesta e ZCode con conferma', async () => {
    const fetchMock = mockApi({
      'GET /api/overview': overview,
      'POST /api/env': { env: { ANTHROPIC_BASE_URL: 'https://p1-8000.proxy.runpod.net', ANTHROPIC_AUTH_TOKEN: "k'ey" } },
      'POST /api/clients/zcode': { file: '/home/u/.zcode/v2/config.json' },
    });
    render(<Clients />);
    await screen.findByText('llmpod run claude --profile qwen3-coder');
    expect(screen.queryByText(/ANTHROPIC_AUTH_TOKEN/)).toBeNull(); // niente chiave senza richiesta esplicita
    expect(fetchMock.mock.calls.some(([p]) => p === '/api/env')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Mostra gli export' }));
    await screen.findByText(/export ANTHROPIC_AUTH_TOKEN='k'\\''ey'/);
    expect(screen.getByText(/Contiene la chiave del profilo/)).toBeTruthy();
    const zcode = screen.getByRole('button', { name: 'Configura ZCode' });
    expect(zcode.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/ZCode è chiuso/));
    fireEvent.click(zcode);
    await screen.findByText(/config\.json/);
    expect(body(fetchMock, '/api/clients/zcode')).toEqual({ profile: 'qwen3-coder', zcodeClosed: true });
  });

  it('R19c: select con etichetta "Profilo" (elenca tutti i profili); nome con caratteri speciali quotato nei comandi', async () => {
    mockApi({ 'GET /api/overview': { ...overview, profiles: [{ name: 'a b' }, { name: 'qwen3-coder' }] } });
    render(<Clients />);
    await screen.findByText("llmpod run claude --profile 'a b'");
    expect(screen.getByLabelText('Profilo')).toBeTruthy();
    expect(screen.queryByLabelText(/con Pod attivo/)).toBeNull();
  });

  it('cambiando profilo gli export mostrati vengono nascosti', async () => {
    mockApi({
      'GET /api/overview': { ...overview, profiles: [{ name: 'qwen3-coder' }, { name: 'altro' }] },
      'POST /api/env': { env: { LLMPOD_API_KEY: 'chiave-di-prova' } },
    });
    render(<Clients />);
    await screen.findByText('llmpod run pi --profile qwen3-coder');
    fireEvent.click(screen.getByRole('button', { name: 'Mostra gli export' }));
    await screen.findByText(/chiave-di-prova/);
    fireEvent.change(screen.getByLabelText('Profilo'), { target: { value: 'altro' } });
    expect(screen.queryByText(/chiave-di-prova/)).toBeNull();
  });

  it('errore dell\'API (ZCode in esecuzione) mostrato all\'utente', async () => {
    mockApi({
      'GET /api/overview': overview,
      'POST /api/clients/zcode': { __status: 400, body: { error: { code: 'INVALID_INPUT', message: 'ZCode è in esecuzione' } } },
    });
    render(<Clients />);
    await screen.findByText('llmpod run claude --profile qwen3-coder');
    fireEvent.click(screen.getByLabelText(/ZCode è chiuso/));
    fireEvent.click(screen.getByRole('button', { name: 'Configura ZCode' }));
    await screen.findByText('ZCode è in esecuzione');
  });
});

describe('Prova veloce', () => {
  it('iframe di Open WebUI e scelta del profilo (R27: host diverso da quello dell\'interfaccia)', async () => {
    const fetchMock = mockApi({
      'GET /api/overview': overview,
      'GET /api/openwebui': { url: 'http://127.0.0.1:3000', profile: null, proxy: { port: 8081, listening: true } },
      'POST /api/openwebui/profile': { ok: true },
    });
    // jsdom è su http://localhost:3000/: l'iframe usa 127.0.0.1, così il cookie di sessione dell'interfaccia non gli arriva.
    expect(window.location.hostname).toBe('localhost');
    render(<QuickTest />);
    const frame = await screen.findByTitle('Open WebUI');
    expect(frame.getAttribute('src')).toBe('http://127.0.0.1:3000');
    expect(screen.getByText('Apri in una nuova scheda').getAttribute('href')).toBe('http://127.0.0.1:3000');
    expect(screen.getByText(/8081/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Profilo per Open WebUI/), { target: { value: 'qwen3-coder' } });
    await screen.findByText(/Profilo impostato/);
    expect(body(fetchMock, '/api/openwebui/profile')).toEqual({ profile: 'qwen3-coder' });
  });

  it('indirizzo non loopback invariato; proxy non attivo; errore 409 sul profilo', async () => {
    mockApi({
      'GET /api/overview': overview,
      'GET /api/openwebui': { url: 'https://owui.example.org', profile: null, proxy: null },
      'POST /api/openwebui/profile': { __status: 409, body: { error: { message: 'Per il profilo "qwen3-coder" c\'è già un\'operazione in corso (up)' } } },
    });
    render(<QuickTest />);
    expect((await screen.findByTitle('Open WebUI')).getAttribute('src')).toBe('https://owui.example.org');
    expect(screen.getByText('non attivo')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Profilo per Open WebUI/), { target: { value: 'qwen3-coder' } });
    await screen.findByText(/operazione in corso/);
    expect(screen.queryByText(/Profilo impostato/)).toBeNull();
  });

  it('errore nel caricamento mostrato', async () => {
    mockApi({});
    render(<QuickTest />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});

describe('embedUrl (R27)', () => {
  it('scambia 127.0.0.1 e localhost solo se coincidono con l\'host della pagina', () => {
    expect(embedUrl('http://127.0.0.1:3000', '127.0.0.1')).toBe('http://localhost:3000');
    expect(embedUrl('http://localhost:3100', 'localhost')).toBe('http://127.0.0.1:3100');
    expect(embedUrl('http://127.0.0.1:3000', 'localhost')).toBe('http://127.0.0.1:3000');
    expect(embedUrl('https://owui.example.org', 'localhost')).toBe('https://owui.example.org');
    expect(embedUrl('http://127.0.0.1:3000/chat?x=1', '127.0.0.1')).toBe('http://localhost:3000/chat?x=1');
    expect(embedUrl('non-un-url', 'localhost')).toBe('non-un-url');
  });
});
