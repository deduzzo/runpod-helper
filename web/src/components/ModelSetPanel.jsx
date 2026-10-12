import { useState } from 'react';
import { fmtGiB } from '../lib/api.js';
import { Badge, Button, inputClass } from './ui.jsx';

const fmtTokens = (n) => Number(n).toLocaleString('it-IT');

// Modelli del set con la posizione (come "llmpod plan <set>/<n>"), filtrati su id, famiglia e variante.
function filterModels(models, query) {
  const q = query.trim().toLowerCase();
  return models
    .map((model, i) => ({ n: i + 1, model }))
    .filter(({ model: m }) => !q || [m.id, m.family, m.variant].some((t) => t.toLowerCase().includes(q)));
}

function Fact({ label, children }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-gray-200">{children}</dd>
    </div>
  );
}

function ModelCard({ n, model: m, busy, onPlan }) {
  return (
    <li
      className="fade-up group flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-400/40 hover:shadow-[0_0_24px_rgba(139,92,246,0.25)] focus-within:border-cyan-400/60"
      style={{ animationDelay: `${Math.min(n, 12) * 35}ms` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-gray-500">#{n} · {m.family}</p>
          <h3 className="break-all font-mono text-sm text-cyan-100">{m.id}</h3>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Badge tone="violet">{m.variant}</Badge>
          {m.mtp ? <Badge tone="green">MTP</Badge> : <Badge tone="gray">senza MTP</Badge>}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <Fact label="Formato">{m.format.toUpperCase()}</Fact>
        <Fact label="Pesi">{fmtGiB(m.weightsGiB)}</Fact>
        <Fact label="Contesto max">{fmtTokens(m.context)}</Fact>
        <Fact label="Consigliato">{fmtTokens(m.recommendedContext)}</Fact>
        <Fact label="Parser">{m.toolParser}{m.reasoningParser ? ` · ${m.reasoningParser}` : ''}</Fact>
        <Fact label="Licenza">{m.license ?? '?'}</Fact>
      </dl>
      {m.quantization && <p className="text-xs text-gray-400">{m.quantization}</p>}
      <p className="text-sm text-gray-300">{m.notes}</p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-gray-500" title={m.revision}>@{m.revision.slice(0, 12)}</span>
        <Button aria-label={`Calcola il piano per ${m.id}`} loading={busy} onClick={() => onPlan(m)}>Calcola il piano</Button>
      </div>
    </li>
  );
}

// Schede del set consigliato: avviso, filtro e un pulsante per calcolare il piano di ogni modello.
export function ModelSetPanel({ set, busy, onPlan }) {
  const [query, setQuery] = useState('');
  const rows = filterModels(set.models, query);
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-300">{set.description}</p>
      <div role="note" className="fade-up rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">{set.warning}</div>
      <input aria-label="Filtra il set" className={`${inputClass} w-full`} placeholder="Filtra per nome, famiglia o variante" value={query} onChange={(e) => setQuery(e.target.value)} />
      {rows.length === 0
        ? <p className="text-sm text-gray-400">Nessun modello del set corrisponde al filtro</p>
        : (
          <ul className="grid gap-3 md:grid-cols-2">
            {rows.map(({ n, model }) => <ModelCard key={model.id} n={n} model={model} busy={busy === model.id} onPlan={onPlan} />)}
          </ul>
        )}
      <p className="text-xs text-gray-500">Prezzo e GPU dipendono dalla disponibilità attuale: il piano li calcola dal catalogo Runpod. Da terminale: llmpod search --set {set.id}</p>
    </div>
  );
}
