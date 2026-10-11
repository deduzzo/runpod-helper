import { attachRenderer } from '../render.js';
import { fmtUSD } from '../../core/confirm.js';

// Gestione di Ctrl+C durante "up": non deve mai lasciare un Pod acceso senza avvisare.
export function createInterruptHandler({ ops, runpod, io, name, getPodId, exit = (c) => process.exit(c) }) {
  let running = false;
  return async () => {
    if (running) {
      io.err('  Terminazione in corso, attendere…');
      return;
    }
    running = true;
    try {
      let id = getPodId();
      if (!id) {
        try {
          const pod = (await runpod.listPods()).find((p) => p.name === `llmpod-${name}` && !['TERMINATED', 'EXITED'].includes(p.status));
          id = pod?.id ?? null;
        } catch { /* ricerca best-effort */ }
      }
      if (!id) return;
      let terminate = true;
      try {
        terminate = await io.ask(`\nInterrotto. Terminare il Pod ${id} per non continuare a pagare?`, true);
      } catch { /* risposta non ottenibile (es. secondo Ctrl+C): meglio spegnere */ }
      if (!terminate) {
        io.err(`⚠ Pod ${id} lasciato acceso: spegnilo con "llmpod down ${name}"`);
        return;
      }
      try {
        await ops.down(name, { yes: true });
      } catch (err) {
        io.err(`⚠ Il Pod ${id} potrebbe essere ancora attivo: ${err.message}. Controlla su https://www.runpod.io/console/pods`);
      }
    } finally {
      exit(130);
    }
  };
}

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
      const onSigint = createInterruptHandler({ ops: ctx.ops, runpod: ctx.runpod, io, name, getPodId: () => podId });
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
