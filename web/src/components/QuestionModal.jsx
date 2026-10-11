export function QuestionModal({ question, onAnswer }) {
  if (!question) return null;
  const highlight = (yes) => (question.defYes === yes ? 'ring-2 ring-cyan-300' : '');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="glass neon-border fade-up w-full max-w-md p-6">
        <p className="mb-6 text-base text-gray-100">{question.text}</p>
        <div className="flex justify-end gap-3">
          <button type="button" className={`rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5 ${highlight(false)}`} onClick={() => onAnswer(false)}>No</button>
          <button type="button" className={`rounded-xl bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-black ${highlight(true)}`} onClick={() => onAnswer(true)}>Sì</button>
        </div>
      </div>
    </div>
  );
}
