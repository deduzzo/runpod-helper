import { fmtUSD } from '../../core/confirm.js';
import { table, fmtDuration } from '../render.js';

export function register(program, getCtx) {
  program.command('status')
    .description('Pod attivi, costi, credito residuo, volume')
    .option('--json', 'output JSON')
    .action(async (opts) => {
      const ctx = getCtx();
      const s = await ctx.ops.status();
      if (opts.json) return ctx.io.raw(JSON.stringify(s, null, 2));
      const { io } = ctx;
      if (!s.pods.length) io.out('Nessun Pod llmpod attivo.');
      else {
        io.out(table(s.pods, [
          { label: 'Profilo', value: (p) => `${p.profile}${p.orphan ? ' (orfano)' : ''}` },
          { key: 'podId', label: 'Pod' },
          { key: 'status', label: 'Stato' },
          { label: 'GPU', value: (p) => (p.gpu ? `${p.gpu.id} ×${p.gpu.count}` : '?') },
          { label: 'Costo', align: 'right', value: (p) => `${fmtUSD(p.hourlyUSD)}/h` },
          { label: 'Uptime', align: 'right', value: (p) => fmtDuration(p.uptimeSeconds) },
          { label: 'Sessione', align: 'right', value: (p) => fmtUSD(p.sessionUSD) },
          { label: 'Spegnimento', value: (p) => (p.supervisor?.idleSeconds != null
            ? `inattivo da ${fmtDuration(p.supervisor.idleSeconds)} su ${fmtDuration(p.supervisor.idleLimitSeconds)}; massimo tra ${fmtDuration(p.supervisor.maxSeconds - p.supervisor.uptimeSeconds)}`
            : p.supervisor?.phase ?? '—') },
        ]));
        if (s.pods.some((p) => p.orphan)) io.out('⚠ Pod "orfani": non risultano avviati da questo computer. Terminali con: llmpod down <profilo>');
      }
      io.out(`Credito residuo: ${s.balance ? fmtUSD(s.balance.balance) : 'non disponibile'}`);
      if (s.volume) io.out(`Volume: ${s.volume.name} (${s.volume.size} GB, ${s.volume.dataCenterId}) — ${fmtUSD(s.volume.monthlyUSD)} al mese`);
    });
}
