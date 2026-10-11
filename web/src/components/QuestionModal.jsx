import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

// Montato su document.body: dentro una scheda con backdrop-filter `position: fixed` sarebbe relativo alla scheda
// e il dialogo di conferma (costi) potrebbe essere tagliato. Esc non chiude: serve una risposta esplicita.
export function QuestionModal({ question, onAnswer }) {
  const titleId = useId();
  const defaultRef = useRef(null);
  const questionId = question?.id;
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
        <div className="flex justify-end gap-3">
          <button ref={question.defYes ? null : defaultRef} type="button" className={`rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5 ${highlight(false)}`} onClick={() => onAnswer(false)}>No</button>
          <button ref={question.defYes ? defaultRef : null} type="button" className={`rounded-xl bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-black ${highlight(true)}`} onClick={() => onAnswer(true)}>Sì</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
