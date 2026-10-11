import { useState } from 'react';
import { api, fmtUSD, fmtGiB } from '../lib/api.js';
import { shellQuoteArgs } from '../../../src/core/planner/shell-quote.js';
import { Card, Button, Field, Badge, ErrorBox, CodeBlock, inputClass } from './ui.jsx';

const AVAIL = { HIGH: 'green', MEDIUM: 'cyan', LOW: 'amber', NONE: 'red' };
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function PlanView({ data, onPlanChange }) {
  const { plan, advice, advisorError, advisorSkipped } = data;
  const [applied, setApplied] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function applyAdvice() {
    setBusy('apply'); setApplyError(null);
    try { const r = await api('/api/plan/apply-advice', { method: 'POST', body: {} }); setApplied(true); onPlanChange(r.plan); } catch (e) { setApplyError(e); } finally { setBusy(null); }
  }
  async function save() {
    setBusy('save'); setSaveError(null); setSaved(null);
    try { const r = await api('/api/profiles', { method: 'POST', body: { name } }); setSaved(r.profile.name); } catch (e) { setSaveError(e); } finally { setBusy(null); }
  }

  const m = plan.model;
  const elsewhere = plan.elsewhere ?? [];
  const nameValid = NAME_RE.test(name);
  const command = `vllm serve ${shellQuoteArgs([m.id])} --served-model-name <profilo> ${shellQuoteArgs(plan.vllm.args)}`;
  return (
    <div className="space-y-4">
      <Card title="Piano calcolato">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <p className="break-words"><span className="text-gray-400">Modello:</span> {m.id} <span className="text-gray-500">@ {m.revision.slice(0, 12)}</span></p>
          <p><span className="text-gray-400">Licenza:</span> {m.license ?? '?'} {m.gated ? <Badge tone="amber">gated</Badge> : null}</p>
          <p><span className="text-gray-400">Memoria:</span> pesi {fmtGiB(plan.estimate.weightsGiB)} · KV {fmtGiB(plan.estimate.kvGiB)} · per GPU {fmtGiB(plan.estimate.perGpuGiB)}</p>
          <p><span className="text-gray-400">Contesto:</span> {plan.context} token × {plan.concurrency} {plan.kvCacheDtype ? <Badge tone="violet">KV FP8</Badge> : null}</p>
          <p><span className="text-gray-400">Parser:</span> strumenti {plan.parsers.tool ?? 'nessuno'} · ragionamento {plan.parsers.reasoning ?? 'nessuno'}</p>
          <p><span className="text-gray-400">Scelta:</span> {plan.gpu ? <>{plan.gpu.id} ×{plan.gpu.count} a <strong className="neon-text">{fmtUSD(plan.hourlyUSD)}/h</strong></> : <Badge tone="red">nessuna GPU</Badge>}</p>
        </div>
        {!plan.gpu && (
          <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
            {elsewhere.length ? (
              <>
                <p>Nessuna GPU disponibile in {plan.dataCenterId}. Disponibili in altri datacenter:</p>
                <ul className="mt-1 list-disc pl-5">
                  {elsewhere.map((e, i) => (
                    <li key={`${e.gpuId}-${e.count}-${i}`}>{`${e.name} ×${e.count}`} a {fmtUSD(e.hourly)}/h{e.elsewhere?.length ? ` (${e.elsewhere.map((d) => d.id).join(', ')})` : ''}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>Nessuna GPU adatta trovata, né in {plan.dataCenterId} né altrove: riduci il contesto o le richieste parallele, oppure scegli un altro modello.</p>
            )}
          </div>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-gray-400"><tr><th className="py-1">GPU</th><th>N</th><th>VRAM</th><th>Per GPU</th><th>Margine</th><th>Costo</th><th>In {plan.dataCenterId}</th></tr></thead>
            <tbody>
              {plan.candidates.map((c, i) => (
                <tr key={`${c.gpuId}-${c.count}-${i}`} className="border-t border-white/5">
                  <td className="py-1">{c.name}</td><td>{c.count}</td><td>{c.memoryGiB} GB</td><td>{fmtGiB(c.perGpuGiB)}</td><td>{fmtGiB(c.headroomGiB)}</td><td>{fmtUSD(c.hourly)}/h</td>
                  <td>{c.availabilityHere ? <Badge tone={AVAIL[c.availabilityHere] ?? 'red'}>{c.availabilityHere}</Badge> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4"><CodeBlock text={command} /></div>
        {plan.warnings.map((w, i) => <p key={`${w}-${i}`} className="mt-2 break-words text-sm text-amber-300">⚠ {w}</p>)}
      </Card>

      {(advice || advisorError || advisorSkipped) && (
        <Card title="Consulente">
          {advisorError && <p className="break-words text-sm text-amber-300">⚠ Consulente non disponibile: {advisorError}</p>}
          {advisorSkipped && <p className="break-words text-sm text-gray-400">ℹ {advisorSkipped}</p>}
          {advice && (
            <div className="space-y-2 text-sm">
              {advice.rationale && <p className="break-words text-gray-200">{advice.rationale}</p>}
              {advice.recipePath && <p className="break-words text-xs text-gray-500">Recipe: {advice.recipePath}</p>}
              <ul className="font-mono text-xs">
                {advice.changes.added.map((a, i) => <li key={`${a}-${i}`} className="break-words text-emerald-300">+ {a}</li>)}
                {advice.changes.removed.map((r, i) => <li key={`${r}-${i}`} className="break-words text-rose-300">- {r}</li>)}
                {advice.changes.changed.map((c, i) => <li key={`${c.flag}-${i}`} className="break-words text-cyan-300">~ {c.flag}: {c.from ?? '(senza valore)'} → {c.to ?? '(senza valore)'}</li>)}
              </ul>
              {advice.rejected.map((r, i) => <p key={`${r.key}-${i}`} className="break-words text-xs text-gray-500">✗ scartato {r.key}: {r.reason}</p>)}
              {advice.warnings.map((w, i) => <p key={`${w}-${i}`} className="break-words text-amber-300">⚠ {w}</p>)}
              <Button onClick={applyAdvice} loading={busy === 'apply'} disabled={applied || advice.accepted.length === 0}>{applied ? 'Proposta applicata' : 'Applica la proposta'}</Button>
              {applyError && <div role="alert"><ErrorBox error={applyError} /></div>}
            </div>
          )}
        </Card>
      )}

      <Card title="Salva come profilo">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Nome del profilo">
            <input aria-label="Nome del profilo" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} pattern="^[a-z0-9][a-z0-9-]{0,40}$" placeholder="qwen3-coder" />
          </Field>
          <Button onClick={save} loading={busy === 'save'} disabled={busy !== null || !plan.gpu || !nameValid}>Salva come profilo</Button>
        </div>
        {!plan.gpu && <p className="mt-2 text-xs text-amber-300">Nessuna GPU disponibile: non è possibile salvare il profilo.</p>}
        {plan.gpu && !nameValid && <p className="mt-2 text-xs text-gray-500">Il nome usa solo minuscole, cifre e trattini (massimo 41 caratteri) e inizia con una lettera o una cifra.</p>}
        {saved && <p className="mt-3 text-sm text-emerald-300">Profilo salvato: avvialo dalla scheda Profili ({saved}).</p>}
        <div className="mt-3"><ErrorBox error={saveError} /></div>
      </Card>
    </div>
  );
}
