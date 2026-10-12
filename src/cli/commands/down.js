import { attachRenderer } from '../render.js';
import { fmtUSD } from '../../core/confirm.js';

export function register(program, getCtx) {
  program.command('down [profilo]')
    .description('Elimina il Pod, acceso o spento (il network volume con i pesi resta)')
    .option('--yes', 'non chiedere conferme')
    .option('--dry-run', 'non terminare, mostra soltanto')
    .option('--keep-volume', 'mantiene il volume (comportamento predefinito; per eliminarlo usa destroy-volume)')
    .action(async (name, opts) => {
      const ctx = getCtx();
      const profile = await ctx.ops.resolveProfile(name);
      const off = attachRenderer(ctx.events, ctx.io);
      try {
        const r = await ctx.ops.down(profile, { yes: opts.yes, dryRun: opts.dryRun });
        if (!r.podId) ctx.io.out(`Nessun Pod per ${profile}`);
        else if (r.dryRun) ctx.io.out(`[dry-run] verrebbe eliminato il Pod ${(r.podIds ?? [r.podId]).join(', ')}`);
        else if (r.podIds?.length > 1) ctx.io.out(`✓ Pod eliminati: ${r.podIds.join(', ')}${r.sessionUSD ? ` (costo della sessione circa ${fmtUSD(r.sessionUSD)})` : ''}`);
        else if (r.stopped && !r.sessionUSD) ctx.io.out(`✓ Pod ${r.podId} eliminato (era spento: ora non costa più nulla)`);
        else ctx.io.out(`✓ Pod ${r.podId} terminato (costo della sessione circa ${fmtUSD(r.sessionUSD)})`);
      } finally {
        off();
      }
    });
}
