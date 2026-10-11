import { useEffect, useRef, useState } from 'react';
import { api, fmtUSD } from '../lib/api.js';
import { Card, Button, Badge, ErrorBox, Spinner } from '../components/ui.jsx';
import { JobPanel } from '../components/JobPanel.jsx';

export default function Profiles() {
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState({});
  const [errors, setErrors] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [starting, setStarting] = useState(null);
  const alive = useRef(true);

  async function load() {
    try {
      const o = await api('/api/overview');
      if (!alive.current) return;
      setOverview(o);
      setLoadError(null);
      // Job già in corso (anche avviati altrove, es. dalla CLI/altra scheda): si mostrano al caricamento.
      const running = {};
      for (const j of o.jobs ?? []) if (j.status === 'running') running[j.kind.split(':')[1]] = j.id;
      setJobs((prev) => ({ ...running, ...prev }));
    } catch (e) {
      if (alive.current) setLoadError(e);
    }
  }
  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, []);

  async function start(action, profile) {
    setErrors((x) => ({ ...x, [profile]: null }));
    setStarting(`${action}:${profile}`);
    try {
      const { job } = await api('/api/jobs', { method: 'POST', body: { action, profile } });
      setJobs((j) => ({ ...j, [profile]: job.id }));
    } catch (e) {
      // 409 incluso: il server dice quale operazione è già in corso sul profilo.
      setErrors((x) => ({ ...x, [profile]: e }));
    } finally {
      setStarting(null);
    }
  }

  if (!overview) return loadError ? <ErrorBox error={loadError} /> : <div className="flex justify-center p-6"><Spinner /></div>;
  if (!overview.profiles.length) return <Card title="Profili"><p className="text-gray-400">Nessun profilo: calcolane uno nella scheda Modelli.</p></Card>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {overview.profiles.map((p) => (
        <Card key={p.name} title={p.name}>
          <div className="space-y-1 text-sm">
            <p className="break-words text-gray-300">{p.model ?? 'modello non indicato'}</p>
            <p className="text-gray-400">
              {p.gpu ? `${p.gpu.id} ×${p.gpu.count}` : 'GPU da scegliere'} · contesto {p.context ?? '?'} · costo stimato{' '}
              <strong className="text-gray-200">{p.hourlyUSD != null ? `${fmtUSD(p.hourlyUSD)}/h` : 'non disponibile'}</strong>
            </p>
            {p.advisorApplied && <Badge tone="violet">consulente</Badge>}
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => start('up', p.name)} loading={starting === `up:${p.name}`} disabled={starting !== null}>Avvia</Button>
            <Button variant="ghost" onClick={() => start('down', p.name)} loading={starting === `down:${p.name}`} disabled={starting !== null}>Spegni</Button>
          </div>
          {errors[p.name] && <div className="mt-3" role="alert"><ErrorBox error={errors[p.name]} /></div>}
          {jobs[p.name] && <div className="mt-4 border-t border-white/10 pt-4"><JobPanel jobId={jobs[p.name]} onFinished={load} /></div>}
        </Card>
      ))}
      {loadError && <div className="md:col-span-2"><ErrorBox error={loadError} /></div>}
    </div>
  );
}
