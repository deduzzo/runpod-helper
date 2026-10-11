import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { EventsProvider, useAnyJobEvent } from './lib/events.jsx';
import { Spinner } from './components/ui.jsx';
import Models from './pages/Models.jsx';
import Profiles from './pages/Profiles.jsx';
import Status from './pages/Status.jsx';
import Clients from './pages/Clients.jsx';
import QuickTest from './pages/QuickTest.jsx';

const TABS = [
  { id: 'models', label: 'Modelli', Page: Models },
  { id: 'profiles', label: 'Profili', Page: Profiles },
  { id: 'status', label: 'Stato e costi', Page: Status },
  { id: 'clients', label: 'Client', Page: Clients },
  { id: 'quick', label: 'Prova veloce', Page: QuickTest },
];

// R19b: localStorage può mancare o lanciare (finestra privata, dati bloccati): l'app funziona comunque.
function readTab() {
  try { return localStorage.getItem('llmpod.tab') ?? 'models'; } catch { return 'models'; }
}

// Domande dei job in attesa di risposta, per job: una domanda resta pendente finché non arriva answer (stessa domanda), done o failed.
function usePendingQuestions() {
  const [pending, setPending] = useState({});
  const onEvent = useCallback((e) => {
    if (!e?.jobId) return;
    if (e.type === 'question') setPending((p) => ({ ...p, [e.jobId]: e.questionId }));
    else if ((e.type === 'answer' || e.type === 'done' || e.type === 'failed')) {
      setPending((p) => {
        if (!(e.jobId in p) || (e.type === 'answer' && p[e.jobId] !== e.questionId)) return p;
        const { [e.jobId]: _gone, ...rest } = p;
        return rest;
      });
    }
  }, []);
  // Allineamento con lo stato del server: all'avvio e a ogni riconnessione SSE (la domanda può essere arrivata prima).
  const sync = useCallback(async () => {
    try {
      const { jobs = [] } = await api('/api/jobs');
      setPending(Object.fromEntries(jobs.filter((j) => j.status === 'running' && j.question).map((j) => [j.id, j.question.id])));
    } catch { /* elenco non disponibile: restano gli eventi SSE */ }
  }, []);
  useAnyJobEvent(onEvent, sync);
  useEffect(() => { sync(); }, [sync]);
  return Object.keys(pending).length > 0;
}

function QuestionBanner({ tab, onGo }) {
  const pending = usePendingQuestions();
  if (!pending || tab === 'profiles') return null;
  return (
    <div role="status" className="fade-up mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
      <span>Una domanda attende risposta</span>
      <button type="button" onClick={onGo} className="rounded-lg bg-amber-400/20 px-3 py-1 text-amber-100 transition hover:bg-amber-400/30">Vai a Profili</button>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState('loading');
  const [tab, setTab] = useState(readTab);

  useEffect(() => {
    api('/api/session').then((s) => setSession(s)).catch((err) => setSession({ error: err }));
  }, []);
  useEffect(() => { try { localStorage.setItem('llmpod.tab', tab); } catch { /* storage non disponibile */ } }, [tab]);

  if (session === 'loading') return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (session.error) {
    const invalid = session.error.status === 401;
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="glass fade-up max-w-md p-8 text-center">
          <h1 className="mb-3 text-2xl font-bold neon-text">llmpod</h1>
          {invalid
            ? <p className="text-gray-300">Sessione non valida: riapri il link stampato da <code className="text-cyan-300">llmpod ui</code>.</p>
            : <p className="text-gray-300">Server non raggiungibile. Controlla che <code className="text-cyan-300">llmpod ui</code> sia ancora in esecuzione e ricarica la pagina.</p>}
        </div>
      </div>
    );
  }
  const { Page } = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <EventsProvider>
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src="/icon.svg" alt="" className="glow h-10 w-10 rounded-xl" />
            <div>
              <h1 className="text-2xl font-bold neon-text">llmpod</h1>
              <p className="text-xs text-gray-400">LLM self-hosted su Runpod · v{session.version}</p>
            </div>
          </div>
          <nav className="glass flex flex-wrap gap-1 p-1">
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-sm transition-all duration-200 ${tab === t.id ? 'bg-gradient-to-r from-cyan-400/30 to-fuchsia-500/30 text-white neon-border' : 'text-gray-400 hover:text-white'}`}>
                {t.label}
              </button>
            ))}
          </nav>
        </header>
        <QuestionBanner tab={tab} onGo={() => setTab('profiles')} />
        <main key={tab} className="fade-up"><Page /></main>
      </div>
    </EventsProvider>
  );
}
