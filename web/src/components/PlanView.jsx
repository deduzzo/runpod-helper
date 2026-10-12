import { useEffect, useState } from 'react';
import { api, fmtUSD, fmtGiB } from '../lib/api.js';
import { shellQuoteArgs } from '../../../src/core/planner/shell-quote.js';
import { mtpLabel } from '../../../src/core/planner/mtp-label.js';
import { Card, Button, Field, Badge, ErrorBox, CodeBlock, inputClass } from './ui.jsx';

const AVAIL = { HIGH: 'green', MEDIUM: 'cyan', LOW: 'amber', NONE: 'red' };
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const keyOf = (g) => `${g.id}|${g.count}`;
// Selezionabile: disponibile ora e, dopo un consiglio, ancora in grado di contenere il modello.
const usable = (o) => o.available && o.fits !== false;
const vram = (o) => `${o.count > 1 ? `${o.count}×` : ''}${o.memoryGiB} GB`;
// Opzioni scelte dal server (plan.options); un piano senza `options` (salvato da una versione precedente) si ricava da `candidates`.
function planOptions(plan) {
  if (plan.options) return plan.options;
  return (plan.candidates ?? []).map((c) => ({
    id: c.gpuId, name: c.name, count: c.count, memoryGiB: c.memoryGiB, perGpuGiB: c.perGpuGiB, headroomGiB: c.headroomGiB, hourly: c.hourly,
    availabilityHere: c.availabilityHere, elsewhere: c.elsewhere ?? [], availableHere: c.availabilityHere !== 'NONE', available: true,
  }));
}
// Il comando mostrato segue il numero di GPU scelto.
function withTensorParallel(args, count) {
  const out = [...args];
  const i = out.indexOf('--tensor-parallel-size');
  if (i >= 0 && count != null) out[i + 1] = String(count);
  return out;
}

export function PlanView({ data, onPlanChange }) {
  const { plan, advice, advisorError, advisorSkipped, planId } = data;
  const [applied, setApplied] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirmName, setConfirmName] = useState(null);
  const options = planOptions(plan);
  // Un piano senza `options` (salvato da una versione precedente) non offre scelta: vale solo la GPU del piano.
  const selectable = Boolean(plan.options);
  const [selected, setSelected] = useState(plan.gpu ? keyOf(plan.gpu) : null);
  // Se cambia il piano (es. dopo "Applica la proposta") la scelta si riallinea: resta solo se è ancora selezionabile.
  useEffect(() => {
    setSelected((prev) => (selectable && options.some((o) => keyOf(o) === prev && usable(o)) ? prev : (plan.gpu ? keyOf(plan.gpu) : null)));
  }, [planId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Un piano la cui GPU non è tra le opzioni (piani salvati da versioni precedenti) conserva comunque la sua scelta.
  const chosen = options.find((o) => keyOf(o) === selected) ?? (plan.gpu && keyOf(plan.gpu) === selected ? { ...plan.gpu, name: plan.gpu.id, hourly: plan.hourlyUSD } : null);
  // La GPU viaggia al salvataggio solo se l'utente ha cambiato la scelta del piano.
  const changed = Boolean(chosen) && (!plan.gpu || keyOf(plan.gpu) !== selected);

  async function applyAdvice() {
    setBusy('apply'); setApplyError(null);
    try { const r = await api('/api/plan/apply-advice', { method: 'POST', body: {} }); setApplied(true); onPlanChange(r.plan, r.planId); } catch (e) { setApplyError(e); } finally { setBusy(null); }
  }
  // R28: se il nome esiste già si chiede conferma prima di sovrascrivere il profilo.
  async function save(overwrite = false) {
    setBusy('save'); setSaveError(null); setSaved(null);
    try {
      if (!overwrite) {
        let existing = [];
        try { existing = (await api('/api/overview')).profiles?.map((p) => p.name) ?? []; } catch { /* elenco non disponibile: il server decide */ }
        if (existing.includes(name)) { setConfirmName(name); return; }
      }
      setConfirmName(null);
      const r = await api('/api/profiles', { method: 'POST', body: { name, planId, ...(changed ? { gpu: { id: chosen.id, count: chosen.count } } : {}) } });
      setSaved(r.profile.name);
    } catch (e) { setSaveError(e); } finally { setBusy(null); }
  }

  const m = plan.model;
  const elsewhere = plan.elsewhere ?? [];
  const nameValid = NAME_RE.test(name);
  const command = `vllm serve ${shellQuoteArgs([m.id])} --served-model-name <profilo> ${shellQuoteArgs(withTensorParallel(plan.vllm.args, chosen?.count))}`;
  return (
    <div className="space-y-4">
      <Card title="Piano calcolato">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <p className="break-words"><span className="text-gray-400">Modello:</span> {m.id} <span className="text-gray-500">@ {m.revision.slice(0, 12)}</span></p>
          <p><span className="text-gray-400">Licenza:</span> {m.license ?? '?'} {m.gated ? <Badge tone="amber">gated</Badge> : null}</p>
          <p><span className="text-gray-400">Memoria:</span> pesi {fmtGiB(plan.estimate.weightsGiB)} · KV {fmtGiB(plan.estimate.kvGiB)} · per GPU {fmtGiB(plan.estimate.perGpuGiB)}</p>
          <p><span className="text-gray-400">Contesto:</span> {plan.context} token × {plan.concurrency} {plan.kvCacheDtype ? <Badge tone="violet">KV FP8</Badge> : null}</p>
          <p><span className="text-gray-400">Parser:</span> strumenti {plan.parsers.tool ?? 'nessuno'} · ragionamento {plan.parsers.reasoning ?? 'nessuno'}</p>
          {plan.mtp && <p><span className="text-gray-400">{plan.mtp.draft === 'dspark' ? 'Draft:' : 'MTP:'}</span> {mtpLabel(plan.mtp)}</p>}
          <p><span className="text-gray-400">Scelta:</span> {chosen ? <>{chosen.name ?? chosen.id} ×{chosen.count} a <strong className="neon-text">{fmtUSD(chosen.hourly)}/h</strong></> : <Badge tone="red">nessuna GPU</Badge>}</p>
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
          <p id="gpu-table-label" className="mb-1 text-sm text-gray-400">{selectable ? 'Scegli la GPU da usare' : 'GPU adatte'}</p>
          <table className="w-full text-left text-sm" aria-labelledby="gpu-table-label">
            <thead className="text-gray-400"><tr>{selectable && <th className="py-1"><span className="sr-only">Usa</span></th>}<th className="py-1">GPU</th><th>N</th><th>VRAM</th><th>Per GPU</th><th>Margine</th><th>Costo</th><th>Disponibilità in {plan.dataCenterId}</th></tr></thead>
            <tbody>
              {options.map((o, i) => {
                const k = keyOf(o);
                const label = `Usa ${o.name ?? o.id} ×${o.count}`;
                const ok = selectable && usable(o);
                return (
                  <tr
                    key={k}
                    className={`border-t border-white/5 transition ${ok ? 'cursor-pointer' : ''} ${selected === k ? 'bg-cyan-400/10' : 'hover:bg-white/5'} ${usable(o) ? '' : 'opacity-60'}`}
                    onClick={ok ? () => setSelected(k) : undefined}
                  >
                    {selectable && (
                      <td className="py-1 pr-2">
                        <input type="radio" name="gpu-choice" aria-label={label} aria-describedby={ok ? undefined : `gpu-note-${i}`} checked={selected === k} disabled={!ok} onChange={() => setSelected(k)} />
                      </td>
                    )}
                    <td className="py-1">{o.name ?? o.id}</td><td>{o.count}</td><td>{vram(o)}</td><td>{fmtGiB(o.perGpuGiB)}</td><td>{fmtGiB(o.headroomGiB)}</td><td>{fmtUSD(o.hourly)}/h</td>
                    <td id={`gpu-note-${i}`} className="space-x-1">
                      {o.availableHere && o.availabilityHere && <Badge tone={AVAIL[o.availabilityHere] ?? 'red'}>{o.availabilityHere}</Badge>}
                      {!o.availableHere && o.elsewhere?.length > 0 && <Badge tone="amber">solo altrove ({o.elsewhere.map((d) => d.id).join(', ')})</Badge>}
                      {!o.available && <Badge tone="red">non disponibile ora</Badge>}
                      {o.available && o.fits === false && <Badge tone="red">non entra con gli argomenti attuali</Badge>}
                    </td>
                  </tr>
                );
              })}
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
            <input aria-label="Nome del profilo" className={inputClass} value={name} onChange={(e) => { setName(e.target.value); setConfirmName(null); }} pattern="^[a-z0-9][a-z0-9-]{0,40}$" placeholder="qwen3-coder" />
          </Field>
          <Button onClick={() => save()} loading={busy === 'save'} disabled={busy !== null || !chosen || !nameValid}>Salva come profilo</Button>
        </div>
        {!chosen && <p className="mt-2 text-xs text-amber-300">{options.some(usable) ? 'Scegli una GPU dalla tabella per salvare il profilo.' : 'Nessuna GPU disponibile: non è possibile salvare il profilo.'}</p>}
        {chosen && !nameValid && <p className="mt-2 text-xs text-gray-500">Il nome usa solo minuscole, cifre e trattini (massimo 41 caratteri) e inizia con una lettera o una cifra.</p>}
        {confirmName && confirmName === name && (
          <div className="fade-up mt-3 space-y-2 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm" role="alert">
            <p className="text-amber-200">Il profilo "{confirmName}" esiste già: salvando verrà sovrascritto.</p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={() => save(true)} loading={busy === 'save'} disabled={busy !== null}>Sovrascrivi</Button>
              <Button variant="ghost" onClick={() => setConfirmName(null)} disabled={busy !== null}>Annulla</Button>
            </div>
          </div>
        )}
        {saved && <p className="mt-3 text-sm text-emerald-300">Profilo salvato: avvialo dalla scheda Profili ({saved}).</p>}
        <div className="mt-3"><ErrorBox error={saveError} /></div>
      </Card>
    </div>
  );
}
