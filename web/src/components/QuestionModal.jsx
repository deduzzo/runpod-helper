import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Montato su document.body: dentro una scheda con backdrop-filter `position: fixed` sarebbe relativo alla scheda
// e il dialogo di conferma (costi) potrebbe essere tagliato. Esc non chiude: serve una risposta esplicita.
// Due tipi di domanda: conferma (sì/no, risposta booleana) e scelta (kind "choice": risposta = id dell'opzione, null = annulla).
export function QuestionModal({ question, onAnswer }) {
  const titleId = useId();
  const defaultRef = useRef(null);
  const questionId = question?.id;
  const isChoice = question?.kind === 'choice';
  // La scelta dell'utente vale solo per la domanda in cui è stata fatta: una domanda nuova riparte dalla sua predefinita.
  const [picked, setPicked] = useState({ q: null, id: null });
  const selected = picked.q === questionId && picked.id != null ? picked.id : (question?.defaultId ?? question?.options?.[0]?.id ?? null);
  useEffect(() => { if (questionId) defaultRef.current?.focus(); }, [questionId]);
  useEffect(() => {
    if (!questionId) return undefined;
    const block = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } };
    document.addEventListener('keydown', block, true);
    return () => document.removeEventListener('keydown', block, true);
  }, [questionId]);
  if (!question) return null;
  const highlight = (yes) => (question.defYes === yes ? 'ring-2 ring-cyan-300' : '');
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="glass neon-border fade-up w-full max-w-md p-6">
        <p id={titleId} className="mb-6 text-base text-gray-100">{question.text}</p>
        {isChoice ? (
          <>
            <div role="radiogroup" aria-labelledby={titleId} className="mb-6 space-y-2">
              {question.options.map((o) => (
                <label key={o.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm transition ${selected === o.id ? 'border-cyan-400/60 bg-cyan-400/10' : 'border-white/10 hover:bg-white/5'}`}>
                  <input
                    ref={o.id === selected ? defaultRef : null}
                    type="radio"
                    name={`q-${questionId}`}
                    value={o.id}
                    className="mt-1"
                    checked={selected === o.id}
                    onChange={() => setPicked({ q: questionId, id: o.id })}
                  />
                  <span className="break-words text-gray-100">{o.label}</span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5" onClick={() => onAnswer(null)}>Annulla</button>
              <button type="button" disabled={selected == null} className="rounded-xl bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50" onClick={() => onAnswer(selected)}>Conferma</button>
            </div>
          </>
        ) : (
          <div className="flex justify-end gap-3">
            <button ref={question.defYes ? null : defaultRef} type="button" className={`rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5 ${highlight(false)}`} onClick={() => onAnswer(false)}>No</button>
            <button ref={question.defYes ? defaultRef : null} type="button" className={`rounded-xl bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-black ${highlight(true)}`} onClick={() => onAnswer(true)}>Sì</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
