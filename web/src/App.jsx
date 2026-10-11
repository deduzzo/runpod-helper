import { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { EventsProvider } from './lib/events.jsx';
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

export default function App() {
  const [session, setSession] = useState('loading');
  const [tab, setTab] = useState(readTab);

  useEffect(() => {
    api('/api/session').then((s) => setSession(s)).catch(() => setSession(null));
  }, []);
  useEffect(() => { try { localStorage.setItem('llmpod.tab', tab); } catch { /* storage non disponibile */ } }, [tab]);

  if (session === 'loading') return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="glass fade-up max-w-md p-8 text-center">
          <h1 className="mb-3 text-2xl font-bold neon-text">llmpod</h1>
          <p className="text-gray-300">Sessione non valida. Apri il link stampato nel terminale da <code className="text-cyan-300">llmpod ui</code>.</p>
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
        <main key={tab} className="fade-up"><Page /></main>
      </div>
    </EventsProvider>
  );
}
