import { attachRenderer } from '../render.js';
import { fmtUSD } from '../../core/confirm.js';

export function register(program, getCtx) {
  program.command('up <profilo>')
    .description('Crea il Pod, attende vLLM ed esegue lo smoke test')
    .option('--yes', 'non chiedere conferme')
    .option('--dry-run', 'mostra la richiesta senza creare nulla')
    .action(async (name, opts) => {
      const ctx = getCtx();
      const { io } = ctx;
      const off = attachRenderer(ctx.events, io, { verbose: program.opts().verbose });
      let podId = null;
      const offPod = ctx.events.on((e) => { if (e.type === 'pod') podId = e.podId; });
      const onSigint = async () => {
        process.off('SIGINT', onSigint);
        if (podId && await io.ask(`\nInterrotto. Terminare il Pod ${podId} per non continuare a pagare?`, true)) await ctx.ops.down(name, { yes: true });
        process.exit(130);
      };
      process.on('SIGINT', onSigint);
      try {
        const r = await ctx.ops.up(name, { yes: opts.yes, dryRun: opts.dryRun });
        if (r.dryRun) {
          io.out(`[dry-run] ${r.message}`);
          io.out(`Candidati: ${r.candidates.map((c) => `${c.id} ×${c.count} @ ${c.dataCenterId}${c.withVolume ? '' : ' (senza volume)'}`).join(', ')}`);
          io.out(JSON.stringify(r.body, null, 2));
          return;
        }
        io.out(`✓ ${name} pronto in ${r.startupSeconds} s`);
        io.out(`  Endpoint:  ${r.baseUrl}  (OpenAI: ${r.baseUrl}/v1)`);
        io.out(`  Costo:     ${fmtUSD(r.hourlyUSD)}/h su ${r.candidate.id} ×${r.candidate.count} (${r.candidate.dataCenterId})`);
        io.out('  Smoke test: /v1/models ✓  /v1/messages con strumento ✓  /v1/chat/completions con strumento ✓');
        if (r.contextSuggestion) io.out(`  La KV cache consente fino a ${r.contextSuggestion} token per richiesta: puoi rigenerare il profilo con --context ${r.contextSuggestion}`);
        io.out(`Usa: llmpod run claude | opencode | pi | zcode   ·   Spegni: llmpod down ${name}`);
      } finally {
        process.off('SIGINT', onSigint);
        offPod();
        off();
      }
    });
}
