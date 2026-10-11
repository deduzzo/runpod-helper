import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useJobEvents } from '../lib/events.jsx';
import { QuestionModal } from './QuestionModal.jsx';
import { Button, ErrorBox, Spinner, Badge } from './ui.jsx';

const MAX_LOGS = 200;
const TERMINAL = ['done', 'failed'];

function AdviceView({ advice }) {
  const { added = [], removed = [], changed = [] } = advice.changes ?? {};
  const rejected = advice.rejected ?? [];
  return (
    <div className="fade-up space-y-2 rounded-xl border border-violet-400/30 bg-violet-500/10 p-3 text-sm">
      <p className="font-medium text-violet-200">Proposta del consulente</p>
      {advice.rationale && <p className="text-gray-300">{advice.rationale}</p>}
      <ul className="space-y-0.5 font-mono text-xs">
        {added.map((a) => <li key={`a-${a}`} className="text-emerald-300">+ {a}</li>)}
        {removed.map((r) => <li key={`r-${r}`} className="text-rose-300">- {r}</li>)}
        {changed.map((c) => <li key={`c-${c.flag}`} className="text-amber-300">~ {c.flag}: {String(c.from ?? '')} → {String(c.to ?? '')}</li>)}
      </ul>
      {rejected.length > 0 && (
        <ul className="space-y-0.5 text-xs text-gray-400">
          {rejected.map((r, i) => <li key={i}>Scartato {typeof r === 'string' ? r : `${r.key}: ${r.reason}`}</li>)}
        </ul>
      )}
      {(advice.warnings ?? []).map((w, i) => <p key={i} className="text-xs text-amber-300">⚠ {w}</p>)}
    </div>
  );
}

// Con un jobId diverso lo stato si azzera (key): niente eventi del job precedente.
export function JobPanel(props) {
  return <JobPanelInner key={props.jobId} {...props} />;
}

function JobPanelInner({ jobId, onFinished }) {
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('running');
  const [question, setQuestion] = useState(null);
  const [phases, setPhases] = useState([]);
  const [progress, setProgress] = useState(null);
  const [logs, setLogs] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [infos, setInfos] = useState([]);
  const [pods, setPods] = useState([]);
  const [advices, setAdvices] = useState([]);
  const [jobError, setJobError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showLogs, setShowLogs] = useState(false);

  // Deduplica per `seq`: gli stessi eventi arrivano sia dal fetch sia dal flusso SSE (e di nuovo dopo una riconnessione).
  const seen = useRef(new Set());
  const next = useRef(0); // primo seq non ancora ricevuto in modo contiguo: il `since` della prossima sincronizzazione
  const answered = useRef(new Set());
  const syncing = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);
  const finishedCb = useRef(onFinished);
  finishedCb.current = onFinished;

  const ingest = useCallback((e) => {
    if (e.seq != null) {
      if (seen.current.has(e.seq)) return false;
      seen.current.add(e.seq);
    }
    switch (e.type) {
      case 'phase': setPhases((p) => [...p, e.message]); break;
      case 'progress': setProgress({ message: e.message, ratio: e.ratio }); break;
      case 'info': setInfos((l) => [...l, e.message]); break;
      case 'warning': setWarnings((l) => [...l, e.message]); break;
      case 'pod': setPods((l) => (l.includes(e.podId) ? l : [...l, e.podId])); break;
      case 'advice': setAdvices((l) => [...l, e]); break;
      case 'log': setLogs((l) => [...l.slice(-(MAX_LOGS - 1)), e.line]); break;
      case 'question': setQuestion({ id: e.questionId, text: e.text, defYes: e.defYes }); break;
      case 'answer':
        answered.current.add(e.questionId);
        setQuestion((q) => (q?.id === e.questionId ? null : q));
        break;
      case 'done':
        setStatus('done');
        setQuestion(null);
        finishedCb.current?.(e.result);
        break;
      case 'failed':
        setStatus('failed');
        setQuestion(null);
        setJobError(e.error ?? { message: 'Operazione non riuscita' });
        break;
      default: break;
    }
    return true;
  }, []);

  const advance = () => { while (seen.current.has(next.current)) next.current += 1; };

  const sync = useCallback(async () => {
    if (syncing.current) { again.current = true; return; }
    syncing.current = true;
    try {
      do {
        again.current = false;
        try {
          const { job, events } = await api(`/api/jobs/${jobId}?since=${next.current}`);
          if (!alive.current) return;
          const sorted = [...(events ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
          for (const e of sorted) ingest(e);
          // Il server ha restituito tutto ciò che ha da `since` in poi: i seq mancanti sono stati scartati (solo `log`).
          const maxSeq = sorted.reduce((m, e) => Math.max(m, e.seq ?? -1), -1);
          next.current = Math.max(next.current, maxSeq + 1);
          advance();
          // Lo stato non torna mai indietro da terminale; la domanda dello snapshot serve solo se gli eventi non l'hanno già chiusa.
          setStatus((s) => (TERMINAL.includes(s) ? s : job.status));
          if (job.status === 'failed' && job.error) setJobError((x) => x ?? job.error);
          if (job.question && !answered.current.has(job.question.id)) setQuestion((q) => q ?? job.question);
          setLoadError(null);
          setLoaded(true);
        } catch (err) {
          if (!alive.current) return;
          setLoadError(err);
        }
      } while (again.current && alive.current);
    } finally {
      syncing.current = false;
    }
  }, [jobId, ingest]);

  useEffect(() => {
    alive.current = true;
    sync();
    return () => { alive.current = false; };
  }, [sync]);

  const onEvent = useCallback((e) => {
    if (!ingest(e)) return;
    if (e.seq == null) return;
    if (e.seq === next.current) advance();
    else if (e.seq > next.current) sync(); // buco nella sequenza: si recuperano gli eventi persi
  }, [ingest, sync]);

  // Alla riconnessione del flusso SSE si rifà il fetch dello stato (potrebbero essersi persi eventi).
  useJobEvents(jobId, onEvent, sync);

  async function answer(value) {
    const q = question;
    if (!q) return;
    setQuestion(null);
    answered.current.add(q.id);
    setActionError(null);
    try {
      await api(`/api/jobs/${jobId}/answer`, { method: 'POST', body: { questionId: q.id, answer: value } });
    } catch (err) {
      setActionError(err);
    }
  }

  if (!loaded && loadError) {
    return (
      <div className="space-y-3">
        <ErrorBox error={loadError} />
        <Button variant="ghost" onClick={sync}>Riprova</Button>
      </div>
    );
  }
  if (!loaded) return <Spinner />;

  return (
    <div className="fade-up space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {status === 'running' && <><Spinner /><Badge tone="cyan">in corso</Badge></>}
        {status === 'done' && <Badge tone="green">completato</Badge>}
        {status === 'failed' && <Badge tone="red">non riuscito</Badge>}
        {progress && status === 'running' && <span className="text-gray-400">{progress.message}</span>}
      </div>
      {progress?.ratio != null && status === 'running' && (
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.ratio * 100)}>
          <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 transition-all duration-500" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
        </div>
      )}
      <ol className="space-y-1 text-sm text-gray-300">
        {phases.map((p, i) => <li key={i} className="fade-up">▸ {p}</li>)}
      </ol>
      {pods.map((p) => <p key={p} className="text-sm text-cyan-200">Pod: <code>{p}</code></p>)}
      {infos.map((m, i) => <p key={i} className="text-sm text-gray-300">ℹ {m}</p>)}
      {warnings.map((w, i) => <p key={i} className="text-sm text-amber-300">⚠ {w}</p>)}
      {advices.map((a, i) => <AdviceView key={i} advice={a} />)}
      {status === 'failed' && <ErrorBox error={jobError} />}
      {loadError && (
        <div className="space-y-2">
          <ErrorBox error={loadError} />
          <Button variant="ghost" onClick={sync}>Riprova</Button>
        </div>
      )}
      <ErrorBox error={actionError} />
      {logs.length > 0 && (
        <div>
          <button type="button" className="text-xs text-cyan-300 hover:underline" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? 'Nascondi i log di vLLM' : `Mostra i log di vLLM (${logs.length})`}
          </button>
          {showLogs && <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-black/50 p-3 text-xs text-gray-300">{logs.join('\n')}</pre>}
        </div>
      )}
      <QuestionModal question={question} onAnswer={answer} />
    </div>
  );
}
