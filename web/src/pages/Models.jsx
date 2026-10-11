import { useState } from 'react';
import { api, fmtGiB } from '../lib/api.js';
import { Card, Button, Field, Badge, ErrorBox, inputClass } from '../components/ui.jsx';
import { PlanView } from '../components/PlanView.jsx';

export default function Models() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(null);
  const [model, setModel] = useState('');
  const [context, setContext] = useState(65536);
  const [concurrency, setConcurrency] = useState(2);
  const [useAdvisor, setUseAdvisor] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function search() {
    setBusy('search'); setError(null);
    try { setRows((await api(`/api/search?q=${encodeURIComponent(query)}&limit=20`)).rows); } catch (e) { setError(e); } finally { setBusy(null); }
  }
  async function plan() {
    setBusy('plan'); setError(null); setResult(null);
    try { setResult(await api('/api/plan', { method: 'POST', body: { model: model.trim(), context: Number(context), concurrency: Math.min(8, Math.max(1, Math.round(Number(concurrency)) || 1)), advisor: useAdvisor } })); } catch (e) { setError(e); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <Card title="Cerca su Hugging Face">
        <form className="flex gap-3" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <input aria-label="Cerca un modello" className={`${inputClass} flex-1`} placeholder="Cerca un modello (es. qwen3 coder)" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" loading={busy === 'search'}>Cerca</Button>
        </form>
        {rows && rows.length === 0 && <p className="mt-4 text-sm text-gray-400">Nessun risultato</p>}
        {rows && rows.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-gray-400"><tr><th className="py-1">Modello</th><th>Parametri</th><th>Pesi</th><th>Licenza</th><th>Gated</th><th>Parser</th><th>MTP</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} aria-selected={model.trim() === r.id} className={`cursor-pointer border-t border-white/5 transition hover:bg-white/5 ${model.trim() === r.id ? 'bg-cyan-400/10' : ''}`} onClick={() => setModel(r.id)}>
                    <td className="py-1"><button type="button" className="break-all text-left text-cyan-200 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60">{r.id}</button></td>
                    <td>{r.params ? `${(r.params / 1e9).toFixed(1)} B` : '?'}</td>
                    <td>{r.weightsGiB == null ? '?' : fmtGiB(r.weightsGiB)}</td>
                    <td>{r.license ?? '?'}</td>
                    <td>{r.gated ? <Badge tone="amber">sì</Badge> : 'no'}</td>
                    <td>{r.parser ?? <Badge tone="amber">nessuno</Badge>}</td>
                    <td>{r.mtp ? <Badge tone="green">sì</Badge> : '?'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Calcola un piano">
        <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); plan(); }}>
          <div className="sm:col-span-2">
            <Field label="Modello (org/nome, org/nome@rev o URL)">
              <input aria-label="Modello" className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder="Qwen/Qwen3-Coder-30B-A3B-Instruct" />
            </Field>
          </div>
          <Field label="Contesto">
            <select className={inputClass} value={context} onChange={(e) => setContext(e.target.value)}>
              {[16384, 32768, 65536, 131072].map((c) => <option key={c} value={c}>{c.toLocaleString('it-IT')} token</option>)}
            </select>
          </Field>
          <Field label="Richieste parallele">
            <input type="number" min="1" max="8" className={inputClass} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-gray-300 sm:col-span-3">
            <input type="checkbox" checked={useAdvisor} onChange={(e) => setUseAdvisor(e.target.checked)} /> Usa il consulente
          </label>
          <Button type="submit" loading={busy === 'plan'} disabled={!model.trim()}>Calcola il piano</Button>
        </form>
      </Card>

      <ErrorBox error={error} />
      {result && <PlanView key={result.plan.model.revision} data={result} onPlanChange={(p, id) => setResult((r) => ({ ...r, plan: p, planId: id ?? r.planId }))} />}
    </div>
  );
}
