// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import Models from '../../web/src/pages/Models.jsx';
import { mockApi } from './helpers.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SHA1 = 'aedc6ce29b7b0c84c7fadfb59fb8524357f8014c';
const SHA2 = 'd5822b068da8ddb301665b48c58718e6e18a2c3a';
const sets = {
  version: 1, updatedAt: '2026-10-12',
  sets: [{
    id: 'abliterated', name: 'Abliterated', description: 'Modelli senza rifiuti per il coding agentico', warning: 'Salvaguardie ridotte: uso responsabile',
    models: [
      { id: 'llmfan46/Qwen3.8-27B-GPTQ', revision: SHA1, family: 'Qwen3.8-27B', variant: 'GPTQ Int4', format: 'gptq', quantization: 'GPTQ 4 bit', weightsGiB: 18.2, mtp: true, context: 262144, toolParser: 'qwen3_coder', reasoningParser: 'qwen3', license: 'apache-2.0', notes: 'Il modello in uso', recommendedContext: 131072, architecture: 'Qwen3_5ForConditionalGeneration', modelType: 'qwen3_5', gated: false },
      { id: 'dealignai/GLM-5.3-Flash-UNCENSORED-FP8', revision: SHA2, family: 'GLM-5.3-Flash', variant: 'FP8', format: 'fp8', quantization: 'FP8', weightsGiB: 305.8, mtp: false, context: 1048576, toolParser: 'glm47', reasoningParser: 'glm47', license: 'mit', notes: 'Grande', recommendedContext: 98304, architecture: 'Glm5NextForConditionalGeneration', modelType: 'glm5_next', gated: false },
    ],
  }],
};
const plan = {
  model: { id: 'dealignai/GLM-5.3-Flash-UNCENSORED-FP8', revision: SHA2, requestedRevision: SHA2, license: 'mit', gated: false },
  context: 98304, concurrency: 2, kvCacheDtype: null, parsers: { tool: 'glm47', reasoning: 'glm47' },
  estimate: { weightsGiB: 305.8, kvGiB: 12, perGpuGiB: 50 }, gpu: { id: 'H100', count: 8 }, hourlyUSD: 21.5,
  candidates: [{ gpuId: 'H100', name: 'H100 80GB', count: 8, memoryGiB: 80, perGpuGiB: 50, headroomGiB: 22, hourly: 21.5, availabilityHere: 'HIGH' }],
  alternatives: [], dataCenterId: 'EU-RO-1', vllm: { image: 'vllm/vllm-openai:v0.30.0', args: ['--max-model-len', '98304'] }, warnings: [],
};

const chooseSet = async () => {
  const select = await screen.findByLabelText('Ricerca');
  await within(select).findByRole('option', { name: /Set consigliato: Abliterated/ });
  fireEvent.change(select, { target: { value: 'abliterated' } });
};

describe('pagina Modelli: set consigliati', () => {
  it('il selettore offre "tutti" e i set; scelto il set compaiono le schede, l\'avviso e niente ricerca Hugging Face', async () => {
    const fetchMock = mockApi({ 'GET /api/model-sets': sets });
    render(<Models />);
    const select = await screen.findByLabelText('Ricerca');
    expect(within(select).getByRole('option', { name: /Tutti i modelli/ })).toBeTruthy();
    expect(screen.getByLabelText('Cerca un modello')).toBeTruthy();
    await chooseSet();
    expect(screen.queryByLabelText('Cerca un modello')).toBeNull();
    expect(screen.getByText('Salvaguardie ridotte: uso responsabile')).toBeTruthy();
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('llmfan46/Qwen3.8-27B-GPTQ')).toBeTruthy();
    expect(within(cards[0]).getByText('18,2 GiB')).toBeTruthy();
    expect(within(cards[0]).getByText('MTP')).toBeTruthy();
    expect(within(cards[1]).queryByText('MTP')).toBeNull();
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/api/search'))).toBe(false);
  });

  it('il filtro restringe le schede del set', async () => {
    mockApi({ 'GET /api/model-sets': sets });
    render(<Models />);
    await chooseSet();
    fireEvent.change(screen.getByLabelText('Filtra il set'), { target: { value: 'glm' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('dealignai/GLM-5.3-Flash-UNCENSORED-FP8')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filtra il set'), { target: { value: 'nessuno-così' } });
    expect(screen.getByText(/Nessun modello del set/)).toBeTruthy();
  });

  it('"Calcola il piano" della scheda precompila modello (revisione verificata) e contesto consigliato e calcola il piano', async () => {
    const fetchMock = mockApi({ 'GET /api/model-sets': sets, 'POST /api/plan': { plan, planId: 'p1', advice: null, advisorError: null, advisorSkipped: null } });
    render(<Models />);
    await chooseSet();
    const btn = screen.getByRole('button', { name: 'Calcola il piano per dealignai/GLM-5.3-Flash-UNCENSORED-FP8' });
    expect(btn.tagName).toBe('BUTTON');
    fireEvent.click(btn);
    await screen.findByText('Piano calcolato');
    expect(screen.getByLabelText(/Modello \(/).value).toBe(`dealignai/GLM-5.3-Flash-UNCENSORED-FP8@${SHA2}`);
    expect(screen.getByLabelText('Contesto').value).toBe('98304');
    const call = fetchMock.mock.calls.find(([p, i]) => p === '/api/plan' && i?.method === 'POST');
    expect(JSON.parse(call[1].body)).toMatchObject({ model: `dealignai/GLM-5.3-Flash-UNCENSORED-FP8@${SHA2}`, context: 98304 });
  });

  it('se i set non si caricano resta la ricerca globale', async () => {
    mockApi({ 'GET /api/model-sets': { __status: 500, body: { error: { message: 'boh' } } }, 'GET /api/search': { rows: [] } });
    render(<Models />);
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }));
    await screen.findByText('Nessun risultato');
    await waitFor(() => expect(screen.queryByText('boh')).toBeNull());
    expect(screen.queryByRole('option', { name: /Set consigliato/ })).toBeNull();
  });
});
