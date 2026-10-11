import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { embedUrl } from '../lib/openwebui.js';
import { Card, Field, Badge, ErrorBox, Spinner, inputClass } from '../components/ui.jsx';

export default function QuickTest() {
  const [info, setInfo] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    Promise.all([api('/api/openwebui'), api('/api/overview')])
      .then(([i, o]) => { if (alive.current) { setInfo(i); setProfiles(o.profiles); } })
      .catch((e) => { if (alive.current) setError(e); });
    return () => { alive.current = false; };
  }, []);

  async function choose(profile) {
    setError(null); setMessage(null);
    try {
      await api('/api/openwebui/profile', { method: 'POST', body: { profile } });
      if (!alive.current) return;
      setInfo((i) => ({ ...i, profile }));
      setMessage(`Profilo impostato: Open WebUI userà ${profile}`);
    } catch (e) { if (alive.current) setError(e); }
  }

  if (!info) return error ? <div role="alert"><ErrorBox error={error} /></div> : <div className="flex justify-center p-6"><Spinner /></div>;
  // R27: host diverso da quello dell'interfaccia, così il cookie di sessione non viene inviato a Open WebUI.
  const candidate = embedUrl(info.url, window.location.hostname);
  const url = /^https?:\/\//i.test(candidate ?? '') ? candidate : null;
  return (
    <div className="space-y-4">
      <Card title="Prova veloce con Open WebUI">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Profilo per Open WebUI">
            <select className={inputClass} value={info.profile ?? ''} onChange={(e) => choose(e.target.value)}>
              <option value="" disabled>scegli…</option>
              {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </Field>
          <p className="text-sm text-gray-400">Proxy: {info.proxy?.listening ? <Badge tone="green">attivo sulla porta {info.proxy.port}</Badge> : <Badge tone="red">non attivo</Badge>}</p>
          {url && <a className="text-sm text-cyan-300 transition hover:text-cyan-200 hover:underline" href={url} target="_blank" rel="noreferrer noopener">Apri in una nuova scheda</a>}
        </div>
        {message && <p className="fade-up mt-3 text-sm text-emerald-300">{message}</p>}
        <p className="mt-3 text-xs text-gray-500">Open WebUI si avvia con Docker (scripts/start) o manualmente; se la pagina resta vuota, non è in esecuzione.</p>
        <p className="mt-1 text-xs text-gray-500">Se la finestra incorporata non si carica (Open WebUI può rifiutare l'incorporamento), usa "Apri in una nuova scheda".</p>
      </Card>
      {!url && <ErrorBox error={{ message: 'L\'indirizzo di Open WebUI non è un indirizzo http(s)', hint: 'Controlla LLMPOD_OPENWEBUI_URL' }} />}
      {url && <iframe
        title="Open WebUI"
        src={url}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
        allow="clipboard-write"
        className="glass fade-up h-[70vh] w-full"
      />}
      {error && <div role="alert"><ErrorBox error={error} /></div>}
    </div>
  );
}
