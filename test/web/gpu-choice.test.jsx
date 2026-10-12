// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { QuestionModal } from '../../web/src/components/QuestionModal.jsx';
import { PlanView } from '../../web/src/components/PlanView.jsx';
import { JobPanel } from '../../web/src/components/JobPanel.jsx';
import { EventsProvider } from '../../web/src/lib/events.jsx';
import { mockApi, FakeEventSource } from './helpers.js';

beforeEach(() => { FakeEventSource.reset(); vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const options = [{ id: 'A|1|EU', label: 'GPU-A ×1 · 80 GB · 1,50 $/h · EU · HIGH' }, { id: 'B|1|EU', label: 'GPU-B ×1 · 96 GB · 2,50 $/h · EU · LOW' }];
const choice = { id: 'q1', kind: 'choice', text: 'Quale GPU usare per l\'avvio?', options, defaultId: 'B|1|EU' };

describe('QuestionModal: domanda a scelta', () => {
  it('mostra le opzioni come radio (predefinita selezionata e con il focus) e risponde con l\'id scelto', () => {
    const onAnswer = vi.fn();
    render(<QuestionModal question={choice} onAnswer={onAnswer} />);
    const group = screen.getByRole('radiogroup', { name: /Quale GPU usare/ });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
    expect(document.activeElement).toBe(radios[1]);
    expect(screen.getByText(/GPU-A ×1 · 80 GB/)).toBeTruthy();
    fireEvent.click(radios[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));
    expect(onAnswer).toHaveBeenCalledWith('A|1|EU');
  });

  it('Conferma subito risponde con la predefinita; Annulla risponde null; Esc non fa nulla', () => {
    const onAnswer = vi.fn();
    render(<QuestionModal question={choice} onAnswer={onAnswer} />);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));
    expect(onAnswer).toHaveBeenLastCalledWith('B|1|EU');
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(onAnswer).toHaveBeenLastCalledWith(null);
  });

  it('una domanda successiva riparte dalla sua predefinita', () => {
    const { rerender } = render(<QuestionModal question={choice} onAnswer={() => {}} />);
    fireEvent.click(screen.getAllByRole('radio')[0]);
    rerender(<QuestionModal question={{ ...choice, id: 'q2', defaultId: 'B|1|EU' }} onAnswer={() => {}} />);
    expect(screen.getAllByRole('radio').map((r) => r.checked)).toEqual([false, true]);
  });

  it('una domanda sì/no (senza kind o con kind confirm) resta com\'era', () => {
    render(<QuestionModal question={{ id: 'q', kind: 'confirm', text: 'Confermi?', defYes: true }} onAnswer={() => {}} />);
    expect(screen.getByRole('button', { name: 'Sì' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});

describe('JobPanel: domanda a scelta', () => {
  it('mostra la scelta e invia l\'id come risposta', async () => {
    const fetchMock = mockApi({
      'GET /api/jobs/j1': { job: { id: 'j1', kind: 'up:p', status: 'running', question: choice }, events: [] },
      'POST /api/jobs/j1/answer': { ok: true },
    });
    render(<EventsProvider><JobPanel jobId="j1" /></EventsProvider>);
    await screen.findByRole('radiogroup');
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([p]) => p === '/api/jobs/j1/answer')).toBe(true));
    const call = fetchMock.mock.calls.find(([p]) => p === '/api/jobs/j1/answer');
    expect(JSON.parse(call[1].body)).toEqual({ questionId: 'q1', answer: 'A|1|EU' });
  });

  it('una domanda a scelta arrivata dal flusso SSE ha opzioni e predefinita', async () => {
    mockApi({ 'GET /api/jobs/j1': { job: { id: 'j1', kind: 'up:p', status: 'running', question: null }, events: [] } });
    render(<EventsProvider><JobPanel jobId="j1" /></EventsProvider>);
    await screen.findByText('in corso');
    const { act } = await import('@testing-library/react');
    await act(async () => { FakeEventSource.last.emit('job', { jobId: 'j1', seq: 0, type: 'question', questionId: 'q9', kind: 'choice', text: 'Scegli', options, defaultId: 'A|1|EU' }); });
    expect(screen.getAllByRole('radio').map((r) => r.checked)).toEqual([true, false]);
  });
});

const opt = (id, count, hourly, availabilityHere, elsewhere = [], extra = {}) => ({
  id, name: id, count, memoryGiB: 80, perGpuGiB: 70.9, headroomGiB: 1.1, hourly, availabilityHere, elsewhere,
  availableHere: availabilityHere !== 'NONE', available: availabilityHere !== 'NONE' || elsewhere.length > 0, ...extra,
});
const plan = {
  model: { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', revision: 'b2cff646eb4bb1d6', requestedRevision: 'main', license: 'apache-2.0', gated: false },
  context: 65536, concurrency: 2, kvCacheDtype: null, parsers: { tool: 'qwen3_coder', reasoning: null },
  estimate: { weightsGiB: 56.9, kvGiB: 12, perGpuGiB: 70.9 }, gpu: { id: 'GPU-A', count: 1 }, hourlyUSD: 1.5, alternatives: [], elsewhere: [], dataCenterId: 'EU-RO-1',
  options: [opt('GPU-NOW', 1, 1.2, 'NONE'), opt('GPU-A', 1, 1.5, 'HIGH'), opt('GPU-B', 2, 2.5, 'LOW'), opt('GPU-C', 1, 3, 'NONE', [{ id: 'US-1', availability: 'MEDIUM' }])],
  candidates: [], vllm: { image: 'vllm/vllm-openai:v0.30.0-cu129', args: ['--max-model-len', '65536', '--tensor-parallel-size', '1'] }, warnings: [],
};
const data = { plan, planId: 'piano-1', advice: null, advisorError: null, advisorSkipped: null };

describe('PlanView: tabella delle GPU selezionabile', () => {
  it('radio accessibili con la scelta predefinita; non disponibile ora disabilitata; badge di disponibilità', () => {
    render(<PlanView data={data} onPlanChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => [r.getAttribute('aria-label'), r.checked, r.disabled])).toEqual([
      ['Usa GPU-NOW ×1', false, true],
      ['Usa GPU-A ×1', true, false],
      ['Usa GPU-B ×2', false, false],
      ['Usa GPU-C ×1', false, false],
    ]);
    expect(screen.getByText('HIGH')).toBeTruthy();
    expect(screen.getByText('LOW')).toBeTruthy();
    expect(screen.getByText('non disponibile ora')).toBeTruthy();
    expect(screen.getByText(/solo altrove/)).toBeTruthy();
    expect(screen.getByText(/US-1/)).toBeTruthy();
  });

  it('scegliendo un\'altra GPU la riga "Scelta", il costo e il comando riflettono la scelta', () => {
    render(<PlanView data={data} onPlanChange={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Usa GPU-B ×2' }));
    expect(screen.getByText(/GPU-B ×2/, { selector: 'p *, p' })).toBeTruthy();
    expect(screen.getAllByText(/2,50 \$\/h/).length).toBeGreaterThan(0);
    expect(document.querySelector('pre').textContent).toMatch(/--tensor-parallel-size 2/);
  });

  it('il salvataggio invia la GPU scelta solo se diversa da quella del piano', async () => {
    const fetchMock = mockApi({ 'GET /api/overview': { profiles: [] }, 'POST /api/profiles': { profile: { name: 'qwen' } } });
    render(<PlanView data={data} onPlanChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'qwen' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Usa GPU-B ×2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/Profilo salvato/);
    const call = fetchMock.mock.calls.find(([p, i]) => p === '/api/profiles' && i?.method === 'POST');
    expect(JSON.parse(call[1].body)).toEqual({ name: 'qwen', planId: 'piano-1', gpu: { id: 'GPU-B', count: 2 } });
  });

  it('senza cambiare scelta il corpo è quello di prima (nessuna gpu)', async () => {
    const fetchMock = mockApi({ 'GET /api/overview': { profiles: [] }, 'POST /api/profiles': { profile: { name: 'qwen' } } });
    render(<PlanView data={data} onPlanChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'qwen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/Profilo salvato/);
    const call = fetchMock.mock.calls.find(([p, i]) => p === '/api/profiles' && i?.method === 'POST');
    expect(JSON.parse(call[1].body)).toEqual({ name: 'qwen', planId: 'piano-1' });
  });

  it('senza GPU nel datacenter si può scegliere una disponibile altrove e salvare', async () => {
    const fetchMock = mockApi({ 'GET /api/overview': { profiles: [] }, 'POST /api/profiles': { profile: { name: 'qwen' } } });
    const noHere = { ...plan, gpu: null, hourlyUSD: null, options: [opt('GPU-C', 1, 3, 'NONE', [{ id: 'US-1', availability: 'MEDIUM' }])] };
    render(<PlanView data={{ ...data, plan: noHere }} onPlanChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Nome del profilo/), { target: { value: 'qwen' } });
    expect(screen.getByRole('button', { name: 'Salva come profilo' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Usa GPU-C ×1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salva come profilo' }));
    await screen.findByText(/Profilo salvato/);
    const call = fetchMock.mock.calls.find(([p, i]) => p === '/api/profiles' && i?.method === 'POST');
    expect(JSON.parse(call[1].body).gpu).toEqual({ id: 'GPU-C', count: 1 });
  });

  it('un piano vecchio con solo "candidates" continua a mostrarsi', () => {
    const old = { ...plan, options: undefined, candidates: [{ gpuId: 'GPU-A', name: 'GPU-A', count: 1, memoryGiB: 80, perGpuGiB: 70.9, headroomGiB: 1, hourly: 1.5, availabilityHere: 'HIGH' }] };
    render(<PlanView data={{ ...data, plan: old }} onPlanChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Usa GPU-A ×1' }).checked).toBe(true);
  });
});
