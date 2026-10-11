import { useEffect, useRef, useState } from 'react';
import { api, fmtUSD, fmtDuration } from '../lib/api.js';
import { Card, Button, Badge, ErrorBox, Spinner } from '../components/ui.jsx';

const REFRESH_MS = 15_000;

function shutdown(p) {
  const s = p.supervisor;
  if (s?.idleSeconds == null) return s?.phase ?? '—';
  const max = s.maxSeconds != null && s.uptimeSeconds != null ? `; massimo tra ${fmtDuration(s.maxSeconds - s.uptimeSeconds)}` : '';
  return `inattivo da ${fmtDuration(s.idleSeconds)} su ${fmtDuration(s.idleLimitSeconds)}${max}`;
}

export default function Status() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return; // niente richieste sovrapposte (timer + clic su "Aggiorna")
    inFlight.current = true;
    setBusy(true);
    try {
      const s = await api('/api/status');
      if (alive.current) { setStatus(s); setError(null); }
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, []);

  if (!status) return error ? <ErrorBox error={error} /> : <div className="flex justify-center p-6"><Spinner /></div>;
  const pods = status.pods ?? [];
  return (
    <div className="space-y-4">
      <Card title="Pod attivi">
        <div className="mb-3 flex justify-end"><Button variant="ghost" onClick={load} loading={busy}>Aggiorna</Button></div>
        {pods.length === 0 ? <p className="text-gray-400">Nessun Pod llmpod attivo.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-gray-400"><tr><th className="py-1">Profilo</th><th>Pod</th><th>Stato</th><th>GPU</th><th>Costo</th><th>Uptime</th><th>Sessione</th><th>Spegnimento</th></tr></thead>
              <tbody>
                {pods.map((p) => (
                  <tr key={p.podId} className="border-t border-white/5 transition hover:bg-white/5">
                    <td className="py-1 pr-2">{p.profile} {p.orphan && <Badge tone="amber">orfano</Badge>}</td>
                    <td className="pr-2">{p.podId}</td>
                    <td className="pr-2"><Badge tone={p.status === 'RUNNING' ? 'green' : 'cyan'}>{p.status}</Badge></td>
                    <td className="pr-2">{p.gpu ? `${p.gpu.id} ×${p.gpu.count}` : '?'}</td>
                    <td className="pr-2">{fmtUSD(p.hourlyUSD)}/h</td>
                    <td className="pr-2">{fmtDuration(p.uptimeSeconds)}</td>
                    <td className="pr-2">{fmtUSD(p.sessionUSD)}</td>
                    <td className="text-gray-300">{shutdown(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Credito Runpod"><p className="text-2xl font-semibold neon-text">{status.balance ? fmtUSD(status.balance.balance) : 'non disponibile'}</p></Card>
        <Card title="Volume dei pesi">
          {status.volume ? <p className="text-sm">{status.volume.name} · {status.volume.size} GB · {status.volume.dataCenterId} · <strong>{fmtUSD(status.volume.monthlyUSD)} al mese</strong></p> : <p className="text-gray-400">Nessun volume configurato.</p>}
        </Card>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
