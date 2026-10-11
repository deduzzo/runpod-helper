import { useState } from 'react';
import { api, fmtUSD, fmtGiB } from '../lib/api.js';
import { Card, Button, Field, Badge, ErrorBox, CodeBlock, inputClass } from './ui.jsx';

const AVAIL = { HIGH: 'green', MEDIUM: 'cyan', LOW: 'amber', NONE: 'red' };

export function PlanView({ data, onPlanChange }) {
  const { plan, advice, advisorError, advisorSkipped } = data;
  const [applied, setApplied] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function applyAdvice() {
    setBusy('apply'); setError(null);
    try { const r = await api('/api/plan/apply-advice', { method: 'POST', body: {} }); setApplied(true); onPlanChange(r.plan); } catch (e) { setError(e); } finally { setBusy(null); }
  }
  async function save() {
    setBusy('save'); setError(null);
    try { const r = await api('/api/profiles', { method: 'POST', body: { name } }); setSaved(r.profile.name); } catch (e) { setError(e); } finally { setBusy(null); }
  }

  const m = plan.model;
  return (
    <div className="space-y-4">
      <Card title="Piano">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <p><span className="text-gray-400">Modello:</span> {m.id} <span className="text-gray-500">@ {m.revision.slice(0, 12)}</span></p>
          <p><span className="text-gray-400">Licenza:</span> {m.license ?? '?'} {m.gated ? <Badge tone="amber">gated</Badge> : null}</p>
          <p><span className="text-gray-400">Memoria:</span> pesi {fmtGiB(plan.estimate.weightsGiB)} · KV {fmtGiB(plan.estimate.kvGiB)} · per GPU {fmtGiB(plan.estimate.perGpuGiB)}</p>
          <p><span className="text-gray-400">Contesto:</span> {plan.context} token × {plan.concurrency} {plan.kvCacheDtype ? <Badge tone="violet">KV FP8</Badge> : null}</p>
          <p><span className="text-gray-400">Parser:</span> strumenti {plan.parsers.tool ?? 'nessuno'} · ragionamento {plan.parsers.reasoning ?? 'nessuno'}</p>
          <p><span className="text-gray-400">Scelta:</span> {plan.gpu ? <>{plan.gpu.id} ×{plan.gpu.count} a <strong className="neon-text">{fmtUSD(plan.hourlyUSD)}/h</strong></> : <Badge tone="red">nessuna GPU nel datacenter</Badge>}</p>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-gray-400"><tr><th className="py-1">GPU</th><th>N</th><th>VRAM</th><th>Per GPU</th><th>Margine</th><th>Costo</th><th>In {plan.dataCenterId}</th></tr></thead>
            <tbody>
              {plan.candidates.map((c) => (
                <tr key={`${c.gpuId}-${c.count}`} className="border-t border-white/5">
                  <td className="py-1">{c.name}</td><td>{c.count}</td><td>{c.memoryGiB} GB</td><td>{fmtGiB(c.perGpuGiB)}</td><td>{fmtGiB(c.headroomGiB)}</td><td>{fmtUSD(c.hourly)}/h</td>
                  <td><Badge tone={AVAIL[c.availabilityHere] ?? 'red'}>{c.availabilityHere}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4"><CodeBlock text={`vllm serve ${m.id} --served-model-name <profilo> ${plan.vllm.args.join(' ')}`} /></div>
        {plan.warnings.map((w) => <p key={w} className="mt-2 text-sm text-amber-300">⚠ {w}</p>)}
      </Card>

      {(advice || advisorError || advisorSkipped) && (
        <Card title="Consulente">
          {advisorError && <p className="text-sm text-amber-300">⚠ Consulente non disponibile: {advisorError}</p>}
          {advisorSkipped && <p className="text-sm text-gray-400">ℹ {advisorSkipped}</p>}
          {advice && (
            <div className="space-y-2 text-sm">
              {advice.rationale && <p className="text-gray-200">{advice.rationale}</p>}
              {advice.recipePath && <p className="text-xs text-gray-500">Recipe: {advice.recipePath}</p>}
              <ul className="font-mono text-xs">
                {advice.changes.added.map((a) => <li key={a} className="text-emerald-300">+ {a}</li>)}
                {advice.changes.removed.map((r) => <li key={r} className="text-rose-300">- {r}</li>)}
                {advice.changes.changed.map((c) => <li key={c.flag} className="text-cyan-300">~ {c.flag}: {c.from ?? '(senza valore)'} → {c.to ?? '(senza valore)'}</li>)}
              </ul>
              {advice.rejected.map((r) => <p key={r.key} className="text-xs text-gray-500">✗ scartato {r.key}: {r.reason}</p>)}
              {advice.warnings.map((w) => <p key={w} className="text-amber-300">⚠ {w}</p>)}
              <Button onClick={applyAdvice} loading={busy === 'apply'} disabled={applied || advice.accepted.length === 0}>{applied ? 'Proposta applicata' : 'Applica la proposta'}</Button>
            </div>
          )}
        </Card>
      )}

      <Card title="Salva come profilo">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Nome del profilo">
            <input aria-label="Nome del profilo" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} pattern="^[a-z0-9][a-z0-9-]{0,40}$" placeholder="qwen3-coder" />
          </Field>
          <Button onClick={save} loading={busy === 'save'} disabled={busy !== null || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)}>Salva come profilo</Button>
        </div>
        {saved && <p className="mt-3 text-sm text-emerald-300">Profilo salvato: avvialo dalla scheda Profili ({saved}).</p>}
      </Card>
      <ErrorBox error={error} />
    </div>
  );
}
