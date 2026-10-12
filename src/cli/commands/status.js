import { fmtUSD } from '../../core/confirm.js';
import { table, fmtDuration } from '../render.js';
import { STOPPED_WARNING } from '../../core/pod-state.js';

// Limiti correnti letti dal supervisore del Pod (cambiabili con "llmpod keep").
function shutdownLabel(s) {
  if (!s) return '—';
  const idle = s.idleLimitSeconds === 0 ? 'inattività: mai'
    : s.idleSeconds != null ? `inattivo da ${fmtDuration(s.idleSeconds)} su ${fmtDuration(s.idleLimitSeconds)}` : s.phase;
  const max = s.maxSeconds != null && s.uptimeSeconds != null ? `; massimo tra ${fmtDuration(s.maxSeconds - s.uptimeSeconds)}` : '';
  return `${idle}${max}`;
}

export function register(program, getCtx) {
  program.command('status')
    .description('Pod (avviati e spenti), costi, credito residuo, volume')
    .option('--json', 'output JSON')
    .action(async (opts) => {
      const ctx = getCtx();
      const s = await ctx.ops.status();
      if (opts.json) return ctx.io.raw(JSON.stringify(s, null, 2));
      const { io } = ctx;
      if (!s.pods.length) io.out('Nessun Pod llmpod.');
      else {
        io.out(table(s.pods, [
          { label: 'Profilo', value: (p) => `${p.profile}${p.orphan ? ' (orfano)' : ''}` },
          { key: 'podId', label: 'Pod' },
          { key: 'stateLabel', label: 'Stato' },
          { label: 'GPU', value: (p) => (p.gpu ? `${p.gpu.id} ×${p.gpu.count}` : '?') },
          { label: 'Costo', align: 'right', value: (p) => (p.hourlyUSD == null ? '—' : `${fmtUSD(p.hourlyUSD)}/h`) },
          { label: 'Uptime', align: 'right', value: (p) => (p.state === 'stopped' ? '—' : fmtDuration(p.uptimeSeconds)) },
          { label: 'Sessione', align: 'right', value: (p) => (p.sessionUSD == null ? '—' : fmtUSD(p.sessionUSD)) },
          { label: 'Spegnimento', value: (p) => shutdownLabel(p.supervisor) },
        ]));
        for (const p of s.pods.filter((x) => x.state === 'stopped')) {
          io.out(`⚠ ${p.profile} (${p.podId}): ${STOPPED_WARNING(p.profile, p.diskGB)}`);
        }
        if (s.pods.some((p) => p.orphan)) io.out('⚠ Pod "orfani": non risultano avviati da questo computer. Terminali con: llmpod down <profilo>');
      }
      io.out(`Credito residuo: ${s.balance ? fmtUSD(s.balance.balance) : 'non disponibile'}`);
      if (s.volume) io.out(`Volume: ${s.volume.name} (${s.volume.size} GB, ${s.volume.dataCenterId}) — ${fmtUSD(s.volume.monthlyUSD)} al mese`);
    });
}
