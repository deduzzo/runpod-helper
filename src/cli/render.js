import { redact } from '../core/secrets.js';

export function createIo({ stdout = process.stdout, stderr = process.stderr, prompt }) {
  return {
    out: (t) => stdout.write(`${redact(t)}\n`),
    raw: (t) => stdout.write(`${t}\n`),
    err: (t) => stderr.write(`${redact(t)}\n`),
    ask: prompt.ask,
    askText: prompt.askText,
    askSecret: prompt.askSecret,
  };
}

export function attachRenderer(events, io, { verbose = false } = {}) {
  let lastProgress = '';
  return events.on((e) => {
    if (e.type === 'phase') io.err(`▸ ${e.message}`);
    else if (e.type === 'progress' && e.message !== lastProgress) { lastProgress = e.message; io.err(`  … ${e.message}`); }
    else if (e.type === 'log' && verbose) io.err(`  │ ${e.line}`);
    else if (e.type === 'warning') io.err(`⚠ ${e.message}`);
    else if (e.type === 'info') io.err(`ℹ ${e.message}`);
    else if (e.type === 'pod') io.err(`  Pod creato: ${e.podId}`);
    else if (e.type === 'advice') renderAdvice(io, { rationale: e.rationale, changes: e.changes, rejected: e.rejected, warnings: e.warnings });
  });
}

export function table(rows, columns) {
  const cells = rows.map((r) => columns.map((c) => String(c.value ? c.value(r) : r[c.key] ?? '')));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i].length)));
  const line = (vals) => vals.map((v, i) => (columns[i].align === 'right' ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(columns.map((c) => c.label)), line(widths.map((w) => '─'.repeat(w))), ...cells.map(line)].join('\n');
}

export const fmtGiB = (n) => `${Number(n).toFixed(1).replace('.', ',')} GiB`;

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`;
}

export function renderAdvice(io, advice) {
  if (advice.rationale) io.out(`Consulente: ${advice.rationale}`);
  const { added, removed, changed } = advice.changes;
  for (const a of added) io.out(`  + ${a}`);
  for (const r of removed) io.out(`  - ${r}`);
  for (const c of changed) io.out(`  ~ ${c.flag}: ${c.from ?? '(senza valore)'} → ${c.to ?? '(senza valore)'}`);
  if (!added.length && !removed.length && !changed.length) io.out('  (nessuna modifica proposta)');
  for (const r of advice.rejected) io.out(`  ✗ scartato ${r.key}: ${r.reason}`);
  for (const w of advice.warnings) io.out(`⚠ ${w}`);
}
