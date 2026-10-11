// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Models from '../../web/src/pages/Models.jsx';
import { mockApi } from './helpers.js';

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
      'POST /api/plan': { plan, advice, advisorError: null, advisorSkipped: null },
      'POST /api/plan/apply-advice': { plan: { ...plan, vllm: { ...plan.vllm, args: ['--max-model-len', '65536', '--enable-prefix-caching'] } } },
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
