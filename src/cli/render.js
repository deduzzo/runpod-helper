import { redact } from '../core/secrets.js';
import { stripControl } from '../core/advisor/advice.js';

export function createIo({ stdout = process.stdout, stderr = process.stderr, prompt }) {
  const err = (t) => stderr.write(`${redact(t)}\n`);
  // Domanda a scelta numerata: invio = predefinita (defId). Le opzioni sono { id, label }; restituisce l'id scelto.
  async function askChoice(text, options, defId) {
    const found = options.findIndex((o) => o.id === defId);
    const def = found >= 0 ? found : 0;
    err(text);
    options.forEach((o, i) => err(`  ${i + 1}) ${stripControl(o.label)}${i === def ? '  (predefinita)' : ''}`));
    for (;;) {
      const a = String(await prompt.askText('Scelta:', String(def + 1))).trim();
      const n = /^\d+$/.test(a) ? Number(a) : 0;
      if (n >= 1 && n <= options.length) return options[n - 1].id;
      err(`Scelta non valida: indica un numero da 1 a ${options.length}`);
    }
  }
  return {
    interactive: Boolean(prompt.isTty),
    askChoice,
    out: (t) => stdout.write(`${redact(t)}\n`),
    raw: (t) => stdout.write(`${t}\n`),
    err,
    ask: prompt.ask,
    askText: prompt.askText,
    askSecret: prompt.askSecret,
  };
}

const CLI_COMMANDS = 'init|search|plan|save|up|down|status|env|run|rotate-key|destroy-volume|advisor|ui|chat|prepare|logs|keep|metrics|tune|manage|start|mcp';

// Dentro Docker il comando si lancia dal wrapper: negli errori "llmpod <comando>" diventa "bin/llmpod <comando>".
export function dockerCommands(text, env = process.env) {
  if (typeof text !== 'string' || env.LLMPOD_IN_DOCKER !== '1') return text;
  return text.replace(new RegExp(`(?<![\\w/.-])llmpod (?=(?:${CLI_COMMANDS})(?![\\w-]))`, 'g'), 'bin/llmpod ');
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
  const t = stripControl; // il testo del consulente non deve poter muovere il cursore o riscrivere il terminale
  if (advice.rationale) io.out(`Consulente: ${t(advice.rationale)}`);
  const { added, removed, changed } = advice.changes;
  for (const a of added) io.out(`  + ${t(a)}`);
  for (const r of removed) io.out(`  - ${t(r)}`);
  for (const c of changed) io.out(`  ~ ${t(c.flag)}: ${t(c.from) || '(senza valore)'} → ${t(c.to) || '(senza valore)'}`);
  if (!added.length && !removed.length && !changed.length) io.out('  (nessuna modifica proposta)');
  for (const r of advice.rejected) io.out(`  ✗ scartato ${t(r.key)}: ${t(r.reason)}`);
  for (const w of advice.warnings) io.out(`⚠ ${t(w)}`);
}
