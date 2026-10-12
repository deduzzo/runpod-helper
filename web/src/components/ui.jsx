import { useState } from 'react';

export function Card({ title, children, className = '' }) {
  return (
    <section className={`glass fade-up p-5 ${className}`}>
      {title && <h2 className="mb-4 text-lg font-semibold neon-text">{title}</h2>}
      {children}
    </section>
  );
}

const VARIANTS = {
  primary: 'bg-gradient-to-r from-cyan-400 via-violet-500 to-fuchsia-500 text-black hover:brightness-110',
  ghost: 'border border-white/15 text-gray-200 hover:bg-white/5',
  danger: 'bg-rose-500/90 text-white hover:bg-rose-500',
};

export function Button({ variant = 'primary', loading = false, className = '', children, disabled, ...props }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all duration-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-gray-400">{label}</span>
      {children}
    </label>
  );
}

export const inputClass = 'rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-gray-100 outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20';

const TONES = { cyan: 'bg-cyan-400/15 text-cyan-300', violet: 'bg-violet-400/15 text-violet-300', amber: 'bg-amber-400/15 text-amber-300', red: 'bg-rose-400/15 text-rose-300', green: 'bg-emerald-400/15 text-emerald-300', gray: 'bg-gray-400/15 text-gray-300', orange: 'bg-orange-400/15 text-orange-300' };
export function Badge({ tone = 'cyan', children }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="fade-up rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm">
      <p className="font-medium text-rose-300">{error.message}</p>
      {error.hint && <p className="mt-1 text-rose-200/80">{error.hint}</p>}
    </div>
  );
}

export function CodeBlock({ text, copy = true }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/50 p-3 text-xs text-cyan-100">{text}</pre>
      {copy && (
        <button
          type="button"
          className="absolute right-2 top-2 rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {})}
        >
          {copied ? 'Copiato' : 'Copia'}
        </button>
      )}
    </div>
  );
}
