import { LlmpodError, Codes } from '../../core/errors.js';
import { fmtUSD } from '../../core/confirm.js';
import { fmtDuration } from '../render.js';

const num = (n, digits = 1) => Number(n).toLocaleString('it-IT', { maximumFractionDigits: digits });

function speculativeLines(spec, draftLabel) {
  if (!spec) return [`Accettazione ${draftLabel}: decodifica speculativa non attiva`];
  const fmt = (a) => `${num(a.acceptanceRatePct)} % dei token proposti, lunghezza media accettata ${num(a.meanAcceptedLength, 2)}, per posizione ${a.perPositionPct.map((p) => `${num(p)} %`).join(' · ')}`;
  return [
    `Accettazione ${draftLabel} (totale, ${spec.total ? num(spec.total.drafts, 0) : 0} passi): ${spec.total ? fmt(spec.total) : 'nessuna bozza ancora'}`,
    `Accettazione ${draftLabel} (finestra): ${spec.window ? fmt(spec.window) : 'nessun traffico nella finestra'}`,
  ];
}

export function register(program, getCtx) {
  program.command('metrics [profilo]')
    .description('Metriche di vLLM sul Pod: token/s, richieste, uso della KV cache, accettazione MTP/DSpark, errori')
    .option('--window <secondi>', 'secondi tra le due letture per calcolare i tassi (1..300)', (v) => Number(v), 10)
    .option('--json', 'output JSON')
    .action(async (name, opts) => {
      const ctx = getCtx();
      if (!Number.isFinite(opts.window)) throw new LlmpodError(Codes.INVALID_INPUT, '--window deve essere un numero di secondi');
      const profile = await ctx.ops.resolveProfile(name);
      const r = await ctx.ops.metrics(profile, { window: opts.window });
      if (opts.json) return ctx.io.raw(JSON.stringify(r, null, 2));
      const { io } = ctx;
      const s = r.supervisor;
      io.out(`Pod ${r.podId} (${r.profile}) · ${r.gpu ? `${r.gpu.id} ×${r.gpu.count}` : 'GPU ?'} · ${r.hourlyUSD ? `${fmtUSD(r.hourlyUSD)}/h` : 'costo ?'} · vLLM: ${s?.phase ?? 'supervisore non raggiungibile'}`);
      if (s) io.out(`Acceso da ${fmtDuration(s.uptimeSeconds ?? 0)} · inattivo da ${s.idleSeconds == null ? '—' : fmtDuration(s.idleSeconds)} · riavvii ${s.restarts ?? 0}${s.lastError ? ` · ultimo errore: ${s.lastError}` : ''}`);
      if (!r.metrics) {
        io.out(`Metriche non disponibili: ${r.metricsError}`);
        return undefined;
      }
      const m = r.metrics;
      const draft = r.mtp?.draft === 'dspark' ? 'DSpark' : 'MTP';
      io.out(`Finestra: ${m.windowSeconds} s`);
      io.out(`Generazione: ${num(m.throughput.generationTokensPerSec)} token/s · prompt: ${num(m.throughput.promptTokensPerSec)} token/s`);
      io.out(`Richieste: ${m.requests.running} in corso · ${m.requests.waiting} in coda · ${m.requests.completedInWindow} completate nella finestra`);
      io.out(`KV cache: ${m.kvCacheUsagePct == null ? 'n/d' : `${num(m.kvCacheUsagePct)} %`}${s?.kvCacheTokens ? ` di ${num(s.kvCacheTokens, 0)} token` : ''}`);
      for (const line of speculativeLines(m.speculative, draft)) io.out(line);
      io.out(`Errori: ${m.errors.aborted} richieste interrotte · ${m.errors.preemptions} preemption · HTTP 4xx ${m.errors.http4xx} · HTTP 5xx ${m.errors.http5xx} (${m.errors.http5xxInWindow} nella finestra)`);
      return undefined;
    });
}
