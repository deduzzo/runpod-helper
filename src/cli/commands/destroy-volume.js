import { LlmpodError, Codes } from '../../core/errors.js';
import { confirmAction } from '../../core/confirm.js';

export function register(program, getCtx) {
  program.command('destroy-volume')
    .description('Elimina il network volume con i pesi (doppia conferma)')
    .option('--yes', 'salta entrambe le conferme')
    .option('--dry-run', 'non eliminare, mostra soltanto')
    .action(async (opts) => {
      const ctx = getCtx();
      const { io, store } = ctx;
      const volume = store.readConfig().volume;
      if (!volume) throw new LlmpodError(Codes.NOT_FOUND, 'Nessun network volume configurato');
      const active = (await ctx.runpod.listPods()).filter((p) => p.name?.startsWith('llmpod-') && !['TERMINATED', 'EXITED'].includes(p.status));
      if (active.length) throw new LlmpodError(Codes.INVALID_INPUT, `Ci sono Pod llmpod attivi (${active.map((p) => p.id).join(', ')})`, { hint: 'Terminali prima con: llmpod down' });
      const conf = await confirmAction({ description: `Eliminare DEFINITIVAMENTE il volume ${volume.name} (${volume.size} GB, ${volume.dataCenterId})? I pesi scaricati andranno persi`, yes: opts.yes, dryRun: opts.dryRun, ask: io.ask });
      if (conf.dryRun) return io.out(`[dry-run] ${conf.message}`);
      if (!opts.yes && (await io.askText('Per confermare digita il nome del volume:', '')) !== volume.name) {
        throw new LlmpodError(Codes.CANCELLED, 'Nome non corrispondente: volume NON eliminato');
      }
      await ctx.runpod.deleteVolume(volume.id);
      store.writeConfig({ volume: null });
      io.out(`✓ Volume ${volume.name} eliminato`);
    });
}
