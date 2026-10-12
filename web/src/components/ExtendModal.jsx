import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, fmtUSD, fmtDuration } from '../lib/api.js';
import { Button, ErrorBox, Field, inputClass } from './ui.jsx';

const IDLE_RANGE = [0, 1440];
const HOURS_RANGE = [0.25, 168];

// Numero da un campo di testo: stringa vuota o non numerica = non valido.
const num = (s) => (String(s).trim() === '' ? NaN : Number(String(s).replace(',', '.')));

// Finestra "Prolunga": cambia inattività e ore massime di un Pod avviato (POST /api/pods/:profile/watchdog).
// Il pulsante di invio riporta il costo massimo quando le ore massime aumentano: il clic è la conferma del costo.
// Montata su document.body come QuestionModal (un antenato con backdrop-filter taglierebbe il `position: fixed`).
export function ExtendModal({ pod, onClose, onDone }) {
  const titleId = useId();
  const firstRef = useRef(null);
  const sup = pod.supervisor;
  const curIdleMin = sup.idleLimitSeconds / 60;
  const curHours = sup.maxSeconds / 3600;
  const [never, setNever] = useState(sup.idleLimitSeconds === 0);
  const [idle, setIdle] = useState(sup.idleLimitSeconds === 0 ? '30' : String(curIdleMin));
  const [hours, setHours] = useState(String(curHours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { firstRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const idleValue = never ? 0 : num(idle);
  const hoursValue = num(hours);
  const idleError = !never && !(idleValue >= IDLE_RANGE[0] && idleValue <= IDLE_RANGE[1]) ? `L'inattività deve essere tra ${IDLE_RANGE[0]} e ${IDLE_RANGE[1]} minuti` : null;
  const hoursError = !(hoursValue >= HOURS_RANGE[0] && hoursValue <= HOURS_RANGE[1]) ? `Le ore massime devono essere tra ${String(HOURS_RANGE[0]).replace('.', ',')} e ${HOURS_RANGE[1]}` : null;
  const idleChanged = !idleError && idleValue !== curIdleMin;
  const hoursChanged = !hoursError && hoursValue !== curHours;
  const increases = hoursChanged && hoursValue > curHours;
  const remaining = !hoursError ? hoursValue * 3600 - (sup.uptimeSeconds ?? 0) : 0;
  const maxCost = increases ? Math.max(0, (remaining / 3600) * (pod.hourlyUSD ?? 0)) : null;
  const valid = !idleError && !hoursError && (idleChanged || hoursChanged);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/pods/${encodeURIComponent(pod.profile)}/watchdog`, {
        method: 'POST',
        body: { idleMinutes: idleChanged ? idleValue : null, maxHours: hoursChanged ? hoursValue : null },
      });
      if (alive.current) onDone(pod);
    } catch (e) {
      if (alive.current) { setError(e); setBusy(false); }
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="glass neon-border fade-up w-full max-w-md space-y-4 p-6">
        <h2 id={titleId} className="text-lg font-semibold neon-text">Prolunga {pod.profile} ({pod.podId})</h2>
        <p className="text-sm text-gray-400">Cambia quando il Pod si spegne da solo, senza riavviarlo. Le ore massime si contano dall'avvio del Pod (già trascorse: {fmtDuration(sup.uptimeSeconds ?? 0)}).</p>
        <Field label="Inattività (minuti)">
          <input ref={firstRef} type="number" min={IDLE_RANGE[0]} max={IDLE_RANGE[1]} step="1" className={`${inputClass} disabled:opacity-50`} value={idle} disabled={never} onChange={(e) => setIdle(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-200">
          <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
          <span>Mai (non spegnere per inattività)</span>
        </label>
        {idleError && <p role="alert" className="text-sm text-rose-300">{idleError}</p>}
        <Field label="Ore massime dall'avvio">
          <input type="number" min={HOURS_RANGE[0]} max={HOURS_RANGE[1]} step="0.25" className={inputClass} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        {hoursError && <p role="alert" className="text-sm text-rose-300">{hoursError}</p>}
        {increases && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            Il Pod potrà restare acceso ancora {fmtDuration(remaining)}. Costo massimo stimato fino alla scadenza: {fmtUSD(maxCost)} ({fmtUSD(pod.hourlyUSD)}/h).
          </p>
        )}
        {never && !idleError && idleChanged && <p className="text-sm text-amber-200">Senza spegnimento per inattività il Pod resta acceso (e a pagamento) fino al limite di ore massime.</p>}
        <ErrorBox error={error} />
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annulla</Button>
          <Button onClick={submit} disabled={!valid} loading={busy}>{increases ? `Conferma e prolunga (costo massimo ${fmtUSD(maxCost)})` : 'Applica'}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
