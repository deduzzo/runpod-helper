// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Models from '../../web/src/pages/Models.jsx';
import { mockApi } from './helpers.js';
import { PlanView } from '../../web/src/components/PlanView.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'b2cff646eb4bb1d6', requestedRevision: 'main', license: 'apache-2.0', gated: false },
  context: 65536, concurrency: 2, kvCacheDtype: null, parsers: { tool: 'qwen3_coder', reasoning: null },
  estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 }, gpu: { id: 'NVIDIA A100 80GB PCIe', count: 1 }, hourlyUSD: 1.79,
  candidates: [{ gpuId: 'NVIDIA A100 80GB PCIe', name: 'A100 80GB', count: 1, memoryGiB: 80, perGpuGiB: 70.9, headroomGiB: 1.1, hourly: 1.79, availabilityHere: 'HIGH' }],
  alternatives: [], dataCenterId: 'EU-RO-1', vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536'] }, warnings: ['Modello con licenza da verificare'],
};
const advice = { accepted: ['enable-prefix-caching=true'], rejected: [{ key: 'api-key', reason: 'flag vietato' }], changes: { added: ['--enable-prefix-caching'], removed: [], changed: [] }, rationale: 'Suggerito dalla recipe', warnings: [], recipePath: 'Qwen/Qwen3-Coder-480B-A35B.md' };

describe('pagina Modelli', () => {
  it('ricerca, scelta del modello, piano con proposta, applica e salva', async () => {
    const fetchMock = mockApi({
      'GET /api/search': { rows: [{ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', params: 30.5e9, weightsGiB: 56.9, license: 'apache-2.0', gated: false, parser: 'qwen3_coder' }, { id: 'x/Strano', params: 7e9, weightsGiB: null, license: null, gated: 'manual', parser: null }] },
      'POST /api/plan': { plan, planId: 'piano-1', advice, advisorError: null, advisorSkipped: null },
      'POST /api/plan/apply-advice': { plan: { ...plan, vllm: { ...plan.vllm, args: ['--max-model-len', '65536', '--enable-prefix-caching'] } }, planId: 'piano-2' },
      'POST /api/profiles': { profile: { name: 'qwen3-coder' } },
    });
    render(<Models />);
    fireEvent.change(screen.getByPlaceholderText(/cerca/i), { target: { value: 'qwen3 coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }));
    await screen.findByText('x/Strano');
    expect(screen.getByText('nessuno')).toBeTruthy();
    fireEvent.click(screen.getByText('Qwen/Qwen3-Coder-30B-A3B-Instruct'));
    expect(screen.getByLabelText(/Modello/).value).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');
    fireEvent.click(screen.getByRole('button', { name: 'Calcola il piano' }));
    await screen.findByText('Suggerito dalla recipe');
    expect(screen.getAllByText(/1,79 \$\/h/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\+ --enable-prefix-caching/)).toBeTruthy();
    expect(screen.getByText(/api-key: flag vietato/)).toBeTruthy();
    const planCall = fetchMock.mock.calls.find(([p, i]) => p === '/api/plan' && i?.method === 'POST');
    expect(JSON.parse(planCall[1].body)).toMatchObject({ model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', context: 65536, concurrency: 2, advisor: true });
    fireEvent.click(screen.getByRole('button', { name: 'Applica la proposta' }));
    await screen.findByText('Proposta applicata');
    await waitFor(() => expect(document.querySelector('pre').textContent).toMatch(/--enable-prefix-caching$/));
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'qwen3-coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/Profilo salvato/);
    // R11: il salvataggio invia l'id del piano visualizzato (quello dopo l'applicazione della proposta)
    const saveCall = fetchMock.mock.calls.find(([p, i]) => p === '/api/profiles' && i?.method === 'POST');
    expect(JSON.parse(saveCall[1].body)).toEqual({ name: 'qwen3-coder', planId: 'piano-2' });
  });

  it('R11: 409 "Il piano è cambiato" al salvataggio è mostrato e il profilo non risulta salvato', async () => {
    mockApi({
      'GET /api/overview': { profiles: [] },
      'POST /api/profiles': { __status: 409, body: { error: { code: 'HTTP', message: 'Il piano è cambiato: ricalcolalo prima di salvare' } } },
    });
    render(<PlanView data={{ plan, planId: 'piano-1', advice: null, advisorError: null, advisorSkipped: null }} onPlanChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'qwen3-coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/Il piano è cambiato/);
    expect(screen.queryByText(/Profilo salvato/)).toBeNull();
  });

  it('pesi non stimabili (null) mostrati come "?"', async () => {
    mockApi({ 'GET /api/search': { rows: [{ id: 'x/Awq', params: 7e9, weightsGiB: null, license: null, gated: false, parser: null }] } });
    render(<Models />);
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }));
    await screen.findByText('x/Awq');
    const cells = [...document.querySelectorAll('tbody tr td')].map((td) => td.textContent);
    expect(cells[2]).toBe('?');
  });

  it('errore del piano mostrato con il suggerimento', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'GATED_MODEL', message: 'Accesso negato a meta-llama/X', hint: 'Richiedi l\'accesso' } }), { status: 400 }));
    render(<Models />);
    fireEvent.change(screen.getByLabelText(/Modello/), { target: { value: 'meta-llama/X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calcola il piano' }));
    await screen.findByText('Accesso negato a meta-llama/X');
    expect(screen.getByText('Richiedi l\'accesso')).toBeTruthy();
  });
});

describe('selezione dei risultati', () => {
  it('ogni riga ha un pulsante per il modello e la riga scelta è evidenziata', async () => {
    mockApi({ 'GET /api/search': { rows: [{ id: 'a/Uno', params: 1e9, weightsGiB: 2, license: 'mit', gated: false, parser: 'x' }, { id: 'b/Due', params: 2e9, weightsGiB: 4, license: 'mit', gated: false, parser: 'x' }] } });
    render(<Models />);
    fireEvent.change(screen.getByLabelText('Cerca un modello'), { target: { value: 'uno' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }));
    const btn = await screen.findByRole('button', { name: 'b/Due' });
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.closest('tr').getAttribute('aria-selected')).toBe('false');
    fireEvent.click(btn);
    expect(screen.getByLabelText(/Modello \(/).value).toBe('b/Due');
    expect(btn.closest('tr').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'a/Uno' }).closest('tr').getAttribute('aria-selected')).toBe('false');
  });

  it('nessun risultato e errore di ricerca', async () => {
    mockApi({ 'GET /api/search': { rows: [] } });
    render(<Models />);
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }));
    await screen.findByText('Nessun risultato');
    cleanup(); vi.restoreAllMocks();
    mockApi({ 'GET /api/search': { __status: 502, body: { error: { message: 'Hugging Face non raggiungibile' } } } });
    render(<Models />);
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }));
    await screen.findByText('Hugging Face non raggiungibile');
  });

  it('invia il modello senza spazi ai bordi e intitola il risultato "Piano calcolato"', async () => {
    const fetchMock = mockApi({ 'POST /api/plan': { plan, advice: null, advisorError: null, advisorSkipped: null } });
    render(<Models />);
    fireEvent.change(screen.getByLabelText(/Modello \(/), { target: { value: '  Qwen/Qwen3-Coder-30B-A3B-Instruct \n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calcola il piano' }));
    await screen.findByText('Piano calcolato');
    const call = fetchMock.mock.calls.find(([p]) => p === '/api/plan');
    expect(JSON.parse(call[1].body).model).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');
  });
});

describe('PlanView', () => {
  it('il comando vllm serve è quotato per la shell', () => {
    const p = { ...plan, vllm: { ...plan.vllm, args: ['--default-chat-template-kwargs', '{"a":"$(cmd)"}', '--max-model-len', '65536'] } };
    render(<PlanView data={{ plan: p, advice: null, advisorError: null, advisorSkipped: null }} onPlanChange={() => {}} />);
    const pre = document.querySelector('pre').textContent;
    expect(pre).toBe(`vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct --served-model-name <profilo> --default-chat-template-kwargs '{"a":"$(cmd)"}' --max-model-len 65536`);
  });

  it('409 sull\'applicazione: messaggio come avviso sotto il pulsante', async () => {
    mockApi({ 'POST /api/plan/apply-advice': { __status: 409, body: { error: { message: 'Il piano è cambiato: rigenera la proposta' } } } });
    const onPlanChange = vi.fn();
    render(<PlanView data={{ plan, advice, advisorError: null, advisorSkipped: null }} onPlanChange={onPlanChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Applica la proposta' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Il piano è cambiato/);
    expect(onPlanChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Applica la proposta' })).toBeTruthy();
  });

  it('mostra advisorError e advisorSkipped', () => {
    const { rerender } = render(<PlanView data={{ plan, advice: null, advisorError: 'timeout del provider', advisorSkipped: null }} onPlanChange={() => {}} />);
    expect(screen.getByText(/Consulente non disponibile: timeout del provider/)).toBeTruthy();
    rerender(<PlanView data={{ plan, advice: null, advisorError: null, advisorSkipped: 'Nessun provider configurato' }} onPlanChange={() => {}} />);
    expect(screen.getByText(/Nessun provider configurato/)).toBeTruthy();
  });

  it('senza GPU nel datacenter: alternative altrove e salvataggio disabilitato con spiegazione', () => {
    const p = { ...plan, gpu: null, hourlyUSD: null, options: [], candidates: [], elsewhere: [{ gpuId: 'H100', name: 'H100 80GB', count: 1, hourly: 2.69, elsewhere: [{ id: 'US-CA-2', availability: 'HIGH' }] }] };
    render(<PlanView data={{ plan: p, advice: null, advisorError: null, advisorSkipped: null }} onPlanChange={() => {}} />);
    expect(screen.getByText(/nessuna GPU disponibile in EU-RO-1/i)).toBeTruthy();
    expect(screen.getByText(/H100 80GB ×1/)).toBeTruthy();
    expect(screen.getByText(/2,69 \$\/h/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'ok-nome' } });
    expect(screen.getByRole('button', { name: 'Salva come profilo' }).disabled).toBe(true);
    expect(screen.getByText(/Nessuna GPU disponibile: non è possibile salvare il profilo/)).toBeTruthy();
  });

  it('senza GPU e senza alternative: avviso chiaro', () => {
    const p = { ...plan, gpu: null, hourlyUSD: null, elsewhere: [] };
    render(<PlanView data={{ plan: p, advice: null, advisorError: null, advisorSkipped: null }} onPlanChange={() => {}} />);
    expect(screen.getByText(/Nessuna GPU adatta trovata/)).toBeTruthy();
  });

  it('suggerisce il formato del nome quando non è valido', () => {
    render(<PlanView data={{ plan, advice: null, advisorError: null, advisorSkipped: null }} onPlanChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'Nome Sbagliato' } });
    expect(screen.getByText(/minuscole, cifre e trattini/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Salva come profilo' }).disabled).toBe(true);
  });

  it('la motivazione del consulente è resa come testo, non come HTML', () => {
    const bad = { ...advice, rationale: '<img src=x onerror=alert(1)> ciao' };
    const { container } = render(<PlanView data={{ plan, advice: bad, advisorError: null, advisorSkipped: null }} onPlanChange={() => {}} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> ciao/)).toBeTruthy();
  });

  it('il messaggio di salvataggio si azzera a un nuovo salvataggio e non mostra badge senza disponibilità', async () => {
    const p = { ...plan, candidates: [{ ...plan.candidates[0], availabilityHere: undefined }] };
    let n = 0;
    mockApi({ 'POST /api/profiles': () => ({ profile: { name: `p${++n}` } }) });
    const { container } = render(<PlanView data={{ plan: p, advice: null, advisorError: null, advisorSkipped: null }} onPlanChange={() => {}} />);
    expect(container.querySelectorAll('tbody tr td:last-child span').length).toBe(0);
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'uno' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/\(p1\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/\(p2\)/);
  });
});
