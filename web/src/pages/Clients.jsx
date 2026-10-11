import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Card, Button, Field, ErrorBox, CodeBlock, Spinner, inputClass } from '../components/ui.jsx';
import { shellQuote, shellQuoteArgs } from '../../../src/core/planner/shell-quote.js';

const CLIENTS = ['claude', 'opencode', 'pi'];

export default function Clients() {
  const [profiles, setProfiles] = useState(null);
  const [profile, setProfile] = useState('');
  const [env, setEnv] = useState(null);
  const [closed, setClosed] = useState(false);
  const [zcodeFile, setZcodeFile] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  // Le risposte arrivate dopo un cambio di profilo (o dopo l'uscita dalla pagina) vengono scartate.
  const current = useRef('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api('/api/overview')
      .then((o) => { if (!alive.current) return; setProfiles(o.profiles); setProfile(o.profiles[0]?.name ?? ''); })
      .catch((e) => { if (alive.current) { setProfiles([]); setError(e); } });
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { current.current = profile; }, [profile]);

  function choose(name) {
    setProfile(name); setEnv(null); setZcodeFile(null); setClosed(false); setError(null);
  }
  async function showEnv() {
    const asked = profile;
    setBusy('env'); setError(null);
    try {
      const r = await api('/api/env', { method: 'POST', body: { profile: asked } });
      if (alive.current && current.current === asked) setEnv(r.env);
    } catch (e) { if (alive.current && current.current === asked) setError(e); } finally { if (alive.current) setBusy(null); }
  }
  async function zcode() {
    const asked = profile;
    setBusy('zcode'); setError(null);
    try {
      const r = await api('/api/clients/zcode', { method: 'POST', body: { profile: asked, zcodeClosed: closed } });
      if (alive.current && current.current === asked) { setZcodeFile(r.file); setClosed(false); }
    } catch (e) { if (alive.current && current.current === asked) setError(e); } finally { if (alive.current) setBusy(null); }
  }

  if (!profiles) return error ? <div role="alert"><ErrorBox error={error} /></div> : <div className="flex justify-center p-6"><Spinner /></div>;
  return (
    <div className="space-y-4">
      <Card title="Profilo">
        {profiles.length === 0 ? <p className="text-gray-400">Nessun profilo salvato: crea un piano dalla scheda Modelli e salvalo.</p> : (
          <Field label="Profilo">
            <select className={inputClass} value={profile} onChange={(e) => choose(e.target.value)}>
              {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <p className="mt-3 text-xs text-gray-500">I client si collegano al Pod del profilo: avvialo prima dalla scheda Profili.</p>
      </Card>
      {profile && (
        <>
          <Card title="Comandi">
            <div className="space-y-2">
              {CLIENTS.map((c) => <CodeBlock key={c} text={shellQuoteArgs(['llmpod', 'run', c, '--profile', profile])} />)}
            </div>
          </Card>
          <Card title="Export per altri client">
            <p className="mb-3 text-sm text-gray-400">Gli export contengono la chiave del profilo: vengono richiesti solo qui, non sono salvati nel browser.</p>
            <div className="flex gap-2">
              <Button onClick={showEnv} loading={busy === 'env'}>Mostra gli export</Button>
              {env && <Button variant="ghost" onClick={() => setEnv(null)}>Nascondi</Button>}
            </div>
            {env && (
              <div className="fade-up mt-3 space-y-2">
                <p className="text-sm text-amber-300">⚠ Contiene la chiave del profilo: non condividerla.</p>
                <CodeBlock text={Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n')} />
              </div>
            )}
          </Card>
          <Card title="ZCode">
            <p className="mb-3 text-sm text-gray-400">ZCode riscrive la sua configurazione all'uscita: chiudilo prima di continuare.</p>
            <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> ZCode è chiuso</label>
            <Button onClick={zcode} disabled={!closed} loading={busy === 'zcode'}>Configura ZCode</Button>
            {zcodeFile && <p className="fade-up mt-3 text-sm text-emerald-300">Configurato: {zcodeFile}. Apri ZCode e scegli il provider "llmpod (Runpod)".</p>}
          </Card>
        </>
      )}
      {error && <div role="alert"><ErrorBox error={error} /></div>}
    </div>
  );
}
